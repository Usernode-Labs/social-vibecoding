'use strict';

// Admin › Journey's flows reading: who is in which project and whom they
// brought. A person's path could be read step by step, but not which KIND of
// project they ended up in (one of their own they shared, or a public one
// they found), nor what they did in each project apart, nor the invites they
// sent that nobody followed.
//
// What these pin: the audience rule is the screen's own; the assembly (one
// entry per person and project, invites with the people they reached, the
// projects somebody's row names); the queries' guards; the route and its demo
// payload; and the connector's page of people, short rows, names wrapped.
// The queries themselves run in tests/journey-flows-postgres.test.js.

process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const journey = require('../src/services/journey');
const demo = require('../src/services/journey-demo');
const communities = require('../src/services/communities');
const tools = require('../src/services/mcp-tools');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const NOW = new Date('2026-11-12T12:00:00Z');
const squash = (sql) => sql.replace(/\s+/g, ' ').trim();

const APPS = [
  { id: 1, slug: 'garden', name: 'Garden', created_at: '2026-09-01T10:00:00Z', platform: false, audience: 'invited', members: 2, maker_id: 11, maker: 'ana' },
  { id: 2, slug: 'atlas', name: 'Atlas', created_at: '2026-09-02T10:00:00Z', platform: false, audience: 'open', members: 5, maker_id: 12, maker: 'ben' },
  { id: 3, slug: 'unused', name: 'Unused', created_at: '2026-09-03T10:00:00Z', platform: false, audience: 'solo', members: 1, maker_id: 99, maker: 'ghost' },
  { id: 4, slug: 'homeroom', name: 'Homeroom', created_at: '2026-01-01T10:00:00Z', platform: true, audience: 'open', members: 40, maker_id: null, maker: null },
];
const row = (userId, username, appId, facts = {}) => ({
  user_id: userId, username, app_id: appId, days: 0, first_day: null, last_day: null,
  changes: 0, live: 0, votes: 0, requests: 0, feedback: 0, messages: 0, made: false, member: false, invited_by: null,
  total: 4, ...facts,
});
const ROWS = [
  row(11, 'ana', 1, { made: true, member: true, days: 6, first_day: '2026-09-01', last_day: '2026-09-20', changes: 2, live: 1 }),
  row(11, 'ana', 4, { member: true, messages: 3 }),
  row(12, 'ben', 1, { member: true, invited_by: 'ana', days: 2, first_day: '2026-09-06', last_day: '2026-09-07', votes: 1 }),
  row(12, 'ben', 2, { made: true, member: true }),
];
const SENT = [
  { user_id: 11, username: 'ana', app_id: 1, links: 2, shared: 1, direct: 1, opened: 3, first_at: '2026-09-05T10:00:00Z', opens_since: '2026-09-05T10:02:00Z' },
  // Somebody with no row of their own who still sent an invite.
  { user_id: 13, username: 'cy', app_id: 2, links: 1, shared: 0, direct: 0, opened: 0, first_at: '2026-09-08T10:00:00Z', opens_since: '2026-09-05T10:02:00Z' },
];
const REACHED = [
  { maker_id: 11, app_id: 1, user_id: 12, username: 'ben', status: 'joined', how: 'link', at: '2026-09-06T09:00:00Z' },
  { maker_id: 11, app_id: 1, user_id: 14, username: 'dee', status: 'invited', how: 'direct', at: '2026-09-07T10:00:00Z' },
  // An admin's invite reached somebody: it is on nobody's list of invites.
  { maker_id: 1, app_id: 2, user_id: 13, username: 'cy', status: 'queued', how: 'link', at: '2026-09-09T09:00:00Z' },
];

test('the audience is the screen\'s own rule, written out', () => {
  const members = '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = ap.community_id)';
  assert.equal(squash(journey.FLOWS_AUDIENCE_SQL), squash(communities.audienceSql('ap', members)),
    'services/communities.js audienceSql, so a project reads here as it reads on its own page');
  assert.ok(journey.FLOWS_APPS_SQL.includes(journey.FLOWS_AUDIENCE_SQL));
  assert.deepEqual([...journey.FLOWS_AUDIENCES], ['solo', 'invited', 'open']);
});

test('one entry per person and project, the invites they sent with the people reached, and only the projects named', () => {
  const read = journey.flowsReading({ apps: APPS, rows: ROWS, sent: SENT, reached: REACHED });

  assert.deepEqual(read.apps.map((a) => a.slug), ['garden', 'atlas', 'homeroom'], 'a project nobody\'s row names is left out');
  assert.deepEqual(read.apps[0], {
    slug: 'garden', name: 'Garden', audience: 'invited', platform: false,
    madeAt: '2026-09-01T10:00:00Z', madeBy: { userId: 11, name: 'ana' }, members: 2,
  });
  assert.equal(read.apps[2].madeBy, null);

  assert.deepEqual(read.people.map((p) => p.name), ['ana', 'ben', 'cy'], 'by name; an inviter with no row of their own is there too');
  const [ana, ben, cy] = read.people;
  assert.deepEqual(ana.apps.map((a) => a.slug), ['garden', 'homeroom']);
  assert.deepEqual(ana.apps[0], {
    slug: 'garden', made: true, member: true, invitedBy: null, days: 6, firstDay: '2026-09-01', lastDay: '2026-09-20',
    changes: 2, live: 1, votes: 0, requests: 0, feedback: 0, messages: 0,
  });
  assert.deepEqual(ana.invites, [{
    slug: 'garden', links: 2, shared: 1, direct: 1, opened: 3, firstAt: '2026-09-05T10:00:00Z',
    reached: [
      { userId: 12, name: 'ben', status: 'joined', how: 'link', at: '2026-09-06T09:00:00Z' },
      { userId: 14, name: 'dee', status: 'invited', how: 'direct', at: '2026-09-07T10:00:00Z' },
    ],
  }]);
  assert.equal(ben.apps[0].invitedBy, 'ana');
  assert.deepEqual(ben.invites, []);
  assert.deepEqual(cy.apps, []);
  assert.deepEqual(cy.invites[0].reached, [], 'an invite nobody followed is an entry with nobody reached');

  assert.deepEqual(read.counts, {
    people: 3, apps: 3, audiences: { solo: 0, invited: 1, open: 1 }, inviters: 2,
  }, 'Homeroom itself is not counted as a project of its audience');
  assert.equal(read.cut, null);
  assert.equal(read.opensSince, '2026-09-05T10:02:00Z');
  assert.deepEqual(read.notRecorded, {});

  // A row for a project the apps read did not return is dropped, not guessed.
  const stray = journey.flowsReading({ apps: APPS, rows: [row(11, 'ana', 77)], sent: [], reached: [] });
  assert.deepEqual(stray.people, []);
  // The cap says so, and with no open recorded anywhere `opened` is not a zero to trust.
  const capped = journey.flowsReading({ apps: APPS, rows: [row(11, 'ana', 1, { total: 9 })], sent: [], reached: [] });
  assert.deepEqual(capped.cut, { kept: 1, of: 9 });
  assert.equal(capped.notRecorded.opened.recorded, false);
  assert.equal(capped.opensSince, null);
  assert.deepEqual(journey.flowsReading().people, []);
});

test('the queries: real people only, up to now, a row cap that keeps the count', () => {
  for (const sql of [journey.FLOWS_PEOPLE_SQL, journey.FLOWS_SENT_SQL, journey.FLOWS_REACHED_SQL]) {
    assert.match(sql, /u\.is_admin IS NOT TRUE/, 'the real-person rule');
    assert.match(sql, /\$2::timestamptz/);
    assert.match(sql, /LIMIT \$1::int\s*$/);
  }
  assert.match(journey.FLOWS_PEOPLE_SQL, /\(COUNT\(\*\) OVER \(\)\)::int AS total/);
  assert.match(journey.FLOWS_PEOPLE_SQL, /aa\.seconds_spent >= 30/, 'a day of use is thirty seconds or more, as the stages count it');
  assert.match(journey.FLOWS_PEOPLE_SQL, /m\.source IN \('joined', 'collaborator'\)/,
    'membership the platform gives by itself is no row of its own');
  // A link into a private project writes a collaborator row too: it is the
  // link's, never a second invite by name.
  assert.match(journey.FLOWS_SENT_SQL, /c\.accepted_via IS DISTINCT FROM 'link'/);
  assert.match(journey.FLOWS_REACHED_SQL, /c\.accepted_via IS DISTINCT FROM 'link'/);
  assert.match(journey.FLOWS_SENT_SQL, /o\.user_id IS DISTINCT FROM r\.id/, 'their own open of their own link is not one');
  assert.match(journey.FLOWS_REACHED_SQL, /rd\.status <> 'cancelled'/);
});

// A pool that answers the four flows queries and records what it was asked.
function fakePool({ apps = APPS, rows = ROWS, sent = SENT, reached = REACHED, leftOut = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('platform_settings')) return { rows: [{ value: JSON.stringify(leftOut) }] };
      if (sql === journey.FLOWS_APPS_SQL) return { rows: apps };
      if (sql === journey.FLOWS_PEOPLE_SQL) return { rows };
      if (sql === journey.FLOWS_SENT_SQL) return { rows: sent };
      if (sql === journey.FLOWS_REACHED_SQL) return { rows: reached };
      return { rows: [] };
    },
  };
}

test('flows reads its four queries with now, the cap and the left-out ids', async () => {
  const pool = fakePool();
  const read = await journey.flows(pool, { now: NOW, leftOutIds: [9] });
  assert.equal(read.people.length, 3);
  assert.deepEqual(pool.queries.find((q) => q.sql === journey.FLOWS_APPS_SQL).params, [NOW]);
  for (const sql of [journey.FLOWS_PEOPLE_SQL, journey.FLOWS_SENT_SQL, journey.FLOWS_REACHED_SQL]) {
    const q = pool.queries.find((x) => x.sql === sql);
    assert.equal(q.params[0], journey.FLOWS_MAX);
    assert.equal(q.params[1], NOW);
    assert.deepEqual(q.params[3], [9]);
  }
});

test('the route answers with the reading, and its demo payload is built by the same assembly', async (t) => {
  const express = require('express');
  const pool = fakePool();
  require('../src/db/pool').getPool = () => pool;
  const { adminRoutes } = require('../src/routes/admin');
  const appX = express();
  appX.use((req, _res, next) => { req.user = { id: 1, username: 'lead', isAdmin: true }; next(); });
  appX.use(adminRoutes({ jwtSecret: 'test' }));
  const server = appX.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const real = await (await fetch(`${base}/api/admin/journey/flows`)).json();
  assert.deepEqual(real.people.map((p) => p.name), ['ana', 'ben', 'cy']);
  assert.equal(real.demo, undefined);

  const shown = await (await fetch(`${base}/api/admin/journey/flows?demo=1`)).json();
  assert.equal(shown.demo, true);
  assert.deepEqual(Object.keys(shown).filter((k) => k !== 'demo').sort(), Object.keys(real).sort(), 'the same keys as the real payload');
  assert.deepEqual(demo.flows().apps.map((a) => a.audience).sort(), ['invited', 'open', 'solo'], 'one project of each audience');
  assert.ok(demo.flows().people.some((p) => p.invites.some((i) => i.reached.length === 0)), 'and an invite nobody followed');
});

// ── The connector ──────────────────────────────────────────────────────

const ADMIN = { id: 1, username: 'lead', isAdmin: true, canAdminWrite: true };
function register({ pool, user = ADMIN }) {
  const specs = new Map();
  const handlers = new Map();
  tools.registerTools({
    registerTool(name, spec, handler) { specs.set(name, spec); handlers.set(name, handler); },
  }, {
    accessToken: 'svmcp_test', scopes: [READ_SCOPE, WRITE_SCOPE], user: { ...user }, clientName: 'Claude Code', clientId: 'c1',
    origin: 'https://homeroom.example', baseUrl: 'http://platform.internal',
    pool, config: {}, tokenId: 1, grantId: null, delegation: null,
  });
  return { specs, handlers };
}
const parseOutput = (spec, out) => z.object(spec.outputSchema).parse(out.structuredContent);
const wrapped = (text) => `<untrusted-content>${text}</untrusted-content>`;

test('get_journey_flows returns a page of people, short rows, names as data, and the projects the page names', async () => {
  const { specs, handlers } = register({ pool: fakePool() });
  const spec = specs.get('get_journey_flows');
  assert.ok(spec, 'registered for a full admin');
  assert.equal(spec.annotations.readOnlyHint, true);

  const sc = parseOutput(spec, await handlers.get('get_journey_flows')({}));
  assert.equal(sc.total, 3);
  assert.equal(sc.nextOffset, null);
  assert.deepEqual(sc.counts, { people: 3, apps: 3, audiences: { solo: 0, invited: 1, open: 1 }, inviters: 2 });
  assert.equal(sc.opensSince, '2026-09-05T10:02:00Z');
  assert.deepEqual(sc.apps.map((a) => a.slug), ['garden', 'homeroom', 'atlas'], 'in the order the page first names them');
  assert.deepEqual(sc.apps[0], {
    slug: 'garden', name: wrapped('Garden'), audience: 'invited', platform: false,
    madeAt: '2026-09-01T10:00:00Z', madeBy: { userId: 11, name: wrapped('ana') }, members: 2,
  });

  const [ana, ben, cy] = sc.people;
  assert.equal(ana.name, wrapped('ana'));
  assert.deepEqual(ana.apps[0], {
    slug: 'garden', made: true, member: true, days: 6, firstDay: '2026-09-01', lastDay: '2026-09-20', changes: 2, live: 1,
  }, 'a count of 0, a false flag and a fact nobody recorded are left out');
  assert.deepEqual(ana.apps[1], { slug: 'homeroom', member: true, messages: 3 });
  assert.deepEqual(ana.invites[0], {
    slug: 'garden', links: 2, shared: 1, direct: 1, opened: 3, firstAt: '2026-09-05T10:00:00Z',
    reached: [
      { userId: 12, name: wrapped('ben'), status: 'joined', how: 'link', at: '2026-09-06T09:00:00Z' },
      { userId: 14, name: wrapped('dee'), status: 'invited', how: 'direct', at: '2026-09-07T10:00:00Z' },
    ],
  });
  assert.equal(ben.apps[0].invitedBy, wrapped('ana'), 'who invited them is a name, so data');
  assert.deepEqual(cy.invites[0], { slug: 'atlas', links: 1, firstAt: '2026-09-08T10:00:00Z', reached: [] });
  assert.match(sc.nextStep, /People 1 to 3 of 3\. That is everyone\./);
  assert.match(sc.nextStep, /get_journey_first_mile/);

  // A page at a time, with only the projects that page names.
  const second = parseOutput(spec, await handlers.get('get_journey_flows')({ offset: 1, limit: 1 }));
  assert.deepEqual(second.people.map((p) => p.userId), [12]);
  assert.equal(second.nextOffset, 2);
  assert.deepEqual(second.apps.map((a) => a.slug), ['garden', 'atlas']);
  assert.match(second.nextStep, /call again with offset 2/);
  const past = parseOutput(spec, await handlers.get('get_journey_flows')({ offset: 50 }));
  assert.deepEqual(past.people, []);
  assert.match(past.nextStep, /past the end/);

  const nobody = parseOutput(spec, await register({ pool: fakePool({ rows: [], sent: [], reached: [] }) }).handlers.get('get_journey_flows')({}));
  assert.equal(nobody.total, 0);
  assert.deepEqual(nobody.apps, []);
});

test('get_journey_flows fits one answer, says when the reading was cut, and is for full admins only', async () => {
  // Enough people that a page of a hundred would pass one answer.
  const many = [];
  for (let i = 0; i < 400; i += 1) {
    many.push(row(1000 + i, `person_${String(i).padStart(3, '0')}`, 1, {
      member: true, invited_by: 'ana', days: 3, first_day: '2026-09-06', last_day: '2026-09-09', changes: 1, live: 1, votes: 2,
      requests: 1, feedback: 1, messages: 5, total: 900,
    }));
  }
  const { specs, handlers } = register({ pool: fakePool({ rows: many, sent: [], reached: [] }) });
  const out = await handlers.get('get_journey_flows')({ limit: 100 });
  const sc = parseOutput(specs.get('get_journey_flows'), out);
  assert.ok(sc.people.length >= 1 && sc.people.length <= 100);
  assert.ok(JSON.stringify(out.structuredContent).length <= 50_000, 'one answer a chat client takes whole');
  assert.equal(sc.nextOffset, sc.people.length);
  assert.deepEqual(sc.cut, { kept: 400, of: 900 });
  assert.match(sc.nextStep, /cut to 400 of 900 rows/);

  const viewOnly = register({ pool: fakePool(), user: { ...ADMIN, canAdminWrite: false } });
  assert.equal(viewOnly.specs.has('get_journey_flows'), false, 'not registered for anybody else');

  const broken = { async query(sql) { if (sql.includes('platform_settings')) return { rows: [] }; throw new Error('boom'); } };
  const failed = await register({ pool: broken }).handlers.get('get_journey_flows')({});
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.code, 'platform_error');
});
