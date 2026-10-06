'use strict';

// The Journey page's definitions (#3369): src/services/journey.js. Pure
// parts only here; the queries are pinned against a real database in
// tests/journey-queries-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const journey = require('../src/services/journey');

const at = (iso) => new Date(iso);

test('weeks are Monday to Monday in UTC, and the default is the last finished week', () => {
  assert.equal(journey.isoDay(journey.weekStart(at('2026-10-04T23:59:00Z'))), '2026-09-28', 'Sunday belongs to the week before');
  assert.equal(journey.isoDay(journey.weekStart(at('2026-10-05T00:00:00Z'))), '2026-10-05');
  const now = at('2026-10-07T12:00:00Z');
  const last = journey.parseWeek(undefined, now);
  assert.equal(last.label, '2026-09-28');
  assert.equal(last.finished, true);
  const current = journey.parseWeek('2026-10-05', now);
  assert.equal(current.finished, false, 'the current week is only ever "so far"');
  assert.equal(journey.previousWeek(last).label, '2026-09-21');
  for (const bad of ['2026-10-06', '2026-10-12', '2026-02-30', 'monday', '2026-9-28', 5]) {
    assert.equal(journey.parseWeek(bad, now), null, `${bad} is refused`);
  }
  assert.equal(journey.parseDay('2026-09-24'), '2026-09-24');
  assert.equal(journey.parseDay('2026-09-31'), null);
});

test('an active group is 2 to 6 people with a yes across people', () => {
  assert.equal(journey.isActiveGroup(1, true), false);
  assert.equal(journey.isActiveGroup(2, true), true);
  assert.equal(journey.isActiveGroup(6, true), true);
  assert.equal(journey.isActiveGroup(7, true), false, 'not a small group');
  assert.equal(journey.isActiveGroup(3, false), false, 'nobody said yes to anybody else');
  assert.equal(journey.groupLifecycle({ thisWeek: true, lastWeek: true, earlier: true }), 'still_active');
  assert.equal(journey.groupLifecycle({ thisWeek: true, lastWeek: false, earlier: true }), 'back');
  assert.equal(journey.groupLifecycle({ thisWeek: true, lastWeek: false, earlier: false }), 'new');
  assert.equal(journey.groupLifecycle({ thisWeek: false, lastWeek: true, earlier: false }), 'went_quiet');
  assert.equal(journey.groupLifecycle({ thisWeek: false, lastWeek: false, earlier: true }), null);
});

function rows(list, base = '2026-10-02T10:00:00Z') {
  const t0 = at(base).getTime();
  return list.map(([seconds, kind, screen, via, sequence]) => ({
    at: new Date(t0 + seconds * 1000), kind, screen, via, sequence,
    outcome: kind === 'action_outcome' ? 'success' : undefined,
  }));
}

test('visits are cut by 30 minutes of nothing, or by a return, never by page load', () => {
  const visits = journey.splitVisits(rows([
    [0, 'screen_visit', 'home', 'own', 1],
    [20, 'screen_visit', 'discover', 'own', 2],
    [25, 'action_outcome', 'app_detail', null, 3],
    [1500, 'screen_visit', 'app', 'own', 4], // 25 minutes later, same visit
    [1560, 'screen_hidden', 'app', null, 5],
    [1560 + 1800, 'screen_visit', 'app', 'returned', 6], // a return starts a new visit
    [1560 + 1830, 'screen_visit', 'home', 'own', 7],
    [99999, 'screen_visit', 'messages', 'nudged', 8], // a long gap starts another
  ]));
  assert.deepEqual(visits.map((v) => v.steps.map((s) => s.screen)), [
    ['home', 'discover', 'app'],
    ['app', 'home'],
    ['messages'],
  ]);
  assert.deepEqual(visits[0].steps.map((s) => s.seconds), [20, 1480, 60],
    'time on the last screen ends at "hidden"');
  assert.equal(visits[0].acted, true);
  assert.equal(visits[2].steps[0].seconds, 0, 'a one-step visit with no end has no time on it');
});

test('"possibly lost" needs fast, circling and no landing, and says which cut-offs it used', () => {
  const circling = ['home', 'discover', 'home', 'communities', 'home', 'messages', 'home', 'discover', 'home', 'profile'];
  const visit = journey.splitVisits(rows(circling.map((s, i) => [i * 4, 'screen_visit', s, 'own', i + 1])))[0];
  const reading = journey.lostReading(visit);
  assert.equal(reading.possiblyLost, true);
  assert.equal(reading.steps, 10);
  assert.equal(reading.distinct, 5);
  assert.equal(reading.repeatShare, 0.5);
  assert.deepEqual(reading.cutoffs, journey.LOST_CUTOFFS);
  assert.equal(journey.lostReading(visit, { acted: true }).possiblyLost, false, 'a visit that did something landed');
  const slow = journey.splitVisits(rows(circling.map((s, i) => [i * 40, 'screen_visit', s, 'own', i + 1])))[0];
  assert.equal(journey.lostReading(slow).possiblyLost, false, 'staying 30 seconds anywhere is a landing');
  const straight = ['home', 'discover', 'app', 'project', 'messages', 'profile', 'settings', 'challenges', 'communities'];
  const direct = journey.splitVisits(rows(straight.map((s, i) => [i * 3, 'screen_visit', s, 'own', i + 1])))[0];
  assert.equal(journey.lostReading(direct).possiblyLost, false, 'fast but never circling is not lost');
});

test('next steps count moves and people, keep Left and Other, and flag dead ends', () => {
  const v = (screens, vias = []) => journey.splitVisits(rows(screens.map((s, i) => [i * 10, 'screen_visit', s, vias[i] || 'own', i + 1])));
  const byPerson = new Map([
    [1, [...v(['home', 'discover', 'app']), ...v(['home', 'messages'], [])]],
    [2, [...v(['home', 'discover']), ...v(['home', 'profile', 'home'], ['own', 'own', 'back'])]],
    [3, [...v(['home', 'settings']), ...v(['home', 'discover'])]],
  ]);
  const { rows: out, starts } = journey.nextSteps(byPerson, { top: 2 });
  const home = out.find((r) => r.screen === 'home');
  assert.equal(home.moves, 7);
  assert.equal(home.people, 3);
  assert.deepEqual(home.next, [{ to: 'discover', moves: 3, people: 3 }, { to: 'messages', moves: 1, people: 1 }]);
  assert.equal(home.other, 2, 'profile and settings fall into Other, so the row adds up');
  assert.deepEqual(home.left, { moves: 1, people: 1 });
  assert.equal(home.next.reduce((s, n) => s + n.moves, 0) + home.other + home.left.moves, home.moves);
  assert.equal(home.few, true);
  const discover = out.find((r) => r.screen === 'discover');
  assert.equal(discover.deadEnd, true, 'most visits ended on Discover');
  const profile = out.find((r) => r.screen === 'profile');
  assert.deepEqual(profile.next, [{ to: 'back', moves: 1, people: 1 }]);
  assert.equal(profile.deadEnd, true, 'Back was the most common way out');
  assert.deepEqual(starts[0], { screen: 'home', visits: 6, people: 3 });
});

test('the real-person rule leaves out admins, bots, test accounts, restricted, deleted, service and left-out accounts', () => {
  const sql = journey.REAL_PERSON_SQL;
  for (const part of [
    'u.is_admin IS NOT TRUE', 'u.is_synthetic IS NOT TRUE', 'u.test_account_created_at IS NULL',
    'u.participation_restricted_at IS NULL',
    'u.anonymised_at IS NULL', 'NOT (LOWER(u.username) LIKE ANY($3::text[]))', 'NOT (u.id = ANY($4::int[]))',
  ]) assert.ok(sql.includes(part), part);
  assert.equal(journey.REAL_VOTER_SQL, sql.replace(/\bu\./g, 'uy.'),
    'the yes-voters of a change are held to exactly the same rule');
  // B9: 'homeroom' joined the reserved prefixes with the bot's @mention.
  assert.deepEqual(journey.RESERVED_PATTERNS, ['usernode%', 'staging%', 'homeroom%'],
    'the reserved prefixes nobody else may take (src/services/usernames.js RESERVED_PREFIXES)');
  const usernames = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'usernames.js'), 'utf8');
  assert.match(usernames, /const RESERVED_PREFIXES = \['usernode', 'staging', 'homeroom'\];/);
  assert.deepEqual(journey.notRecorded('no record'), { recorded: false, reason: 'no record' });
});

test('first-mile steps: expired mail proof reads unknown, and nothing counts past an unfinished account', () => {
  const now = at('2026-11-15T12:00:00Z');
  const old = journey.firstMileSteps({
    released_at: '2026-10-01T09:00:00Z', mail_status: null, code_asked_at: null,
    user_id: 9, password_set: true, account_at: '2026-10-01T10:00:00Z', has_platform_access: true,
    access_at: '2026-10-01T10:00:00Z', opened_at: null, needs_username_choice: false,
    needs_communities_choice: false, first_act_at: null,
  }, now);
  assert.deepEqual(old.steps.slice(0, 4).map((s) => s.state), ['done', 'unknown', 'unknown', 'done'],
    'mail proof older than 30 days is unknown, never "not sent"');
  assert.equal(old.stuckAt, 'opened');
  const started = journey.firstMileSteps({
    released_at: '2026-11-14T09:00:00Z', mail_status: 'sent', mail_at: '2026-11-14T09:00:01Z',
    code_asked_at: '2026-11-14T10:00:00Z', user_id: 10, password_set: false, has_platform_access: true,
    needs_username_choice: true, needs_communities_choice: false,
  }, now);
  assert.equal(started.stuckAt, 'account');
  assert.equal(started.furthest, 'code_asked', 'the row\'s defaults do not carry a started account past it');
  assert.deepEqual(started.steps.slice(4).map((s) => s.state), ['not_yet', 'not_yet', 'not_yet', 'not_yet', 'not_yet']);
  // Sign-up asks for no password now: an account that chose its username
  // finished, with or without one (and so did every Apple and Google one).
  const codeOnly = journey.firstMileSteps({
    released_at: '2026-11-14T09:00:00Z', mail_status: 'sent', mail_at: '2026-11-14T09:00:01Z',
    code_asked_at: '2026-11-14T10:00:00Z', user_id: 11, password_set: false, account_at: '2026-11-14T10:01:00Z',
    has_platform_access: false, needs_username_choice: false, needs_communities_choice: false,
  }, now);
  assert.equal(codeOnly.steps[3].state, 'done', 'a username without a password is a finished account');
  assert.equal(codeOnly.stuckAt, 'access');
});

test('a change the Homeroom bot built is credited to the person who asked for it', () => {
  const flat = (x) => x.replace(/\s+/g, ' ');
  const person = flat(journey.CHANGE_PERSON_SQL);
  assert.match(person, /WHEN EXISTS \(SELECT 1 FROM users bu WHERE bu\.id = cs\.user_id AND bu\.is_synthetic\)/,
    'only a synthetic author is replaced');
  assert.match(person, /homeroom_bot_requesters r WHERE r\.app_id = cs\.app_id AND r\.issue_number = cs\.created_from_issue_number/,
    'the requester the bot recorded for the request it built');
  assert.match(person, /issues ri WHERE ri\.app_id = cs\.app_id AND ri\.github_issue_number = cs\.created_from_issue_number/,
    'else whoever filed that request');
  assert.match(person, /ELSE cs\.user_id END/, 'every other change is its author\'s');
  // Every reading that keys on a change's author reads it through the rule:
  // the North Star and its trend, the groups one short, the trust checks,
  // and the Activate, Belong and Use stages.
  for (const [name, sql] of Object.entries({
    LIVE_CHANGES_SQL: journey.LIVE_CHANGES_SQL, WAITING_SQL: journey.WAITING_SQL, TRUST_SQL: journey.TRUST_SQL,
  })) {
    assert.ok(sql.includes(journey.CHANGE_PERSON_SQL), `${name} credits bot builds`);
    assert.doesNotMatch(sql, /pvx\.user_id <> cs\.user_id/, `${name}: "somebody else's yes" means somebody other than the person credited`);
  }
  const stages = journey.STAGES_SQL;
  assert.equal(stages.split(journey.CHANGE_PERSON_SQL).length - 1, 5,
    'Activate (a change), Belong (a yes, kudos or a comment on somebody else\'s change) and Use');
  assert.doesNotMatch(stages, /<> cs\.user_id/);
});

test('creation path: people once each, the shortest time, and an absent record before recording is not a no', () => {
  const recordedFrom = { running: new Date('2026-09-22T00:00:00Z'), preview: null, change_live: new Date('2026-09-22T00:00:00Z') };
  const row = (userId, createdAt, extra = {}) => ({
    app_id: userId * 10, slug: `p${userId}`, name: `P${userId}`, user_id: userId, username: `u${userId}`, created_at: createdAt,
    running_at: null, first_version_at: null, preview_at: null, change_live_at: null, ...extra,
  });
  const plus = (iso, s) => new Date(new Date(iso).getTime() + s * 1000);
  const T = '2026-09-29T10:00:00Z';
  const projects = [
    row(1, T, { running_at: plus(T, 90), first_version_at: plus(T, 100) }),
    row(1, '2026-09-30T10:00:00Z', { running_at: plus('2026-09-30T10:00:00Z', 30) }),
    row(2, T, { running_at: plus(T, 200), change_live_at: plus(T, 500) }),
    row(3, '2026-09-20T10:00:00Z', { running_at: plus('2026-09-20T10:00:00Z', 50) }),
  ].map((r) => journey.creationProject(r, recordedFrom));
  assert.equal(projects[3].steps.running.counted, true, 'a record from before recording began is still a fact');
  assert.equal(projects[3].steps.change_live.counted, false, 'its absence is not a no');
  const steps = Object.fromEntries(journey.creationSteps(projects).map((s) => [s.key, s]));
  assert.deepEqual(journey.CREATION_STEPS, ['created', 'running', 'first_version', 'preview', 'change_live']);
  assert.deepEqual([steps.created.reached, steps.created.of], [3, 3], 'people, not projects');
  assert.deepEqual([steps.running.reached, steps.running.medianSeconds], [3, 50], 'person 1 counts once, with 30 s');
  assert.deepEqual([steps.first_version.reached, steps.first_version.withinTarget, steps.first_version.targetSeconds], [1, 1, 120]);
  assert.deepEqual([steps.change_live.reached, steps.change_live.of, steps.change_live.withinTarget], [1, 2, 1]);
  assert.deepEqual(steps.preview.reached, journey.notRecorded('Not recorded for projects created before this step was first recorded.'),
    'a step nothing recorded yet reads "not recorded", never 0');
  assert.equal(steps.preview.of, 0);
  assert.deepEqual(journey.creationSteps([]).map((s) => s.reached), [0, 0, 0, 0, 0], 'nobody made anything: zeros are true');
  assert.deepEqual(journey.CREATION_TARGETS, { running: 300, first_version: 120, change_live: 600 });
});

test('pairs: both active is the aha, and inside the 7 days a no is still open', () => {
  const now = at('2026-10-07T12:00:00Z');
  const base = { slug: 'duo', name: 'Duo', via_invite: true, host_id: 1, host: 'ana', second_id: 2, second: 'ben' };
  const both = journey.pairReading({
    ...base, second_at: '2026-09-29T10:00:00Z', host_active_at: '2026-09-28T00:00:00Z', second_active_at: '2026-09-30T08:00:00Z',
  }, now);
  assert.deepEqual([both.bothActive, both.hoursToBoth, both.via, both.open], [true, 22, 'invite', false],
    'the clock starts when the second one joined, even when the first was active that morning');
  const missed = journey.pairReading({ ...base, second_at: '2026-09-29T10:00:00Z', host_active_at: null, second_active_at: '2026-09-30T08:00:00Z' }, now);
  assert.deepEqual([missed.bothActive, missed.open], [false, false]);
  const waiting = journey.pairReading({ ...base, via_invite: false, second_at: '2026-10-05T10:00:00Z', host_active_at: null, second_active_at: null }, now);
  assert.deepEqual([waiting.bothActive, waiting.open, waiting.via], [false, true, 'members']);
  assert.equal(journey.PAIR_DAYS, 7);
  assert.match(journey.PAIRS_SQL, /INTERVAL '7 days'/, 'the SQL window is the same 7 days');
  assert.doesNotMatch(journey.PAIRS_SQL.replace(/INTERVAL '7 days'/g, ''), /INTERVAL/, 'and no other');
  for (const sql of [journey.PAIRS_SQL, journey.CREATION_PATH_SQL]) {
    assert.ok(sql.includes(journey.REAL_PERSON_SQL), 'real people only');
    assert.match(sql, /self_hosted IS NOT TRUE/, 'Homeroom\'s own project is left out');
  }
  assert.match(journey.PAIRS_SQL, /cmb\.source IN \('creator', 'collaborator', 'favorite', 'joined'\)/,
    'the one-time backfill rows are not joins');
});
