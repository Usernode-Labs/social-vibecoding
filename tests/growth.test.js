'use strict';

// The Growth reading behind Admin › Journey (src/services/growth.js) and its
// staging demo (src/services/growth-demo.js): who is a newcomer, what a group
// is, and the shape the page reads. The SQL is validated against the schema
// by scripts/check-sql.js; here a fake pool answers each query in turn.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const growth = require('../src/services/growth');
const demo = require('../src/services/growth-demo');

test('the era starts at the landing page, and a group is three people', () => {
  assert.equal(growth.ERA_START, '2026-09-14');
  assert.equal(growth.GROUP_MIN, 3);
  assert.equal(growth.STAY_SECONDS, 30);
});

test('a group is a project where three people in scope acted in the same week', () => {
  const acts = [
    { appId: 1, userId: 10, week: '2026-11-02' }, { appId: 1, userId: 11, week: '2026-11-02' },
    { appId: 1, userId: 12, week: '2026-11-02' }, { appId: 1, userId: 13, week: '2026-11-02' },
    { appId: 2, userId: 10, week: '2026-11-02' }, { appId: 2, userId: 11, week: '2026-11-02' },
    { appId: 3, userId: 20, week: '2026-10-05' }, { appId: 3, userId: 21, week: '2026-10-05' }, { appId: 3, userId: 22, week: '2026-10-05' },
    { appId: 3, userId: 20, week: '2026-10-12' }, { appId: 3, userId: 21, week: '2026-10-12' }, { appId: 3, userId: 22, week: '2026-10-12' },
  ];
  const everyone = growth.groupsAmong(acts, new Set([10, 11, 12, 13, 20, 21, 22]));
  assert.deepEqual(everyone.map((g) => [g.appId, g.weeks, g.people, g.cameBack]), [
    [1, ['2026-11-02'], [10, 11, 12, 13], false],
    [3, ['2026-10-05', '2026-10-12'], [20, 21, 22], true],
  ], 'two people are not a group; a second week is coming back');
  const some = growth.groupsAmong(acts, new Set([10, 11, 20, 21, 22]));
  assert.deepEqual(some.map((g) => g.appId), [3], 'only people in scope count towards the three');
});

test('the team\'s domains are Journey\'s', () => {
  const journey = require('../src/services/journey');
  for (const d of journey.TEAM_DOMAINS) assert.ok(growth.NO_ACCOUNT_SQL.includes(`'${d}'`), d);
});

test('weeks run from the era\'s Monday to the current one', () => {
  const weeks = growth.eraWeeks(new Date('2026-11-17T10:00:00Z'));
  assert.equal(weeks[0], '2026-09-14');
  assert.equal(weeks[weeks.length - 1], '2026-11-16');
  assert.equal(weeks.length, 10);
});

test('the reading puts each person, their weeks and the groups in one payload', async () => {
  const answers = [
    // PEOPLE_SQL
    { rows: [
      { user_id: 1, username: 'old', created_at: '2026-01-01', early: true, season_early: true, connected: false, admitted_at: null, link_at: null, heard: null, opened: true, stayed: true, last_seen: '2026-11-15' },
      { user_id: 2, username: 'new', created_at: '2026-10-28', early: false, season_early: false, connected: false, admitted_at: '2026-10-28T08:00:00Z', link_at: null, heard: 'x', opened: true, stayed: false, last_seen: '2026-10-29' },
      { user_id: 3, username: 'friend', created_at: '2026-11-02', early: false, season_early: false, connected: false, admitted_at: null, link_at: '2026-11-02T19:58:00Z', heard: null, opened: true, stayed: true, last_seen: '2026-11-02' },
    ] },
    // NO_ACCOUNT_SQL
    { rows: [{ signup_id: 77, released_at: '2026-11-13T07:00:00Z', heard: null }] },
    // MAIL_SQL
    { rows: [{ signup_id: 50, linked_user_id: 2, clicked: false, opened: true, on_record: true }, { signup_id: 77, linked_user_id: null, clicked: false, opened: false, on_record: true }] },
    // ACTIVE_WEEKS_SQL
    { rows: [{ user_id: 1, week: '2026-11-09' }, { user_id: 3, week: '2026-11-02' }] },
    // PROJECT_ACTS_SQL
    { rows: [{ app_id: 9, user_id: 1, week: '2026-11-02' }, { app_id: 9, user_id: 3, week: '2026-11-02' }] },
    // TIME_SQL: person 2 left within 9 s twice; person 3 stayed 4 minutes once
    { rows: [{ user_id: 2, bin: 2, visits: 2, longest: 9 }, { user_id: 3, bin: 7, visits: 1, longest: 240 }] },
    // LAST_WEEK_SQL
    { rows: [{ user_id: 1, opened: true, used: true, contributed: true, analytics_wau: true }] },
  ];
  const pool = { query: async () => answers.shift() };
  const r = await growth.reading(pool, { leftOutIds: [], now: new Date('2026-11-17T10:00:00Z') });
  assert.equal(r.demo, false);
  assert.equal(r.people.length, 4, 'three accounts and one admit with no account yet');
  const by = Object.fromEntries(r.people.map((p) => [p.key, p]));
  assert.equal(by.u2.way, 'waitlist');
  assert.equal(by.u2.mail, 'opened');
  assert.equal(by.u3.way, 'link', 'an invite link is the way in, whatever else happened');
  assert.equal(by.u3.cameAt, '2026-11-02T19:58:00.000Z');
  assert.equal(by.w77.userId, null);
  assert.equal(by.w77.mail, 'sent');
  assert.deepEqual(by.u1.activeWeeks, ['2026-11-09']);
  assert.equal(by.u1.last7.analyticsWau, true);
  assert.deepEqual(r.timeBins, [1, 5, 10, 20, 30, 60, 120, 300, 900]);
  assert.equal(by.u2.bestSeconds, 9);
  assert.deepEqual(by.u2.visitBins, [0, 2, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(by.u3.bestSeconds, 240);
  assert.equal(by.u1.bestSeconds, null, 'no app time, no longest visit');
  assert.deepEqual(by.w77.visitBins, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(r.groups.newcomers, [], 'one newcomer is not a group');
  assert.deepEqual(r.groups.everyone, [], 'two people are not a group either');
});

test('the demo is whole, labelled and invented', () => {
  const d = demo.reading();
  assert.equal(d.demo, true);
  assert.equal(d.weeks[0], '2026-09-14');
  const newcomers = d.people.filter((p) => !p.early && !p.connected);
  assert.ok(newcomers.length > 90, 'about a hundred newcomers');
  assert.ok(d.people.some((p) => p.early), 'and an early community to switch on');
  assert.equal(d.groups.newcomers.length, 1, 'one group of newcomers');
  assert.equal(d.groups.newcomers[0].cameBack, false, 'that did not come back');
  for (const p of d.people) {
    for (const key of ['key', 'userId', 'name', 'early', 'seasonEarly', 'connected', 'way', 'admittedDay', 'cameAt', 'heard', 'mail', 'opened', 'stayed', 'lastSeen', 'bestSeconds', 'visitBins', 'activeWeeks', 'last7']) {
      assert.ok(key in p, `${p.key} has ${key}`);
    }
  }
  assert.ok(d.people.some((p) => p.bestSeconds && p.bestSeconds < 30) && d.people.some((p) => p.bestSeconds >= 30), 'time on both sides of 30 s');
  const t = demo.timeline(910100);
  assert.equal(t.demo, true);
  assert.ok(t.events.some((e) => e.kind === 'build' && e.until));
});

test('the routes are Journey readings: any admin, the demo under staging', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.js'), 'utf8');
  assert.match(admin, /router\.get\('\/api\/admin\/journey\/growth', journeyRead\('growth', \(\) => growthDemoData\.reading\(\),/);
  assert.match(admin, /router\.get\('\/api\/admin\/journey\/growth\/groups\/:appId', journeyRead\('growth group'/);
  assert.match(admin, /if \(!Number\.isSafeInteger\(appId\) \|\| appId <= 0\) return \{ status: 400/);
});
