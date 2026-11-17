'use strict';

// Demo payload for Admin › Journey's Growth reading (services/growth.js),
// served only under staging with ?demo=1 (src/routes/admin.js), like the
// other Journey readings in services/journey-demo.js. Every person is
// invented. The shape is services/growth.js reading()'s, marked `demo: true`;
// the newcomers' path roughly follows the autumn the page was designed on:
// about a hundred let in one at a time, a few dozen opened Homeroom, ten
// stayed, and one group of four built twice in an evening and did not come
// back.

const growth = require('./growth');

// Weeks from the one before the era to a fixed "now", so the demo does not
// drift as real time passes.
const NOW = new Date('2026-11-17T10:00:00Z');
const WEEKS = growth.eraWeeks(NOW);

// A small deterministic generator: the same demo on every load.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const day = (iso) => `${iso}T12:00:00.000Z`;
const weekOf = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10);
};

function person(n, fields) {
  return {
    key: `d${n}`, userId: fields.account === false ? null : 900200 + n, name: fields.account === false ? null : `demo_${String(n).padStart(3, '0')}`,
    early: false, seasonEarly: false, connected: false,
    way: 'waitlist', admittedDay: null, cameAt: null, heard: null, mail: null,
    opened: false, stayed: false, lastSeen: null, bestSeconds: null, visitBins: growth.TIME_BINS.map(() => 0), activeWeeks: [],
    last7: { opened: false, used: false, contributed: false, analyticsWau: false },
    ...fields,
  };
}

// Invented time in an app, shaped like the real reading: who stayed spent
// minutes, who only opened left within seconds or never reached an app.
function withTime(p, n) {
  if (!p.opened) return p;
  const best = p.stayed ? 170 + ((n * 37) % 700) : (n % 3 === 0 ? 0 : 5 + (n % 11));
  if (!best) return p;
  const bin = (s) => growth.TIME_BINS.filter((edge) => s >= edge).length - 1;
  const visitBins = growth.TIME_BINS.map(() => 0);
  visitBins[bin(best)] += 1;
  if (p.stayed) { visitBins[bin(4 + (n % 20))] += 1; visitBins[bin(40 + (n % 200))] += 1 + (n % 3); }
  return { ...p, bestSeconds: best, visitBins };
}

function reading() {
  const people = [];
  let n = 0;
  // The group: an organiser from the first admit day and three friends who
  // came by the organiser's invite link on 2 Nov. Journey's demo people, so
  // their person view opens.
  const group = [900101, 900102, 900103, 900104];
  group.forEach((id, i) => {
    n += 1;
    people.push({
      ...person(n, {}), userId: id, name: ['mira_k', 'tobi', 'lena.s', 'okafor'][i],
      way: i === 0 ? 'waitlist' : 'link', admittedDay: i === 0 ? '2026-10-01' : null,
      cameAt: day(i === 0 ? '2026-10-01' : '2026-11-02'), heard: i === 0 ? 'friend' : null, mail: i === 0 ? 'clicked' : null,
      opened: true, stayed: true, lastSeen: day(i === 0 ? '2026-11-16' : '2026-11-03'),
      activeWeeks: i === 0 ? ['2026-10-26', '2026-11-02', '2026-11-16'] : ['2026-11-02'],
      last7: { opened: i === 0, used: i === 0, contributed: i === 0, analyticsWau: i === 0 },
    });
  });
  // The rest of the newcomers: admit days, and how far each got.
  const r = rng(6361);
  const days = [['2026-09-19', 4], ['2026-09-29', 2], ['2026-10-01', 9], ['2026-10-09', 2], ['2026-10-28', 16],
    ['2026-11-03', 2], ['2026-11-06', 26], ['2026-11-13', 30]];
  const heard = ['x', 'x', 'friend', null, null, 'linkedin', 'event', 'other'];
  for (const [admit, count] of days) {
    for (let k = 0; k < count; k += 1) {
      n += 1;
      const account = r() < 0.4;
      const opened = account && r() < 0.5;
      const stayed = opened && r() < 0.55;
      const later = WEEKS.filter((w) => w >= weekOf(admit));
      const weeks = stayed ? later.filter((w, i) => i === 0 || r() < 0.25) : [];
      people.push(person(n, {
        account, admittedDay: admit, cameAt: day(admit), heard: heard[Math.floor(r() * heard.length)],
        mail: r() < 0.6 ? (r() < 0.2 ? 'clicked' : r() < 0.4 ? 'opened' : 'sent') : 'not_on_record',
        opened, stayed, lastSeen: opened ? day(later[Math.min(later.length - 1, Math.floor(r() * later.length))] || admit) : null,
        activeWeeks: weeks,
        last7: { opened: opened && r() < 0.4, used: stayed && r() < 0.4, contributed: stayed && r() < 0.3, analyticsWau: opened && r() < 0.4 },
      }));
    }
  }
  // Signed up on their own, never let in.
  for (let k = 0; k < 8; k += 1) {
    n += 1;
    people.push(person(n, { way: 'signup', cameAt: day(['2026-09-26', '2026-10-27', '2026-10-30', '2026-11-05', '2026-11-11'][k % 5]) }));
  }
  // The early community: Season 1 and older accounts, busy every week.
  const groupsEveryone = [];
  for (let k = 0; k < 170; k += 1) {
    n += 1;
    const busy = r();
    const weeks = WEEKS.filter(() => r() < busy * 0.9);
    people.push(person(n, {
      early: true, seasonEarly: k < 135, way: 'signup', cameAt: day('2026-03-01'),
      opened: true, stayed: busy > 0.25, lastSeen: weeks.length ? day(weeks[weeks.length - 1]) : day('2026-06-20'),
      activeWeeks: weeks,
      last7: { opened: busy > 0.5, used: busy > 0.55, contributed: busy > 0.5, analyticsWau: busy > 0.45 },
    }));
  }
  for (let g = 0; g < 30; g += 1) {
    const weeks = WEEKS.filter(() => r() < 0.45);
    if (!weeks.length) continue;
    const members = [];
    for (let k = 0; k < 3 + Math.floor(r() * 4); k += 1) members.push(900200 + 112 + Math.floor(r() * 170));
    groupsEveryone.push({
      appId: 910000 + g, weeks, people: [...new Set(members)].sort((a, b) => a - b), cameBack: weeks.length >= 2,
      name: `Demo project ${g + 1}`, slug: `demo-project-${g + 1}`, private: false, madeAt: day('2026-09-20'),
      builds: 2 + Math.floor(r() * 30), firstBuildMinutes: 20 + Math.floor(r() * 60),
    });
  }
  const theGroup = {
    appId: 910100, weeks: ['2026-11-02'], people: group, cameBack: false,
    name: 'Space shooter (demo)', slug: 'space-shooter-demo', private: true, madeAt: '2026-11-02T19:47:00.000Z',
    builds: 2, firstBuildMinutes: 34,
  };
  return {
    demo: true,
    eraStart: growth.ERA_START,
    groupMin: growth.GROUP_MIN,
    staySeconds: growth.STAY_SECONDS,
    timeBins: growth.TIME_BINS,
    weeks: WEEKS,
    thisWeek: WEEKS[WEEKS.length - 1],
    people: people.map(withTime),
    groups: { newcomers: [theGroup], everyone: [theGroup, ...groupsEveryone] },
  };
}

// The demo group's evening, minute by minute (UTC).
function timeline(appId) {
  const at = (hm) => `2026-11-02T${hm}:00.000Z`;
  const msgs = ['20:00', '20:03', '20:06', '20:09', '20:12', '20:22', '20:24', '20:26', '20:29', '20:31', '20:33', '20:35'];
  return {
    appId: Number(appId) || 910100,
    demo: true,
    events: [
      { kind: 'made', at: at('19:47'), userId: 900101, until: null },
      { kind: 'joined', at: at('19:47'), userId: 900101, until: null },
      { kind: 'build', at: at('19:48'), userId: 900101, until: at('20:21') },
      { kind: 'joined', at: at('19:58'), userId: 900102, until: null },
      { kind: 'joined', at: at('20:05'), userId: 900103, until: null },
      { kind: 'joined', at: at('20:05'), userId: 900104, until: null },
      { kind: 'build', at: at('20:28'), userId: 900102, until: at('20:35') },
      ...msgs.map((m, i) => ({ kind: 'message', at: at(m), userId: 900101 + (i % 4), until: null })),
    ].sort((a, b) => a.at.localeCompare(b.at)),
  };
}

module.exports = { reading, timeline, NOW };
