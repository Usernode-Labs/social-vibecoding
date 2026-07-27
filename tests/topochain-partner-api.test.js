// Topochain v4 partner API (plan Task 6; SPEC §4.3, lines 834-840/1320-1453).
//
// HTTP-level tests against a throwaway express app + a regex-dispatching
// mock pool that ALSO implements `.connect()` (client with `.query`/
// `.release`) for the PUT /delegations/:account transaction — same idiom
// as tests/topochain-public-api.test.js and tests/board-order.test.js's
// pool-injection style, extended for the transactional route.
//
// Run with: node --test tests/topochain-partner-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ─── Fixture data ─────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

const USERS = [
  { id: 1, email: 'alice@example.com', telegram: null, discord: null },
  { id: 2, email: null, telegram: 'bobtg', discord: null },
  { id: 3, email: null, telegram: null, discord: 'caroldiscord' },
  { id: 4, email: 'dave@example.com', telegram: null, discord: null },
];

const SEASON_EVENTS = [
  { id: 100, season_id: 10 },
  { id: 101, season_id: 20 },
];

// user 1: enrolled directly in event 100.
// user 2: enrolled season-wide (season_id 10, season_event_id NULL) — still
//   covers event 100 (judgment call #3).
// user 3: not enrolled anywhere.
// user 4: enrolled in event 101 only (wrong event for a 100-scoped call).
const USER_ENROLLMENTS = [
  { user_id: 1, season_event_id: 100, season_id: 10 },
  { user_id: 2, season_event_id: null, season_id: 10 },
  { user_id: 4, season_event_id: 101, season_id: 20 },
];

const CHALLENGE_TEMPLATES = [
  { id: 50, category: 'onchain_tx' },
];

const CHALLENGES = [
  { id: 500, season_event_id: 100, challenge_template_id: 50 },
  { id: 501, season_event_id: 101, challenge_template_id: 50 }, // belongs to a different event
];

const ONCHAIN_ACCOUNTS = [
  { address: 'ut1known000000000000000000000000000000000' },
  { address: 'ut1closed00000000000000000000000000000000' },
  { address: 'ut1open0000000000000000000000000000000000' },
];

// Mutable per-test state — reset in test.beforeEach.
let userActivities;
let delegationRows; // { id, account, started_at, ended_at }
let nextActivityId;
let nextDelegationId;
let lastUserActivityInsertSql; // raw SQL text of the last INSERT, to prove 'api' is a literal

function resetFixtures() {
  userActivities = [];
  nextActivityId = 1;
  nextDelegationId = 1;
  lastUserActivityInsertSql = null;
  delegationRows = [
    { id: nextDelegationId++, account: 'ut1open0000000000000000000000000000000000', started_at: T(-5), ended_at: null },
    { id: nextDelegationId++, account: 'ut1closed00000000000000000000000000000000', started_at: T(-20), ended_at: T(-10) },
  ];
}

// ─── Mock pool: SQL shape -> in-memory computation ──────────────────────

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// Shared dispatcher used by both `pool.query` and the transactional
// `client.query` (the mock doesn't model real transaction isolation —
// no test here exercises concurrent access, so a single shared in-memory
// store is sufficient, same simplification tests/topochain-public-api.test.js
// makes for its read-only mock).
function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);

  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
    return { rows: [] };
  }

  // POST /user-activities: season_events existence + season_id lookup.
  if (sql.startsWith('SELECT id, season_id FROM season_events WHERE id = $1')) {
    const event = SEASON_EVENTS.find((e) => e.id === params[0]);
    return { rows: event ? [event] : [] };
  }

  // POST /user-activities: identifier resolution — column name is
  // interpolated (from a validated allow-list, never raw input).
  const identifierMatch = /^SELECT id FROM users WHERE (email|telegram|discord) = \$1 LIMIT 1$/.exec(sql);
  if (identifierMatch) {
    const col = identifierMatch[1];
    const user = USERS.find((u) => u[col] === params[0]);
    return { rows: user ? [{ id: user.id }] : [] };
  }

  // POST /user-activities: enrollment check (event-scoped OR season-wide).
  if (sql.startsWith('SELECT id FROM user_enrollments WHERE user_id = $1')) {
    const [userId, seasonEventId, seasonId] = params;
    const row = USER_ENROLLMENTS.find((e) => e.user_id === userId
      && (e.season_event_id === seasonEventId || (e.season_event_id === null && e.season_id === seasonId)));
    return { rows: row ? [{ id: 1 }] : [] };
  }

  // POST /user-activities: challenge + template category lookup.
  if (sql.startsWith('SELECT c.id, c.season_event_id, ct.category FROM challenges c')) {
    const challenge = CHALLENGES.find((c) => c.id === params[0]);
    if (!challenge) return { rows: [] };
    const template = CHALLENGE_TEMPLATES.find((t) => t.id === challenge.challenge_template_id);
    return { rows: [{ id: challenge.id, season_event_id: challenge.season_event_id, category: template ? template.category : null }] };
  }

  // POST /user-activities: the insert itself.
  if (sql.startsWith('INSERT INTO user_activities')) {
    lastUserActivityInsertSql = sql;
    const [userId, seasonEventId, activityType, points, description, metadata, activityAt, challengeId] = params;
    const row = {
      id: nextActivityId++, user_id: userId, season_event_id: seasonEventId, activity_type: activityType,
      points: Number(points).toFixed(2), description, metadata, activity_at: activityAt, challenge_id: challengeId,
    };
    userActivities.push(row);
    return { rows: [row] };
  }

  // GET /delegations: total count of open periods.
  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM account_delegation_periods WHERE ended_at IS NULL')) {
    return { rows: [{ c: delegationRows.filter((d) => d.ended_at == null).length }] };
  }

  // GET /delegations: paginated page of open periods, oldest first.
  if (sql.startsWith('SELECT account, started_at FROM account_delegation_periods WHERE ended_at IS NULL')) {
    const [limit, offset] = params;
    const open = delegationRows.filter((d) => d.ended_at == null).slice().sort((a, b) => a.started_at - b.started_at || a.id - b.id);
    return { rows: open.slice(offset, offset + limit).map((d) => ({ account: d.account, started_at: d.started_at })) };
  }

  // GET /delegations/:account and PUT (pre-transaction): account existence.
  if (sql.startsWith('SELECT address FROM onchain_accounts WHERE address = $1')) {
    const acct = ONCHAIN_ACCOUNTS.find((a) => a.address === params[0]);
    return { rows: acct ? [{ address: acct.address }] : [] };
  }

  // GET /delegations/:account: current period row (any state).
  if (sql.startsWith('SELECT started_at, ended_at FROM account_delegation_periods WHERE account = $1')) {
    const row = delegationRows.find((d) => d.account === params[0]);
    return { rows: row ? [{ started_at: row.started_at, ended_at: row.ended_at }] : [] };
  }

  // PUT /delegations/:account: row lock.
  if (sql.startsWith('SELECT id, started_at, ended_at FROM account_delegation_periods WHERE account = $1 FOR UPDATE')) {
    const row = delegationRows.find((d) => d.account === params[0]);
    return { rows: row ? [{ id: row.id, started_at: row.started_at, ended_at: row.ended_at }] : [] };
  }

  // PUT /delegations/:account: reopen an existing row.
  if (sql.startsWith('UPDATE account_delegation_periods SET started_at = NOW(), ended_at = NULL')) {
    const row = delegationRows.find((d) => d.id === params[0]);
    row.started_at = new Date();
    row.ended_at = null;
    return { rows: [{ started_at: row.started_at }] };
  }

  // PUT /delegations/:account: insert a brand-new row (first-ever delegation).
  if (sql.startsWith('INSERT INTO account_delegation_periods')) {
    const startedAt = new Date();
    delegationRows.push({ id: nextDelegationId++, account: params[0], started_at: startedAt, ended_at: null });
    return { rows: [{ started_at: startedAt }] };
  }

  // PUT /delegations/:account: close an open row.
  if (sql.startsWith('UPDATE account_delegation_periods SET ended_at = NOW()')) {
    const row = delegationRows.find((d) => d.id === params[0]);
    row.ended_at = new Date();
    return { rows: [] };
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

// ─── Test app wiring (require.cache pool swap, mirrors topochain-public-api.test.js) ─

const API_KEY = 'test-partner-secret';

function withMockPool(config, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const partnerModulePath = require.resolve('../src/routes/topochain/partner');
  const authModulePath = require.resolve('../src/middleware/topochain-auth');
  const mockPool = makeMockPool();
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  delete require.cache[partnerModulePath];
  delete require.cache[authModulePath];
  try {
    const { topochainPartnerRoutes } = require('../src/routes/topochain/partner');
    const app = express();
    app.use(express.json());
    app.use(topochainPartnerRoutes(config));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[partnerModulePath];
    delete require.cache[authModulePath];
  }
}

let server;
let base;

function startServer(config) {
  return new Promise((resolve) => {
    // Synchronous callback deliberately not awaited (mirrors
    // topochain-public-api.test.js's test.before note on this pattern).
    withMockPool(config, (app) => {
      server = app.listen(0);
      server.once('listening', () => resolve());
    });
  });
}

test.before(async () => {
  await startServer({ databaseUrl: 'postgres://fake/fake', topochainPartnerApiKey: API_KEY });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => resetFixtures());

test.after(() => server && server.close());

async function get(path, opts) {
  return fetch(`${base}${path}`, { ...opts, headers: { 'x-api-key': API_KEY, ...(opts && opts.headers) } });
}
async function postJson(path, body, opts) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...(opts && opts.headers) },
    body: JSON.stringify(body),
  });
}
async function putJson(path, body, opts) {
  return fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...(opts && opts.headers) },
    body: JSON.stringify(body),
  });
}

// ─── __ping (kept from Task 3) ──────────────────────────────────────────

test('__ping still responds 200 unauthenticated (not gated by partnerApiKey)', async () => {
  const res = await fetch(`${base}/api/v4/partner/__ping`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
});

// ─── Auth (401/500) — exercised once per verb group; every route applies partnerApiKey itself ─

test('POST /user-activities: missing X-API-Key -> 401', async () => {
  const res = await fetch(`${base}/api/v4/user-activities`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { success: false, error: 'Invalid or missing API key.' });
});

test('GET /delegations: wrong X-API-Key -> 401', async () => {
  const res = await fetch(`${base}/api/v4/delegations`, { headers: { 'x-api-key': 'nope' } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { success: false, error: 'Invalid or missing API key.' });
});

test('unconfigured server -> 500 before the key is even checked (own server instance)', async () => {
  await withMockPool({ databaseUrl: 'postgres://fake/fake', topochainPartnerApiKey: '' }, async (app) => {
    const s = app.listen(0);
    await new Promise((r) => s.once('listening', r));
    try {
      const b = `http://127.0.0.1:${s.address().port}`;
      const res = await fetch(`${b}/api/v4/delegations`, { headers: { 'x-api-key': 'anything' } });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { success: false, error: 'API key authentication not configured.' });
    } finally {
      s.close();
    }
  });
});

// ─── POST /user-activities ──────────────────────────────────────────────

function validActivityBody(overrides = {}) {
  return {
    participant_identifier: 'alice@example.com',
    identifier_type: 'email',
    season_event_id: 100,
    challenge_id: 500,
    activity_type: 'submitted_value_should_be_overwritten',
    points: '10.50',
    description: 'did a thing',
    metadata: { foo: 'bar' },
    activity_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

test('POST /user-activities: happy path — 201, activity_type overwritten by template category, points as number, source=api', async () => {
  const res = await postJson('/api/v4/user-activities', validActivityBody());
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.user_id, 1);
  assert.equal(body.data.season_event_id, 100);
  assert.equal(body.data.activity_type, 'onchain_tx'); // NOT the submitted value
  assert.equal(body.data.points, 10.5);
  assert.equal(typeof body.data.points, 'number');
  assert.equal(typeof body.data.id, 'number');
  assert.equal(userActivities.length, 1);
});

test("POST /user-activities: source is hard-set to the literal 'api' and challenge_id is stored", async () => {
  await postJson('/api/v4/user-activities', validActivityBody());
  assert.equal(userActivities.length, 1);
  assert.equal(userActivities[0].challenge_id, 500);
  assert.ok(lastUserActivityInsertSql.includes("'api'"));
});

test('POST /user-activities: season-wide enrollment (season_event_id NULL) counts as enrolled — also proves telegram resolution', async () => {
  const res = await postJson('/api/v4/user-activities', validActivityBody({
    participant_identifier: 'bobtg', identifier_type: 'telegram', challenge_id: 500,
  }));
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.data.user_id, 2);
});

test('POST /user-activities: resolves via discord column', async () => {
  // carol (user 3) isn't enrolled at all -> exercises identifier resolution
  // succeeding but enrollment failing (400), proving discord resolution works.
  const res = await postJson('/api/v4/user-activities', validActivityBody({
    participant_identifier: 'caroldiscord', identifier_type: 'discord', challenge_id: 500,
  }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { success: false, error: 'Participant is not registered for this event.' });
});

test('POST /user-activities: unknown identifier -> 404', async () => {
  const res = await postJson('/api/v4/user-activities', validActivityBody({ participant_identifier: 'nobody@example.com' }));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Participant not found with the given identifier.' });
});

test('POST /user-activities: not enrolled in this event -> 400', async () => {
  // dave (user 4) is enrolled only in event 101, request targets event 100.
  const res = await postJson('/api/v4/user-activities', validActivityBody({
    participant_identifier: 'dave@example.com', identifier_type: 'email',
  }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { success: false, error: 'Participant is not registered for this event.' });
});

test('POST /user-activities: challenge belongs to a different event -> 422 bare error (no details key)', async () => {
  const res = await postJson('/api/v4/user-activities', validActivityBody({ challenge_id: 501 }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.deepEqual(body, { success: false, error: 'Activity type is not available for the specified event.' });
  assert.ok(!('details' in body));
});

test('POST /user-activities: unknown challenge_id -> 422 same bare error', async () => {
  const res = await postJson('/api/v4/user-activities', validActivityBody({ challenge_id: 999999 }));
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { success: false, error: 'Activity type is not available for the specified event.' });
});

test('POST /user-activities: absent challenge_id -> 422 (v4 drops the id-1 fallback entirely)', async () => {
  const body = validActivityBody();
  delete body.challenge_id;
  const res = await postJson('/api/v4/user-activities', body);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { success: false, error: 'Activity type is not available for the specified event.' });
});

test('POST /user-activities: v1 deprecated offchain_activity_type_id alias is ignored, not honored', async () => {
  const body = validActivityBody();
  delete body.challenge_id;
  body.offchain_activity_type_id = 500; // must NOT be honored as a fallback in v4
  const res = await postJson('/api/v4/user-activities', body);
  assert.equal(res.status, 422);
});

test('POST /user-activities: missing required fields -> 422 with the standard details envelope', async () => {
  const res = await postJson('/api/v4/user-activities', {});
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error, 'The given data was invalid.');
  assert.ok(body.details.participant_identifier);
  assert.ok(body.details.identifier_type);
  assert.ok(body.details.season_event_id);
  assert.ok(body.details.activity_type);
  assert.ok(body.details.points);
  assert.ok(body.details.activity_at);
});

test('POST /user-activities: invalid identifier_type -> 422', async () => {
  const res = await postJson('/api/v4/user-activities', validActivityBody({ identifier_type: 'sms' }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.identifier_type);
});

test('POST /user-activities: unknown season_event_id -> 422 "selected...is invalid"', async () => {
  const res = await postJson('/api/v4/user-activities', validActivityBody({ season_event_id: 999999 }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.deepEqual(body.details, { season_event_id: ['The selected season_event_id is invalid.'] });
});

test('POST /user-activities: negative points accepted', async () => {
  const res = await postJson('/api/v4/user-activities', validActivityBody({ points: -5 }));
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.data.points, -5);
});

// ─── GET /delegations ────────────────────────────────────────────────────

test('GET /delegations: open periods only, oldest first, paginated meta envelope', async () => {
  const res = await get('/api/v4/delegations');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data.map((d) => d.account), ['ut1open0000000000000000000000000000000000']);
  assert.equal(body.count, 1);
  assert.deepEqual(body.meta, { page: 1, per_page: 25, total: 1, total_pages: 1 });
  assert.match(body.data[0].delegated_since, /\+00:00$/);
});

test('GET /delegations: per_page=0 -> 422 (guards the source per_page=0 division-by-zero 500)', async () => {
  const res = await get('/api/v4/delegations?per_page=0');
  assert.equal(res.status, 422);
});

// ─── GET /delegations/:account ──────────────────────────────────────────

test('GET /delegations/:account: currently open -> delegated true with delegated_since', async () => {
  const res = await get('/api/v4/delegations/ut1open0000000000000000000000000000000000');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.delegated, true);
  assert.match(body.data.delegated_since, /\+00:00$/);
});

test('GET /delegations/:account: closed period -> delegated false, delegated_since null', async () => {
  const res = await get('/api/v4/delegations/ut1closed00000000000000000000000000000000');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true,
    data: { account: 'ut1closed00000000000000000000000000000000', delegated: false, delegated_since: null },
  });
});

test('GET /delegations/:account: no delegation row at all -> delegated false', async () => {
  const res = await get('/api/v4/delegations/ut1known000000000000000000000000000000000');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.delegated, false);
  assert.equal(body.data.delegated_since, null);
});

test('GET /delegations/:account: unknown account -> 404 Unknown account address.', async () => {
  const res = await get('/api/v4/delegations/ut1doesnotexist00000000000000000000000000');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Unknown account address.' });
});

// ─── PUT /delegations/:account ───────────────────────────────────────────

test('PUT /delegations/:account: validation runs BEFORE the account lookup (bad body + unknown account -> 422 not 404)', async () => {
  const res = await putJson('/api/v4/delegations/ut1totallyunknown000000000000000000000000', { delegated: 'not-a-bool' });
  assert.equal(res.status, 422);
});

test('PUT /delegations/:account: missing delegated field -> 422', async () => {
  const res = await putJson('/api/v4/delegations/ut1known000000000000000000000000000000000', {});
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.delegated);
});

test('PUT /delegations/:account: unknown account with valid body -> 404', async () => {
  const res = await putJson('/api/v4/delegations/ut1totallyunknown000000000000000000000000', { delegated: true });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Unknown account address.' });
});

test('PUT /delegations/:account: turn on from nothing -> inserts a period, changed:true', async () => {
  const res = await putJson('/api/v4/delegations/ut1known000000000000000000000000000000000', { delegated: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.delegated, true);
  assert.equal(body.data.changed, true);
  assert.equal(body.message, 'Account marked as delegated.');
  assert.match(body.data.delegated_since, /\+00:00$/);

  // Re-fetch to prove it persisted.
  const get2 = await get('/api/v4/delegations/ut1known000000000000000000000000000000000');
  assert.equal((await get2.json()).data.delegated, true);
});

test('PUT /delegations/:account: idempotent re-assert true->true -> changed:false, unchanged message', async () => {
  const res = await putJson('/api/v4/delegations/ut1open0000000000000000000000000000000000', { delegated: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.changed, false);
  assert.equal(body.data.delegated, true);
  assert.equal(body.message, 'Delegation flag unchanged.');
});

test('PUT /delegations/:account: idempotent re-assert false->false (no row) -> changed:false, delegated:false', async () => {
  const res = await putJson('/api/v4/delegations/ut1known000000000000000000000000000000000', { delegated: false });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.changed, false);
  assert.equal(body.data.delegated, false);
  assert.equal(body.data.delegated_since, null);
  assert.equal(body.message, 'Delegation flag unchanged.');
});

test('PUT /delegations/:account: turn off an open period -> changed:true, closes it', async () => {
  const res = await putJson('/api/v4/delegations/ut1open0000000000000000000000000000000000', { delegated: false });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.delegated, false);
  assert.equal(body.data.changed, true);
  assert.equal(body.message, 'Account unmarked as delegated.');

  const get2 = await get('/api/v4/delegations/ut1open0000000000000000000000000000000000');
  assert.equal((await get2.json()).data.delegated, false);
});

test('PUT /delegations/:account: accepts "1"/"0" string booleans (Laravel boolean rule)', async () => {
  const res = await putJson('/api/v4/delegations/ut1known000000000000000000000000000000000', { delegated: '1' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.delegated, true);
});

test('PUT /delegations/:account: re-delegating after a close opens a fresh period on the same row', async () => {
  // ut1closed is currently ended — turn it back on, then verify GET reflects it.
  const res = await putJson('/api/v4/delegations/ut1closed00000000000000000000000000000000', { delegated: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.changed, true);
  assert.equal(body.data.delegated, true);

  const get2 = await get('/api/v4/delegations/ut1closed00000000000000000000000000000000');
  const getBody = await get2.json();
  assert.equal(getBody.data.delegated, true);
});
