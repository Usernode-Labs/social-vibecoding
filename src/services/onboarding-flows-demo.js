'use strict';

// A whole, labelled demo payload for Admin › Onboarding flows, answered under
// staging with ?demo=1 like the Journey routes' (services/journey-demo.js): a
// staging copy has emptied private tables, and a chart of half-real people
// would be worse than invented ones that say so. Every person here is made
// up, from a fixed seed, so the page is the same on every load and the
// before & after shots of a change to it compare like with like. Each one is
// passed through the real `classify`, so the lanes follow the real rules.

const flows = require('./onboarding-flows');

// A small fixed-seed generator: the same people every time.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['mira', 'tobi', 'lena', 'okafor', 'jun', 'sable', 'rafa', 'ines', 'noor', 'pax', 'wren', 'ari',
  'cleo', 'dov', 'esme', 'finn', 'gia', 'hale', 'ivo', 'juno', 'kit', 'lux', 'moss', 'nell'];
const PUBLIC_APPS = ['Trail Log', 'Supper Club', 'Tally', 'Word Garden'];
const PRIVATE_APPS = ['Chore Wheel', 'Flat Budget', 'Team Lunch'];

function demo() {
  const rnd = seeded(20261113);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const chance = (p) => rnd() < p;
  const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  let id = 900500;
  const base = (over) => ({
    k: (id += 1), n: `sample_${pick(FIRST)}_${String(id).slice(-3)}`,
    door: 'direct', src: 'unrecorded', s1: false, tooNew: false, linkJoin: false, cohort: null, wait: null,
    got: 'in', stuck: null, stuckReason: null, first: 'none', opened: false, st: '', kinds: [], days: 0,
    failed: 0, taps: 0, mail: null, signup: null, acct: null, access: null, noAccount: false, arr: null, via: null,
    made: [], inv: null, shared: [], sent: 0, useDays: 0, useApps: 0, pubApp: null, pubDays: 0, pubN: 0,
    pubContrib: false, accepted: 0, lastA: null, lastC: null, recent: false,
    ...over,
  });
  // Somebody who is taking part: what they made, use and contribute.
  const active = (p, { level }) => {
    const heavy = level > 0.66;
    const apps = heavy ? between(3, 6) : (level > 0.3 ? between(1, 3) : (chance(0.5) ? 1 : 0));
    p.first = chance(0.8) ? 'app' : 'spoke';
    p.opened = true;
    p.st = heavy ? 'AEVBUS' : (level > 0.3 ? 'AEVB' : 'AEV');
    p.kinds = heavy ? ['change', 'feedback', 'vote'] : (level > 0.3 ? ['feedback', 'vote'] : ['vote']);
    p.pubContrib = level > 0.15;
    p.pubN = apps;
    p.pubApp = apps ? pick(PUBLIC_APPS) : null;
    p.pubDays = apps ? between(2, heavy ? 30 : 9) : 0;
    p.useApps = apps;
    p.useDays = apps ? p.pubDays + between(0, heavy ? 40 : 6) : 0;
    p.accepted = heavy ? between(6, 14) : (level > 0.4 ? between(1, 5) : 0);
    if (chance(heavy ? 0.6 : 0.2)) p.made = [{ n: pick(chance(0.5) ? PUBLIC_APPS : PRIVATE_APPS), aud: chance(0.5) ? 'public' : 'private', at: '2026-09-12' }];
    const lapsed = chance(heavy ? 0.05 : 0.35);
    p.lastA = lapsed ? between(35, 80) : between(0, 20);
    p.lastC = p.lastA + between(0, 6);
    p.recent = !lapsed;
    return p;
  };

  const people = [];
  // Here before the waitlist.
  for (let i = 0; i < 34; i += 1) {
    const p = base({ door: 'direct', src: 'season1', s1: true, acct: '2026-05-20', access: '2026-08-01', days: 104 });
    people.push(chance(0.85) ? active(p, { level: rnd() }) : { ...p, opened: chance(0.5), stuck: 'opened', stuckReason: 'Has access, never opened Homeroom' });
  }
  // Off the waitlist, in three cohorts; the newest was let in this week.
  const cohorts = [['2026-10-01', 43, 9], ['2026-10-28', 16, 12], ['2026-11-10', 3, 14]];
  for (const [cohort, days, size] of cohorts) {
    for (let i = 0; i < size; i += 1) {
      const p = base({
        door: 'waitlist', cohort, days, wait: between(3, 70), tooNew: days < flows.TOO_NEW_DAYS,
        src: pick(['x', 'x', 'friend', 'event', 'other', 'unrecorded']), mail: [chance(0.6), chance(0.2)],
        arr: chance(0.25) ? { t: 'rec', l: pick(['X', 'Reddit', 'Campaign: launch']) } : (chance(0.2) ? { t: 'noref' } : null),
      });
      if (chance(0.55)) {
        p.noAccount = true;
        p.got = p.tooNew ? 'new' : (chance(0.25) ? 'mail_none' : 'mail_ignored');
        p.stuck = p.got === 'mail_none' ? 'mail_sent' : 'code_asked';
        p.stuckReason = p.got === 'mail_none' ? 'No admit mail on record' : 'Has not followed the mail';
        if (p.got === 'mail_none') p.mail = null;
        people.push(p);
      } else {
        p.acct = cohort; p.access = cohort;
        people.push(chance(0.6) ? active(p, { level: rnd() * 0.7 }) : { ...p, opened: chance(0.5), stuck: 'first_act', stuckReason: 'Inside, no act yet' });
      }
    }
  }
  // By a member's invite link, into three projects.
  const sharers = people.filter((p) => p.s1 && p.recent).slice(0, 3);
  const projects = [[PRIVATE_APPS[0], 'private', 6], [PRIVATE_APPS[1], 'private', 4], [PUBLIC_APPS[1], 'public', 5]];
  projects.forEach(([app, aud, size], si) => {
    const host = sharers[si];
    const reached = [];
    for (let i = 0; i < size; i += 1) {
      const waiting = chance(0.2);
      const p = base({
        door: 'invite', src: 'invite', days: between(4, 40), acct: '2026-10-20', access: waiting ? null : '2026-10-21',
        got: waiting ? 'waiting' : 'in', stuck: waiting ? 'joined' : null, stuckReason: waiting ? 'Waiting for access to join' : null,
        inv: { by: host.n, n: app, aud, how: pick(['signed_up', 'signed_up', 'was_signed_in']), status: waiting ? 'waiting' : 'joined', seen: true },
        via: chance(0.5) ? { t: 'rec', l: pick(['WhatsApp', 'Link copied', 'Discord']) } : null,
      });
      p.arr = p.via;
      reached.push(p.k);
      if (waiting) { people.push(p); continue; }
      if (!chance(0.75)) { people.push({ ...p, opened: true, first: 'joined', st: 'A', lastA: between(0, 20), recent: true }); continue; }
      active(p, { level: rnd() * 0.8 });
      // Some people a private project brought in stay in it and nowhere else.
      if (aud === 'private' && chance(0.75)) Object.assign(p, { pubContrib: false, pubN: 0, pubApp: null, pubDays: 0 });
      people.push(p);
    }
    host.shared.push({ n: app, aud, own: true, inv: reached });
    host.sent += size + between(0, 3);
  });

  const out = people.map((p) => flows.classify(p));
  const pubApps = PUBLIC_APPS.map((n) => ({
    n, vis: out.filter((p) => p.pubApp === n).length + 3, back: out.filter((p) => p.pubApp === n).length, mk: [sharers[0].n],
  })).sort((a, b) => b.back - a.back);
  return {
    demo: true,
    asOf: '2026-11-13T12:00:00.000Z',
    early: { label: 'Season 1', until: '2026-06-30' },
    rules: { recentDays: flows.RECENT_DAYS, tooNewDays: flows.TOO_NEW_DAYS, returnDays: flows.RETURN_DAYS },
    people: out,
    ghost: [],
    pubApps,
    nPublic: pubApps.length,
    nApps: PUBLIC_APPS.length + PRIVATE_APPS.length,
    waiting: {
      people: 48, counted: 48, medianDays: 37, longestDays: 71,
      waited: [['under_2_weeks', 6], ['2_to_5_weeks', 14], ['6_to_12_weeks', 28]],
      far: [['confirmed', 44], ['answered', 12], ['account', 2], ['none', 4]],
      said: [['x', 21], ['not_said', 15], ['friend', 8], ['other', 4]],
      form: [['form', 46], ['account', 2]],
      months: [['2026-09', 30], ['2026-10', 14], ['2026-11', 4]],
    },
    cut: false,
  };
}

module.exports = { demo };
