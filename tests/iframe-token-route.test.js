// Route contract for GET /api/iframe-token (server.js) after the RSA
// cutover: the shell must name which app it wants an identity for, and
// the app-scoped audience must actually be scoped.
//
// Why this suite exists. The cutover rewrote the endpoint to take
// `?app=<slug>` and to gate it through appAccess.getAppForUser at the
// 'view' level — but passed a TRIMMED column list ('id, slug'). That is
// a silent no-op: checkAppAccess() reads `view_visibility` off the row it
// is handed, and a MISSING column takes the "legacy rows mid-migration
// may briefly lack the column; treat as public" branch. Every app looked
// public, so any authenticated user could mint a valid app-identity token
// for a view-private app they cannot see — defeating the existence-hiding
// 404 the handler's own comment claims to implement. Nothing else in the
// suite covered the endpoint at all.
//
// The handler is INLINE IN server.js, which opens a pool and listens on
// load, so it is extracted from source and run in a sandbox (same stance
// as tests/scaffold-token-compat.test.js). Two things are deliberately
// NOT stubbed, because they are what is under test:
//
//   - appAccess is the REAL module, so the privacy gate is the real
//     checkAppAccess + the real `SELECT ${columns} FROM apps` projection.
//     A trimmed column list fails here exactly as it does in production.
//   - platformJwt is the REAL module, so the emitted token is verified
//     with real RS256 key material and a real audience check.
//
// Run with: node --test tests/iframe-token-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');
const appAccess = require('../src/services/app-access');

const VIEWER = { id: 5, username: 'viewer', isAdmin: false };
const OWNER = { id: 9, username: 'owner', isAdmin: false };

const PUBLIC_APP = {
  id: 11, slug: 'public-app', created_by: OWNER.id, self_hosted: false,
  collab_visibility: 'public', view_visibility: 'public',
};
const PRIVATE_APP = {
  id: 12, slug: 'private-app', created_by: OWNER.id, self_hosted: false,
  collab_visibility: 'private', view_visibility: 'private',
};

// ── Extract the real handler out of server.js ───────────────────────────
//
// Matched on the route literal and closed on the first line-anchored
// `});`, which is the handler's own terminator (every nested block inside
// it is indented). If server.js is reshaped so this stops matching, the
// assertions below fail loudly rather than silently testing nothing.
function handlerSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf("app.get('/api/iframe-token'");
  assert.notEqual(start, -1, "could not find the /api/iframe-token route in server.js");
  const end = src.indexOf('\n});', start);
  assert.notEqual(end, -1, 'could not find the end of the /api/iframe-token handler');
  return src.slice(start, end + '\n});'.length);
}

// Build a pool whose `apps` SELECT honours the projection the handler
// asked for — that projection IS the bug surface, so faking a full row
// regardless of `columns` would make this suite pass against the defect.
function makePool({ apps = [], collaborators = [], users = {} } = {}) {
  const calls = [];
  return {
    calls,
    appsQuery: () => calls.find((c) => /FROM apps WHERE slug/.test(c.sql)),
    async query(sql, params) {
      const text = String(sql);
      calls.push({ sql: text, params });

      const appsMatch = text.match(/^SELECT (.+) FROM apps WHERE slug = \$1$/);
      if (appsMatch) {
        const row = apps.find((a) => a.slug === params[0]);
        if (!row) return { rows: [] };
        const cols = appsMatch[1].trim();
        if (cols === '*') return { rows: [{ ...row }] };
        // Project exactly the named columns, dropping everything else —
        // what Postgres does, and what makes a missing view_visibility
        // actually missing.
        const projected = {};
        for (const c of cols.split(',').map((s) => s.trim())) {
          if (c in row) projected[c] = row[c];
        }
        return { rows: [projected] };
      }

      if (/FROM app_collaborators/.test(text)) {
        const [appId, userId] = params;
        return {
          rows: collaborators.some((c) => c.appId === appId && c.userId === userId)
            ? [{ 1: 1 }] : [],
        };
      }

      if (/SELECT usernode_pubkey, locale FROM users/.test(text)) {
        return { rows: [users[params[0]] || { usernode_pubkey: null, locale: null }] };
      }

      return { rows: [] };
    },
  };
}

// Run the extracted handler once. The sandbox supplies exactly the
// identifiers the handler closes over in server.js.
async function call({ user = VIEWER, query = {}, pool = makePool() } = {}) {
  const routes = [];
  const app = {
    get: (routePath, fn) => routes.push({ routePath, fn }),
  };

  // eslint-disable-next-line no-new-func
  new Function('app', 'appAccess', 'platformJwt', 'getPool', 'config', 'log', handlerSource())(
    app, appAccess, platformJwt, () => pool, {}, { error: () => {}, warn: () => {} }
  );
  assert.equal(routes.length, 1, 'expected exactly one registered route');

  const req = { user, query };
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };

  await routes[0].fn(req, res);
  return { res, pool };
}

// ── Contract ────────────────────────────────────────────────────────────

test('401 when unauthenticated', async () => {
  const { res } = await call({ user: null, query: { app: 'public-app' } });
  assert.equal(res.statusCode, 401);
});

test('400 when no ?app= is given', async () => {
  const { res, pool } = await call({ query: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /app query parameter is required/);
  // A caller that named no app leaks nothing, so it must not even reach
  // the apps table.
  assert.equal(pool.appsQuery(), undefined, 'no app named → no DB lookup');
});

test('400 when ?app= is present but blank', async () => {
  const { res } = await call({ query: { app: '   ' } });
  assert.equal(res.statusCode, 400);
});

test('404 for an unknown slug', async () => {
  const pool = makePool({ apps: [PUBLIC_APP] });
  const { res } = await call({ query: { app: 'no-such-app' }, pool });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'App not found' });
});

// THE REGRESSION TEST for the trimmed-column defect. With 'id, slug' the
// projected row has no view_visibility, checkAppAccess takes its
// treat-as-public branch, and this returns 200 with a usable token for an
// app the caller must not even be able to confirm exists.
test('404 for a view-private app the caller cannot view', async () => {
  const pool = makePool({ apps: [PRIVATE_APP] });
  const { res } = await call({ user: VIEWER, query: { app: 'private-app' }, pool });
  assert.equal(res.statusCode, 404,
    'a view-private app must be indistinguishable from a nonexistent one');
  assert.deepEqual(res.body, { error: 'App not found' });
  assert.equal(res.body.token, undefined);
});

// Same 404, so the private-app response carries no existence oracle.
test('an unknown slug and a forbidden app are byte-identical responses', async () => {
  const pool = makePool({ apps: [PRIVATE_APP] });
  const forbidden = await call({ user: VIEWER, query: { app: 'private-app' }, pool });
  const unknown = await call({ user: VIEWER, query: { app: 'nope' }, pool });
  assert.equal(forbidden.res.statusCode, unknown.res.statusCode);
  assert.deepEqual(forbidden.res.body, unknown.res.body);
});

// The fix must not over-restrict: checkAppAccess grants on collaborator
// membership, so a member of a view-private app still gets its identity.
test('a collaborator on a view-private app gets a token', async () => {
  const pool = makePool({
    apps: [PRIVATE_APP],
    collaborators: [{ appId: PRIVATE_APP.id, userId: OWNER.id }],
  });
  const { res } = await call({ user: OWNER, query: { app: 'private-app' }, pool });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token, 'a permitted caller must still get a token');
  const claims = platformJwt.verifyAppIdentityToken(res.body.token, { appId: PRIVATE_APP.id });
  assert.equal(claims.id, OWNER.id);
});

test('an admin gets a token for a view-private app', async () => {
  const pool = makePool({ apps: [PRIVATE_APP] });
  const { res } = await call({
    user: { id: 1, username: 'admin', isAdmin: true },
    query: { app: 'private-app' },
    pool,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
});

test('200 for a public app, and the token is scoped to THAT app', async () => {
  const pool = makePool({
    apps: [PUBLIC_APP, PRIVATE_APP],
    users: { [VIEWER.id]: { usernode_pubkey: 'ut1abc', locale: 'pt-BR' } },
  });
  const { res } = await call({ user: VIEWER, query: { app: 'public-app' }, pool });
  assert.equal(res.statusCode, 200);

  const claims = platformJwt.verifyAppIdentityToken(res.body.token, { appId: PUBLIC_APP.id });
  assert.equal(claims.id, VIEWER.id);
  assert.equal(claims.username, VIEWER.username);
  assert.equal(claims.usernode_pubkey, 'ut1abc');
  assert.equal(claims.locale, 'pt-BR');
  assert.equal(claims.aud, `usernode:app:${PUBLIC_APP.id}`);
  assert.equal(claims.pur, 'iframe');

  // The whole point of the cutover: app B must not accept app A's token.
  assert.throws(
    () => platformJwt.verifyAppIdentityToken(res.body.token, { appId: PRIVATE_APP.id }),
    /audience/i,
    'a token minted for one app must not verify for another'
  );
});

// ── The projection itself ───────────────────────────────────────────────
//
// Behavioural coverage above would also pass if the handler selected '*'.
// Pin the actual contract: the gate must be handed the columns it reads.
test('the apps lookup projects the visibility columns the gate reads', async () => {
  const pool = makePool({ apps: [PUBLIC_APP] });
  await call({ user: VIEWER, query: { app: 'public-app' }, pool });
  const q = pool.appsQuery();
  assert.ok(q, 'the handler must resolve the slug through the apps table');
  for (const col of ['view_visibility', 'collab_visibility', 'created_by']) {
    assert.match(q.sql, new RegExp(`\\b${col}\\b`),
      `the projection must include ${col} — checkAppAccess reads it and `
      + 'treats a missing column as public');
  }
});
