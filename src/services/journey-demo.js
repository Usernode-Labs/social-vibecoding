'use strict';

// Demo payloads for the admin Journey endpoints (#3369), served only under
// staging with ?demo=1 (src/routes/admin.js), so the dashboard and its
// preview have something to show. A staging clone has the private tables
// emptied and fixture rows reseeded, so real and invented numbers would
// otherwise sit side by side; every endpoint returns a whole demo payload
// instead, marked `demo: true`. The people are invented. Shapes follow
// src/services/journey.js exactly; tests/journey-routes.test.js pins that.

const journey = require('./journey');

const P = Object.freeze({
  mira: { userId: 900101, name: 'mira_k' },
  tobi: { userId: 900102, name: 'tobi' },
  lena: { userId: 900103, name: 'lena.s' },
  okafor: { userId: 900104, name: 'okafor' },
  jun: { userId: 900105, name: 'jun' },
  sable: { userId: 900106, name: 'sable' },
  rafa: { userId: 900107, name: 'rafa' },
});

const step = (key, state, at = null, note = null) => ({ key, state, at, note });

function firstMilePerson(p, steps, extra = {}) {
  const stuck = steps.find((s) => s.state === 'stuck');
  const done = steps.filter((s) => s.state === 'done');
  return {
    signupId: null, userId: p ? p.userId : null, name: p ? p.name : 'j…@example.test', hasAccount: !!p,
    door: 'admitted', steps, furthest: done.length ? done[done.length - 1].key : null,
    stuckAt: stuck ? stuck.key : null, stuckReason: stuck ? stuck.note : null,
    daysSince: 3, failedAttempts: 0, repeatedTaps: 0, tour: null, welcome: null, ...extra,
  };
}

function cohorts() {
  return {
    demo: true,
    cohorts: [
      { day: '2026-10-05', admitted: 4, withAccount: 3 },
      { day: '2026-09-24', admitted: 3, withAccount: 3 },
    ],
    otherWay: { people: 1 },
  };
}

// Everyone in a demo cohort reached every step: the earlier cohort and the
// one person who came in another way.
const allDone = (p, at, extra = {}) => firstMilePerson(p, journey.FIRST_MILE_STEPS
  .map((key) => step(key, 'done', key === 'username' ? null : at)), { daysSince: 11, ...extra });

function firstMile(day) {
  if (day === '2026-09-24') {
    const people = [P.okafor, P.jun, P.sable].map((p) => allDone(p, '2026-09-24T10:00:00Z'));
    return { demo: true, cohort: day, people, steps: journey.firstMileCounts(people),
      notRecorded: { followedLink: journey.notRecorded('Nothing records the admit mail being opened or its link followed.') } };
  }
  if (day === 'other_way') {
    const people = [allDone(P.rafa, '2026-09-20T10:00:00Z', { door: 'activation code' })];
    people[0].steps = people[0].steps.slice(journey.FIRST_MILE_STEPS.indexOf('account'));
    return { demo: true, cohort: day, people, steps: journey.firstMileCounts(people), notRecorded: {} };
  }
  const D = '2026-10-05T09:10:00Z';
  const people = [
    firstMilePerson(P.mira, [
      step('admitted', 'done', D), step('mail_sent', 'done', D), step('code_asked', 'done', '2026-10-05T18:31:00Z'),
      step('account', 'done', '2026-10-05T18:32:00Z'), step('access', 'done', '2026-10-05T18:32:00Z'),
      step('opened', 'done', '2026-10-05T18:34:00Z'), step('username', 'done'),
      step('join', 'done', '2026-10-05T18:36:00Z', 'joined'),
      step('first_act', 'done', '2026-10-05T18:52:00Z', 'message'),
    ], { tour: { ended: 'finish', step: 3, at: '2026-10-05T18:40:00Z' } }),
    firstMilePerson(P.tobi, [
      step('admitted', 'done', D), step('mail_sent', 'done', D), step('code_asked', 'done', '2026-10-06T07:48:00Z'),
      step('account', 'done', '2026-10-06T07:49:00Z'), step('access', 'done', '2026-10-06T07:49:00Z'),
      step('opened', 'done', '2026-10-06T07:51:00Z'), step('username', 'done'),
      step('join', 'done', '2026-10-06T07:52:00Z', 'skipped'),
      step('first_act', 'stuck', null, 'Inside, no act yet'),
    ], { failedAttempts: 2, repeatedTaps: 1, tour: { ended: 'skip', step: 1, at: '2026-10-06T07:53:00Z' } }),
    firstMilePerson(P.lena, [
      step('admitted', 'done', D), step('mail_sent', 'done', D), step('code_asked', 'done', '2026-10-05T12:20:00Z'),
      step('account', 'done', '2026-10-05T12:22:00Z'), step('access', 'done', '2026-10-05T12:22:00Z'),
      step('opened', 'done', '2026-10-05T12:25:00Z'), step('username', 'done'),
      step('join', 'stuck', null, 'Join screen shown, not answered'), step('first_act', 'not_yet'),
    ]),
    firstMilePerson(null, [
      step('admitted', 'done', D), step('mail_sent', 'done', D),
      step('code_asked', 'stuck', null, 'Admitted, never asked for a login code'),
      step('account', 'not_yet'), step('access', 'not_yet'), step('opened', 'not_yet'),
      step('username', 'not_yet'), step('join', 'not_yet'), step('first_act', 'not_yet'),
    ]),
  ];
  return {
    demo: true,
    cohort: day || '2026-10-05',
    people,
    steps: journey.firstMileCounts(people),
    notRecorded: { followedLink: journey.notRecorded('Nothing records the admit mail being opened or its link followed.') },
  };
}

// The people of a demo cohort, or null for everyone.
function members(day) {
  if (!day) return null;
  return new Set(firstMile(day).people.filter((p) => p.userId).map((p) => p.userId));
}

function stages(day, all = false) {
  const ids = members(day);
  const people = [
    { ...P.mira, arrive: true, explore: true, activate: true, belong: true, use: false, stay: true, invite: false, activateKinds: ['vote'], stoppedAt: 'stay' },
    { ...P.tobi, arrive: true, explore: false, activate: false, belong: false, use: false, stay: false, invite: false, activateKinds: [], stoppedAt: 'arrive' },
    { ...P.okafor, arrive: true, explore: true, activate: true, belong: true, use: true, stay: true, invite: false, activateKinds: ['change', 'vote'], stoppedAt: 'stay' },
    { ...P.jun, arrive: true, explore: true, activate: true, belong: true, use: false, stay: true, invite: false, activateKinds: ['feedback', 'vote'], stoppedAt: 'stay' },
    { ...P.sable, arrive: true, explore: true, activate: true, belong: false, use: true, stay: true, invite: false, activateKinds: ['change'], stoppedAt: 'stay' },
    { ...P.rafa, arrive: true, explore: true, activate: true, belong: true, use: false, stay: true, invite: true, activateKinds: ['vote'], stoppedAt: 'invite' },
  ].filter((p) => !ids || ids.has(p.userId));
  const counts = {};
  const stoppedAt = {};
  for (const key of journey.STAGES) {
    counts[key] = people.filter((p) => p[key]).length;
    stoppedAt[key] = people.filter((p) => p.stoppedAt === key).map((p) => ({ userId: p.userId, name: p.name }));
  }
  return { demo: true, week: all ? 'all' : '2026-09-28', finished: !all, counts, stoppedAt, people };
}

function activeGroups(day) {
  const ids = members(day);
  const keep = (g) => !ids || g.people.some((p) => ids.has(p.userId));
  const all = {
    demo: true,
    week: '2026-09-28',
    finished: true,
    count: 2,
    trend: [
      { week: '2026-08-10', count: 1 }, { week: '2026-08-17', count: 2 }, { week: '2026-08-24', count: 1 },
      { week: '2026-08-31', count: 3 }, { week: '2026-09-07', count: 2 }, { week: '2026-09-14', count: 2 },
      { week: '2026-09-21', count: 2 }, { week: '2026-09-28', count: 2 },
    ],
    groups: [
      { slug: 'trail-log', name: 'Trail Log', selfHosted: false, changes: 3, people: [P.sable, P.rafa, P.mira], active: true, lifecycle: 'new' },
      { slug: 'chore-wheel', name: 'Chore Wheel', selfHosted: false, changes: 2, people: [P.okafor, P.jun], active: true, lifecycle: 'still_active' },
    ],
    wentQuiet: [{ slug: 'supper-club', name: 'Supper Club', people: [P.lena], lifecycle: 'went_quiet' }],
    homeroom: { changes: 11, people: 19 },
    oneShort: [{ slug: 'tally', name: 'Tally', people: [P.tobi], why: 'a change is waiting for a yes from someone else', since: '2026-10-01T10:00:00Z' }],
  };
  if (!ids) return all;
  const groups = all.groups.filter(keep);
  // A cohort's trend can never be above its own count of groups in the demo.
  const trend = all.trend.map((t, i) => ({ ...t, count: i === all.trend.length - 1 ? groups.length : Math.min(t.count, groups.length) }));
  return { ...all, count: groups.length, trend, groups, wentQuiet: all.wentQuiet.filter(keep), oneShort: all.oneShort.filter(keep) };
}

function trustChecks() {
  return {
    demo: true,
    week: '2026-09-28',
    withoutGroupVote: { count: 1, of: 6, atLeastForced: 1, changes: [{ slug: 'tally', project: 'Tally', author: 'tobi', forced: true }] },
    teamShare: { team: 5, of: 11 },
    lockstep: { possible: [], cutoffs: journey.LOCKSTEP_CUTOFFS },
  };
}

function coverage() {
  return {
    demo: true, week: '2026-09-28', activePeople: 31, withNavigation: 27,
    byDay: [{ day: '2026-09-28', build: 'abc1234', rows: 412 }, { day: '2026-09-29', build: 'abc1234', rows: 388 }],
  };
}

function loops(day, allTime = false) {
  const ids = members(day);
  const all = {
    demo: true,
    change: {
      week: allTime ? 'all' : '2026-09-28',
      steps: journey.LOOP_STEPS,
      atStep: { notice: 9, make_sense: 6, sketch: 5, decide: 4, go_live: 3, hear_back: { status: 'coming' } },
      turnsClosed: { status: 'coming' },
      live: [{ project: 'Trail Log', slug: 'trail-log', number: 12, title: 'Show the elevation', reporter: P.mira,
        step: 'go_live', since: '2026-10-01T10:00:00Z', days: 6, holder: 'sable', noticedAt: '2026-09-29T10:00:00Z',
        liveAt: '2026-10-01T10:00:00Z', closed: false, daysFromNotice: 2 }],
      perProject: [{ slug: 'trail-log', project: 'Trail Log', thisWeek: 2, lastWeek: 1, alsoLastWeek: true }],
      open: [
        { project: 'Chore Wheel', slug: 'chore-wheel', number: 7, title: 'Rotate on Sundays', reporter: P.jun,
          step: 'notice', since: '2026-09-30T10:00:00Z', days: 6, holder: null, noticedAt: '2026-09-30T10:00:00Z', liveAt: null, closed: false },
        { project: 'Trail Log', slug: 'trail-log', number: 14, title: 'Dark mode', reporter: P.mira,
          step: 'sketch', since: '2026-10-03T10:00:00Z', days: 3, holder: 'sable', noticedAt: '2026-10-02T10:00:00Z', liveAt: null, closed: false },
      ],
    },
    invite: {
      steps: ['invited', 'arrived', 'did_something', 'invited_someone'],
      counts: { invited: 1, arrived: 1, did_something: 1, invited_someone: 0 },
      pairs: [{ host: P.rafa, invitee: P.sable, letInAt: '2026-10-02T09:00:00Z', arrived: true, didSomething: true, invitedSomeone: false }],
    },
  };
  if (!ids) return all;
  // Narrowed the way journey.changeLoop and journey.inviteLoop narrow.
  const mine = (t) => t.reporter && ids.has(t.reporter.userId);
  const open = all.change.open.filter(mine);
  const live = all.change.live.filter(mine);
  const atStep = {};
  for (const key of journey.LOOP_STEPS) {
    atStep[key] = key === 'hear_back' ? { status: 'coming' }
      : key === 'go_live' ? live.length : open.filter((t) => t.step === key).length;
  }
  const pairs = all.invite.pairs.filter((x) => ids.has(x.host.userId) || ids.has(x.invitee.userId));
  return {
    ...all,
    change: { ...all.change, open, live, atStep, perProject: all.change.perProject.filter((p) => live.some((t) => t.slug === p.slug)) },
    invite: { ...all.invite, pairs, counts: {
      invited: pairs.length, arrived: pairs.filter((x) => x.arrived).length,
      did_something: pairs.filter((x) => x.didSomething).length, invited_someone: pairs.filter((x) => x.invitedSomeone).length,
    } },
  };
}

function nextSteps() {
  return {
    demo: true,
    people: 6,
    leftOut: { droppedEvents: [], noNavigation: [] },
    starts: [{ screen: 'home', visits: 38, people: 6 }, { screen: 'messages', visits: 9, people: 4 }],
    rows: [
      { screen: 'home', moves: 41, people: 6, next: [{ to: 'discover', moves: 15, people: 5 }, { to: 'app', moves: 11, people: 5 }, { to: 'messages', moves: 6, people: 4 }], other: 4, left: { moves: 5, people: 3 }, deadEnd: false, few: false },
      { screen: 'discover', moves: 18, people: 5, next: [{ to: 'app', moves: 6, people: 4 }, { to: 'home', moves: 4, people: 3 }], other: 0, left: { moves: 8, people: 4 }, deadEnd: true, few: false },
      { screen: 'profile', moves: 4, people: 2, next: [{ to: 'back', moves: 3, people: 2 }], other: 0, left: { moves: 1, people: 1 }, deadEnd: true, few: true },
    ],
  };
}

function person(userId) {
  return {
    demo: true,
    userId: Number(userId) || P.tobi.userId,
    name: P.tobi.name,
    cohort: '2026-10-05',
    firstMile: firstMile().people[1],
    found: [],
    cameBackTo: [],
    usedOftenNotOnHome: [],
    waysIn: { address: 1 },
    visits: 1,
    possiblyLost: [{
      at: '2026-10-06T07:53:00Z',
      path: ['home', 'discover', 'home', 'communities', 'home', 'messages', 'home', 'discover', 'app:tally', 'discover', 'home', 'profile', 'home'],
      possiblyLost: true, steps: 13, distinct: 7, seconds: 50, secondsPerStep: 3.8, repeatShare: 0.46, landed: false,
      cutoffs: journey.LOST_CUTOFFS,
    }],
    failedAttempts: 2,
    repeatedTaps: 1,
    challenges: { openedAt: null, credits: [] },
    navigation: { recorded: true },
  };
}

// "All time" in the demo: the same headline week, with sixteen weeks of trend.
const EARLIER_TREND = [0, 0, 1, 1, 0, 1, 2, 1].map((count, i) => ({
  week: new Date(Date.UTC(2026, 5, 15 + i * 7)).toISOString().slice(0, 10), count,
}));

function summary(day, all = false) {
  const mile = firstMile(day === 'other_way' || day === '2026-09-24' ? day : undefined);
  const groups = activeGroups(day);
  return {
    demo: true,
    week: '2026-09-28',
    allTime: all,
    thisWeekSoFar: { week: '2026-10-05', count: 1 },
    groups: all ? { ...groups, trend: [...EARLIER_TREND.map((t) => ({ ...t, count: Math.min(t.count, groups.count) })), ...groups.trend] } : groups,
    stuck: mile.people.filter((p) => p.stuckAt).map((p) => ({
      userId: p.userId, name: p.name, cohort: mile.cohort, stuckAt: p.stuckAt, reason: p.stuckReason,
      days: p.daysSince, failedAttempts: p.failedAttempts,
    })),
    openTurns: loops(day).change.open,
    trust: trustChecks(),
    coverage: coverage(),
  };
}

function leftOut() {
  return { demo: true, people: [{ userId: 900199, username: 'qa_phone', reason: 'test', note: 'QA phone', addedBy: 'admin', addedAt: '2026-10-02T10:00:00Z' }] };
}

module.exports = { cohorts, firstMile, stages, activeGroups, trustChecks, coverage, loops, nextSteps, person, summary, leftOut };
