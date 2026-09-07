// Topochain v4 admin API — the waitlist list read
// (GET /api/v4/admin/waitlist).
//
// Same "fake Postgres" idiom as tests/topochain-admin-delegations.test.js:
// rows as plain arrays, one startsWith-dispatching `handleQuery`, and the
// FULL composer app (topochainAdminRoutes) rather than the submodule
// factory, so the router-wide adminReadGate and the composer registration
// are exercised on every request.
//
// What this file exists to hold (#1544). The admin screen was reworked to
// answer three questions it previously could not: who brought this row in,
// whether the "you're in" mail actually left, and which rows filled the
// survey in. Each of those is a SHAPE the route emits, and each is easy to
// drop in a later refactor of the query without any screen test noticing —
// the screen tests read the .tsx source, not the payload.
//
// Run with: node --test tests/topochain-admin-waitlist-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Same require.cache indirection as the other admin test files — install
// the wrapper BEFORE requiring the admin composer below.
const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const { SECTIONS } = require('../src/services/waitlist-signals');

// ─── Fixtures ───────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

// Five signups, one per thing the list has to say differently:
//   1  waiting, confirmed, brought two people in, a part-filled survey
//   2  waiting, never confirmed, was brought in by 1, no survey at all
//   3  admitted, brought in by 1, and its "you're in" mail was sent
//   4  admitted with NO delivery on file (the staging-clone shape, since
//      mail_deliveries is staging:private)
//   5  waiting, confirmed, the most thoroughly filled row on the page
let signupRows;
let userRows;
let mailRows;

function resetFixtures() {
  signupRows = [
    {
      id: 1,
      email: 'anchor@example.invalid',
      submitted_at: T(-30),
      released_at: null,
      confirmed_at: T(-29),
      linked_user_id: 11,
      invited_by: null,
      answers: {
        made_url: 'https://example.invalid/made',
        country: 'DE',
        discovery: { source: 'friend' },
        group: { name: 'Chess club' },
        loss: { had: 'yes' },
      },
    },
    {
      id: 2,
      email: 'brought-in@example.invalid',
      submitted_at: T(-20),
      released_at: null,
      confirmed_at: null,
      linked_user_id: null,
      invited_by: 1,
      answers: null,
    },
    {
      id: 3,
      email: 'admitted-mailed@example.invalid',
      submitted_at: T(-25),
      released_at: T(-2),
      confirmed_at: T(-24),
      linked_user_id: 12,
      invited_by: 1,
      answers: { made_url: 'https://example.invalid/other' },
    },
    {
      id: 4,
      email: 'admitted-silent@example.invalid',
      submitted_at: T(-26),
      released_at: T(-1),
      confirmed_at: T(-25),
      linked_user_id: null,
      invited_by: null,
      answers: null,
    },
    {
      id: 5,
      email: 'thorough@example.invalid',
      submitted_at: T(-5),
      released_at: null,
      confirmed_at: T(-5),
      linked_user_id: null,
      invited_by: null,
      answers: {
        _version: 2,
        made_url: 'https://example.invalid/thorough',
        country: 'UY',
        discovery: { source: 'podcast' },
        group: { name: 'Demo crew' },
        loss: { had: 'yes' },
        handles: { farcaster: 'someone' },
        followed_claim: true,
      },
    },
  ];
  userRows = [
    { id: 11, username: 'anchor-user', has_platform_access: false },
    { id: 12, username: 'admitted-user', has_platform_access: true },
  ];
  mailRows = [
    // Two deliveries for the same address: the LATEST is what the row
    // reports, so a retried send does not leave the screen showing the
    // failure it recovered from.
    { id: 70, recipient: 'admitted-mailed@example.invalid', kind: 'waitlist_released', status: 'failed', created_at: T(-3), error: 'temporary failure' },
    { id: 71, recipient: 'admitted-mailed@example.invalid', kind: 'waitlist_released', status: 'sent', created_at: T(-2), error: null },
    // A different kind for the silent row — the lateral must not pick it
    // up and report a confirmation mail as the admission mail.
    { id: 72, recipient: 'admitted-silent@example.invalid', kind: 'waitlist_confirm', status: 'sent', created_at: T(-25), error: null },
  ];
}

// ─── Mock pool ──────────────────────────────────────────────────────────

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// Sniffing the filters means isolating the OUTER WHERE. Two things get in
// the way: the SELECT list carries the invited_count subquery (whose own
// WHERE mentions `c.invited_by = w.id`, the very phrase the "brought
// someone in" filter is recognised by), and the lateral carries its own
// ORDER BY. So: everything after the lateral closes, up to the last
// ORDER BY.
function whereHalf(sql) {
  const lateral = sql.indexOf('m ON TRUE');
  const tail = lateral >= 0 ? sql.slice(lateral) : sql;
  const order = tail.lastIndexOf('ORDER BY');
  return order >= 0 ? tail.slice(0, order) : tail;
}

function answeredKeys(row) {
  const a = row.answers;
  return a && typeof a === 'object' && !Array.isArray(a) ? Object.keys(a).length : 0;
}

function filterRows(sql) {
  const w = whereHalf(sql);
  let rows = signupRows.slice();
  if (w.includes('w.released_at IS NULL')) rows = rows.filter((r) => r.released_at == null);
  if (w.includes('w.released_at IS NOT NULL')) rows = rows.filter((r) => r.released_at != null);
  if (w.includes('w.confirmed_at IS NOT NULL')) rows = rows.filter((r) => r.confirmed_at != null);
  if (w.includes('c.invited_by = w.id')) {
    rows = rows.filter((r) => signupRows.some((c) => c.invited_by === r.id));
  }
  return rows;
}

function sortRows(sql, rows) {
  const byAnswered = sql.includes('(w.confirmed_at IS NOT NULL) DESC');
  return rows.slice().sort((a, b) => {
    const released = Number(a.released_at != null) - Number(b.released_at != null);
    if (released) return released;
    if (byAnswered) {
      const conf = Number(b.confirmed_at != null) - Number(a.confirmed_at != null);
      if (conf) return conf;
      const keys = answeredKeys(b) - answeredKeys(a);
      if (keys) return keys;
    }
    return (a.submitted_at - b.submitted_at) || (a.id - b.id);
  });
}

function decorate(r) {
  const u = (r.linked_user_id != null && userRows.find((x) => x.id === r.linked_user_id)) || null;
  const parent = (r.invited_by != null && signupRows.find((x) => x.id === r.invited_by)) || null;
  const mail = mailRows
    .filter((m) => m.recipient === r.email && m.kind === 'waitlist_released')
    .sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id))[0] || null;
  return {
    ...r,
    invited_count: signupRows.filter((c) => c.invited_by === r.id).length,
    invited_by_email: parent ? parent.email : null,
    linked_username: u ? u.username : null,
    has_platform_access: u ? u.has_platform_access : null,
    invite_mail_status: mail ? mail.status : null,
    invite_mail_at: mail ? mail.created_at : null,
    invite_mail_error: mail ? mail.error : null,
  };
}

const seenSql = [];

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);
  seenSql.push(sql);

  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM waitlist_signups w')) {
    return { rows: [{ c: filterRows(sql).length }] };
  }

  if (sql.startsWith('SELECT w.id, w.email')) {
    const limit = params[0];
    const offset = params[1];
    const rows = sortRows(sql, filterRows(sql)).slice(offset, offset + limit).map(decorate);
    return { rows };
  }

  throw new Error(`Unhandled mock query: ${sql}`);
}

function makeMockPool() {
  return {
    query: async (sql, params) => handleQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => handleQuery(sql, params),
      release: () => {},
    }),
  };
}

// ─── App builder ────────────────────────────────────────────────────────

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'anon') { next(); return; }
    if (role === 'user') { req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false }; next(); return; }
    if (role === 'readonly') { req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false }; next(); return; }
    req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

function buildApp(role) {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(topochainAdminRoutes({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function get(path, role = 'admin') {
  const { server, base } = await listen(buildApp(role));
  try {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

test.beforeEach(() => {
  resetFixtures();
  seenSql.length = 0;
  currentMockPool = makeMockPool();
});

// ─── Auth + registration ────────────────────────────────────────────────

test('non-admin gets the SPEC 403 body; a view-only admin can read the queue', async () => {
  const denied = await get('/api/v4/admin/waitlist', 'user');
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { success: false, error: 'Unauthorized. Admin access required.' });

  const ro = await get('/api/v4/admin/waitlist', 'readonly');
  assert.equal(ro.status, 200);
  assert.equal(ro.body.success, true);
});

// ─── Default order ──────────────────────────────────────────────────────

test('the default order is FIFO with the admitted rows last', async () => {
  const { status, body } = await get('/api/v4/admin/waitlist');
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((r) => r.id), [1, 2, 5, 4, 3]);
  assert.deepEqual(body.meta, { page: 1, per_page: 200, total: 5, total_pages: 1 });
});

// ─── The invite graph, both directions ──────────────────────────────────

// `invited_count` said how many a row brought in; nothing said who brought
// the row ITSELF in, which is the question an admin following a referral
// chain actually has. The address travels with the id because this screen
// is keyed by email and a bare id is unreadable on it.
test('a row carries who brought it in, by id AND by address', async () => {
  const { body } = await get('/api/v4/admin/waitlist');
  const byId = new Map(body.data.map((r) => [r.id, r]));

  assert.equal(byId.get(2).invited_by, 1);
  assert.equal(byId.get(2).invited_by_email, 'anchor@example.invalid');
  assert.equal(byId.get(3).invited_by, 1);
  assert.equal(byId.get(3).invited_by_email, 'anchor@example.invalid');

  // The other direction is unchanged: the anchor brought two people in.
  assert.equal(byId.get(1).signals.invited, 2);
  assert.equal(byId.get(1).invited_by, null);
  assert.equal(byId.get(1).invited_by_email, null);
});

// ─── The admission mail ─────────────────────────────────────────────────

test('an admitted row reports its latest "you\'re in" delivery, and null when none was recorded', async () => {
  const { body } = await get('/api/v4/admin/waitlist');
  const byId = new Map(body.data.map((r) => [r.id, r]));

  // Latest wins: a retried send must not leave the screen reporting the
  // failure it already recovered from.
  assert.deepEqual(Object.keys(byId.get(3).invite_email).sort(),
    ['created_at', 'error', 'status']);
  assert.equal(byId.get(3).invite_email.status, 'sent');
  assert.equal(byId.get(3).invite_email.error, null);
  assert.match(byId.get(3).invite_email.created_at, /\+00:00$/); // iso() rendering

  // No delivery on file is null, not an empty object — every row in a
  // staging clone looks like this, since mail_deliveries is
  // staging:private. A confirmation mail to the same address is a
  // different kind and must not be reported as the admission mail.
  assert.equal(byId.get(4).invite_email, null);
  // A row that was never admitted has no admission mail either.
  assert.equal(byId.get(1).invite_email, null);
});

test('the delivery lookup is scoped to the waitlist_released kind', async () => {
  await get('/api/v4/admin/waitlist');
  const list = seenSql.find((s) => s.startsWith('SELECT w.id, w.email'));
  assert.match(list, /FROM mail_deliveries d/);
  assert.match(list, /d\.kind = 'waitlist_released'/);
  assert.match(list, /d\.recipient = w\.email/);
  // LEFT JOIN LATERAL, not an inner join: a row with no delivery must
  // still appear in the queue.
  assert.match(list, /LEFT JOIN LATERAL/);
});

// ─── ?sort=answered ─────────────────────────────────────────────────────

// An admin's manual lens over the same rows, deliberately NOT a ranking:
// it never promotes an admitted row above a waiting one, and it is opt-in.
test('?sort=answered reorders by how much was filled in, admitted rows still last', async () => {
  const { body } = await get('/api/v4/admin/waitlist?sort=answered');
  assert.deepEqual(body.data.map((r) => r.id), [5, 1, 2, 3, 4]);

  // The default is untouched by the presence of the parameter elsewhere.
  const plain = await get('/api/v4/admin/waitlist');
  assert.deepEqual(plain.body.data.map((r) => r.id), [1, 2, 5, 4, 3]);
});

test('an unknown sort falls back to the queue order rather than erroring', async () => {
  const { status, body } = await get('/api/v4/admin/waitlist?sort=nonsense');
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((r) => r.id), [1, 2, 5, 4, 3]);
});

// The count query answers "how many rows match", which the ORDER BY has no
// bearing on — adding a join to it would just cost a scan per page.
test('sorting changes the list query only, never the count', async () => {
  await get('/api/v4/admin/waitlist?sort=answered');
  const count = seenSql.find((s) => s.startsWith('SELECT COUNT(*)::int AS c'));
  assert.doesNotMatch(count, /ORDER BY/);
  assert.doesNotMatch(count, /JOIN/);
});

// ─── Filters still filter ───────────────────────────────────────────────

test('status and only still narrow the queue, and the total narrows with them', async () => {
  const pending = await get('/api/v4/admin/waitlist?status=pending');
  assert.deepEqual(pending.body.data.map((r) => r.id), [1, 2, 5]);
  assert.equal(pending.body.meta.total, 3);

  const released = await get('/api/v4/admin/waitlist?status=released');
  assert.deepEqual(released.body.data.map((r) => r.id), [4, 3]);
  assert.equal(released.body.meta.total, 2);

  const confirmed = await get('/api/v4/admin/waitlist?only=confirmed');
  assert.deepEqual(confirmed.body.data.map((r) => r.id), [1, 5, 4, 3]);

  // "Brought someone in" is an EXISTS over the children, so it selects the
  // parent and not the rows it referred.
  const invited = await get('/api/v4/admin/waitlist?only=invited');
  assert.deepEqual(invited.body.data.map((r) => r.id), [1]);
  assert.equal(invited.body.meta.total, 1);

  const both = await get('/api/v4/admin/waitlist?status=pending&only=confirmed');
  assert.deepEqual(both.body.data.map((r) => r.id), [1, 5]);
});

// ─── The signals block ──────────────────────────────────────────────────

// The screen renders "N of M answered". M used to be typed into the column
// and went stale when the survey grew a seventh section; it travels with
// the facts now, so the payload has to carry it.
test('every row carries the section total alongside the sections it answered', async () => {
  const { body } = await get('/api/v4/admin/waitlist');
  for (const row of body.data) {
    assert.equal(row.signals.sections_total, SECTIONS.length, `row ${row.id}`);
    assert.ok(row.signals.sections.length <= row.signals.sections_total);
  }
  const byId = new Map(body.data.map((r) => [r.id, r]));
  assert.deepEqual(byId.get(5).signals.sections.length, SECTIONS.length);
  assert.deepEqual(byId.get(2).signals.sections, []);
  // Still facts only: no score reached the wire.
  assert.deepEqual(Object.keys(byId.get(1).signals).sort(),
    ['confirmed', 'invited', 'sections', 'sections_total', 'verified']);
});

test('the survey answers are passed through, and a plain-email row reads null', async () => {
  const { body } = await get('/api/v4/admin/waitlist');
  const byId = new Map(body.data.map((r) => [r.id, r]));
  assert.equal(byId.get(1).answers.country, 'DE');
  assert.equal(byId.get(1).answers.discovery.source, 'friend');
  assert.equal(byId.get(2).answers, null);
});
