'use strict';

// The bot's slots on a project, against the full PostgreSQL schema
// (16 Oct 2026). PROPOSALS_PER_APP_CAP counts a slot for every change of
// the bot's up for a vote or being merged AND for every build under way
// that will become one (homeroom-bot.js slotHolders). Before, only the
// changes counted, and on 15 October the bot started eleven builds at once
// as slots freed, ending with seven open changes against five slots.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the bot\'s slots on a project count its builds under way, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_slots_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [lee] } = await pool.query(`INSERT INTO users (username, password) VALUES ('lee', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('plant-pal', 'plant-pal', 'running', 'https://github.com/usernode-bot/plant-pal')
     RETURNING id`,
  );
  const session = async ({ status, linked = [], user = botUser.id, ago = 0 }) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues, created_at, promoted_at)
     VALUES ($1, $2, $3, $4, $5::int[], NOW() - make_interval(hours => $6), NOW() - make_interval(hours => $6)) RETURNING id`,
    [app.id, user, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, status, linked, ago],
  )).rows[0].id;
  const run = async (issue, fields = {}) => {
    const f = { verdict: 'ready', mode: 'live', ago: 1, ...fields };
    return (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cap_suppressed, build_ok,
                                      live_build_waiting_at, build_session_id, proposal_session_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() - make_interval(hours => $10)) RETURNING id`,
      [app.id, issue, f.mode, f.verdict, f.cap || null, f.ok ?? null, f.waiting ? new Date() : null,
        f.buildSession || null, f.proposal || null, f.ago],
    )).rows[0].id;
  };
  const slots = async () => (await bot.slotHolders(pool, botUser, app.id)).map((r) => `${r.kind}#${r.issue_number}`);

  await t.test('changes up for a vote and builds under way each take a slot', async () => {
    await session({ status: 'promoted', linked: [1], ago: 30 });
    await session({ status: 'merging', linked: [2], ago: 20 });
    await session({ status: 'merged', linked: [3] }); // done: no slot
    await session({ status: 'archived', linked: [4] }); // withdrawn: no slot
    await session({ status: 'promoted', linked: [5], user: lee.id }); // a person's: not the bot's slot
    await run(6, { waiting: true, ago: 3 }); // waiting its turn to be built
    const building = await session({ status: 'active' });
    await run(7, { buildSession: building, ago: 2 }); // being built
    assert.deepEqual(await slots(), ['proposal#1', 'proposal#2', 'build#6', 'build#7'], 'oldest first');
    assert.equal((await bot.capRoomFor(pool, botUser, app.id)).proposals_per_app, 1, 'four of five taken');
  });

  await t.test('a held, finished, abandoned or superseded build takes none', async () => {
    await run(8, { waiting: true, cap: 'proposals_per_app' }); // held by the cap itself
    await run(9, { waiting: true, ok: false }); // its build failed
    await run(10, { waiting: true, ago: 24 * 8 }); // older than the window
    const gone = await session({ status: 'archived' });
    await run(11, { buildSession: gone }); // its build session was given up
    await run(12, { waiting: true, ago: 5 });
    await run(12, { verdict: 'question', ago: 1 }); // read again since, and asked a question
    await run(13, { verdict: 'question', waiting: true }); // never a build
    await run(1, { waiting: true }); // a second build for a request with an open change: same slot
    assert.deepEqual(await slots(), ['proposal#1', 'proposal#2', 'build#6', 'build#7']);
  });

  await t.test('K2: a red change handed to a person and untouched for days lets its slot go', async () => {
    const redChanges = require('../src/services/homeroom-bot-red-changes');
    const HEAD = 'c'.repeat(40);
    const red = async (linked, { handedDaysAgo = 4, idleDaysAgo = 4, state = 'failing', verdict = 'person', head = HEAD } = {}) => {
      const id = await session({ status: 'promoted', linked });
      await pool.query(
        `UPDATE chat_sessions SET check_state = $2, reviewed_head_sha = $3, checks_commit_sha = $3, pr_title = $4,
                last_activity_at = NOW() - make_interval(days => $5) WHERE id = $1`,
        [id, state, HEAD, `Change for #${linked[0]}`, idleDaysAgo],
      );
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha, created_at)
         VALUES ($1, $2, 'live', $3, $4, $5, NOW() - make_interval(days => $6))`,
        [app.id, linked[0], verdict, id, head, handedDaysAgo],
      );
      return id;
    };
    const stale = await red([20]);
    const recent = await red([21], { handedDaysAgo: 1 }); // handed over yesterday
    const touched = await red([22], { idleDaysAgo: 1 }); // somebody wrote on it since
    const passing = await red([23], { state: 'passing' }); // green again
    const moved = await red([24], { head: 'd'.repeat(40) }); // its hand-off was about an older head
    const platform = await red([25]); // the platform's failure, not the change's
    await pool.query(
      `INSERT INTO events (app_id, session_id, event_type, metadata) VALUES ($1, $2, 'platform_incident', '{"kind":"checks_not_change"}')`,
      [app.id, platform],
    );
    const archived = [];
    const lines = [];
    const deps = {
      sessionLifecycle: {
        async archiveSession({ sessionId, reason }) {
          archived.push({ sessionId, reason });
          const { rowCount } = await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [sessionId]);
          return { archived: rowCount === 1 };
        },
      },
      ws: { async sendSystemMessage(_pool, appId, content, msgType, metadata, thread) { lines.push({ content, thread }); } },
    };
    const out = await redChanges.sweepStaleRedChanges(pool, { appId: app.id, deps });
    assert.deepEqual(out, { withdrawn: [stale] });
    assert.deepEqual(archived, [{ sessionId: stale, reason: 'red-checks' }]);
    assert.deepEqual(lines, [{
      content: '“Change for #20” was withdrawn: its checks failed and nobody changed it for 3 days. This request stays open for anyone to take up.',
      thread: { type: 'issue', ref: 20 },
    }]);
    for (const id of [recent, touched, passing, moved, platform]) {
      assert.equal((await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status, 'promoted');
    }
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = ANY($1::int[])`, [[recent, touched, passing, moved, platform]]);
  });

  await t.test('a fifth slot taken by a build holds the next ready verdict', async () => {
    assert.equal(await bot.simulateCaps(pool, botUser, app.id, 'ready', {}), null, 'four taken: room for one');
    await run(14, { waiting: true });
    assert.equal(await bot.simulateCaps(pool, botUser, app.id, 'ready', {}), 'proposals_per_app',
      'five taken, one of them a build not yet proposed');
    assert.equal((await bot.capRoomFor(pool, botUser, app.id)).proposals_per_app, 0);
  });

  await t.test('the slots view: what holds each slot, what waits for one, with their tracks', async () => {
    const track = require('../src/services/homeroom-bot-track');
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title) VALUES ($1, 6, 'Sunlight log'), ($1, 8, 'Repotting reminders'), ($1, 30, 'Shipped by a person')`,
      [app.id],
    );
    const settings = { mode: 'live', pausedApps: [] };
    const liveSvc = { isLiveFor: () => true };
    const view = await track.slotsView(pool, { app: { id: app.id, slug: 'plant-pal', name: 'Plant Pal' }, settings, deps: { liveSvc } });
    assert.equal(view.cap, 5);
    assert.equal(view.acts, true);
    assert.deepEqual(view.slots.map((s) => `${s.kind}#${s.issueNumber}`), ['proposal#1', 'proposal#2', 'build#6', 'build#7', 'build#14']);
    const six = view.slots.find((s) => s.issueNumber === 6);
    assert.equal(six.title, 'Sunlight log');
    assert.equal(six.track.state, 'queued', 'ready, waiting its turn to be built');
    assert.equal(six.track.step, 'build');
    assert.equal(view.slots.find((s) => s.issueNumber === 7).track.state, 'planning', 'its build session is open; no plan posted yet');
    assert.deepEqual(view.waiting.map((w) => [w.issueNumber, w.position, w.limit, w.title]), [[8, 1, 'slots', 'Repotting reminders']]);
    assert.equal(view.waiting[0].track.state, 'held');
    assert.deepEqual(view.waiting[0].track.held, { limit: 'slots', position: 1, until: null });
    assert.equal(view.week, null, 'nobody signed in, no week');

    // The request page's track for a request somebody else shipped.
    await run(30, { verdict: 'person' });
    await pool.query(`UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = 30`, [app.id]);
    const shipped = await session({ status: 'merged', linked: [30], user: lee.id });
    await pool.query('UPDATE chat_sessions SET pr_number = 5247 WHERE id = $1', [shipped]);
    const tracks = await track.tracksForRequests(pool, { appId: app.id, numbers: [30, 999] });
    assert.deepEqual([...tracks.keys()], [30], 'only requests the bot had');
    assert.equal(tracks.get(30).state, 'done_elsewhere');
    assert.deepEqual(tracks.get(30).doneBy, { username: 'lee', prNumber: 5247 });
  });

  // 16 Oct 2026: the platform's slots page listed 25 requests "waiting for a
  // slot" with none of its slots in use. All but one had closed, and that
  // one was claimed: the bot leaves a request a person has alone. The line
  // now holds only what waits for the bot, and each row says what it is.
  await t.test('the line is only what waits for the bot, and each row says what it asks and who asked', async () => {
    const track = require('../src/services/homeroom-bot-track');
    const settings = { mode: 'live', pausedApps: [] };
    const liveSvc = { isLiveFor: () => true };
    const plantPal = { id: app.id, slug: 'plant-pal', name: 'Plant Pal', repo_url: 'https://github.com/usernode-bot/plant-pal' };
    await run(40, { cap: 'proposals_per_app' }); // closed since, as the bot recorded
    await pool.query('INSERT INTO homeroom_bot_closed_requests (app_id, issue_number, closed_at) VALUES ($1, 40, NOW())', [app.id]);
    await run(41, { cap: 'proposals_per_app' }); // a person has a change of their own for it now
    await session({ status: 'active', linked: [41], user: lee.id });
    await run(42, { cap: 'proposals_per_app' }); // closed on GitHub; nothing of ours says so yet
    await run(43, { cap: 'proposals_per_app' }); // open: waits behind #8
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 43, $2, 'Water reminders')`,
      [app.id, lee.id],
    );
    const github = {
      fetchPublicIssues: async () => ({
        issues: [
          { number: 8, title: 'Repotting reminders', body: '' },
          { number: 41, title: 'Frost alerts', body: 'Warn me before a frost.' },
          { number: 43, title: 'Water reminders by plant', body: '**Source:** Suggest an improvement\n\nRemind me to water each plant on its own schedule.\n\nPinned with Comment mode' },
        ],
        truncatedList: false,
      }),
    };
    const view = await track.slotsView(pool, { app: plantPal, settings, deps: { liveSvc, github } });
    assert.deepEqual(view.waiting.map((w) => [w.issueNumber, w.position]), [[8, 1], [43, 2]],
      'neither the recorded close (#40), the closed one (#42), nor the taken one (#41)');
    const water = view.waiting[1];
    assert.equal(water.title, 'Water reminders by plant', 'GitHub\'s title before the one the bot kept');
    assert.equal(water.askedBy, 'lee');
    assert.equal(water.excerpt, 'Remind me to water each plant on its own schedule.', 'the asker\'s words, not the lines around them');
    assert.deepEqual(view.taken.map((w) => [w.issueNumber, w.by, w.title, w.excerpt]), [[41, 'lee', 'Frost alerts', 'Warn me before a frost.']]);
    assert.equal(view.taken[0].track.why, 'taken');
    assert.deepEqual(view.taken[0].track.held, { limit: 'taken', position: null, until: null, by: 'lee' });
    // The request's own page says the same.
    const own = await track.tracksForRequests(pool, { appId: app.id, numbers: [41] });
    assert.equal(own.get(41).why, 'taken');

    // A list that is not whole says nothing about what closed: #42 stays.
    const unsure = { fetchPublicIssues: async () => ({ issues: [], note: 'issues unavailable' }) };
    const partial = await track.slotsView(pool, { app: plantPal, settings, deps: { liveSvc, github: unsure } });
    assert.deepEqual(partial.waiting.map((w) => w.issueNumber), [8, 42, 43]);
    assert.equal(partial.waiting[2].title, 'Water reminders', 'the title the bot kept when GitHub has none');
    assert.equal(partial.waiting[2].excerpt, null);
  });
});
