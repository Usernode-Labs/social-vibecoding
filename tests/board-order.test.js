// #613: drag-and-drop reorder of Dev-board cards, persisted server-side.
//
// Covers:
//   1. parseOrder — the pure body validator (type/ref shape, dedupe, length
//      cap, malformed rejection).
//   2. The GET/POST HTTP endpoints against a stateful in-memory mock pool
//      that re-implements the table's read + full-replace-write semantics:
//      POST validation (bad column, oversized array, unauthenticated → 401,
//      non-member → 404), the dense 0..N-1 rewrite, the WS fan-out, and the
//      GET round-trip of the per-column shape.
//   3. Source guards pinning the schema table, the WS wiring, and the server
//      mount so a refactor can't silently drop them.
//
// Run with: node --test tests/board-order.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// board-order.js destructures getPool at module-eval time, so the pool
// override MUST be installed before the route is first required. A late-bound
// holder lets test.before swap in the stateful mock pool. Same trick lets the
// WS fan-out be captured before the route grabs it.
const poolMod = require('../src/db/pool');
let mockPool = null;
poolMod.getPool = () => mockPool;
const wsMod = require('../src/services/ws');
const wsEvents = [];
wsMod.pushBoardOrderUpdate = (d) => wsEvents.push(d);
const appAccess = require('../src/services/app-access');

// ── 1. Pure validator ──────────────────────────────────────────────────
const { parseOrder, MAX_ORDER_LEN, boardOrderRoutes } = require('../src/routes/board-order');

test('parseOrder accepts a clean list and normalizes to {card_type, card_ref}', () => {
  const out = parseOrder([{ type: 'issue', ref: 3 }, { type: 'proposal', ref: 45 }]);
  assert.deepEqual(out, [
    { card_type: 'issue', card_ref: 3 },
    { card_type: 'proposal', card_ref: 45 },
  ]);
});

test('parseOrder dedupes by (type, ref), keeping first occurrence order', () => {
  const out = parseOrder([
    { type: 'issue', ref: 3 },
    { type: 'issue', ref: 3 },
    { type: 'gov', ref: 3 },
  ]);
  assert.deepEqual(out, [
    { card_type: 'issue', card_ref: 3 },
    { card_type: 'gov', card_ref: 3 },
  ]);
});

test('parseOrder rejects malformed entries and non-arrays', () => {
  assert.equal(parseOrder(null), null);
  assert.equal(parseOrder('nope'), null);
  assert.equal(parseOrder([{ type: 'widget', ref: 1 }]), null); // bad type
  assert.equal(parseOrder([{ type: 'issue', ref: 0 }]), null); // ref <= 0
  assert.equal(parseOrder([{ type: 'issue', ref: 'x' }]), null); // non-int ref
  assert.equal(parseOrder([42]), null); // not an object
});

test('parseOrder caps the array length', () => {
  const huge = Array.from({ length: MAX_ORDER_LEN + 1 }, (_, i) => ({ type: 'issue', ref: i + 1 }));
  assert.equal(parseOrder(huge), null);
});

// ── 2. Stateful mock pool + HTTP endpoints ──────────────────────────────
//
// Re-implements the SQL the route issues against an in-memory `store`, plus
// a connect()-backed transaction client (BEGIN/DELETE/INSERT/COMMIT).
function makeMockPool() {
  const store = []; // { app_id, column_key, card_type, card_ref, position }

  const run = (sql, params) => {
    if (/^SELECT column_key, card_type, card_ref/.test(sql.trim())) {
      const [appId] = params;
      const rows = store
        .filter((r) => r.app_id === appId)
        .sort((a, b) => (a.column_key < b.column_key ? -1 : a.column_key > b.column_key ? 1 : a.position - b.position))
        .map((r) => ({ column_key: r.column_key, card_type: r.card_type, card_ref: r.card_ref }));
      return { rows };
    }
    if (/^DELETE FROM dev_board_card_order/.test(sql.trim())) {
      const [appId, column] = params;
      for (let i = store.length - 1; i >= 0; i--) {
        if (store[i].app_id === appId && store[i].column_key === column) store.splice(i, 1);
      }
      return { rows: [] };
    }
    if (/^INSERT INTO dev_board_card_order/.test(sql.trim())) {
      const [appId, column, cardType, cardRef, position] = params;
      store.push({ app_id: appId, column_key: column, card_type: cardType, card_ref: cardRef, position });
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
  // 'nope' models a non-member / missing app (collab gate returns null).
  appAccess.getAppForUser = async (_pool, slug) =>
    (slug === 'nope' ? null : { id: 1, slug });

  const app = express();
  app.use(express.json());
  // Anonymous when the x-anon header is present, else a signed-in tester.
  app.use((req, _res, next) => {
    if (!req.headers['x-anon']) req.user = { id: 100, username: 'tester' };
    next();
  });
  app.use(boardOrderRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('GET returns the empty per-column shape before any order is saved', async () => {
  const r = await fetch(`${base}/api/apps/demo/board-order`).then((x) => x.json());
  assert.deepEqual(r, { issues: [], review: [] });
});

test('POST rejects an unknown column', async () => {
  const r = await fetch(`${base}/api/apps/demo/board-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column: 'done', order: [] }),
  });
  assert.equal(r.status, 400);
});

test('POST rejects a malformed / oversized order', async () => {
  const bad = await fetch(`${base}/api/apps/demo/board-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column: 'issues', order: [{ type: 'widget', ref: 1 }] }),
  });
  assert.equal(bad.status, 400);

  const huge = Array.from({ length: MAX_ORDER_LEN + 1 }, (_, i) => ({ type: 'issue', ref: i + 1 }));
  const big = await fetch(`${base}/api/apps/demo/board-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column: 'issues', order: huge }),
  });
  assert.equal(big.status, 400);
});

test('POST from an anonymous caller is 401', async () => {
  const r = await fetch(`${base}/api/apps/demo/board-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-anon': '1' },
    body: JSON.stringify({ column: 'issues', order: [] }),
  });
  assert.equal(r.status, 401);
});

test('POST to a non-member / missing app is 404', async () => {
  const r = await fetch(`${base}/api/apps/nope/board-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column: 'issues', order: [] }),
  });
  assert.equal(r.status, 404);
});

test('POST full-replace writes dense 0..N-1 positions, fans out WS, GET round-trips', async () => {
  wsEvents.length = 0;
  const order = [
    { type: 'issue', ref: 900002 },
    { type: 'issue', ref: 900001 },
    { type: 'issue', ref: 900003 },
  ];
  const post = await fetch(`${base}/api/apps/demo/board-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column: 'issues', order }),
  });
  assert.equal(post.status, 200);
  const posted = await post.json();
  assert.deepEqual(posted.issues, [
    { type: 'issue', ref: 900002 },
    { type: 'issue', ref: 900001 },
    { type: 'issue', ref: 900003 },
  ]);
  assert.deepEqual(posted.review, []);

  // Dense 0..N-1 positions in the store, in submitted order.
  const stored = mockPool.store
    .filter((r) => r.column_key === 'issues')
    .sort((a, b) => a.position - b.position);
  assert.deepEqual(stored.map((r) => r.position), [0, 1, 2]);
  assert.deepEqual(stored.map((r) => r.card_ref), [900002, 900001, 900003]);

  // WS fan-out fired once, scoped to the app + column.
  assert.equal(wsEvents.length, 1);
  assert.equal(wsEvents[0].appId, 1);
  assert.equal(wsEvents[0].column, 'issues');

  // A second POST REPLACES the column (no accumulation).
  await fetch(`${base}/api/apps/demo/board-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column: 'issues', order: [{ type: 'issue', ref: 900003 }] }),
  });
  const after = mockPool.store.filter((r) => r.column_key === 'issues');
  assert.equal(after.length, 1);
  assert.equal(after[0].card_ref, 900003);

  // The review column was untouched by the issues writes.
  const get = await fetch(`${base}/api/apps/demo/board-order`).then((x) => x.json());
  assert.deepEqual(get.review, []);
  assert.deepEqual(get.issues, [{ type: 'issue', ref: 900003 }]);
});

// ── 3. Source guards ────────────────────────────────────────────────────
test('schema defines the dev_board_card_order table (public, not staging:private)', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf-8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS dev_board_card_order/);
  assert.match(schema, /UNIQUE\(app_id, column_key, card_type, card_ref\)/);
  assert.doesNotMatch(schema, /COMMENT ON TABLE dev_board_card_order IS 'staging:private'/);
});

test('ws service exports pushBoardOrderUpdate; server + FE are wired', () => {
  const wsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ws.js'), 'utf-8');
  assert.match(wsSrc, /function pushBoardOrderUpdate/);
  assert.match(wsSrc, /type: 'board_order_update'/);

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  assert.match(serverSrc, /boardOrderRoutes\(config\)/);

  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf-8');
  assert.match(appJs, /case 'board_order_update':/);

  const fe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf-8');
  assert.match(fe, /_applyManualOrder/, 'FE has the overlay helper');
  assert.match(fe, /board-order/, 'FE fetches the order endpoint');
  assert.match(fe, /dev-drag-handle/, 'FE renders a drag handle');
});
