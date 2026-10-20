'use strict';

// #5133: the admin Access review. Who may read it and record a review (full
// admins only), what the review says each role can do (held against the
// gates the routes actually apply), when the next review is due, and that a
// role set in the console is noted for the review.
//
// The routes run end to end against a mocked pool, like
// tests/view-only-admin.test.js; the SQL itself runs against PostgreSQL in
// tests/admin-access-review-postgres.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const poolMod = require('../src/db/pool');
let handler = async () => ({ rows: [] });
const queries = [];
const sharedPool = {
  query: async (sql, params) => { queries.push({ sql, params }); return handler(sql, params); },
  async connect() {
    return {
      query: async (sql, params) => { queries.push({ sql, params }); return handler(sql, params); },
      release() {},
    };
  },
};
poolMod.getPool = () => sharedPool;

const express = require('express');
const { adminRoutes } = require('../src/routes/admin');
const review = require('../src/services/admin-access-review');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NORMAL = { id: 9, username: 'norm', isAdmin: false, canAdminWrite: false, adminReadonly: false };
const VIEW_ADMIN = { id: 8, username: 'view', isAdmin: true, canAdminWrite: false, adminReadonly: true };
const FULL_ADMIN = { id: 1, username: 'full', isAdmin: true, canAdminWrite: true, adminReadonly: false };

let currentUser = FULL_ADMIN;

const ADMIN_ROWS = [
  { id: 1, username: 'full', is_admin: true, admin_readonly: false, created_at: '2026-01-01T00:00:00Z',
    role_set_at: '2026-02-01T00:00:00Z', role_set_by: 'root', last_sign_in_at: '2026-10-18T09:00:00Z',
    last_database_export_at: null },
  { id: 8, username: 'view', is_admin: true, admin_readonly: true, created_at: '2026-03-01T00:00:00Z',
    role_set_at: null, role_set_by: null, last_sign_in_at: null, last_database_export_at: null },
];

function defaultHandler(sql) {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
  if (/FROM users u\s+LEFT JOIN LATERAL/.test(sql)) return { rows: ADMIN_ROWS };
  if (/FROM admin_access_reviews r/.test(sql)) return { rows: [] };
  if (/INSERT INTO admin_access_reviews/.test(sql)) {
    return { rows: [{ id: 1, reviewed_at: new Date().toISOString(), full_admins: 1, view_only_admins: 1 }] };
  }
  if (/SELECT id, is_admin, admin_readonly, participation_restricted_at FROM users WHERE id = \$1/.test(sql)) {
    return { rows: [{ id: 2, is_admin: true, admin_readonly: false, participation_restricted_at: null }] };
  }
  if (/COUNT\(\*\)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE/.test(sql)) {
    return { rows: [{ n: 5 }] };
  }
  if (/UPDATE users SET is_admin = \$1, admin_readonly = \$2 WHERE id = \$3/.test(sql)) {
    return { rows: [{ id: 2, username: 'target', is_admin: true, admin_readonly: false }] };
  }
  return { rows: [] };
}

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  currentUser = FULL_ADMIN;
  handler = defaultHandler;
  queries.length = 0;
});

function call(method, p, body) {
  return fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

test('the access review is full admins only: a view-only admin and a member get 403 and no query runs', async () => {
  for (const user of [VIEW_ADMIN, NORMAL]) {
    currentUser = user;
    queries.length = 0;
    // A member is turned away by adminMiddleware first (a redirect away,
    // under the router's stripped path), a view-only admin by
    // requireAdminWrite; neither ever gets the 200.
    const want = user === VIEW_ADMIN ? 403 : 302;
    assert.equal((await call('GET', '/api/admin/access-review')).status, want, `${user.username} GET`);
    assert.equal((await call('POST', '/api/admin/access-review/reviews', {})).status, want, `${user.username} POST`);
    assert.deepEqual(queries.filter((q) => /admin_access_reviews|admin_role_changes/.test(q.sql)), [],
      `${user.username} reached no review query`);
  }
});

test('a full admin reads every admin with role and capabilities', async () => {
  const res = await call('GET', '/api/admin/access-review');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.reviewIntervalDays, 90);
  assert.deepEqual(body.counts, { full: 1, viewOnly: 1 });
  const [full, view] = body.admins;
  assert.equal(full.role, 'admin');
  assert.equal(full.roleSetBy, 'root');
  assert.equal(full.capabilities.databaseExport, true);
  assert.equal(view.role, 'view_admin');
  assert.equal(view.roleSetAt, null);
  assert.equal(view.capabilities.databaseExport, false);
  assert.equal(view.capabilities.personalDataExports, false);
  assert.equal(view.capabilities.changeThings, false);
  assert.equal(view.capabilities.sqlConsole, true);
  assert.equal(body.review.overdue, true, 'never reviewed is due now');
});

test('recording a review stores the reviewer and the note, and refuses a long note', async () => {
  let res = await call('POST', '/api/admin/access-review/reviews', { note: 'x'.repeat(review.NOTE_MAX + 1) });
  assert.equal(res.status, 400);
  assert.equal(queries.filter((q) => /INSERT INTO admin_access_reviews/.test(q.sql)).length, 0);

  res = await call('POST', '/api/admin/access-review/reviews', { note: '  removed old-ops  ' });
  assert.equal(res.status, 200);
  const insert = queries.find((q) => /INSERT INTO admin_access_reviews/.test(q.sql));
  assert.ok(insert, 'the review is written');
  assert.deepEqual(insert.params, [FULL_ADMIN.id, 'removed old-ops']);
  assert.ok(Array.isArray((await res.json()).admins), 'answers with the fresh report');
});

test('a role set in the console is noted for the review, on both the grant and the demotion path', async () => {
  let res = await call('POST', '/api/admin/users/2/is-admin', { role: 'admin' });
  assert.equal(res.status, 200);
  let noted = queries.filter((q) => /INSERT INTO admin_role_changes/.test(q.sql));
  assert.equal(noted.length, 1);
  assert.deepEqual(noted[0].params, [2, 'admin', FULL_ADMIN.id]);

  queries.length = 0;
  res = await call('POST', '/api/admin/users/2/is-admin', { role: 'view_admin' });
  assert.equal(res.status, 200);
  noted = queries.filter((q) => /INSERT INTO admin_role_changes/.test(q.sql));
  assert.equal(noted.length, 1);
  assert.deepEqual(noted[0].params, [2, 'view_admin', FULL_ADMIN.id]);
});

test('a failure to note the role change does not undo or fail the change itself', async () => {
  handler = (sql, params) => {
    if (/INSERT INTO admin_role_changes/.test(sql)) throw new Error('relation does not exist');
    return defaultHandler(sql, params);
  };
  const res = await call('POST', '/api/admin/users/2/is-admin', { role: 'admin' });
  assert.equal(res.status, 200);
});

test('a view-only admin still cannot set a role, so nothing is noted', async () => {
  currentUser = VIEW_ADMIN;
  const res = await call('POST', '/api/admin/users/2/is-admin', { role: 'admin' });
  assert.equal(res.status, 403);
  assert.equal(queries.filter((q) => /admin_role_changes|UPDATE users/.test(q.sql)).length, 0);
});

test('the next review is due 90 days after the latest, and overdue from then', () => {
  const latest = { reviewed_at: '2026-07-01T12:00:00.000Z', reviewer_username: 'full', note: null };
  const fresh = review.reviewStatus(latest, new Date('2026-09-01T00:00:00Z'));
  assert.equal(fresh.lastReviewedBy, 'full');
  assert.equal(fresh.nextDueAt, '2026-09-29T12:00:00.000Z');
  assert.equal(fresh.overdue, false);
  assert.equal(review.reviewStatus(latest, new Date('2026-09-29T12:00:00Z')).overdue, true);
  assert.deepEqual(review.reviewStatus(null), {
    lastReviewedAt: null, lastReviewedBy: null, note: null, nextDueAt: null, overdue: true,
  });
});

test('roles and capabilities: only a full admin changes things or takes an export', () => {
  assert.equal(review.roleOf({ is_admin: false, admin_readonly: false }), 'user');
  assert.equal(review.roleOf({ is_admin: true, admin_readonly: true }), 'view_admin');
  assert.equal(review.roleOf({ is_admin: true, admin_readonly: false }), 'admin');
  const user = review.capabilitiesFor('user');
  assert.ok(Object.values(user).every((v) => v === false), 'a member has none');
  const view = review.capabilitiesFor('view_admin');
  assert.deepEqual(
    Object.keys(view).filter((k) => view[k]).sort(),
    ['readConsole', 'sqlConsole'],
  );
  const full = review.capabilitiesFor('admin');
  assert.ok(Object.values(full).every((v) => v === true));
});

test('what the review says matches the gates: exports are requireAdminWrite, the SQL console is not', () => {
  // If one of these gates moves, the capability above is wrong, and so is
  // what the review tells the person signing it off.
  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.post\('\/api\/admin\/db-export\/ticket',\s*noteDbExportPreDenials, requireAdminWrite/);
  assert.match(admin, /router\.get\('\/api\/admin\/db-export', requireAdminWrite/);
  assert.match(admin, /router\.get\('\/api\/admin\/homeroom-bot\/export\.csv', requireAdminWrite/);
  assert.match(admin, /router\.get\('\/api\/admin\/shots\/export\.csv', requireAdminWrite/);
  assert.match(admin, /router\.get\('\/api\/admin\/access-review', requireAdminWrite/);
  assert.match(admin, /router\.post\('\/api\/admin\/access-review\/reviews', requireAdminWrite/);
  assert.match(read('src/routes/homeroom-bench.js'),
    /router\.get\('\/api\/admin\/homeroom-bot\/bench\/runs\/:id\/trials\.csv', requireAdminWrite/);
  assert.match(read('src/routes/topochain/admin/users.js'),
    /router\.get\('\/api\/v4\/admin\/users\/export-csv\/:seasonEventId', adminWriteGate/);
  assert.match(read('src/routes/topochain/admin/waitlist.js'),
    /router\.get\('\/api\/v4\/admin\/waitlist\/export-csv', adminWriteGate/);
  const dbTools = read('src/routes/topochain/admin/db-tools.js');
  assert.match(dbTools, /router\.get\('\/api\/v4\/admin\/database\/export', adminWriteGate/);
  assert.match(dbTools, /router\.post\('\/api\/v4\/admin\/sql-query\/execute', async/,
    'the SQL console stays open to every admin, as the review says');
});

test('the section is registered, full-admin only on screen, and drawn from the AdminUI registry', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  assert.match(consoleJs, /\{ key: 'access-review', label: 'Access review', group: 'People' \}/);
  assert.match(consoleJs, /'access-review': 'AdminAccessReview'/);
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-access-review\.tsx';/);
  const tsx = read('frontend/src/features/admin/admin-access-review.tsx');
  assert.match(tsx, /import \{ AdminUI \} from '\.\/admin-console\.js';/);
  assert.match(tsx, /render\(el: Element\) \{\s*host = el;\s*mountLegacyPortal\(el, <AccessReviewSection \/>\);/);
  assert.match(tsx, /destroy\(\) \{\s*unmountLegacyPortal\(host\);/);
  assert.match(tsx, /if \(!canWrite\) \{/, 'a view-only admin gets a sentence, not the list');
  assert.match(tsx, /useEffect\(\(\) => \{ if \(canWrite\) refresh\(\); \}/, 'and no request');
  assert.ok(!/<a\b/.test(tsx), 'nothing from the API is rendered as an anchor');
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/access-review' \}/);
  assert.match(audit, /'#admin\/access-review'/);
});

test('the review line reads the way the request asks', async () => {
  // The .tsx is not loadable from node:test; its two pure helpers are small
  // enough to pin by their source.
  const tsx = read('frontend/src/features/admin/admin-access-review.tsx');
  assert.match(tsx, /`Last reviewed \$\{fmtDate\(review\.lastReviewedAt\)\} by \$\{by\}`/);
  assert.match(tsx, /`Next review due \$\{fmtDate\(review\.nextDueAt\)\}`/);
  assert.match(tsx, /'Never reviewed'/);
});

test('the schema keeps both records and tags them staging:private', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS admin_role_changes \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS admin_access_reviews \(/);
  assert.match(schema, /COMMENT ON TABLE admin_role_changes IS 'staging:private';/);
  assert.match(schema, /COMMENT ON TABLE admin_access_reviews IS 'staging:private';/);
});
