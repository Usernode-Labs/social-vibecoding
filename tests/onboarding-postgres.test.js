'use strict';

// A new account's first run (communities, stage 5), against the REAL schema
// in a throwaway PostgreSQL database: what "What communities do you want to
// join?" lists and what answering it does, and the season's First
// challenges on Home, which #4635 drew as ordinary challenge cards: no gate
// holds the rest of the season back on Home, and the Getting started card
// and its routes are gone (the gate service itself lives on, for the
// Challenges tab and the mobile lists). New account, existing member and
// signed-out visitor, the done state, and a gate that stays open. Driven
// through the routes (src/routes/onboarding.js, src/routes/home-panels.js)
// so the HTTP shapes are pinned too.
// Skipped when no server is reachable, required when TEST_DATABASE_URL is
// set, like tests/communities-postgres.test.js.
//
// The welcome tour's "done" (#3237) rides the same file: it is part of the
// same first run, it is written through the same router, and Reset first run
// clears it with the rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the first run: join screen and the First challenges, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'onboarding_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  require('../src/db/pool').getPool = () => pool;
  const ws = require('../src/services/ws');
  ws.pushNotificationToUser = () => {};
  ws.sendSystemMessage = async () => {};
  require('../src/services/events').record = async () => {};
  const { onboardingRoutes } = require('../src/routes/onboarding');

  // The two newcomers carry both sign-up flags, as every sign-up path writes
  // them; grace and old_hand are accounts from before the one list
  // (2026-10-01), with neither.
  const { rows: people } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, needs_communities_choice, getting_started_gate) VALUES
       ('newbie', 'x', TRUE, TRUE, TRUE), ('grace', 'x', TRUE, FALSE, FALSE), ('old_hand', 'x', TRUE, FALSE, FALSE),
       ('skipper', 'x', TRUE, TRUE, TRUE)
     RETURNING id, username`
  );
  const [newbie, grace, oldHand, skipper] = people;
  const app = async (n, fields) => {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, status, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [n, fields.slug, fields.createdBy ?? grace.id, !!fields.selfHosted, fields.status || 'running',
        fields.view || 'public', fields.collab || 'public']
    );
    // Re-read: the community is minted by an AFTER INSERT trigger, so
    // RETURNING still shows the row without it.
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  };
  // Homeroom first: the platform's own project, which every account with
  // platform access is already in (the trigger in schema.sql).
  const homeroom = await app('Homeroom', { slug: 'homeroom', selfHosted: true, createdBy: null });
  const garden = await app('City garden', { slug: 'city-garden' });
  const soccer = await app('Pickup soccer', { slug: 'pickup-soccer' });
  const club = await app('Book club', { slug: 'book-club', view: 'private', collab: 'private' });
  const diary = await app('Diary', { slug: 'diary', view: 'private', collab: 'private' });
  const broken = await app('Broken', { slug: 'broken', status: 'error' });
  // The smallest open community, but one an admin has featured.
  const chess = await app('Chess club', { slug: 'chess-club' });
  await pool.query('INSERT INTO featured_apps (app_id, sort_order) VALUES ($1, 0)', [chess.id]);
  // The garden describes itself in its dapp.json; the soccer club does not.
  await pool.query(`UPDATE apps SET manifest_snapshot = $2 WHERE id = $1`,
    [garden.id, { description: '  Swap seeds and   plan the shared plots.  ' }]);
  // Members, so the open communities sort by size: the garden is bigger.
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $3, 'joined'), ($2, $3, 'joined'), ($1, $4, 'joined')`,
    [garden.community_id, soccer.community_id, oldHand.id, grace.id]);
  // Grace invited the newcomer into her private group.
  await pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES ($1, $2, 'member', NULL), ($1, $3, 'invited', $2)`,
    [club.id, grace.id, newbie.id]);

  let viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = viewer; next(); });
  server.use(onboardingRoutes({ selfAppPublicVoting: true }));
  const listener = await new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const inCommunity = async (a, userId) => (await pool.query(
    'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [a.community_id, userId])).rows.length > 0;

  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  await t.test('the join screen lists Homeroom, the invite, what is featured, then open communities by size', async () => {
    const res = await call('GET', '/api/me/join-suggestions');
    assert.equal(res.status, 200);
    const list = res.data.communities;
    assert.deepEqual(list.map((c) => c.slug), ['homeroom', 'book-club', 'chess-club', 'city-garden', 'pickup-soccer'],
      'the featured community leads the open ones, however small');
    list.splice(2, 1);
    assert.equal(list[0].detail, 'Contribute to the Homeroom platform');
    assert.equal(list[0].checked, true, 'already in Homeroom, so it arrives ticked');
    assert.equal(list[1].detail, 'Invited by @grace');
    assert.equal(list[1].checked, true, 'an invite arrives ticked');
    assert.equal(list[2].detail, 'Swap seeds and plan the shared plots.',
      'a community says what it is, in its own dapp.json description, tidied');
    assert.equal(list[3].detail, '', 'and says nothing when it has none, rather than the same words on every row');
    assert.equal(list[2].checked, false);
    assert.ok(!list.some((c) => c.slug === diary.slug), 'a private project nobody invited you to is never offered');
    assert.ok(!list.some((c) => c.slug === broken.slug), 'nor a project that is not running');
  });

  await t.test('Homeroom is offered only where it is listed anywhere else', async () => {
    const onboarding = require('../src/services/onboarding');
    const hidden = await onboarding.joinSuggestions(pool, newbie.id, { showSelfHosted: false });
    assert.ok(!hidden.some((c) => c.self_hosted));
  });

  await t.test('answering joins what was ticked, accepts the invite, and leaves an unticked Homeroom', async () => {
    assert.equal(await inCommunity(homeroom, newbie.id), true, 'in Homeroom by default');
    const res = await call('POST', '/api/me/communities', { join: ['book-club', 'city-garden', 'diary', 'nope'] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.joined.sort(), ['book-club', 'city-garden']);
    assert.deepEqual(res.data.left, ['homeroom']);
    assert.equal(await inCommunity(garden, newbie.id), true);
    assert.equal(await inCommunity(homeroom, newbie.id), false, 'unticked: left');
    assert.equal(await inCommunity(diary, newbie.id), false, 'a private project is not joined by naming it');
    const collab = await pool.query(
      'SELECT status FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [club.id, newbie.id]);
    assert.equal(collab.rows[0].status, 'member', 'the invite was accepted, as the notification would');
    assert.equal(await inCommunity(club, newbie.id), true);
    const pin = await pool.query('SELECT hidden FROM app_favorites WHERE app_id = $1 AND user_id = $2', [garden.id, newbie.id]);
    assert.equal(pin.rows[0]?.hidden, false, 'joining puts it on Home');
    // The accepted invite too: the vote digest finds a member through this
    // pin, so a join with no pin would never be told a vote waits on them.
    const invitedPin = await pool.query('SELECT hidden FROM app_favorites WHERE app_id = $1 AND user_id = $2', [club.id, newbie.id]);
    assert.equal(invitedPin.rows[0]?.hidden, false, 'accepting the invite here puts it on Home, as an invite link does');
    const u = (await pool.query(
      'SELECT needs_communities_choice, communities_onboarded_at FROM users WHERE id = $1', [newbie.id])).rows[0];
    assert.equal(u.needs_communities_choice, false);
    assert.ok(u.communities_onboarded_at);
  });

  await t.test('Skip for now records the answer and joins or leaves nothing', async () => {
    viewer = { id: skipper.id, username: skipper.username, isAdmin: false };
    try {
      assert.equal(await inCommunity(homeroom, skipper.id), true);
      const res = await call('POST', '/api/me/communities', { skip: true });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual([res.data.joined, res.data.left], [[], []]);
      assert.equal(await inCommunity(homeroom, skipper.id), true, 'a skip keeps Homeroom');
      const u = (await pool.query(
        'SELECT needs_communities_choice, communities_onboarded_at FROM users WHERE id = $1', [skipper.id])).rows[0];
      assert.equal(u.needs_communities_choice, false, 'the screen does not come back');
      assert.ok(u.communities_onboarded_at);
      assert.equal((await call('POST', '/api/me/communities', { skip: true })).status, 409);
    } finally {
      viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
    }
  });

  await t.test('a second answer is refused, and so is a bad body', async () => {
    const again = await call('POST', '/api/me/communities', { join: ['pickup-soccer'] });
    assert.equal(again.status, 409);
    assert.equal(again.data.alreadyDone, true);
    assert.equal(await inCommunity(soccer, newbie.id), false);
    viewer = { id: oldHand.id, username: oldHand.username, isAdmin: false };
    const never = await call('POST', '/api/me/communities', { join: ['pickup-soccer'] });
    assert.equal(never.status, 409, 'an account that was never asked cannot answer');
    const bad = await call('POST', '/api/me/communities', { join: 'city-garden' });
    assert.equal(bad.status, 400);
    viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
  });

  // ── A season's First challenges, and what Home shows them as ──────────
  //
  // A running season set up the way evan sets production's up: four First
  // challenges in his order (their names are data), and two more the old
  // gate used to hold back. Rules on the measures that say where a row
  // goes; Vote has none.
  const { rows: [season] } = await pool.query(
    `INSERT INTO seasons (name, starts_at, ends_at, is_active)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE) RETURNING id`);
  const { rows: [event] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE, '{}'::jsonb, $1, 'season')
     RETURNING id`, [season.id]);
  const { rows: templates } = await pool.query(
    `INSERT INTO challenge_templates (category, goal, task, reward, cta_link) VALUES
       ('ONBOARDING', 'Join a community', 'Find people to build with.', '500 pts', NULL),
       ('ONBOARDING', 'Try an app', 'Open an app and try it.', '500 pts', NULL),
       ('ONBOARDING', 'Vote on a change', 'Help decide what ships next.', '250', '#communities'),
       ('ONBOARDING', 'Suggest an improvement', 'Tell a community what would make it better.', '250 pts', NULL),
       ('PERSISTENT', 'Make your first proposal', 'Propose a change.', '1,000 pts', NULL),
       ('WEEKLY', 'Test three apps this week', 'Leave a note on each.', '600 pts', NULL)
     RETURNING id, goal`);
  const tplOf = (goal) => templates.find((r) => r.goal === goal).id;
  const { rows: challengeRows } = await pool.query(
    `INSERT INTO challenges (season_event_id, challenge_template_id, display_order)
     SELECT $1, id, id FROM challenge_templates WHERE id = ANY($2::bigint[]) ORDER BY id
     RETURNING id, challenge_template_id`, [event.id, templates.map((r) => r.id)]);
  const challengeOf = (goal) => Number(challengeRows.find((r) => Number(r.challenge_template_id) === Number(tplOf(goal))).id);
  await pool.query(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_template_id) VALUES
       ('Join', 'COMMUNITY_JOINED', $1), ('Try', 'TRY_APPS', $2), ('Suggest', 'USEFUL_FEEDBACK', $3)`,
    [tplOf('Join a community'), tplOf('Try an app'), tplOf('Suggest an improvement')]);
  // A credit as an admin (or the scorer) writes one.
  const credit = (userId, goal, points) => pool.query(
    `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, metadata, activity_at, challenge_id)
     VALUES ($1, $2, 'challenge_completion', $3, '{"kind":"challenge_completion"}'::jsonb, NOW(), $4)`,
    [userId, event.id, points, challengeOf(goal)]);
  const { homePanelRoutes } = require('../src/routes/home-panels');
  server.use(homePanelRoutes());
  const homePanel = async () => (await call('GET', '/api/home-panels')).data.panels.find((p) => p.key === 'challenges');
  const { loadOnboarding, visibleChallenges } = require('../src/services/topochain/challenge-onboarding');

  await t.test('Home sends the whole season to a new account too, with no gate summary (#4635)', async () => {
    // The newcomer, mid first run: every challenge, First ones and the rest,
    // however many are done and whether the tour is finished.
    const panel = await homePanel();
    assert.equal(panel.onboarding, undefined, 'no gate summary');
    assert.equal(panel.total, 6);
    assert.deepEqual(panel.challenges.map((c) => c.id).sort((a, b) => a - b),
      ['Join a community', 'Try an app', 'Vote on a change', 'Suggest an improvement',
        'Make your first proposal', 'Test three apps this week'].map(challengeOf));
    // Existing members, whatever they have or have not done: the same shape.
    for (const who of [grace, oldHand]) {
      viewer = { id: who.id, username: who.username, isAdmin: false };
      const open = await homePanel();
      assert.equal(open.onboarding, undefined, `${who.username}: no gate summary`);
      assert.equal(open.challenges.length, 6, `${who.username}: every challenge`);
    }
    viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
    // A signed-out visitor: no `users` row joins, nobody is gated. The gate
    // service keeps its answer for the Challenges tab and the mobile lists.
    const anon = await loadOnboarding(pool, null, { seasonId: season.id });
    assert.equal(anon.gated, false);
    assert.equal(visibleChallenges(challengeRows, anon).length, 6);
    const newcomer = await loadOnboarding(pool, newbie.id, { seasonId: season.id });
    assert.equal(newcomer.gated, true, 'the service still gates a new account, for the lists');
  });

  await t.test('the tour finishing opens the lists\' gate, and the credits tick the cards on Home', async () => {
    // From zero: whatever earlier subtests scored is taken back, so the done
    // states below are the credits this test writes.
    await pool.query('DELETE FROM user_activities WHERE user_id = $1', [newbie.id]);
    await credit(newbie.id, 'Join a community', 500);
    await credit(newbie.id, 'Try an app', 500);
    await credit(newbie.id, 'Vote on a change', 250);
    await credit(newbie.id, 'Suggest an improvement', 250);
    let panel = await homePanel();
    const doneIds = () => panel.challenges.filter((c) => c.progress.done).map((c) => c.id).sort((a, b) => a - b);
    assert.deepEqual(doneIds(),
      ['Join a community', 'Try an app', 'Vote on a change', 'Suggest an improvement'].map(challengeOf),
      'Home counts the credits, gated or not');

    await pool.query('UPDATE users SET tour_done_at = NOW() WHERE id = $1', [newbie.id]);
    panel = await homePanel();
    // The read that found the whole list done recorded it, so the gate the
    // Challenges tab and the mobile lists read stays open from here.
    const u = (await pool.query('SELECT getting_started_unlocked_at FROM users WHERE id = $1', [newbie.id])).rows[0];
    assert.ok(u.getting_started_unlocked_at, 'the gate stays open from here');
    assert.deepEqual(doneIds(), ['Join a community', 'Try an app', 'Vote on a change', 'Suggest an improvement'].map(challengeOf),
      'Home\'s shape is unchanged: the rest were never hidden from it');
    // Me counts the four the way Home does (profile.js viewerDoneRule).
    const { readChallengeTotals } = require('../src/routes/profile');
    assert.deepEqual(await readChallengeTotals(pool, newbie.id, season.id), { total: 6, done: 4 });
  });

  await t.test('a First challenge an admin adds later shows up on Home, and locks nothing', async () => {
    const { rows: [later] } = await pool.query(
      `INSERT INTO challenge_templates (category, goal, task, reward)
       VALUES ('ONBOARDING', 'Say hi in a chat', 'Post in a community chat.', '100 pts') RETURNING id`);
    await pool.query(
      `INSERT INTO challenges (season_event_id, challenge_template_id, display_order) VALUES ($1, $2, 0)`,
      [event.id, later.id]);
    const panel = await homePanel();
    assert.equal(panel.onboarding, undefined, 'not gated');
    assert.equal(panel.challenges.length, 7);
    const joined = panel.challenges.find((c) => c.goal === 'Say hi in a chat');
    assert.equal(joined.progress.done, false, 'the new one is to do, like any other card');
  });

  await t.test('the card\'s routes are gone', async () => {
    for (const [method, path] of [['GET', '/api/me/getting-started'], ['POST', '/api/me/getting-started/close']]) {
      const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    const res = await fetch(`${base}/api/me/getting-started/seen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"step":"workshop"}',
    });
    assert.equal(res.status, 404);
  });

  // The welcome tour's "done", on the account rather than per browser
  // (#3237). Through the REAL session middleware and the real /api/auth/me,
  // not the stubbed viewer above, so the 401 and the field the tour reads
  // are both what a browser gets.
  await t.test('the welcome tour is done on the account: marked behind a session, read back on /api/auth/me', async () => {
    // Start from an account that has never finished it (the tour test above
    // set the column).
    await pool.query('UPDATE users SET tour_done_at = NULL WHERE id = $1', [newbie.id]);
    const cookieParser = require('cookie-parser');
    const { authMiddleware } = require('../src/middleware/auth');
    const { authRoutes } = require('../src/routes/auth');
    const token = crypto.randomBytes(24).toString('hex');
    const expired = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES
         ($1, $2, NOW() + INTERVAL '1 day'), ($3, $2, NOW() - INTERVAL '1 hour')`,
      [token, newbie.id, expired]);
    const real = express();
    real.use(express.json(), cookieParser());
    real.use(authMiddleware({}));
    real.use(authRoutes({}));
    real.use(onboardingRoutes({ selfAppPublicVoting: true }));
    const realListener = await new Promise((resolve) => { const s = real.listen(0, '127.0.0.1', () => resolve(s)); });
    const realBase = `http://127.0.0.1:${realListener.address().port}`;
    const as = (session) => ({
      'Content-Type': 'application/json', ...(session ? { Cookie: `session=${session}` } : {}),
    });
    const markDone = (session) => fetch(`${realBase}/api/me/tour-done`, { method: 'POST', headers: as(session), body: '{}' });
    const me = async () => (await (await fetch(`${realBase}/api/auth/me`, { headers: as(token) })).json()).user;
    const doneAt = async () => (await pool.query('SELECT tour_done_at FROM users WHERE id = $1', [newbie.id])).rows[0].tour_done_at;
    try {
      for (const session of [null, 'not-a-session', expired]) {
        assert.equal((await markDone(session)).status, 401, `no session (${session}), no write`);
      }
      assert.equal(await doneAt(), null, 'nothing was recorded by the refused calls');
      assert.equal((await me()).tourDone, false, 'never finished anywhere: Settings offers it');

      const res = await markDone(token);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      const first = await doneAt();
      assert.ok(first instanceof Date, 'Finish or Skip is kept on the account');
      assert.equal((await me()).tourDone, true, 'so every other browser and device reads it');

      // A replay finished later, or the one-time backfill from a browser that
      // had the flag, lands on an account that already has it: no change.
      assert.equal((await markDone(token)).status, 200);
      assert.equal((await doneAt()).getTime(), first.getTime(), 'the first finish is the one kept');
      const other = (await pool.query('SELECT tour_done_at FROM users WHERE id = $1', [grace.id])).rows[0];
      assert.equal(other.tour_done_at, null, 'only the caller\'s own account');
    } finally {
      await new Promise((resolve) => realListener.close(resolve));
    }
  });

  // An admin's "Reset first run" (Admin → Users → ⋯). Continues from the
  // newcomer above, who has answered, joined and finished the tour.
  await t.test('Reset first run brings the first run back and touches nothing the account owns', async () => {
    const onboarding = require('../src/services/onboarding');
    const membershipsBefore = (await pool.query(
      'SELECT community_id FROM community_members WHERE user_id = $1 ORDER BY community_id', [newbie.id])).rows;
    const pinsBefore = (await pool.query(
      'SELECT app_id FROM app_favorites WHERE user_id = $1 AND NOT hidden ORDER BY app_id', [newbie.id])).rows;

    assert.ok((await pool.query('SELECT tour_done_at FROM users WHERE id = $1', [newbie.id])).rows[0].tour_done_at,
      'the tour was finished before the reset');
    assert.deepEqual(await onboarding.resetFirstRun(pool, newbie.id), { id: newbie.id, username: 'newbie' });
    const u = (await pool.query(
      `SELECT needs_communities_choice, communities_onboarded_at, getting_started_closed_at, getting_started_seen,
              tour_done_at, getting_started_gate, getting_started_unlocked_at
         FROM users WHERE id = $1`, [newbie.id])).rows[0];
    assert.deepEqual(u, {
      needs_communities_choice: true, communities_onboarded_at: null,
      getting_started_closed_at: null, getting_started_seen: null,
      tour_done_at: null,
      // Behind the lists' gate as a new account again (2026-10-01): how an
      // admin tries the first run on any account. Home does not read these
      // columns any more (#4635), the Challenges tab and the lists do.
      getting_started_gate: true, getting_started_unlocked_at: null,
    }, 'exactly a new account\'s first-run state: the tour follows the join screen again, on every device');
    assert.deepEqual((await pool.query(
      'SELECT community_id FROM community_members WHERE user_id = $1 ORDER BY community_id', [newbie.id])).rows,
    membershipsBefore, 'still in everything it joined');
    assert.deepEqual((await pool.query(
      'SELECT app_id FROM app_favorites WHERE user_id = $1 AND NOT hidden ORDER BY app_id', [newbie.id])).rows,
    pinsBefore, 'its Home tiles stay');

    // The join screen shows what it is already in, ticked, and can be
    // answered again.
    const list = (await call('GET', '/api/me/join-suggestions')).data.communities;
    assert.equal(list.find((c) => c.slug === 'city-garden').checked, true);
    const again = await call('POST', '/api/me/communities', { join: ['city-garden'] });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(await onboarding.resetFirstRun(pool, 987654321), null, 'no such account');
  });
});
