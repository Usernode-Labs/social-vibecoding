// PM view drag-and-drop: per-person manual card order, persisted server-side.
//
// Covers:
//   1. parseOrder / normalizeAssigneeKey — the pure body validators (type/ref
//      shape, dedupe, length cap, malformed rejection; assignee trim +
//      case-fold + length gate).
//   2. The GET/POST HTTP endpoints against a stateful in-memory mock pool that
//      re-implements the table's read + full-per-person-replace semantics:
//      POST validation (bad assignee, oversized array, unauthenticated → 401,
//      non-member → 404), the dense 0..N-1 rewrite scoped to one person, the
//      WS fan-out, and the GET round-trip of the per-assignee-key shape.
//   3. Source guards pinning the schema table, the WS wiring, and the server
//      mount so a refactor can't silently drop them.
//
// Run with: node --test tests/dev-pm-order.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// pm-order.js destructures getPool at module-eval time, so the pool override
// MUST be installed before the route is first required. Same late-bound trick
// board-order.test.js uses, and the same for capturing the WS fan-out.
const poolMod = require('../src/db/pool');
let mockPool = null;
poolMod.getPool = () => mockPool;
const wsMod = require('../src/services/ws');
const wsEvents = [];
wsMod.pushBoardOrderUpdate = (d) => wsEvents.push(d);
const appAccess = require('../src/services/app-access');

// ── 1. Pure validators ──────────────────────────────────────────────────
const {
  parseOrder, normalizeAssigneeKey, stagingMockPmOrder, MAX_ORDER_LEN, pmOrderRoutes,
} = require('../src/routes/pm-order');

test('parseOrder accepts a clean list and normalizes to {card_type, card_ref}', () => {
  const out = parseOrder([{ type: 'issue', ref: 3 }, { type: 'proposal', ref: 45 }]);
  assert.deepEqual(out, [
    { card_type: 'issue', card_ref: 3 },
    { card_type: 'proposal', card_ref: 45 },
  ]);
});

test('parseOrder rejects gov cards (PM sections never hold them)', () => {
  assert.equal(parseOrder([{ type: 'gov', ref: 3 }]), null);
});

test('parseOrder dedupes by (type, ref), keeping first occurrence order', () => {
  const out = parseOrder([
    { type: 'issue', ref: 3 },
    { type: 'issue', ref: 3 },
    { type: 'proposal', ref: 3 },
  ]);
  assert.deepEqual(out, [
    { card_type: 'issue', card_ref: 3 },
    { card_type: 'proposal', card_ref: 3 },
  ]);
});

test('parseOrder rejects malformed entries and non-arrays', () => {
  assert.equal(parseOrder(null), null);
  assert.equal(parseOrder('nope'), null);
  assert.equal(parseOrder([{ type: 'widget', ref: 1 }]), null);
  assert.equal(parseOrder([{ type: 'issue', ref: 0 }]), null);
  assert.equal(parseOrder([{ type: 'issue', ref: 'x' }]), null);
  assert.equal(parseOrder([42]), null);
});

test('parseOrder caps the array length', () => {
  const huge = Array.from({ length: MAX_ORDER_LEN + 1 }, (_, i) => ({ type: 'issue', ref: i + 1 }));
  assert.equal(parseOrder(huge), null);
});

test('normalizeAssigneeKey trims + case-folds, matching the assignee group key', () => {
  assert.equal(normalizeAssigneeKey('  Evan '), 'evan');
  assert.equal(normalizeAssigneeKey('MAYA-BUILDER'), 'maya-builder');
  assert.equal(normalizeAssigneeKey(''), null);
  assert.equal(normalizeAssigneeKey('   '), null);
  assert.equal(normalizeAssigneeKey('x'.repeat(65)), null); // over the 64 cap
  assert.equal(normalizeAssigneeKey(42), null);
});

test('stagingMockPmOrder ranks one card under staging-demo-user, leaves one out', () => {
  const m = stagingMockPmOrder();
  assert.deepEqual(Object.keys(m), ['staging-demo-user']);
  // Only the proposal is ranked; the issue is intentionally unranked (#617).
  assert.deepEqual(m['staging-demo-user'], [{ type: 'proposal', ref: 9000013 }]);
});

// ── 2. Stateful mock pool + HTTP endpoints ──────────────────────────────
function makeMockPool() {
  const store = []; // { app_id, assignee_key, card_type, card_ref, position }

  const run = (sql, params) => {
    if (/^SELECT assignee_key, card_type, card_ref/.test(sql.trim())) {
      const [appId] = params;
      const rows = store
        .filter((r) => r.app_id === appId)
        .sort((a, b) => (a.assignee_key < b.assignee_key ? -1 : a.assignee_key > b.assignee_key ? 1 : a.position - b.position))
        .map((r) => ({ assignee_key: r.assignee_key, card_type: r.card_type, card_ref: r.card_ref }));
      return { rows };
    }
    if (/^DELETE FROM dev_pm_card_order/.test(sql.trim())) {
      const [appId, key] = params;
      for (let i = store.length - 1; i >= 0; i--) {
        if (store[i].app_id === appId && store[i].assignee_key === key) store.splice(i, 1);
      }
      return { rows: [] };
    }
    if (/^INSERT INTO dev_pm_card_order/.test(sql.trim())) {
      const [appId, key, cardType, cardRef, position] = params;
      store.push({ app_id: appId, assignee_key: key, card_type: cardType, card_ref: cardRef, position });
      return { rows: [] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [] };
    throw new Error(`unexpected SQL in mock: ${sql.slice(0, 60)}`);
  };

  return {
    store,
    async query(sql, params) { return run(sql, params); },
    async connect() {
      return {
        async query(sql, params) { return run(sql, params); },
        release() {},
      };
    },
  };
}

const express = require('express');

let server;
let base;

test.before(async () => {
  mockPool = makeMockPool();
  appAccess.getAppForUser = async (_pool, slug) =>
    (slug === 'nope' ? null : { id: 1, slug });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!req.headers['x-anon']) req.user = { id: 100, username: 'tester' };
    next();
  });
  app.use(pmOrderRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('GET returns an empty map before any order is saved', async () => {
  const r = await fetch(`${base}/api/apps/demo/pm-order`).then((x) => x.json());
  assert.deepEqual(r, {});
});

test('POST rejects an empty / over-long assignee', async () => {
  const empty = await fetch(`${base}/api/apps/demo/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: '   ', order: [] }),
  });
  assert.equal(empty.status, 400);

  const long = await fetch(`${base}/api/apps/demo/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: 'x'.repeat(65), order: [] }),
  });
  assert.equal(long.status, 400);
});

test('POST rejects a malformed / oversized order', async () => {
  const bad = await fetch(`${base}/api/apps/demo/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: 'alice', order: [{ type: 'gov', ref: 1 }] }),
  });
  assert.equal(bad.status, 400);

  const huge = Array.from({ length: MAX_ORDER_LEN + 1 }, (_, i) => ({ type: 'issue', ref: i + 1 }));
  const big = await fetch(`${base}/api/apps/demo/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: 'alice', order: huge }),
  });
  assert.equal(big.status, 400);
});

test('POST from an anonymous caller is 401', async () => {
  const r = await fetch(`${base}/api/apps/demo/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-anon': '1' },
    body: JSON.stringify({ assignee: 'alice', order: [] }),
  });
  assert.equal(r.status, 401);
});

test('POST to a non-member / missing app is 404', async () => {
  const r = await fetch(`${base}/api/apps/nope/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: 'alice', order: [] }),
  });
  assert.equal(r.status, 404);
});

test('POST full-replace writes dense 0..N-1 per person, fans out WS, GET round-trips', async () => {
  wsEvents.length = 0;
  const order = [
    { type: 'proposal', ref: 9000013 },
    { type: 'issue', ref: 900003 },
  ];
  // Casing is folded to the storage key.
  const post = await fetch(`${base}/api/apps/demo/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: 'Staging-Demo-User', order }),
  });
  assert.equal(post.status, 200);
  const posted = await post.json();
  assert.deepEqual(posted, {
    'staging-demo-user': [
      { type: 'proposal', ref: 9000013 },
      { type: 'issue', ref: 900003 },
    ],
  });

  // Dense 0..N-1 positions in the store, in submitted order.
  const stored = mockPool.store
    .filter((r) => r.assignee_key === 'staging-demo-user')
    .sort((a, b) => a.position - b.position);
  assert.deepEqual(stored.map((r) => r.position), [0, 1]);
  assert.deepEqual(stored.map((r) => r.card_ref), [9000013, 900003]);

  // WS fan-out fired once, scoped to the app and flagged as a PM write.
  assert.equal(wsEvents.length, 1);
  assert.equal(wsEvents[0].appId, 1);
  assert.equal(wsEvents[0].pm, true);
});

test('a POST for one person leaves another person\'s order untouched', async () => {
  await fetch(`${base}/api/apps/demo/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: 'maya-builder', order: [{ type: 'issue', ref: 900006 }] }),
  });
  // Re-POST staging-demo-user with a shorter order (full replace, no accrual).
  await fetch(`${base}/api/apps/demo/pm-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: 'staging-demo-user', order: [{ type: 'issue', ref: 900003 }] }),
  });

  const get = await fetch(`${base}/api/apps/demo/pm-order`).then((x) => x.json());
  assert.deepEqual(get['staging-demo-user'], [{ type: 'issue', ref: 900003 }]);
  assert.deepEqual(get['maya-builder'], [{ type: 'issue', ref: 900006 }]);
});

// ── 3. Source guards ────────────────────────────────────────────────────
test('schema defines the dev_pm_card_order table (public, not staging:private)', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf-8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS dev_pm_card_order/);
  assert.match(schema, /UNIQUE\(app_id, assignee_key, card_type, card_ref\)/);
  assert.doesNotMatch(schema, /COMMENT ON TABLE dev_pm_card_order IS 'staging:private'/);
});

test('server mounts the pm-order route + FE wiring is present', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  assert.match(serverSrc, /pmOrderRoutes\(config\)/);

  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  assert.match(fe, /pm-order/, 'FE fetches + posts the PM order endpoint');
  assert.match(fe, /_commitPmOrder/, 'FE has the PM order commit path');
  assert.match(fe, /_initPmDrag/, 'FE initialises PM drag');
  assert.match(fe, /data-pm-assignee/, 'FE renders per-person drop lists');
});
