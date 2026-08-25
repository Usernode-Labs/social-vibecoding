// Tests for the widened GET /api/sessions/:id/spec read path (shared
// spec versions were invisible to everyone but the session owner — the
// dev-session spec panel rendered "No spec yet" for a spec that WAS
// shared to the group).
//
// Three layers:
//   1. Route behaviour — owner sees spec_md + ALL versions; a non-owner
//      (admins included) sees only versions matching the shared-
//      visibility predicate (group share, #86 user share, conversation
//      share), with `spec` set to the newest VISIBLE version's content,
//      never spec_md; zero visible versions keeps today's 404.
//   2. The staging ?demo=1 mock list (#1012 convention) when no real
//      data matched.
//   3. Coarse source-token guards (same style as
//      tests/spec-copy-markdown.test.js) pinning that both spec read
//      routes share ONE visibility SQL fragment and that the viewer's view
//      MODEL gates its owner-only affordances on _ownsSession. #1078 moved
//      the panel's markup into features/dev-chat/spec-viewer.tsx; the
//      gating stayed a decision in dev-chat.js, which is what this pins.
//
// Like tests/spec-user-share.test.js, the pool is an in-memory mock that
// pattern-matches SQL and the ws module is stubbed via require.cache.
// No real Postgres / sockets.
//
// Run with: node --test tests/spec-viewer-access.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

// ── require.cache stubbing ──────────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

function loadSessions(mockPool) {
  const poolPath = require.resolve('../src/db/pool');
  const wsPath = require.resolve('../src/services/ws');
  const sessionsPath = require.resolve('../src/routes/sessions');

  const origPool = stubModule(poolPath, { getPool: () => mockPool });
  const origWs = stubModule(wsPath, {
    pushNotificationToUser: () => 1,
    broadcastGlobal: () => {},
    broadcast: () => {},
  });
  delete require.cache[sessionsPath];

  const subject = require('../src/routes/sessions');

  const restore = () => {
    if (origPool) require.cache[poolPath] = origPool; else delete require.cache[poolPath];
    if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
    delete require.cache[sessionsPath];
  };
  return { subject, restore };
}

// ── In-memory mock pool ─────────────────────────────────────────────────
// Holds the tables GET /spec touches and answers its three SQL shapes.
function makeMockPool(initial = {}) {
  const state = {
    // Map<id, { id, user_id, spec_md }>
    sessions: new Map(initial.sessions || []),
    // [{ session_id, version, content, shared_to_group_at }]
    specs: (initial.specs || []).slice(),
    // [{ session_id, version, recipient_id }]  (#86 user shares)
    userShares: (initial.userShares || []).slice(),
    // [{ session_id, version, user_id }] — flattened "viewer is an active
    // member of a conversation this version was shared into"
    convShares: (initial.convShares || []).slice(),
  };
  const calls = [];

  const specMeta = (x) => ({
    version: x.version, built_at: null, commit_sha: null, pr_number: null,
    shared_to_group_at: x.shared_to_group_at || null,
    char_count: x.content.length,
  });

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // GET /spec: unscoped session lookup.
    if (/SELECT cs\.id, cs\.user_id, cs\.spec_md\s+FROM chat_sessions cs\s+WHERE cs\.id = \$1/i.test(s)) {
      const row = state.sessions.get(Number(params[0]));
      return { rows: row ? [{ id: row.id, user_id: row.user_id, spec_md: row.spec_md }] : [] };
    }
    // GET /spec, owner arm: unfiltered version list.
    if (/LENGTH\(content\) AS char_count\s+FROM chat_session_specs\s+WHERE session_id = \$1\s+ORDER BY version DESC/i.test(s)) {
      const rows = state.specs
        .filter((x) => x.session_id === Number(params[0]))
        .sort((a, b) => b.version - a.version)
        .map(specMeta);
      return { rows };
    }
    // GET /spec, non-owner arm: shared-visibility filter, content rides along.
    if (/LENGTH\(content\) AS char_count, content\s+FROM chat_session_specs s[\s\S]*chat_session_spec_user_shares us[\s\S]*chat_session_spec_conversation_shares scs/i.test(s)) {
      const sid = Number(params[0]);
      const viewer = Number(params[1]);
      const rows = state.specs
        .filter((x) => x.session_id === sid)
        .filter((x) => x.shared_to_group_at
          || state.userShares.some((u) => u.session_id === sid && u.version === x.version && u.recipient_id === viewer)
          || state.convShares.some((c) => c.session_id === sid && c.version === x.version && c.user_id === viewer))
        .sort((a, b) => b.version - a.version)
        .map((x) => ({ ...specMeta(x), content: x.content }));
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  }

  return { query, state, calls };
}

// Express harness with a per-request user shim.
async function startTestServer(loaded, user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(loaded.subject.sessionRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Session 10 (owner alice/1): v1 unshared draft, v2 group-shared, and a
// live spec_md that has moved AHEAD of the last shared version — the
// exact production shape from the bug report (session 3455).
// Session 11 (owner alice/1): v1 unshared, privately shared with carol/3.
function baseState() {
  return {
    sessions: [
      [10, { id: 10, user_id: 1, spec_md: '# Live draft, ahead of v2' }],
      [11, { id: 11, user_id: 1, spec_md: '# Session 11 draft' }],
    ],
    specs: [
      { session_id: 10, version: 1, content: '# Spec v1 (private)', shared_to_group_at: null },
      { session_id: 10, version: 2, content: '# Spec v2 (group-shared)', shared_to_group_at: '2026-08-19T14:35:45.301Z' },
      { session_id: 11, version: 1, content: '# Session 11 v1', shared_to_group_at: null },
    ],
    userShares: [
      { session_id: 11, version: 1, recipient_id: 3 },
    ],
    convShares: [],
  };
}

async function getSpec(loaded, user, url) {
  const srv = await startTestServer(loaded, user);
  try {
    const res = await fetch(`${srv.baseUrl}${url}`);
    const body = res.status === 200 ? await res.json() : await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await srv.close();
  }
}

// ── 1. Route behaviour ──────────────────────────────────────────────────

test('owner → spec_md + ALL versions, unshared drafts included', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  try {
    const { status, body } = await getSpec(loaded, { id: 1, username: 'alice' }, '/api/sessions/10/spec');
    assert.equal(status, 200);
    assert.equal(body.spec, '# Live draft, ahead of v2');
    assert.deepEqual(body.versions.map((v) => v.version), [2, 1]);
  } finally {
    loaded.restore();
  }
});

test('non-owner → shared versions only, spec = newest VISIBLE content, never spec_md', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  try {
    const { status, body } = await getSpec(loaded, { id: 2, username: 'bob' }, '/api/sessions/10/spec');
    assert.equal(status, 200);
    assert.deepEqual(body.versions.map((v) => v.version), [2]);
    assert.equal(body.spec, '# Spec v2 (group-shared)');
    assert.notEqual(body.spec, '# Live draft, ahead of v2');
    // Version rows are metadata only — the ride-along content is stripped.
    assert.ok(!('content' in body.versions[0]));
    assert.equal(body.versions[0].char_count, '# Spec v2 (group-shared)'.length);
  } finally {
    loaded.restore();
  }
});

test('#86 user-share recipient sees exactly the version shared with them', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  try {
    const { status, body } = await getSpec(loaded, { id: 3, username: 'carol' }, '/api/sessions/11/spec');
    assert.equal(status, 200);
    assert.deepEqual(body.versions.map((v) => v.version), [1]);
    assert.equal(body.spec, '# Session 11 v1');
  } finally {
    loaded.restore();
  }
});

test('conversation-share membership widens the list the same way', async () => {
  const st = baseState();
  st.convShares.push({ session_id: 10, version: 1, user_id: 4 });
  const pool = makeMockPool(st);
  const loaded = loadSessions(pool);
  try {
    const { status, body } = await getSpec(loaded, { id: 4, username: 'dave' }, '/api/sessions/10/spec');
    assert.equal(status, 200);
    // v1 via the conversation share, v2 via the group share.
    assert.deepEqual(body.versions.map((v) => v.version), [2, 1]);
    assert.equal(body.spec, '# Spec v2 (group-shared)');
  } finally {
    loaded.restore();
  }
});

test('unrelated user and non-owner ADMIN on a fully-unshared session → 404', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  try {
    // carol's user-share is on session 11; bob has nothing there.
    const stranger = await getSpec(loaded, { id: 2, username: 'bob' }, '/api/sessions/11/spec');
    assert.equal(stranger.status, 404);
    // Admins are ordinary viewers for spec privacy — sharing is the
    // explicit act that makes a spec visible.
    const admin = await getSpec(loaded, { id: 9, username: 'root', isAdmin: true }, '/api/sessions/11/spec');
    assert.equal(admin.status, 404);
  } finally {
    loaded.restore();
  }
});

test('non-owner admin sees shared-only, not the unshared draft versions', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  try {
    const { status, body } = await getSpec(loaded, { id: 9, username: 'root', isAdmin: true }, '/api/sessions/10/spec');
    assert.equal(status, 200);
    assert.deepEqual(body.versions.map((v) => v.version), [2]);
    assert.equal(body.spec, '# Spec v2 (group-shared)');
  } finally {
    loaded.restore();
  }
});

// ── 2. Staging ?demo=1 mock list ────────────────────────────────────────

test('staging + ?demo=1 → mock list only when no real data matched; prod stays 404', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  const origEnv = process.env.USERNODE_ENV;
  try {
    process.env.USERNODE_ENV = 'staging';
    const mock = await getSpec(loaded, { id: 2, username: 'bob' }, '/api/sessions/11/spec?demo=1');
    assert.equal(mock.status, 200);
    // Two shared versions with a gap where an unshared draft would sit —
    // the filtered, possibly non-contiguous dropdown shape.
    assert.deepEqual(mock.body.versions.map((v) => v.version), [3, 1]);
    assert.ok(mock.body.versions.every((v) => v.shared_to_group_at));
    assert.ok(mock.body.spec.startsWith('# [Mock]'));
    assert.equal(mock.body.versions[0].char_count, mock.body.spec.length);

    // Real data still wins over the mock on the same flags.
    const real = await getSpec(loaded, { id: 2, username: 'bob' }, '/api/sessions/10/spec?demo=1');
    assert.equal(real.status, 200);
    assert.equal(real.body.spec, '# Spec v2 (group-shared)');

    // Staging without the flag, and production with it, both keep the 404.
    const noFlag = await getSpec(loaded, { id: 2, username: 'bob' }, '/api/sessions/11/spec');
    assert.equal(noFlag.status, 404);
    process.env.USERNODE_ENV = 'production';
    const prod = await getSpec(loaded, { id: 2, username: 'bob' }, '/api/sessions/11/spec?demo=1');
    assert.equal(prod.status, 404);
  } finally {
    if (origEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = origEnv;
    loaded.restore();
  }
});

// ── 3. Source-token guards ──────────────────────────────────────────────
// public/js-style browser sources have no exports and the suite has no
// jsdom, so these pin stable tokens (same coarse style as
// tests/spec-copy-markdown.test.js).

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function slice(src, startToken, endToken, label) {
  const start = src.indexOf(startToken);
  assert.ok(start !== -1, `${label}: found ${startToken}`);
  const end = src.indexOf(endToken, start);
  assert.ok(end !== -1, `${label}: found ${endToken} after it`);
  return src.slice(start, end);
}

test('both spec read routes consume the ONE shared visibility fragment', () => {
  const src = read('src', 'routes', 'sessions.js');
  assert.ok(
    src.includes('function specVersionSharedVisibilitySql('),
    'the fragment helper exists'
  );
  // One interpolation per route: the version-list route (viewer is $2)
  // and the single-version route (viewer is $3). If either inlines its
  // own copy of the predicate again, this count drifts and the gates can
  // diverge — the exact bug class this refactor removes.
  const callSites = src.match(/\$\{specVersionSharedVisibilitySql\(/g) || [];
  assert.equal(callSites.length, 2, 'exactly two interpolation call sites');
  assert.ok(src.includes("specVersionSharedVisibilitySql('s', '$2')"), 'list route call site');
  assert.ok(src.includes("specVersionSharedVisibilitySql('s', '$3')"), 'single-version route call site');
});

test('_specViewerView gates the owner-only affordances on _ownsSession', () => {
  const src = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
  const render = slice(src, '_specViewerView() {', '_publishSpecViewer() {', '_specViewerView');
  assert.ok(render.includes('DevChat._ownsSession(DevChat.currentSession)'), 'ownership is computed');
  // `absent` is the model's word for "a non-owner never sees it" — both
  // share routes are owner-scoped server-side, so for anyone else the
  // buttons could only ever fail.
  assert.ok(/groupShare = !isOwner\s*\n?\s*\?\s*\{ kind: 'absent' \}/.test(render),
    'group-share button is owner-only');
  assert.ok(/userShare = !isOwner \? \{ kind: 'absent' \}/.test(render),
    'user-share button is owner-only');
  assert.ok(render.includes('isOwner && isLatest && !isEmpty'), 'build hint is owner-only');
  assert.ok(render.includes('No spec has been shared for this session yet.'), 'non-owner empty copy');
  assert.ok(render.includes('No spec yet. Ask the AI to draft one.'), 'owner empty copy kept');
  // And the component renders nothing at all for an `absent` action.
  const tsx = read('frontend', 'src', 'features', 'dev-chat', 'spec-viewer.tsx');
  assert.ok((tsx.match(/if \(action\.kind === 'absent'\) return null;/g) || []).length === 2,
    'both share buttons draw nothing for a non-owner');
});

test('_loadSpecViewer forwards ?demo=1 so staging previews reach the mock list', () => {
  const src = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
  const loader = slice(src, 'async _loadSpecViewer(', '_selectedSpecVersion() {', '_loadSpecViewer');
  assert.ok(loader.includes('/spec${DevChat._demoQS()}'), 'demo flag rides along on the spec fetch');
});

test('?shot=spec-viewer keeps the panel URL-reachable for the dapp.json check', () => {
  const src = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
  // The panel's open state otherwise lives only in localStorage; without
  // this deep link the declared check (and the before/after screenshots)
  // regress to a closed panel and assert nothing.
  assert.ok(src.includes("get('shot') === 'spec-viewer'"), 'shot param opens the spec panel at session load');
  const manifest = read('dapp.json');
  assert.ok(manifest.includes('shot=spec-viewer'), 'a declared check points at the deep link');
});
