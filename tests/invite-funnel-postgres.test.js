'use strict';

// #4176: "someone opened your invite" only once they sign in, and the admin
// Journey's invite funnel: opened, signed in, joined.
//
//   - An invite link opened signed out (the page's anonymous preview read)
//     tells its maker nothing: no notification, no push. It is still one
//     open for the Journey, once per browser (invite_opened, signedIn false).
//   - Signing in or up from the link (communityInvites.redeemCarried), or
//     opening it already signed in (the signed-in standing read), is the
//     funnel's middle step: invite_signed_in, once per person per link
//     (journey-events.noteInviteSignedIn, the unique index in schema.sql).
//   - journey.firstSession's `opens` counts the three, from the first
//     sign-in through an invite.
//
// The pure reading always runs. The rest runs through the real routes
// against the full schema in a throwaway database: required when
// TEST_DATABASE_URL is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the funnel reading: from the first sign-in through an invite, everyone\'s, never a silent zero', () => {
  const week = { start: new Date('2026-09-28T00:00:00Z'), end: new Date('2026-10-05T00:00:00Z') };
  const row = { since: '2026-09-30T12:00:00Z', opened: 9, signed_in: 4, joined: 2 };
  assert.deepEqual(journey.inviteFunnelReading(row, { week }),
    { from: '2026-09-30T12:00:00.000Z', opened: 9, signedIn: 4, joined: 2 },
    'counted from the first sign-in, which came during the week');
  assert.equal(journey.inviteFunnelReading({ ...row, since: '2026-09-01T00:00:00Z' }, { week }).from,
    '2026-09-28T00:00:00.000Z', 'from the start of the week once the record is older');
  assert.equal(journey.inviteFunnelReading({ ...row, since: null }, { week }).recorded, false, 'never recorded');
  assert.equal(journey.inviteFunnelReading({ ...row, since: '2026-10-06T00:00:00Z' }, { week }).recorded, false,
    'a week before the record began');
  assert.equal(journey.inviteFunnelReading(undefined, { week }).recorded, false);
  assert.match(journey.inviteFunnelReading(row, { week, cohort: true }).reason, /everyone only/,
    'an open signed out is in no cohort');
});

test('the event is registered, recorded once per person per link, and before a carried link is followed', () => {
  const events = require('../src/services/events');
  assert.equal(events.EVENT_TYPES.INVITE_SIGNED_IN, 'invite_signed_in');
  assert.match(read('src/db/schema.sql'),
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_events_invite_signed_in_once\n {2}ON events \(user_id, \(metadata->>'inviteId'\)\)\n {2}WHERE event_type = 'invite_signed_in';/);
  const service = read('src/services/community-invites.js');
  const carried = service.slice(service.indexOf('async function redeemCarried'));
  assert.ok(carried.indexOf("noteInviteSignedIn(pool, { token, userId: user.id, carried: true })")
    < carried.indexOf('await redeem(pool,'), 'recorded while they are not in it yet');
});

test('invite opens, sign-ins and joins through the real routes, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'invite_funnel_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  // See tests/username-invite-join-postgres.test.js: the teardown's forced
  // DROP can reach a connection still closing.
  pool.on('error', () => {});
  await pool.query(read('src/db/schema.sql'));
  const config = { databaseUrl: String(url), selfAppSlug: 'no-such-self-app', challengeScorer: { intervalMinutes: 0 } };
  const { getPool } = require('../src/db/pool');
  t.after(async () => {
    await getPool(config).end().catch(() => {});
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  // No live sockets here. The events are what is under test, so they stay.
  require('../src/services/ws').pushNotificationToUser = () => {};
  const invites = require('../src/services/community-invites');

  async function user(username, { daysOld = 0 } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, created_at)
       VALUES ($1, 'x', TRUE, NOW() - make_interval(days => $2)) RETURNING id, username`,
      [username, daysOld]);
    return rows[0];
  }
  const maya = await user('maya', { daysOld: 30 });
  const sam = await user('sam', { daysOld: 30 });
  const dan = await user('dan', { daysOld: 2 });
  const { rows: [made] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, status) VALUES ('Run Club', 'run-club', $1, 'running') RETURNING id`, [maya.id]);
  await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())`,
    [made.id, maya.id]);
  const app = (await pool.query('SELECT * FROM apps WHERE id = $1', [made.id])).rows[0];
  const link = await invites.createInvite(pool, { app, user: { id: maya.id, isAdmin: false }, days: 0, maxUses: 0 });
  assert.equal(link.ok, true);
  const token = link.link.token;

  const express = require('express');
  const cookieParser = require('cookie-parser');
  const communityInviteRoutes = require('../src/routes/community-invites');
  const server = express();
  server.use(cookieParser());
  server.use(express.json());
  let as = null;
  server.use((req, _res, next) => {
    // Like authMiddleware: nobody is resolved under /api/public/.
    if (as && !req.path.startsWith('/api/public/')) {
      req.user = { id: as.id, username: as.username, isAdmin: false, hasPlatformAccess: true };
    }
    next();
  });
  server.use(communityInviteRoutes(config));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${listener.address().port}`;
  // One browser: the hr_iv cookie it is handed, sent back on every read.
  const browserCookie = (res) => {
    const set = res.headers.getSetCookie().find((c) => c.startsWith('hr_iv='));
    return set ? set.split(';')[0] : null;
  };
  const get = async (p, { who = null, cookie = null } = {}) => {
    as = who;
    const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
    return { status: res.status, body: await res.json(), cookie: browserCookie(res) };
  };

  const opensNotices = async () => (await pool.query(
    `SELECT id, detail FROM notifications WHERE user_id = $1 AND kind = 'invite_opened' ORDER BY id`, [maya.id])).rows;
  const eventsOf = async (type) => (await pool.query(
    `SELECT user_id, metadata FROM events WHERE event_type = $1 ORDER BY id`, [type])).rows;
  // The open is counted after the answer goes (fire and forget): wait for
  // its row.
  const settled = async (n) => {
    for (let i = 0; i < 60; i += 1) {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM community_invite_opens');
      if (rows[0].n >= n) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));
  };

  let firstBrowser = null;
  await t.test('an anonymous preview read tells the maker nothing, and records one open per browser', async () => {
    const first = await get(`/api/public/invites/${token}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.live, true);
    assert.ok(first.cookie, 'the browser is given its cookie');
    firstBrowser = first.cookie;
    await settled(1);
    assert.deepEqual(await opensNotices(), [], 'no "Someone opened your invite"');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM mobile_push_deliveries')).rows[0].n, 0, 'and no push');
    // The same browser again, and a second one.
    await get(`/api/public/invites/${token}`, { cookie: firstBrowser });
    await get(`/api/public/invites/${token}`);
    await settled(2);
    assert.deepEqual(await opensNotices(), []);
    assert.deepEqual((await eventsOf('invite_opened')).map((e) => [e.user_id, e.metadata.signedIn, e.metadata.inviteId]),
      [[null, false, link.link.id], [null, false, link.link.id]], 'two browsers, two opens; the second read of one is not a third');
    assert.deepEqual(await eventsOf('invite_signed_in'), [], 'nobody has signed in');
  });

  await t.test('the same browser signed in is news to the maker, and has the link in hand signed in', async () => {
    const read1 = await get(`/api/invite-links/by-token/${token}`, { who: sam, cookie: firstBrowser });
    assert.equal(read1.status, 200);
    assert.equal(read1.body.mine, null);
    let notices = [];
    for (let i = 0; i < 60 && !notices.length; i += 1) {
      notices = await opensNotices();
      if (!notices.length) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(notices.length, 1, '"Someone opened your invite", now they are signed in');
    assert.equal(notices[0].detail, null, 'one person');
    await get(`/api/invite-links/by-token/${token}`, { who: sam, cookie: firstBrowser });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await opensNotices())[0].detail, null, 'opening it again is not news');
    assert.equal((await eventsOf('invite_opened')).length, 2, 'their open was the signed-out one: not counted twice');
    assert.deepEqual((await eventsOf('invite_signed_in')).map((e) => [e.user_id, e.metadata.how, e.metadata.inviteId]),
      [[sam.id, 'was_signed_in', link.link.id]], 'once per person per link');
    // The maker reading their own link is in no step.
    await get(`/api/invite-links/by-token/${token}`, { who: maya });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await eventsOf('invite_signed_in')).length, 1);
  });

  // A sign-in that carried the link, as routes/auth.js hands it over.
  const signInCarrying = async (account, cookie) => {
    const browserValue = cookie.split('=')[1];
    const cleared = [];
    const req = { cookies: { [invites.INVITE_COOKIE]: token, hr_iv: browserValue }, headers: {} };
    const res = { clearCookie: (n) => cleared.push(n), cookie: () => {} };
    const result = await invites.redeemCarried(pool, req, res, account.id);
    assert.deepEqual(cleared, [invites.INVITE_COOKIE], 'the carried link is spent');
    return result;
  };

  await t.test('signing up or in from a link opened signed out joins, and the maker only hears the join', async () => {
    // Carol opens the link signed out, then signs up from its page.
    const carolBrowser = (await get(`/api/public/invites/${token}`)).cookie;
    const danBrowser = (await get(`/api/public/invites/${token}`)).cookie;
    await settled(4);
    const carol = await user('carol');
    assert.equal((await signInCarrying(carol, carolBrowser)).status, 'joined');
    // Dan, whose account is two days old, signs in from it (its Join).
    assert.equal((await signInCarrying(dan, danBrowser)).status, 'joined');
    const signedIn = (await eventsOf('invite_signed_in')).map((e) => [e.user_id, e.metadata.how]);
    assert.deepEqual(signedIn, [[sam.id, 'was_signed_in'], [carol.id, 'signed_up'], [dan.id, 'signed_in']]);
    let joins = [];
    for (let i = 0; i < 60 && joins.length < 1; i += 1) {
      joins = (await pool.query(
        `SELECT detail FROM notifications WHERE user_id = $1 AND kind = 'member_joined'`, [maya.id])).rows;
      if (!joins.length) await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(joins.length, 1, '"Joined through your invite"');
    assert.deepEqual((await opensNotices()).map((n) => n.detail), [null],
      'the open notice is still Sam alone: Carol and Dan were never on it');
    // Following the link again: in it already, so no step counts twice.
    await signInCarrying(dan, danBrowser);
    assert.equal((await eventsOf('invite_signed_in')).length, 3);
  });

  await t.test('the Journey reads the three steps, real people where a person is known', async () => {
    const window = journey.allTime();
    const r = await journey.firstSession(pool, { week: window });
    const since = (await pool.query(
      `SELECT MIN(created_at) AS at FROM events WHERE event_type = 'invite_signed_in'`)).rows[0].at;
    // Counted from Sam's sign-in, the first through an invite: the two
    // browsers that opened it before then came before the record began.
    // Carol's and Dan's opens are after it.
    assert.deepEqual(r.opens, { from: new Date(since).toISOString(), opened: 2, signedIn: 3, joined: 2 },
      'two opens, three people signed in with it, two joined');
    assert.equal(r.recordedFrom.signedIn, new Date(since).toISOString());
    // Dan on the left-out list: his sign-in and join go, his open signed
    // out cannot.
    const left = await journey.firstSession(pool, { week: window, leftOutIds: [dan.id] });
    assert.deepEqual([left.opens.opened, left.opens.signedIn, left.opens.joined], [2, 2, 1]);
    // A week before the first sign-in through an invite reads "not recorded".
    const old = await journey.firstSession(pool, { week: journey.parseWeek('2026-01-05', new Date()) });
    assert.equal(old.opens.recorded, false);
  });
});
