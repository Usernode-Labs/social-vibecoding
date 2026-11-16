'use strict';

// Admin › Onboarding flows: the reading the flow chart is drawn from
// (src/services/onboarding-flows.js). The join is pure, so its rules are
// pinned here without a database: which door a person came through, where
// they arrived from, how far they got, which lane they are in, and when a
// lane lapses. The queries themselves run in
// tests/onboarding-flows-postgres.test.js.

process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const flows = require('../src/services/onboarding-flows');
const demo = require('../src/services/onboarding-flows-demo');

const NOW = new Date('2026-11-13T12:00:00Z');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const done = (key, note) => ({ key, state: 'done', note: note || null });
const open = (key) => ({ key, state: 'open' });
// One person of the first mile, in and active unless a test says otherwise.
const person = (over = {}) => ({
  userId: 1, signupId: null, name: 'ana', hasAccount: true, invitedOnly: false,
  releasedAt: null, accountAt: '2026-10-01T10:00:00Z', accessAt: '2026-10-01T10:00:00Z', inviteAt: null,
  invite: null, waitlist: null, cameFrom: null, mail: null, daysSince: 43, stuckAt: null, stuckReason: null,
  steps: [done('account'), done('access'), done('opened'), done('first_act', 'app')],
  ...over,
});
const assembled = (people, extra = {}) => flows.assemble({
  mile: { people }, flows: { apps: [], people: [] }, stages: { people: [] }, last: new Map(), waiting: null, now: NOW, ...extra,
});

test('a channel is the best recorded evidence, named by platform where it is one', () => {
  assert.deepEqual(flows.channel({ host: 't.co' }), { t: 'rec', l: 'X' });
  assert.deepEqual(flows.channel({ host: 'web.whatsapp.com' }), { t: 'rec', l: 'WhatsApp' });
  assert.deepEqual(flows.channel({ host: 'blog.example.org' }), { t: 'rec', l: 'blog.example.org' });
  assert.deepEqual(flows.channel({ host: 'none', utm: 'launch' }), { t: 'rec', l: 'Campaign: launch' });
  assert.deepEqual(flows.channel({ tag: 'partner-a' }), { t: 'rec', l: 'Tag: partner-a' });
  assert.deepEqual(flows.channel({ via: 'copied' }), { t: 'rec', l: 'Link copied' });
  assert.deepEqual(flows.channel({ host: 'none' }), { t: 'noref' }, 'looked for, and none given');
  assert.equal(flows.channel({}), null, 'nothing recorded');
});

test('a lane holds only while the person is active', () => {
  const base = { first: 'app', st: 'AV', shared: [], inv: null, got: 'in', pubContrib: false, pubN: 0, recent: true };
  assert.equal(flows.classify(base).lane, 'none');
  assert.equal(flows.classify({ ...base, pubContrib: true }).lane, 'pub');
  assert.equal(flows.classify({ ...base, pubN: 1 }).out, 'pub_user', 'came back to a public project without contributing');
  const shared = { ...base, shared: [{ n: 'Garden', aud: 'private', own: true, inv: [2] }] };
  assert.equal(flows.classify(shared).lane, 'share');
  assert.equal(flows.classify({ ...shared, pubContrib: true }).lane, 'both');
  assert.equal(flows.classify({ ...base, shared: [{ n: 'Atlas', aud: 'public', own: true, inv: [2] }] }).lane, 'none',
    'bringing someone into a public project is not being in a private one');
  const joined = { ...base, inv: { aud: 'private', status: 'joined' } };
  assert.equal(flows.classify(joined).lane, 'share', 'joined a private project and did something');
  assert.equal(flows.classify({ ...joined, first: 'none', st: 'A' }).lane, 'none', 'joined and did nothing');
  assert.equal(flows.classify({ ...joined, inv: { aud: 'private', status: 'waiting' } }).lane, 'none');
  const lapsed = flows.classify({ ...shared, pubContrib: true, recent: false });
  assert.deepEqual([lapsed.lane, lapsed.out, lapsed.priv, lapsed.pub], ['none', 'lapsed', false, null]);
  assert.equal(flows.classify({ ...base, recent: false }).out, 'none', 'never in a lane is not lapsed');
});

test('the door is the invite when it was followed before they were in, else the waitlist, else let in directly', () => {
  const invite = { by: 'ben', project: 'Garden', slug: 'garden', how: 'signed_up', status: 'joined', openedAt: '2026-09-30T09:00:00Z' };
  const out = assembled([
    person({ userId: 1, name: 'direct' }),
    person({ userId: 2, name: 'waited', releasedAt: '2026-09-28T10:00:00Z', waitlist: { joinedAt: '2026-09-01T10:00:00Z', waitedDays: 27, discovery: 'Friend' } }),
    person({ userId: 3, name: 'invited', invite, inviteAt: '2026-09-30T09:00:00Z' }),
    person({ userId: 4, name: 'inside_first', invite, inviteAt: '2026-10-20T09:00:00Z' }),
    person({ userId: 5, name: 'both_ways', invite, inviteAt: '2026-08-20T09:00:00Z', releasedAt: '2026-09-28T10:00:00Z', waitlist: { joinedAt: '2026-09-01T10:00:00Z', waitedDays: 27, discovery: null } }),
    person({ userId: 6, name: 'typed', releasedAt: '2026-09-28T10:00:00Z', waitlist: { joinedAt: '2026-09-01T10:00:00Z', waitedDays: 27, discovery: 'a podcast' } }),
    // Signed up through a link: queued on the waitlist a moment before the
    // invite was recorded, and let in a week later.
    person({ userId: 7, name: 'queued_invitee', invite, inviteAt: '2026-09-21T10:00:05Z', releasedAt: '2026-09-28T10:00:00Z', waitlist: { joinedAt: '2026-09-21T10:00:00Z', waitedDays: 7, discovery: 'Friend' } }),
  ]);
  const by = Object.fromEntries(out.people.map((p) => [p.n, p]));
  assert.deepEqual([by.direct.door, by.direct.src], ['direct', 'unrecorded']);
  assert.deepEqual([by.waited.door, by.waited.src, by.waited.wait, by.waited.cohort], ['waitlist', 'friend', 27, '2026-09-28']);
  assert.deepEqual([by.invited.door, by.invited.src, by.invited.linkJoin], ['invite', 'invite', false]);
  assert.deepEqual([by.inside_first.door, by.inside_first.linkJoin], ['direct', true], 'an invite followed from inside is not the door');
  assert.equal(by.both_ways.door, 'invite', 'the invite came before they joined the waitlist');
  assert.deepEqual([by.queued_invitee.door, by.queued_invitee.src, by.queued_invitee.wait], ['invite', 'invite', 7],
    'a waitlist row of their own does not make the waitlist their door');
  assert.equal(by.typed.src, 'other', 'anything else they typed');
  assert.deepEqual(by.invited.inv, { by: 'ben', n: 'Garden', aud: 'private', how: 'signed_up', status: 'joined', seen: true });
});

test('how far they got: in, waiting, the mail not followed, or too early to say', () => {
  const waitlist = { joinedAt: '2026-09-01T10:00:00Z', waitedDays: 30, discovery: null };
  const none = { hasAccount: false, userId: null, accountAt: null, accessAt: null, steps: [open('account')], waitlist };
  const out = assembled([
    person({ userId: 1, name: 'in' }),
    person({ ...none, signupId: 11, releasedAt: '2026-10-01T10:00:00Z', stuckAt: 'code_asked' }),
    person({ ...none, signupId: 12, releasedAt: '2026-10-01T10:00:00Z', stuckAt: 'mail_sent' }),
    person({ ...none, signupId: 13, releasedAt: '2026-11-10T10:00:00Z', stuckAt: 'mail_sent' }),
    person({ userId: 2, name: 'queued', invitedOnly: true, accessAt: null, steps: [done('account'), open('access')] }),
    person({ userId: 3, name: 'quiet', steps: [done('account'), done('access'), open('opened'), open('first_act')] }),
  ]);
  const by = Object.fromEntries(out.people.map((p) => [p.k, p]));
  assert.deepEqual([by[1].got, by[1].first, by[1].opened], ['in', 'app', true]);
  assert.deepEqual([by.s11.got, by.s11.n, by.s11.noAccount, by.s11.tooNew], ['mail_ignored', 'Signup #11', true, false]);
  assert.equal(by.s12.got, 'mail_none');
  assert.deepEqual([by.s13.got, by.s13.tooNew], ['new', true], 'let off three days ago: not lost yet');
  assert.equal(by[2].got, 'waiting');
  assert.deepEqual([by[3].got, by[3].first, by[3].opened], ['in', 'none', false]);
  assert.deepEqual(out.rules, { recentDays: 28, tooNewDays: 7, returnDays: 2 });
});

test('an account made while waiting, not opened since being let in, is the waitlist\'s loss; a join the platform applied is not an act', () => {
  const waitlist = { joinedAt: '2026-08-20T10:00:00Z', waitedDays: 40, discovery: null };
  const idle = [done('account'), done('access'), open('opened'), open('first_act')];
  const at = (key, when, note) => ({ key, state: 'done', at: when, note: note || null });
  const out = assembled([
    // Signed up in August, let in in October, never back.
    person({ userId: 1, name: 'away', accountAt: '2026-08-21T10:00:00Z', releasedAt: '2026-10-01T10:00:00Z', accessAt: '2026-10-01T10:00:00Z', waitlist, steps: idle }),
    // The same, let in three days ago.
    person({ userId: 2, name: 'fresh', accountAt: '2026-08-21T10:00:00Z', releasedAt: '2026-11-10T10:00:00Z', accessAt: '2026-11-10T10:00:00Z', waitlist, steps: idle }),
    // The same, and came back.
    person({ userId: 3, name: 'back', accountAt: '2026-08-21T10:00:00Z', releasedAt: '2026-10-01T10:00:00Z', accessAt: '2026-10-01T10:00:00Z', waitlist }),
    // Made the account from the admit mail, minutes after being let off, and never opened it.
    person({ userId: 4, name: 'from_mail', accountAt: '2026-10-01T10:20:00Z', releasedAt: '2026-10-01T10:00:00Z', accessAt: '2026-10-01T10:20:00Z', waitlist, steps: idle }),
    // A queued invite, joined for them at the moment they were let in.
    person({ userId: 5, name: 'queued', accountAt: '2026-09-10T10:00:00Z', releasedAt: '2026-10-01T10:00:00Z', accessAt: '2026-10-01T10:00:00.000Z', waitlist,
      steps: [done('account'), done('access'), { key: 'opened', state: 'skipped' }, at('first_act', '2026-10-01T10:00:00.000Z', 'joined')] }),
    // Joined a community themselves, a day after being let in.
    person({ userId: 6, name: 'joiner', accountAt: '2026-09-10T10:00:00Z', releasedAt: '2026-10-01T10:00:00Z', accessAt: '2026-10-01T10:00:00Z', waitlist,
      steps: [done('account'), done('access'), done('opened'), at('first_act', '2026-10-02T09:00:00Z', 'joined')] }),
    // Never on the waitlist: an old account given access later is not this.
    person({ userId: 7, name: 'old_hand', accountAt: '2026-05-01T10:00:00Z', accessAt: '2026-08-01T10:00:00Z', steps: idle }),
  ]);
  const by = Object.fromEntries(out.people.map((p) => [p.n, p]));
  assert.deepEqual([by.away.got, by.away.noAccount, by.away.first, by.away.lane], ['away', false, 'none', 'none']);
  assert.deepEqual([by.fresh.got, by.fresh.tooNew, by.fresh.noAccount], ['new', true, false], 'this week: too early to say, with an account');
  assert.deepEqual([by.back.got, by.back.first], ['in', 'app'], 'came back: in, like anyone else');
  assert.deepEqual([by.from_mail.got, by.from_mail.opened], ['in', false], 'signed up on being let in: a loss after signing up');
  assert.deepEqual([by.queued.got, by.queued.first], ['away', 'none'], 'the platform joined them; they did nothing');
  assert.deepEqual([by.joiner.got, by.joiner.first], ['in', 'joined']);
  assert.equal(by.old_hand.got, 'in');
});

test('projects are private or public by their audience, and a lane lapses after four weeks', () => {
  const apps = [
    { slug: 'garden', name: 'Garden', audience: 'invited', platform: false, madeAt: '2026-09-01T10:00:00Z', madeBy: { name: 'ana' } },
    { slug: 'atlas', name: 'Atlas', audience: 'open', platform: false, madeAt: '2026-09-02T10:00:00Z', madeBy: { name: 'cy' } },
    { slug: 'homeroom', name: 'Homeroom', audience: 'open', platform: true, madeAt: '2026-01-01T10:00:00Z', madeBy: null },
  ];
  const foot = (slug, over = {}) => ({ slug, made: false, member: true, invitedBy: null, days: 0, votes: 0, requests: 0, feedback: 0, changes: 0, live: 0, ...over });
  const out = assembled([person({ userId: 1, name: 'ana' }), person({ userId: 2, name: 'ben' }), person({ userId: 3, name: 'old' })], {
    flows: {
      apps,
      people: [
        { userId: 1, apps: [foot('garden', { made: true, days: 9, changes: 2, live: 2 }), foot('atlas', { days: 4 }), foot('homeroom', { days: 20 })],
          invites: [{ slug: 'garden', links: 2, direct: 1, reached: [{ userId: 2 }, { userId: 99 }] }] },
        { userId: 2, apps: [foot('garden', { days: 1 }), foot('atlas', { days: 1, votes: 3 })], invites: [] },
        { userId: 3, apps: [foot('atlas', { days: 6, feedback: 1 })], invites: [] },
      ],
    },
    stages: { people: [{ userId: 1, arrive: true, explore: true, activate: true, belong: false, use: true, stay: false, activateKinds: ['change'] }] },
    last: new Map([
      [1, { lastContribAt: '2026-11-01T10:00:00Z', lastAppDay: '2026-11-12' }],
      [2, { lastContribAt: '2026-10-20T10:00:00Z', lastAppDay: null }],
      [3, { lastContribAt: '2026-09-01T10:00:00Z', lastAppDay: '2026-09-20' }],
    ]),
    early: { label: 'Season 1', until: '2026-06-30T23:59:59Z' },
  });
  const [ana, ben, old] = out.people;
  assert.deepEqual(ana.made, [{ n: 'Garden', aud: 'private', at: '2026-09-01' }]);
  assert.deepEqual(ana.shared, [{ n: 'Garden', aud: 'private', own: true, inv: [2] }], 'only people who are counted');
  assert.deepEqual([ana.sent, ana.accepted, ana.st, ana.kinds], [3, 2, 'AEVU', ['change']]);
  assert.deepEqual([ana.pubApp, ana.pubDays, ana.pubN, ana.pubContrib], ['Atlas', 4, 1, false], 'the platform is nobody\'s public project');
  assert.deepEqual([ana.useApps, ana.useDays], [3, 33]);
  assert.deepEqual([ana.lane, ana.lastA, ana.lastC, ana.recent], ['both', 1, 12, true]);
  assert.deepEqual([ben.pubContrib, ben.pubN, ben.lane, ben.lastC], [true, 0, 'pub', 24]);
  assert.deepEqual([old.lane, old.out, old.recent, old.lastA], ['none', 'lapsed', false, 54]);
  assert.deepEqual(out.pubApps, [{ n: 'Atlas', vis: 3, back: 2, mk: ['cy'] }]);
  assert.deepEqual([out.nPublic, out.nApps], [1, 2]);
  assert.deepEqual(out.early, { label: 'Season 1', until: '2026-06-30' });
  assert.equal(ana.s1, false);
  assert.equal(out.asOf, NOW.toISOString());
});

test('the people who were here before the waitlist are named for the first season', () => {
  const out = assembled([person({ userId: 1, name: 'early', accountAt: '2026-05-20T10:00:00Z' }), person({ userId: 2, name: 'later' })],
    { early: { label: 'Season 1', until: '2026-06-30T23:59:59Z' } });
  assert.deepEqual(out.people.map((p) => [p.s1, p.src]), [[true, 'season1'], [false, 'unrecorded']]);
  assert.equal(assembled([person()]).early, null, 'no finished season: nobody is early');
});

test('an inviter who is not counted is listed with the counted people they reached', () => {
  const invite = { by: 'staff_lead', project: 'Atlas', slug: 'atlas', how: 'signed_up', status: 'joined', openedAt: null };
  const out = assembled([person({ userId: 1, name: 'ana', invite, inviteAt: '2026-09-30T09:00:00Z' }), person({ userId: 2, name: 'ben' })],
    { flows: { apps: [{ slug: 'atlas', name: 'Atlas', audience: 'open', platform: false }], people: [] } });
  assert.deepEqual(out.ghost, [{ n: 'staff_lead', shared: [{ n: 'Atlas', aud: 'public', own: false, inv: [1] }] }]);
});

test('the demo is whole, made up, the same every time, and follows the real lane rules', () => {
  const a = demo.demo();
  assert.deepEqual(a, demo.demo(), 'a fixed seed: the before and after shots compare like with like');
  assert.equal(a.demo, true);
  assert.deepEqual(Object.keys(a).filter((k) => k !== 'demo').sort(), Object.keys(assembled([person()])).sort(),
    'the same top-level keys as the real reading');
  assert.ok(a.people.every((p) => /^sample_/.test(p.n)), 'nobody here could be mistaken for a member');
  const real = Object.keys(assembled([person()]).people[0]).sort();
  for (const p of a.people) {
    assert.deepEqual(Object.keys(p).sort(), real, 'a demo person has the fields a real one has');
    const again = flows.classify(p);
    assert.deepEqual([again.lane, again.out], [p.lane, p.out]);
  }
  for (const lane of ['none', 'pub', 'share', 'both']) assert.ok(a.people.some((p) => p.lane === lane), `somebody in ${lane}`);
  for (const got of ['in', 'new', 'away', 'waiting', 'mail_ignored', 'mail_none']) assert.ok(a.people.some((p) => p.got === got), got);
  assert.ok(a.people.some((p) => p.out === 'lapsed'), 'somebody lapsed');
  const keys = new Set(a.people.map((p) => p.k));
  assert.equal(keys.size, a.people.length, 'one thread each');
  for (const p of a.people) for (const s of p.shared) for (const k of s.inv) assert.ok(keys.has(k), 'a link reaches people on the page');
});

test('the route answers the demo under staging without reading the database', async (t) => {
  require('../src/db/pool').getPool = () => ({
    async query() { throw new Error('a demo answer must not read the database'); },
    async connect() { throw new Error('a demo answer must not read the database'); },
  });
  const express = require('express');
  const { adminRoutes } = require('../src/routes/admin');
  const appX = express();
  appX.use((req, _res, next) => { req.user = { id: 1, username: 'lead', isAdmin: true }; next(); });
  appX.use(adminRoutes({ jwtSecret: 'test' }));
  const server = appX.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/onboarding-flows?demo=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.demo, true);
  assert.equal(body.people.length, demo.demo().people.length);
});

test('the read is on the Journey gate: any admin reads, and the left-out list applies', () => {
  const src = read('src/routes/admin.js');
  assert.match(src, /router\.get\('\/api\/admin\/onboarding-flows', journeyRead\('onboarding flows', \(\) => onboardingFlowsDemo\.demo\(\),\s*async \(req, ctx\) => onboardingFlows\.reading\(pool, ctx\)\)\);/);
  const svc = read('src/services/onboarding-flows.js');
  assert.match(svc, /journey\.everyoneMile\(pool, ctx\)/);
  assert.match(svc, /journey\.stages\(pool, \{ week: journey\.allTime\(now\), \.\.\.ctx \}\)/, 'all time, with the same people left out');
});
