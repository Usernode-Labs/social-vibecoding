'use strict';

// Admin › Journey's waiting cohort: the people who joined the waitlist and
// have not been let off it yet. Before it, the page and the connector could
// say who was admitted, who came in another way and who was invited and
// waits, but not who is still waiting, for how long, or where they came from.
//
// What these pin: one waiting person's first mile (stuck at the release, and
// a step they did not take is "not yet", never where they stopped); the query
// (only sign-ups nobody has let off, real people, the longest wait first, the
// count of everyone on every row); the cohorts reading's count and the first
// mile's rows and total; the routes taking `waiting` wherever they take a
// cohort; and the connector returning it, with addresses masked and the
// recorded source on each row.

process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const journey = require('../src/services/journey');
const demo = require('../src/services/journey-demo');
const tools = require('../src/services/mcp-tools');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const NOW = new Date('2026-11-12T12:00:00Z');

// A sign-up as FIRST_MILE_WAITING_SQL returns it.
function waitingRow(i, extra = {}) {
  return {
    signup_id: 700 + i,
    email: `waiting.person${i}@example.com`,
    submitted_at: new Date(Date.UTC(2026, 8, 1 + i, 9, 0, 0)),
    confirmed_at: null,
    source: 'form',
    discovery: 'x',
    answered_follow_up: false,
    referred: false,
    project_invite: false,
    user_id: null,
    username: null,
    account_at: null,
    total: 3,
    ...extra,
  };
}

test('a waiting person is stuck at the release, and a step they did not take is not where they stopped', () => {
  assert.deepEqual([...journey.WAITING_MILE_STEPS], ['wl_joined', 'wl_confirmed', 'wl_answered', 'wl_account', 'wl_released']);

  const bare = journey.waitingMilePerson(waitingRow(0), NOW);
  assert.deepEqual(bare.steps.map((s) => s.state), ['done', 'not_yet', 'not_yet', 'not_yet', 'stuck']);
  assert.equal(bare.stuckAt, 'wl_released');
  assert.equal(bare.stuckReason, 'Not let off the waitlist yet');
  assert.equal(bare.furthest, 'wl_joined');
  assert.equal(bare.door, 'waitlist');
  assert.equal(bare.hasAccount, false);
  assert.equal(bare.name, 'waiting.person0@example.com', 'no account: only the address is known');
  // 1 Sep 09:00 to 12 Nov 12:00.
  assert.equal(bare.daysSince, 72);
  assert.equal(bare.waitlist.waitedDays, 72, 'the wait so far');
  assert.equal(bare.waitlist.source, 'form');
  assert.equal(bare.waitlist.discovery, 'x');
  assert.equal(bare.steps[0].note, 'form', 'the join step says which form');

  // Answered the follow-up and made an account, never confirmed the address:
  // the unconfirmed step stays "not yet" although later ones are done.
  const far = journey.waitingMilePerson(waitingRow(1, {
    answered_follow_up: true, user_id: 42, username: 'ada', account_at: '2026-09-03T10:00:00Z',
  }), NOW);
  assert.deepEqual(far.steps.map((s) => s.state), ['done', 'not_yet', 'done', 'done', 'stuck']);
  assert.equal(far.furthest, 'wl_account');
  assert.equal(far.name, 'ada');
  assert.equal(far.userId, 42);
  assert.equal(far.waitlist.answeredFollowUp, true);

  // The counts: nobody "passes" a step they did not take, and everyone is
  // listed as stuck at the release.
  const counts = journey.firstMileCounts([bare, far]);
  assert.deepEqual(counts.map((c) => [c.key, c.passed, c.stuck.length]), [
    ['wl_joined', 2, 0], ['wl_confirmed', 0, 0], ['wl_answered', 1, 0], ['wl_account', 1, 0], ['wl_released', 0, 2],
  ]);
});

test('the waiting query reads only sign-ups nobody has let off, real people, the longest wait first', () => {
  const sql = journey.FIRST_MILE_WAITING_SQL;
  assert.match(sql, /FROM waitlist_signups w/);
  assert.match(sql, /WHERE w\.released_at IS NULL/, 'not let off yet');
  assert.match(sql, /COALESCE\(w\.source, ''\) <> 'test'/, 'a test sign-up stays out');
  assert.match(sql, /u\.has_platform_access IS NOT TRUE/, 'an account that got in another way is not waiting');
  assert.match(sql, /u\.is_admin IS NOT TRUE/, 'an account is held to the real-person rule');
  assert.match(sql, /'onhomeroom\.com'/, 'a team address stays out');
  assert.match(sql, /DISTINCT ON \(COALESCE\('u' \|\| w\.linked_user_id::text, 'w' \|\| w\.id::text\)\)/, 'one row per person');
  assert.match(sql, /\(COUNT\(\*\) OVER \(\)\)::int AS total/, 'every row carries the count of everyone');
  assert.match(sql, /ORDER BY wt\.submitted_at, wt\.signup_id\s+LIMIT \$1::int/, 'oldest first, capped by $1');
  // The four parameters every first-mile query takes.
  for (const p of ['$1', '$2', '$3', '$4']) assert.ok(sql.includes(p), `${p} is used`);
  assert.ok(!sql.includes('$5'));
});

// A pool that answers the waiting query and the came-from read, and records
// what it was asked.
function fakePool({ rows = [], cameFrom = [], leftOut = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('platform_settings')) return { rows: [{ value: JSON.stringify(leftOut) }] };
      if (sql === journey.FIRST_MILE_WAITING_SQL) return { rows: rows.slice(0, params[0]) };
      if (sql.includes('FROM waitlist_signups w') && sql.includes('utm_source')) return { rows: cameFrom };
      return { rows: [] };
    },
  };
}

test('the cohorts reading counts everyone waiting from one row', async () => {
  const pool = fakePool({ rows: [waitingRow(0, { total: 137 })] });
  const read = await journey.cohorts(pool, { now: NOW, leftOutIds: [9] });
  assert.deepEqual(read.waiting, { people: 137 });
  const q = pool.queries.find((x) => x.sql === journey.FIRST_MILE_WAITING_SQL);
  assert.equal(q.params[0], 1, 'one row is enough for the count');
  assert.equal(q.params[1], NOW);
  assert.deepEqual(q.params[3], [9], 'with the left-out ids');

  const none = await journey.cohorts(fakePool(), { now: NOW });
  assert.deepEqual(none.waiting, { people: 0 }, 'nobody waiting');
});

test('the first mile reads the waiting cohort, with each person\'s recorded source and the total', async () => {
  const rows = [waitingRow(0), waitingRow(1, { answered_follow_up: true }), waitingRow(2, { source: 'partner:acme' })];
  const pool = fakePool({
    rows,
    cameFrom: [{ id: 700, linked_user_id: null, referrer_host: 't.co', utm_source: 'x', utm_campaign: 'launch', ref: null, submitted_at: rows[0].submitted_at }],
  });
  const mile = await journey.firstMile(pool, { day: 'waiting', now: NOW });
  assert.equal(mile.cohort, 'waiting');
  assert.equal(mile.total, 3);
  assert.equal(mile.people.length, 3);
  assert.deepEqual(mile.people.map((p) => p.signupId), [700, 701, 702], 'in the order they joined');
  assert.equal(mile.people[0].cameFrom.waitlist.referrerHost, 't.co');
  assert.equal(mile.people[0].cameFrom.waitlist.utmSource, 'x');
  assert.equal(mile.people[1].cameFrom.waitlist, null, 'nothing recorded for the second');
  assert.deepEqual(mile.sources[0], { way: 'unknown', from: null, people: 2 });
  assert.equal(mile.people[0].onboard, null, 'no account, no first-run list');
  assert.equal(mile.mail.recorded, false, 'nobody waiting has been sent an admit mail');
  assert.match(mile.mail.reason, /still on the waitlist/);
  const q = pool.queries.find((x) => x.sql === journey.FIRST_MILE_WAITING_SQL);
  assert.equal(q.params[0], journey.WAITING_MAX);

  // More waiting than the rows returned: the total is the count, not the rows.
  const cut = await journey.firstMile(fakePool({ rows: [waitingRow(0, { total: 5000 })] }), { day: 'waiting', now: NOW });
  assert.equal(cut.total, 5000);
  assert.equal(cut.people.length, 1);
});

test('the routes take waiting wherever they take a cohort, and the demo has one', async (t) => {
  require('../src/db/pool').getPool = () => ({
    async query() { throw new Error('a demo answer must not read the database'); },
    async connect() { throw new Error('a demo answer must not read the database'); },
  });
  const express = require('express');
  const { adminRoutes } = require('../src/routes/admin');
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, username: 'lead', isAdmin: true }; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const res = await fetch(`${base}${p}`); return { status: res.status, body: await res.json() }; };

  const cohorts = await get('/api/admin/journey/cohorts?demo=1');
  assert.deepEqual(cohorts.body.waiting, { people: 3 });

  const mile = await get('/api/admin/journey/first-mile?admitted=waiting&demo=1');
  assert.equal(mile.status, 200);
  assert.equal(mile.body.cohort, 'waiting');
  assert.equal(mile.body.total, 3);
  assert.equal(mile.body.people.length, cohorts.body.waiting.people, 'the chip and the table agree');
  assert.deepEqual(mile.body.steps.map((s) => s.key), [...journey.WAITING_MILE_STEPS]);
  assert.ok(mile.body.people.every((p) => p.stuckAt === 'wl_released'));
  assert.ok(mile.body.people.every((p) => !p.name || /example\.test$|^[a-z_]+$/.test(p.name)), 'sample people only');
  const days = mile.body.people.map((p) => p.daysSince);
  assert.deepEqual(days, [...days].sort((a, b) => b - a), 'the longest wait first');

  // A reading narrowed to the cohort, and a cohort nobody has heard of.
  assert.equal((await get('/api/admin/journey/stages?cohort=waiting&demo=1')).status, 200);
  assert.equal((await get('/api/admin/journey/summary?cohort=waiting&demo=1')).status, 200);
  const bad = await get('/api/admin/journey/stages?cohort=queueing&demo=1');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /other_way, invited, or waiting/);
});

test('the demo\'s waiting people are built the way the real reading builds them', () => {
  const mile = demo.firstMile('waiting');
  assert.equal(mile.demo, true);
  for (const p of mile.people) {
    assert.deepEqual(Object.keys(p).sort(), Object.keys({ ...journey.waitingMilePerson(waitingRow(0), NOW), cameFrom: null, onboard: null }).sort());
  }
  assert.deepEqual(mile.sources.map((s) => s.people).reduce((a, b) => a + b, 0), mile.people.length);
});

// ── The connector ──────────────────────────────────────────────────────

const ADMIN = { id: 1, username: 'evan', isAdmin: true, canAdminWrite: true };
function register({ pool }) {
  const specs = new Map();
  const handlers = new Map();
  tools.registerTools({
    registerTool(name, spec, handler) { specs.set(name, spec); handlers.set(name, handler); },
  }, {
    accessToken: 'svmcp_test', scopes: [READ_SCOPE, WRITE_SCOPE], user: { ...ADMIN }, clientName: 'Claude Code', clientId: 'c1',
    origin: 'https://homeroom.example', baseUrl: 'http://platform.internal',
    pool, config: {}, tokenId: 1, grantId: null, delegation: null,
  });
  return { specs, handlers };
}
const parseOutput = (spec, out) => z.object(spec.outputSchema).parse(out.structuredContent);

test('get_journey_cohorts says how many are still waiting, and where to read them', async (t) => {
  t.mock.method(journey, 'cohorts', async () => ({
    cohorts: [{ day: '2026-10-30', admitted: 10, withAccount: 4 }], otherWay: { people: 1 }, invited: { people: 2 }, waiting: { people: 137 },
  }));
  const { specs, handlers } = register({ pool: fakePool() });
  const out = await handlers.get('get_journey_cohorts')({});
  const sc = parseOutput(specs.get('get_journey_cohorts'), out);
  assert.deepEqual(sc.waiting, { people: 137 });
  assert.match(sc.nextStep, /"waiting"/);
  assert.match(specs.get('get_journey_cohorts').description, /have not been let off it yet/);

  // A server answer from before the cohort existed reads as nobody waiting.
  t.mock.method(journey, 'cohorts', async () => ({ cohorts: [], otherWay: { people: 0 } }));
  const older = parseOutput(specs.get('get_journey_cohorts'), await handlers.get('get_journey_cohorts')({}));
  assert.deepEqual(older.waiting, { people: 0 });
  assert.match(older.nextStep, /"waiting"/);
});

test('get_journey_first_mile reads the waiting cohort: addresses masked, the source on each row', async () => {
  const rows = [waitingRow(0, { total: 5000 }), waitingRow(1, { total: 5000, user_id: 42, username: 'ada', account_at: '2026-09-03T10:00:00Z' })];
  const pool = fakePool({
    rows,
    cameFrom: [{ id: 700, linked_user_id: null, referrer_host: 'none', utm_source: null, utm_campaign: null, ref: 'friend', submitted_at: rows[0].submitted_at }],
  });
  const { specs, handlers } = register({ pool });
  const spec = specs.get('get_journey_first_mile');
  const out = await handlers.get('get_journey_first_mile')({ admitted: 'waiting' });
  const sc = parseOutput(spec, out);
  assert.equal(sc.cohort, 'waiting');
  assert.equal(sc.total, 2, 'the rows read');
  assert.equal(sc.waiting, 5000, 'and everyone waiting, since that is more');
  assert.deepEqual(sc.stepOrder, [...journey.WAITING_MILE_STEPS]);
  assert.equal(sc.people.length, 2);
  const text = out.content[0].text;
  assert.ok(!text.includes('waiting.person0@example.com'), 'no whole address leaves the platform');
  assert.match(text, /w…@example\.com/, 'masked to its first letter and domain');
  const first = sc.people[0];
  assert.equal(first.signupId, 700);
  assert.equal(first.hasAccount, false);
  assert.equal(first.stuckAt, 'wl_released');
  assert.equal(first.steps.wl_released, 'stuck');
  assert.equal(first.steps.wl_confirmed, 'not_yet');
  // The tool reads at the real time, so the wait is at least the fixed one.
  assert.ok(first.waitlist.waitedDays >= 72, `waited ${first.waitlist.waitedDays} days`);
  assert.equal(first.daysSince, first.waitlist.waitedDays);
  assert.deepEqual(first.cameFrom.waitlist, { referrerHost: 'none', utmSource: null, utmCampaign: null, ref: 'friend', at: '2026-09-01T09:00:00Z' });
  assert.equal(first.cameFrom.invite, null);
  assert.equal(sc.people[1].cameFrom, null, 'nothing recorded: no source at all');
  assert.equal(sc.people[1].userId, 42);
  assert.match(spec.description, /wl_joined, wl_confirmed/);
  assert.match(spec.inputSchema.admitted.description, /"waiting" for the people still on the waitlist/);

  // An empty waiting list still names the waiting steps.
  const empty = parseOutput(spec, await register({ pool: fakePool() }).handlers.get('get_journey_first_mile')({ admitted: 'waiting' }));
  assert.equal(empty.total, 0);
  assert.equal(empty.waiting, undefined);
  assert.deepEqual(empty.stepOrder, [...journey.WAITING_MILE_STEPS]);

  // And a cohort nobody has heard of is refused with the list.
  const bad = await handlers.get('get_journey_first_mile')({ admitted: 'queueing' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /other_way, invited, or waiting/);
});
