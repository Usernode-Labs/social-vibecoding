'use strict';

// Which communities' votes put a number on the Communities tab (5 Oct 2026),
// against the REAL schema in a throwaway PostgreSQL database, through the
// real GET /api/workshop/counts handler.
//
// A brand-new account is put in Homeroom, the platform's own community, by
// the users_join_platform_community trigger (source 'auto'), and every change
// proposed to the platform is a vote it owes from that moment. Production
// showed two such accounts an accent "5" and "8" on the tab during their
// first session. The rule (src/services/communities.js,
// UNCHOSEN_COMMUNITIES_SQL): a community you are in only that way, and have
// not taken part in, is `unchosen`, and only the tab's badge reads that.
// `needs`, the Needs you feed and every other count are unchanged.
//
// The client's half is executed in tests/new-account-communities-badge.test.js.
// Skipped when no server is reachable, and required when TEST_DATABASE_URL is
// set, the same contract as tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the Communities tab\'s badge against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 20000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'new_badge_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4, connectionTimeoutMillis: 20000 });
  // The route builds its pool once, from the config it is handed.
  const config = { databaseUrl: String(url), selfAppPublicVoting: true };
  const routePool = require('../src/db/pool').getPool(config);
  t.after(async () => {
    await routePool.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  const communities = require('../src/services/communities');
  const overview = require('../src/routes/workshop-overview');
  const router = overview.workshopOverviewRoutes(config);
  const countsLayer = router.stack.find((l) => l.route?.path === '/api/workshop/counts');
  /** GET /api/workshop/counts as `who` sees it. */
  async function counts(who) {
    let status = 200;
    let body = null;
    await countsLayer.route.stack[0].handle(
      { user: { id: who.id, isAdmin: false }, query: {}, params: {} },
      { status(code) { status = code; return this; }, json(payload) { body = payload; return this; } },
      () => {},
    );
    assert.equal(status, 200);
    return body.counts;
  }

  let seq = 0;
  async function user({ platform = true } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ($1, 'x', $2) RETURNING id, username`,
      [`newcomer_${n}`, platform]
    );
    return rows[0];
  }
  async function app({ createdBy = null, selfHosted = false, view = 'public', collab = 'public' } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [selfHosted ? 'Homeroom' : `App ${n}`, selfHosted ? 'homeroom' : `app-${n}`, createdBy, selfHosted, view, collab]
    );
    // Read back: the AFTER INSERT trigger sets community_id after RETURNING.
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  }
  const promote = async (a, author, title) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_title) VALUES ($1, $2, 'promoted', $3) RETURNING id`,
    [a.id, author.id, title])).rows[0].id;
  const decide = async (a, author, title) => (await pool.query(
    `INSERT INTO issues (app_id, title, created_by, kind) VALUES ($1, $2, $3, 'rename') RETURNING id`,
    [a.id, title, author.id])).rows[0].id;
  const source = async (a, who) => (await pool.query(
    `SELECT source FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [a.community_id, who.id])).rows[0]?.source || null;

  // The platform, as production had it on the day: changes and a decision
  // up for a vote, none of them anybody new's.
  const homeroom = await app({ selfHosted: true });
  const regular = await user();
  const changes = [];
  for (const title of ['Sticky header', 'Bigger tap targets', 'Faster Home', 'Dark mode']) {
    changes.push(await promote(homeroom, regular, title));
  }
  const rename = await decide(homeroom, regular, 'Rename #general to #lobby');

  await t.test('a brand-new account: five votes owed, none of them on the tab, all of them in Needs you', async () => {
    const fresh = await user();
    assert.equal(await source(homeroom, fresh), 'auto', 'put in Homeroom because every account is');
    const c = await counts(fresh);
    assert.equal(c.homeroom.needs, 5, 'the four changes and the decision are still owed');
    assert.equal(c.homeroom.unchosen, true, 'and none of them puts a number on the tab');
    assert.deepEqual(Object.keys(c), ['homeroom'], 'nothing else is counted for a newcomer');
    const feed = overview.shapeNeedsFeed((await pool.query(overview.NEEDS_FEED_SQL,
      [fresh.id, true, false, overview.NEEDS_FEED_MAX])).rows);
    assert.equal(feed.length, 5, 'the items stay in Needs you: only the badge changes');
  });

  await t.test('a member of a group with a change waiting for them sees that one badged', async () => {
    const friend = await user();
    const newbie = await user();
    const flat = await app({ createdBy: friend.id, view: 'private', collab: 'private' });
    for (const who of [friend, newbie]) {
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [flat.id, who.id]);
    }
    await promote(flat, friend, 'Rota for the bins');
    const c = await counts(newbie);
    assert.equal(c[flat.slug].needs, 1);
    assert.equal(c[flat.slug].unchosen, undefined, 'a community they are in by choice is never unchosen');
    assert.equal(c.homeroom.unchosen, true, 'and Homeroom still is');
  });

  await t.test('someone who has voted in Homeroom has its votes counted', async () => {
    const voter = await user();
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [changes[0], voter.id]);
    const c = await counts(voter);
    assert.equal(c.homeroom.needs, 4, 'the four still waiting on them');
    assert.equal(c.homeroom.unchosen, undefined, 'one vote is taking part: the rest ask for them');
    assert.deepEqual([...await communities.unchosenCommunities(pool, voter.id)], []);
  });

  await t.test('every way of taking part ends it; a hidden pin does not', async () => {
    const ways = {
      'a vote on a group decision': (u) => pool.query(
        `INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'yes')`, [rename, u.id]),
      'a change of their own': (u) => pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'active')`, [homeroom.id, u.id]),
      'a request they filed': (u) => pool.query(
        `INSERT INTO issues (app_id, title, created_by) VALUES ($1, 'Please add a dark mode', $2)`, [homeroom.id, u.id]),
      'a line in the old project discussion': (u) => pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, 'hello')`, [homeroom.id, u.id]),
      'a message in #general': (u) => pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content)
         SELECT id, $1, 'hi all' FROM conversations WHERE kind = 'channel' AND channel_key = 'general'`, [u.id]),
      'a pin on Home': (u) => pool.query(
        `INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)`, [homeroom.id, u.id]),
    };
    for (const [way, act] of Object.entries(ways)) {
      const who = await user();
      assert.ok((await communities.unchosenCommunities(pool, who.id)).has('homeroom'), `unchosen before ${way}`);
      await act(who);
      assert.ok(!(await communities.unchosenCommunities(pool, who.id)).has('homeroom'), `${way} is taking part`);
      assert.equal((await counts(who)).homeroom.unchosen, undefined, `${way}: the route says so too`);
    }
    const hider = await user();
    await pool.query(`INSERT INTO app_favorites (app_id, user_id, hidden) VALUES ($1, $2, TRUE)`, [homeroom.id, hider.id]);
    assert.equal((await counts(hider)).homeroom.unchosen, true, 'a hidden row is an opt-out, not a pin');
  });

  await t.test('choosing Homeroom by hand is choosing it', async () => {
    const back = await user();
    await communities.leave(pool, homeroom, back.id);
    assert.ok(!(await communities.unchosenCommunities(pool, back.id)).has('homeroom'),
      'out of it, nothing is unchosen (the tab sums only communities you are in)');
    await communities.join(pool, homeroom, back.id);
    assert.equal(await source(homeroom, back), 'joined');
    // Join pins it too; without the pin, the join alone still counts.
    await pool.query('DELETE FROM app_favorites WHERE app_id = $1 AND user_id = $2', [homeroom.id, back.id]);
    const c = await counts(back);
    assert.equal(c.homeroom.needs, 5);
    assert.equal(c.homeroom.unchosen, undefined);
  });

  await t.test('no account, no read', async () => {
    assert.deepEqual([...await communities.unchosenCommunities(pool, null)], []);
  });
});
