'use strict';

// One work state per request and change (docs/plans/bot-one-model.md, step 3)
// against the FULL PostgreSQL schema in a throwaway database:
// services/work-state.js refresh, its store, and the workflow hook.
//
// What this pins:
//   1. refresh reads the bot's own records for each request (the shared
//      per-request query) and stores one row: a queued request reads, a build
//      held for the project's slots is building, an open question is the
//      requester's move, a change with failing checks is checking, a live one
//      is live, and a change with no request is its own item.
//   2. A second refresh with nothing changed writes nothing and returns
//      nothing, so a transition that moves nobody's stage pushes nothing.
//   3. A change of stage returns the bell it rings (an answered question that
//      is read again rings nothing; a change put up for a vote rings ready).
//   4. afterTransition names the items from an instance key and resolves one
//      scoped `work_state` push per changed row.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/work-state-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('work states against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `work_state_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const ws = require('../src/services/work-state');
  const dm = require('../src/services/homeroom-bot-dm');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`, [username, synthetic]);
  const ada = await user('ws_ada');
  const bob = await user('ws_bob');
  const bot = await user('homeroom_bot', true);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Seed swap', 'ws-seeds', 'running', $1, 'public', 'public') RETURNING id, slug`, [bob.id]);
  const ask = async (number, by, title) => {
    await pool.query(
      'INSERT INTO issues (app_id, github_issue_number, title, created_by) VALUES ($1, $2, $3, $4)',
      [app.id, number, title, by.id]);
    await pool.query(
      'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, asked_text) VALUES ($1, $2, $3, $4)',
      [app.id, number, by.id, title]);
  };
  const run = (number, verdict, extra = {}) => one(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cap_suppressed, build_ok, proposal_session_id)
     VALUES ($1, $2, 'live', $3, $4, $5, $6) RETURNING id`,
    [app.id, number, verdict, extra.capSuppressed || null, extra.buildOk ?? null, extra.proposalSessionId || null]);
  const change = (by, pr, issues, status, extra = {}) => one(
    `INSERT INTO chat_sessions (app_id, user_id, pr_number, linked_issues, status, shared_at, promoted_at, live_at,
                                check_state, checks_commit_sha, reviewed_head_sha)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, 'abc', 'abc') RETURNING id`,
    [app.id, by.id, pr, issues, status, extra.promotedAt || null, extra.liveAt || null, extra.checkState || null]);
  const stored = async (kind, ref) => one(
    'SELECT stage, why, reason, line, whose_move, requester_id FROM work_states WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3',
    [app.id, kind, ref]);
  const req = (n) => ({ appId: app.id, issueNumber: n });

  // 1: waiting in the bot's line, second of two.
  await ask(1, ada, 'Sort the seeds by season');
  await ask(2, ada, 'A swap calendar');
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, enqueued_at)
     VALUES ($1, 2, 1, NOW() - interval '5 minutes'), ($1, 1, 1, NOW())`, [app.id]);
  // 3: read, ready, and held for the project's build slots.
  await ask(3, ada, 'Dark mode');
  await run(3, 'ready', { capSuppressed: 'builds_per_app' });
  // 4: the bot asked her something and she has not answered.
  await ask(4, ada, 'Reminders');
  const asked = await run(4, 'question');
  const sent = await dm.sendDm(pool, { bot, userId: ada.id, content: 'How often should it remind you?' });
  await pool.query(
    `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id, question_status)
     VALUES ($1, $2, $3, $4, 4, 'question', $5, 'open')`,
    [sent.messageId, ada.id, sent.conversationId, app.id, asked.id]);
  // 5: built, up, and two of its checks fail.
  await ask(5, bob, 'Bigger buttons');
  const failing = await change(bot, 501, [5], 'promoted', { promotedAt: new Date(), checkState: 'failing' });
  await run(5, 'ready', { buildOk: true, proposalSessionId: failing.id });
  // 6: merged and live.
  await ask(6, bob, 'Fix the typo');
  const live = await change(bot, 502, [6], 'merged', { promotedAt: new Date(), liveAt: new Date() });
  await run(6, 'ready', { buildOk: true, proposalSessionId: live.id });
  // A change of Bob's own, for no request.
  const own = await change(bob, 503, [], 'active');

  await t.test('one stored row per item, in the ten words', async () => {
    const changed = await ws.refresh(pool, [req(1), req(2), req(3), req(4), req(5), req(6), { sessionId: own.id }]);
    // Seven items, and (11 Nov 2026) a row of their own for the two changes
    // built for requests 5 and 6, which Needs you reads.
    assert.equal(changed.length, 9);
    assert.deepEqual(changed.filter((c) => c.kind === 'change').map((c) => [c.ref, c.state.stage, c.bell]).sort(),
      [[failing.id, 'checking', null], [live.id, 'live', null], [own.id, 'building', null]].sort(),
      'a change built for a request rings nothing: its request does');
    const s1 = await stored('request', 1);
    assert.deepEqual([s1.stage, s1.line, s1.whose_move, Number(s1.requester_id)], ['reading', { code: 'queued', place: 2 }, 'bot', ada.id]);
    assert.deepEqual((await stored('request', 2)).line, { code: 'queued', place: 1 });
    const s3 = await stored('request', 3);
    assert.deepEqual([s3.stage, s3.line], ['building', { code: 'held_builds', position: 1 }]);
    const s4 = await stored('request', 4);
    assert.deepEqual([s4.stage, s4.why, s4.whose_move], ['waiting_for_you', 'question', 'requester']);
    const s5 = await stored('request', 5);
    assert.equal(s5.stage, 'checking');
    assert.equal(s5.line.code, 'checks_failing');
    assert.equal((await stored('request', 6)).stage, 'live');
    const mine = await stored('change', own.id);
    assert.deepEqual([mine.stage, mine.whose_move, Number(mine.requester_id)], ['building', 'builder', bob.id]);
    const firstRing = changed.find((c) => c.ref === 4);
    assert.equal(firstRing.bell, 'needs_you', 'a question asked rings her bell');
  });

  await t.test('nothing changed: nothing written, nothing returned', async () => {
    const before = await one('SELECT MAX(updated_at) AS at FROM work_states');
    const changed = await ws.refresh(pool, [req(1), req(2), req(3), req(4), req(5), req(6), { sessionId: own.id }]);
    assert.deepEqual(changed, []);
    assert.equal(String((await one('SELECT MAX(updated_at) AS at FROM work_states')).at), String(before.at));
  });

  await t.test('a session names its requests; a change of stage rings', async () => {
    await pool.query("UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1", [failing.id]);
    const changed = await ws.refresh(pool, [{ sessionId: failing.id }]);
    assert.equal(changed.length, 2, 'its request, and its own row');
    assert.deepEqual([changed[0].kind, changed[0].ref, changed[0].state.stage, changed[0].bell], ['request', 5, 'up_for_vote', 'ready']);
    assert.equal(Number(changed[0].sessionId), failing.id);
    assert.deepEqual([changed[1].kind, changed[1].ref, changed[1].state.stage, changed[1].state.voteOpen, changed[1].bell],
      ['change', failing.id, 'up_for_vote', true, null]);
    assert.equal(changed[0].state.voteOpen, true, 'the request is open for votes as its change is');
    // The queue moves on: a line that moved rings nothing.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 2', [app.id]);
    const moved = await ws.refresh(pool, [req(1)]);
    assert.deepEqual([moved.length, moved[0].state.line, moved[0].bell], [1, { code: 'queued', place: 1 }, null]);
  });

  await t.test('the workflow hook: items from the key, one push per change', async () => {
    await pool.query("UPDATE homeroom_bot_dm_messages SET question_status = 'answered', answered_at = NOW() WHERE app_id = $1 AND issue_number = 4", [app.id]);
    await pool.query(
      "INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 4, 1, 'reply')", [app.id]);
    const rings = [];
    const pushes = await ws.afterTransition(pool, { machine: 'bot-request', key: `request:${app.id}:4` }, {
      ring: async (_db, row) => { rings.push(row.bell); },
    });
    assert.equal(pushes.length, 1);
    const [push] = pushes;
    assert.equal(push.kind, 'scoped');
    assert.deepEqual(push.routing, { appId: app.id, appSlug: 'ws-seeds' });
    assert.equal(push.data.type, 'work_state');
    assert.equal(push.data.appSlug, 'ws-seeds', 'a page showing the project knows it is about it');
    assert.deepEqual(push.data.item, { kind: 'request', ref: 4, issueNumber: 4, sessionId: null });
    assert.equal(push.data.state.stage, 'reading');
    assert.deepEqual(rings, [], 'read again: nothing to ring');
    assert.deepEqual(await ws.afterTransition(pool, { machine: 'bot-dm', key: `user:${ada.id}` }), [],
      'a machine that moves no request refreshes nothing');
  });

  await t.test('a vote to close a request names it; a route write refreshes and publishes it', async () => {
    const vote = await one(
      `INSERT INTO issues (app_id, github_issue_number, title, created_by, kind, payload)
       VALUES ($1, 900, 'Close #3', $2, 'close_issue', '{"issueNumber": 3}'::jsonb) RETURNING id`, [app.id, bob.id]);
    assert.deepEqual(await ws.itemsOf(pool, { machine: 'governance-proposal', key: `issue:${vote.id}` }),
      [{ appId: app.id, issueNumber: 3 }]);
    assert.deepEqual(await ws.itemsOf(pool, { machine: 'governance-proposal', key: 'issue:999999' }), []);
    await pool.query("UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = 3 AND kind = 'general'", [app.id]);
    const changed = await ws.touched(pool, [req(3)]);
    assert.deepEqual(changed.map((c) => [c.ref, c.state.stage]), [[3, 'closed']]);
  });

  await t.test('the sweep seeds a row for a request the bot knows, then checks the oldest in turn', async () => {
    await ask(7, bob, 'Share a list');
    await ask(70, bob, 'Print a list');
    assert.equal(await stored('request', 7), undefined);
    const first = await ws.sweep(pool, { olderThanMs: 0 });
    assert.equal(first.seeded, 2);
    assert.deepEqual((await stored('request', 7)).line, { code: 'waiting' });
    // 7 waits its turn in the bot's line (a row that moves by time); 70 waits
    // to be read, which moves only when a record of it is written (marked).
    await pool.query('INSERT INTO homeroom_bot_queue (app_id, issue_number, priority) VALUES ($1, 7, 1)', [app.id]);
    await ws.refresh(pool, [req(7)]);
    const checkedAt = async (n) => (await one(
      `SELECT checked_at FROM work_states WHERE app_id = $1 AND item_kind = 'request' AND item_ref = $2`, [app.id, n])).checked_at;
    const before = await checkedAt(7);
    const idleBefore = await checkedAt(70);
    const again = await ws.sweep(pool, { olderThanMs: 0, limit: 100 });
    assert.equal(again.seeded, 0);
    assert.ok(again.checked >= 1);
    assert.ok(new Date(await checkedAt(7)) > new Date(before), 'an unchanged row is still marked checked');
    assert.equal(String(await checkedAt(70)), String(idleBefore), 'a request nobody has started on is left to its marks');
    // The sweep's test is its index's, word for word, so it reads only the rows still moving.
    const client = await pool.connect();
    let forced;
    try {
      await client.query('SET enable_seqscan = off');
      forced = (await client.query(
        `EXPLAIN SELECT app_id FROM work_states
          WHERE stage <> 'closed'
            AND NOT (item_kind = 'request' AND stage = 'reading' AND COALESCE(line->>'code', '') = 'waiting')
          ORDER BY checked_at ASC LIMIT 5`)).rows.map((r) => r['QUERY PLAN']).join('\n');
      await client.query('RESET enable_seqscan');
    } finally { client.release(); }
    assert.match(forced, /work_states_sweep_moving_idx/);
    assert.equal((await stored('request', 3)).stage, 'closed');
    const closedChecked = await one(`SELECT checked_at, updated_at FROM work_states WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 3`, [app.id]);
    assert.equal(String(closedChecked.checked_at), String(closedChecked.updated_at), 'a closed row is not swept');
  });

  await t.test('a write anywhere marks its item, and the drain derives it again', async () => {
    await pool.query('DELETE FROM work_state_dirty');
    // A build's progress, written by no machine: the spec post, a review round.
    await ask(8, ada, 'Weekly digest');
    const run8 = await run(8, 'ready');
    const marks = async () => (await pool.query(
      'SELECT app_id, issue_number, session_id FROM work_state_dirty ORDER BY id')).rows
      .map((r) => (r.session_id ? `s${r.session_id}` : `${r.issue_number}`));
    assert.deepEqual(await marks(), ['8'], 'the request, once, however many of its rows were written');
    await pool.query('UPDATE homeroom_bot_runs SET build_session_id = NULL WHERE id = $1', [run8.id]);
    assert.deepEqual(await marks(), ['8'], 'marking one already marked does nothing');
    // A change's checks move: the change is marked, and a change's turn too.
    await pool.query("UPDATE chat_sessions SET check_state = 'failing' WHERE id = $1", [failing.id]);
    await pool.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1', [own.id]);
    assert.deepEqual(await marks(), ['8', `s${failing.id}`], 'what a stage reads, not every write (a view bumps activity)');
    const out = await ws.drainDirty(pool);
    assert.equal(out.taken, 2);
    assert.deepEqual(out.changed.map((c) => [c.ref, c.state.stage]).sort(),
      [[5, 'checking'], [8, 'building'], [failing.id, 'checking']].sort());
    assert.deepEqual(await marks(), [], 'taken');
    assert.deepEqual((await ws.drainDirty(pool)).taken, 0);
    // A claim, a reply's question answered, a closed record: each marks its request.
    await pool.query('INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 8, $2)', [app.id, bob.id]);
    await pool.query("UPDATE homeroom_bot_dm_messages SET question_status = 'closed' WHERE app_id = $1", [app.id]);
    assert.deepEqual((await marks()).sort(), ['4', '8']);
    await ws.drainDirty(pool);
  });

  await t.test('a change\'s phase or a merge conflict marks its work state', async () => {
    // #6402: deferred checks and a recorded conflict change how a checking
    // change is worded, so each moves the stored row.
    const marks = async () => (await pool.query(
      'SELECT session_id FROM work_state_dirty ORDER BY id')).rows.map((r) => Number(r.session_id));
    await pool.query('DELETE FROM work_state_dirty');
    await pool.query("UPDATE chat_sessions SET check_phase = 'deferred' WHERE id = $1", [own.id]);
    assert.deepEqual(await marks(), [Number(own.id)]);
    await pool.query('DELETE FROM work_state_dirty');
    await pool.query("UPDATE chat_sessions SET merge_conflict_state = 'conflict' WHERE id = $1", [own.id]);
    assert.deepEqual(await marks(), [Number(own.id)]);
    await pool.query('DELETE FROM work_state_dirty');
    await pool.query('UPDATE chat_sessions SET integration_merges_clean = FALSE WHERE id = $1', [own.id]);
    assert.deepEqual(await marks(), [Number(own.id)], 'a measured conflict moves it too');
    await pool.query('DELETE FROM work_state_dirty');
    await pool.query("UPDATE chat_sessions SET check_phase = 'deferred' WHERE id = $1", [own.id]);
    assert.deepEqual(await marks(), [], 'writing the same value again marks nothing');
  });

  await t.test('readers: a person\'s own rows, and a project\'s by number', async () => {
    const hers = await ws.forRequester(pool, ada.id);
    assert.deepEqual(hers.map((r) => r.ref).sort((a, b) => a - b), [1, 2, 3, 4, 8]);
    assert.equal(hers[0].app.slug, 'ws-seeds');
    const byNumber = await ws.forRequests(pool, app.id, [5, 6, 99]);
    assert.deepEqual([...byNumber.keys()].sort(), [5, 6]);
    assert.equal(byNumber.get(6).stage, 'live');
  });

  // Decision 7: the requester's bell rings from the stage, with no message
  // behind it. Its push goes out from the row; "ready to try" owes the email
  // that stands in for the push (activity-mail.js noticeMailTargets).
  await t.test('the bell: a stage change rings its requester, and "ready" owes its email', async () => {
    const mail = require('../src/services/activity-mail');
    const rows = async (who) => (await pool.query(
      `SELECT kind, detail, source_user_id, conversation_message_id, mailed_at, app_id FROM notifications
        WHERE user_id = $1 AND kind LIKE 'build_%' ORDER BY id`, [who.id])).rows;
    await ask(20, ada, 'Swap by post');
    const up = await change(bot, 520, [20], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await run(20, 'ready', { buildOk: true, proposalSessionId: up.id });
    const changed = await ws.refresh(pool, [req(20)]);
    assert.deepEqual([changed[0].state.stage, changed[0].bell], ['up_for_vote', 'ready']);
    const pushes = await ws.pushesOf(pool, changed);
    assert.deepEqual(pushes.map((p) => p.data.type), ['work_state', 'work_state', 'notifications_changed'],
      'its request\'s row and its change\'s, and one bell: its request\'s');
    assert.deepEqual(pushes[2].routing, { userId: ada.id });
    const [ready] = await rows(ada);
    assert.equal(ready.kind, 'build_ready');
    assert.equal(Number(ready.source_user_id), bot.id, 'from Homeroom bot');
    assert.equal(Number(ready.app_id), app.id, 'filed under its project');
    assert.equal(ready.conversation_message_id, null, 'no message behind it');
    assert.equal(ready.mailed_at, null, 'its email is owed');
    const said = require('../src/services/homeroom-bot-notify-copy').parseBotDetail(ready.detail);
    assert.deepEqual([said.moment, said.issueNumber, said.appSlug], ['ready', 20, 'ws-seeds']);
    // The notice clock takes it, and words its email from the detail, with
    // a link to the request's page.
    const { items } = await mail.noticeMailTargets(pool);
    const target = items.find((it) => it.target.startsWith('notification:'));
    assert.ok(target, 'owed to the notice clock');
    const sent = [];
    const real = mail.emailIfNoPush;
    mail.emailIfNoPush = async (_pool, args) => { sent.push(args); return 'sent'; };
    try {
      const out = await mail.mailNotice(pool, target.input.notificationId, { once: (_k, fn) => fn() });
      assert.deepEqual(out, { said: 'sent' });
    } finally { mail.emailIfNoPush = real; }
    assert.deepEqual([sent[0].kind, sent[0].userId, sent[0].appSlug, sent[0].issueNumber], ['build_ready', ada.id, 'ws-seeds', 20]);
    assert.equal(sent[0].detail, ready.detail);
    assert.ok((await rows(ada))[0].mailed_at, 'sent once');
    assert.equal((await mail.noticeMailTargets(pool)).items.length, 0);
    // The same stage again rings nothing.
    assert.deepEqual(await ws.pushesOf(pool, await ws.refresh(pool, [req(20)])), []);

    // Closed without going live: it stopped, and rings, owing no email.
    // T2.1 (19 Nov 2026): a closed change session is 'archived' (set aside,
    // withdrawn or voted down); no change session is ever 'closed'.
    await pool.query("UPDATE chat_sessions SET status = 'archived' WHERE id = $1", [up.id]);
    const stopped = await ws.refresh(pool, [req(20)]);
    assert.deepEqual([stopped[0].state.stage, stopped[0].bell], ['stopped', 'stopped']);
    await ws.pushesOf(pool, stopped);
    const after = await rows(ada);
    assert.deepEqual(after.map((r) => r.kind), ['build_ready', 'build_stopped']);
    assert.ok(after[1].mailed_at, 'no email for a stop');

    // A first version has its own news in its maker's chat: no stage bell.
    await ask(21, bob, 'First version of Seed swap');
    await pool.query('UPDATE homeroom_bot_requesters SET first_version = TRUE WHERE app_id = $1 AND issue_number = 21', [app.id]);
    const fv = await change(bot, 521, [21], 'merged', { promotedAt: new Date(), liveAt: new Date() });
    await run(21, 'ready', { buildOk: true, proposalSessionId: fv.id });
    const fvChanged = await ws.refresh(pool, [req(21)]);
    assert.deepEqual([fvChanged[0].state.stage, fvChanged[0].bell], ['live', 'live']);
    assert.deepEqual((await ws.pushesOf(pool, fvChanged)).map((p) => p.data.type), ['work_state', 'work_state']);
    assert.deepEqual(await rows(bob), []);

    // Somebody who blocked the bot is not rung.
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [bob.id, bot.id]);
    await ask(22, bob, 'Seed photos');
    const theirs = await change(bot, 522, [22], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await run(22, 'ready', { buildOk: true, proposalSessionId: theirs.id });
    await ws.pushesOf(pool, await ws.refresh(pool, [req(22)]));
    assert.deepEqual(await rows(bob), []);
  });

  // #6441: "Ready to try" outlives the change being ready. A change that
  // goes back to building withdraws its unread one; a stage that only moves
  // its line does not; being ready again rings a new one.
  await t.test('#6441: a change back in building withdraws its unread "ready to try"', async () => {
    await ask(30, ada, 'A swap calendar page');
    const up = await change(bot, 530, [30], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await run(30, 'ready', { buildOk: true, proposalSessionId: up.id });
    const rang = await ws.refresh(pool, [req(30)]);
    assert.deepEqual([rang[0].state.stage, rang[0].bell], ['up_for_vote', 'ready']);
    await ws.pushesOf(pool, rang);
    const readyRows = async () => (await pool.query(
      `SELECT id, read_at, mailed_at FROM notifications
        WHERE session_id = $1 AND kind = 'build_ready' ORDER BY id`, [up.id])).rows;
    assert.equal((await readyRows())[0].read_at, null, 'ready to try waits unread');

    // An update queued asks nobody for a vote (11 Nov 2026: its change is not
    // open for votes, so it is the bot's, waiting its turn), but takes
    // nothing back yet: the row somebody has not acted on (#6438's) stays
    // unread.
    const ask30 = await one(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, asker_id, instruction, status)
       VALUES ($1, $2, 30, $3, 'Make it bigger', 'queued') RETURNING id`,
      [app.id, up.id, ada.id]);
    const queued = await ws.refresh(pool, [req(30)]);
    assert.deepEqual([queued[0].state.stage, queued[0].state.line.code, queued[0].state.voteOpen], ['building', 'update_queued', false]);
    assert.deepEqual((await ws.pushesOf(pool, queued)).map((p) => p.data.type), ['work_state', 'work_state'], 'no bell, no withdraw');
    assert.equal((await readyRows())[0].read_at, null, 'nothing rebuilt yet');

    // Taken, it goes back to building: the unread row is withdrawn, its
    // email with it, and the open tab hears its bell moved.
    await pool.query("UPDATE homeroom_bot_change_asks SET status = 'taken', taken_at = NOW() WHERE id = $1", [ask30.id]);
    const back = await ws.refresh(pool, [req(30)]);
    assert.deepEqual([back[0].state.stage, back[0].bell], ['building', null]);
    const backPushes = await ws.pushesOf(pool, back);
    assert.deepEqual(backPushes.map((p) => p.data.type).sort(), ['notifications_changed', 'work_state', 'work_state']);
    assert.deepEqual(backPushes.find((p) => p.data.type === 'notifications_changed').routing, { userId: ada.id });
    const [withdrawn] = await readyRows();
    assert.ok(withdrawn.read_at, 'withdrawn, not deleted');
    assert.ok(withdrawn.mailed_at, 'and its email no longer goes');
    assert.equal((await readyRows()).length, 1, 'the row stays in All');

    // Ready again when the update lands: a new, unread one.
    await pool.query("UPDATE homeroom_bot_change_asks SET status = 'done', done_at = NOW() WHERE id = $1", [ask30.id]);
    const again = await ws.refresh(pool, [req(30)]);
    assert.deepEqual([again[0].state.stage, again[0].bell], ['up_for_vote', 'ready']);
    await ws.pushesOf(pool, again);
    const after = await readyRows();
    assert.equal(after.length, 2);
    assert.equal(after[1].read_at, null, 'the new one rings');
  });

  // 11 Nov 2026 (one model, step 1): the standing. A request's row carries
  // its change, what is asked of its requester and what the bot last said,
  // and its words; a change is open for votes only while it really is.
  await t.test('the standing: its change, its asks, its words, in the row and its push', async () => {
    await ask(40, ada, 'Swap history');
    const up = await change(bot, 540, [40], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await run(40, 'ready', { buildOk: true, proposalSessionId: up.id });
    // #6594: one yes is all the project's rule needs, and a change whose
    // votes are in is going live, not open for votes; a rule asking for two
    // keeps this one up for a vote with its yes counted.
    const { rows: [rule] } = await pool.query('SELECT approvals_required FROM apps WHERE id = $1', [app.id]);
    await pool.query('UPDATE apps SET approvals_required = 2 WHERE id = $1', [app.id]);
    require('../src/services/governance').invalidateGovernance(app.id);
    await pool.query("INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')", [up.id, bob.id]);
    const changed = await ws.refresh(pool, [req(40)]);
    const row = (await ws.forRequests(pool, app.id, [40])).get(40);
    assert.equal(row.stage, 'up_for_vote');
    assert.equal(row.voteOpen, true);
    assert.equal(row.leadChangeId, up.id);
    assert.deepEqual(row.words.stage, { id: 'core:work.stage.upForVote' });
    assert.deepEqual([row.change.id, row.change.number, row.change.status, row.change.votes, row.change.voteOpen],
      [up.id, 540, 'promoted', { yes: 1, no: 0 }, true]);
    assert.deepEqual(row.change.checks, { state: 'passing', phase: null, failing: null });
    assert.deepEqual(row.asks, { question: null, plan: null, closeVote: null, draft: null, offers: [], reports: 0 });
    assert.equal(row.said, null);
    const push = ws.pushOf(changed.find((c) => c.kind === 'request'));
    assert.equal(push.data.state.stage, 'up_for_vote');
    assert.deepEqual(push.data.state.words, row.words, 'the push carries the same row, words and all');
    assert.equal(push.data.state.change.id, up.id);
    // A vote marks the change, and its count moves in the row.
    await pool.query('DELETE FROM work_state_dirty');
    await pool.query("INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'no')", [up.id, ada.id]);
    assert.deepEqual((await pool.query('SELECT session_id FROM work_state_dirty')).rows.map((r) => Number(r.session_id)), [up.id]);
    await ws.drainDirty(pool);
    assert.deepEqual((await ws.forRequests(pool, app.id, [40])).get(40).change.votes, { yes: 1, no: 1 });
    // An open vote to close it is asked of the group, and its votes are in the row.
    const close = await one(
      `INSERT INTO issues (app_id, github_issue_number, title, created_by, kind, payload, status)
       VALUES ($1, 940, 'Close #40', $2, 'close_issue', '{"issueNumber": 40}'::jsonb, 'open') RETURNING id`, [app.id, bob.id]);
    await ws.drainDirty(pool);
    assert.deepEqual((await ws.forRequests(pool, app.id, [40])).get(40).asks.closeVote, { issueId: close.id, yes: 0, no: 0 });
    await pool.query('UPDATE apps SET approvals_required = $2 WHERE id = $1', [app.id, rule.approvals_required]);
    require('../src/services/governance').invalidateGovernance(app.id);
  });

  await t.test('a merged, merging, GitHub-held or shots-held change is never open for votes, nor a Vote row', async () => {
    const overview = require('../src/routes/workshop-overview');
    const owedTo = async (who, ids) => (await pool.query(
      `SELECT cs.id FROM chat_sessions cs WHERE cs.id = ANY($2::int[]) AND ${overview.OWED_PROPOSALS_WHERE}`,
      [who.id, ids])).rows.map((r) => Number(r.id));
    const head = 'abc';
    const made = {};
    made.open = await change(bob, 600, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    made.merged = await change(bob, 601, [], 'merged', { promotedAt: new Date(), liveAt: new Date(), checkState: 'passing' });
    made.merging = await change(bob, 602, [], 'merging', { promotedAt: new Date(), checkState: 'passing' });
    made.github = await change(bob, 603, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await pool.query(`UPDATE chat_sessions SET integration_block_reasons = '["github_checks"]'::jsonb WHERE id = $1`, [made.github.id]);
    made.shots = await change(bob, 604, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await pool.query(
      `UPDATE chat_sessions SET shots_state = 'exploring', shots_run_id = $2, shots_updated_at = NOW(),
              checks_checked_at = NOW(), shots_detail = $3::jsonb WHERE id = $1`,
      [made.shots.id, 'r'.repeat(32), JSON.stringify({ headSha: head, required: true })]);
    const ids = Object.values(made).map((c) => c.id);
    await ws.refresh(pool, ids.map((id) => ({ sessionId: id })));
    const rows = await ws.forChanges(pool, ids);
    const said = Object.fromEntries(Object.entries(made).map(([k, c]) => [k, [rows.get(c.id).stage, rows.get(c.id).voteOpen]]));
    assert.deepEqual(said, {
      open: ['up_for_vote', true],
      merged: ['live', false],
      merging: ['going_live', false],
      github: ['going_live', false],
      shots: ['checking', false],
    });
    assert.deepEqual(rows.get(made.shots.id).line, { code: 'shots' });
    assert.equal(rows.get(made.github.id).change.githubHold, true);
    assert.equal(rows.get(made.shots.id).change.shotsHeld, true);
    assert.deepEqual(await owedTo(ada, ids), [made.open.id], 'Needs you asks for a vote only on the change open for one');
    // Merged meanwhile: the row moves with it, and the Vote row goes.
    await pool.query("UPDATE chat_sessions SET status = 'merged' WHERE id = $1", [made.open.id]);
    await ws.drainDirty(pool);
    assert.equal((await ws.forChanges(pool, [made.open.id])).get(made.open.id).voteOpen, false);
    assert.deepEqual(await owedTo(ada, ids), []);
  });

  await t.test('the turn that takes a change\'s screenshots is no update on its way; a build turn still is', async () => {
    const head = 'abc';
    const taking = await change(bob, 605, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    const turn = (mode) => JSON.stringify({ turnId: `${mode}-turn`, mode, startedAt: new Date().toISOString() });
    // Its tests passed and the shots agent is at it: a turn on the change.
    await pool.query(
      `UPDATE chat_sessions SET shots_state = 'exploring', shots_run_id = $2, shots_updated_at = NOW(),
              checks_checked_at = NOW(), shots_detail = $3::jsonb, active_turn = $4::jsonb WHERE id = $1`,
      [taking.id, 's'.repeat(32), JSON.stringify({ headSha: head, required: true }), turn('shots')]);
    await ws.refresh(pool, [{ sessionId: taking.id }]);
    let row = (await ws.forChanges(pool, [taking.id])).get(taking.id);
    assert.deepEqual([row.stage, row.line, row.voteOpen], ['checking', { code: 'shots' }, false]);
    assert.equal(row.change.update, null, 'nothing is updating it');
    assert.equal(row.change.shotsHeld, true, 'its screenshots are what hold its vote');
    assert.deepEqual(row.words.stage, { id: 'core:work.stage.shots' });
    assert.equal(ws.says(row), 'Taking screenshots · Tests passed: only the before and after screenshots are left');
    // A turn that writes to it is an update, as before.
    await pool.query('UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1', [taking.id, turn('build')]);
    await ws.refresh(pool, [{ sessionId: taking.id }]);
    row = (await ws.forChanges(pool, [taking.id])).get(taking.id);
    assert.deepEqual([row.stage, row.line, row.change.update], ['building', { code: 'revising' }, 'running']);
    // The screenshots settled and the shots turn is still on record (its
    // release comes a moment later): the change is up for a vote already.
    await pool.query(
      `UPDATE chat_sessions SET shots_state = 'verified', active_turn = $2::jsonb WHERE id = $1`, [taking.id, turn('shots')]);
    await ws.refresh(pool, [{ sessionId: taking.id }]);
    row = (await ws.forChanges(pool, [taking.id])).get(taking.id);
    assert.deepEqual([row.stage, row.voteOpen], ['up_for_vote', true]);
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [taking.id]);
  });

  await t.test('a request being built never waits for its plan, anywhere', async () => {
    await ask(50, ada, 'A printable list');
    const build = await change(bot, null, [50], 'active');
    await one(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, build_session_id)
       VALUES ($1, 50, 'live', 'ready', NOW() - interval '1 hour', $2) RETURNING id`, [app.id, build.id]);
    await ws.refresh(pool, [req(50)]);
    const row = (await ws.forRequests(pool, app.id, [50])).get(50);
    assert.notEqual(row.stage, 'waiting_for_you');
    assert.ok(['planning', 'building'].includes(row.stage), row.stage);
    assert.equal(row.asks.plan, null, 'no plan waits for Build it');
    // Needs you (the Homeroom bot tab) does not list it as hers to act on.
    const aiWork = require('../src/services/ai-work');
    const stand = aiWork.standing({ change_status: null, own: true, state: 'open', kind: 'work', request_at: new Date() },
      ada.id, new Date(), bot.id, row, { decides: true });
    assert.notEqual(stand?.group, 'needs');
    // Nor does the bot tell her it waits for her.
    const mayor = require('../src/services/homeroom-bot-mayor');
    const item = mayor.standingItem(row, {});
    assert.equal(item.asks?.planWaitsForBuildIt, undefined);
    assert.notEqual(item.whoseMove, 'requester');
  });

  await t.test('Main\'s request_detail and the request\'s status payload say the same stage and whose move', async () => {
    const mayor = require('../src/services/homeroom-bot-mayor');
    const { standingsFor } = require('../src/routes/issues');
    const settings = { mode: 'live', apps: [] };
    for (const n of [1, 3, 4, 5, 40]) {
      const detail = await mayor.requestDetail(pool, {
        user: { id: ada.id, username: 'ws_ada', isAdmin: true }, project: app.slug, number: n, settings, deps: { domain: null },
      });
      const payload = (await standingsFor(pool, { app: { id: app.id, created_by: bob.id }, numbers: [n], viewer: { id: ada.id } })).get(n);
      assert.ok(detail.standing, `request ${n} has a standing in request_detail`);
      assert.deepEqual([detail.standing.stage, detail.standing.whoseMove], [payload.stage, payload.whoseMove], `request ${n}`);
      assert.equal(detail.standing.says, ws.says(payload, { yours: payload.mine }), `request ${n} says the same words`);
    }
  });

  // Review of the one-model finish (11 Nov 2026).
  await t.test('a change built for a request that goes back to Underway, or goes, is never left open for votes', async () => {
    await ask(61, ada, 'Swap reminders');
    const up = await change(bot, 561, [61], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await run(61, 'ready', { buildOk: true, proposalSessionId: up.id });
    await ws.refresh(pool, [req(61)]);
    const row = async () => (await ws.forChanges(pool, [up.id], { ensure: false })).get(up.id);
    assert.deepEqual([(await row()).stage, (await row()).voteOpen], ['up_for_vote', true]);
    // Unpromoted: its row is derived again, not frozen open for votes.
    await pool.query("UPDATE chat_sessions SET status = 'active' WHERE id = $1", [up.id]);
    await ws.drainDirty(pool);
    assert.deepEqual([(await row()).stage, (await row()).voteOpen], ['building', false]);
    // The sweep checks it like any row (it never stays the oldest unchecked).
    await pool.query(`UPDATE work_states SET checked_at = NOW() - interval '1 hour' WHERE item_kind = 'change' AND item_ref = $1`, [up.id]);
    await ws.sweep(pool, { olderThanMs: 0, limit: 500, seed: 0 });
    const checked = await one(`SELECT checked_at > NOW() - interval '1 minute' AS fresh FROM work_states WHERE item_kind = 'change' AND item_ref = $1`, [up.id]);
    assert.equal(checked.fresh, true);
    // Gone altogether: its row goes with it.
    await pool.query('UPDATE homeroom_bot_runs SET proposal_session_id = NULL WHERE proposal_session_id = $1', [up.id]);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [up.id]);
    await ws.refresh(pool, [{ sessionId: up.id }]);
    assert.equal(await row(), undefined);
  });

  await t.test('changes up for a vote with no row are marked, by the migration and on every boot (a staging copy)', async () => {
    const seed = await change(bob, 562, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    const merging = await change(bob, 563, [], 'merging', { promotedAt: new Date(), checkState: 'passing' });
    const idle = await change(bob, 564, [], 'active');
    await ws.drainDirty(pool);
    // As a staging copy starts: work states and their marks empty.
    await pool.query('DELETE FROM work_state_dirty');
    await pool.query(`DELETE FROM work_states WHERE item_kind = 'change' AND item_ref = ANY($1::int[])`, [[seed.id, merging.id, idle.id]]);
    const marked = async () => (await pool.query('SELECT session_id FROM work_state_dirty WHERE session_id = ANY($1::int[]) ORDER BY session_id',
      [[seed.id, merging.id, idle.id]])).rows.map((r) => Number(r.session_id));
    await require('../src/db/migrate').markChangesWithoutWorkState(pool);
    assert.deepEqual(await marked(), [seed.id, merging.id], 'up for a vote or merging, with no row');
    await require('../src/db/migrate').markChangesWithoutWorkState(pool);
    assert.deepEqual(await marked(), [seed.id, merging.id], 'marking again does nothing');
    await ws.drainDirty(pool);
    assert.equal((await ws.forChanges(pool, [seed.id], { ensure: false })).get(seed.id).voteOpen, true, 'Needs you finds it');
    // The migration's own statement, run again on a database that has rows: idempotent.
    await pool.query(`DELETE FROM work_states WHERE item_kind = 'change' AND item_ref = $1`, [merging.id]);
    const fs = require('node:fs');
    const path = require('node:path');
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/migrations/work-state-backfill-and-indexes.sql'), 'utf8'));
    assert.deepEqual(await marked(), [merging.id]);
    await ws.drainDirty(pool);
  });

  await t.test('a request\'s tries read its own newest runs, however many another request in the batch has', async () => {
    await ask(62, ada, 'Few runs');
    await ask(63, ada, 'Many runs');
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 62, 'live', 'ready'), ($1, 62, 'live', 'question')`,
      [app.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict)
       SELECT $1, 63, 'live', 'empty' FROM generate_series(1, 2100)`, [app.id]);
    const { rows } = await pool.query(ws.STANDING_RUNS_SQL, [[app.id, app.id], [62, 63]]);
    const count = (n) => rows.filter((r) => Number(r.issue_number) === n).length;
    assert.deepEqual([count(62), count(63)], [2, 200], 'at most 200 of each, and none of the other\'s taken');
    assert.ok(rows.every((r, i) => i === 0 || Number(rows[i - 1].id) > Number(r.id)), 'newest first');
    await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = 63', [app.id]);
  });

  await t.test('a change\'s requests are found by each run column\'s own index', async () => {
    await ask(64, ada, 'Built for');
    const build = await change(bot, null, [], 'active');
    await one(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id) VALUES ($1, 64, 'live', 'ready', $2) RETURNING id`,
      [app.id, build.id]);
    assert.deepEqual(await ws.requestsOfSession(pool, build.id), [{ appId: app.id, issueNumber: 64 }]);
    const proposed = await change(bot, 565, [], 'promoted', { promotedAt: new Date(), checkState: 'pending' });
    await run(64, 'ready', { proposalSessionId: proposed.id });
    assert.deepEqual(await ws.requestsOfSession(pool, proposed.id), [{ appId: app.id, issueNumber: 64 }]);
    const client = await pool.connect();
    let plan;
    try {
      await client.query('SET enable_seqscan = off');
      plan = (await client.query('EXPLAIN SELECT 1 FROM homeroom_bot_runs r WHERE r.build_session_id = 1')).rows
        .map((r) => r['QUERY PLAN']).join('\n');
      await client.query('RESET enable_seqscan');
    } finally { client.release(); }
    assert.match(plan, /idx_homeroom_bot_runs_build_session/);
  });

  await t.test('what is its requester\'s alone is theirs: nobody else\'s read or the push names it', async () => {
    await ask(65, ada, 'Swap by post, privately asked');
    const asked = await run(65, 'question');
    const sent = await dm.sendDm(pool, { bot, userId: ada.id, content: 'Which post office?' });
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id, question_status)
       VALUES ($1, $2, $3, $4, 65, 'question', $5, 'open')`,
      [sent.messageId, ada.id, sent.conversationId, app.id, asked.id]);
    const card = await one(
      `INSERT INTO bot_cards (user_id, conversation_id, app_id, kind, title, issue_number)
       VALUES ($1, $2, $3, 'build_plan', 'Swap by post', 65) RETURNING id`,
      [ada.id, sent.conversationId, app.id]);
    const changed = await ws.refresh(pool, [req(65)]);
    const { standingsFor } = require('../src/routes/issues');
    const read = async (viewer) => (await standingsFor(pool, { app: { id: app.id, created_by: bob.id }, numbers: [65], viewer })).get(65);
    const hers = await read({ id: ada.id });
    assert.equal(hers.asks.question.messageId, sent.messageId, 'she reads her own question');
    assert.deepEqual(hers.asks.offers.map((o) => o.id), [card.id]);
    assert.equal(hers.requesterId, ada.id);
    const his = await read({ id: bob.id });
    assert.equal(his.stage, hers.stage);
    assert.deepEqual(his.asks.question, { messageId: null, at: hers.asks.question.at }, 'that a question waits, not which message');
    assert.deepEqual([his.asks.offers, his.asks.openOffers], [[], 1]);
    assert.equal(his.requesterId, null);
    const push = ws.pushOf(changed.find((c) => c.kind === 'request' && c.ref === 65));
    assert.equal(push.kind, 'scoped');
    assert.deepEqual([push.data.state.asks.question.messageId, push.data.state.asks.offers, push.data.state.requesterId], [null, [], null]);
    assert.equal(JSON.stringify(push).includes(`"messageId":${sent.messageId}`), false);
  });

  // #6600: a takeover of a change nobody asked for (its own item) is read
  // from its own record: running says the bot is fixing its failing checks,
  // and a failed one says it could not, until the change is checked again.
  await t.test('#6600: a takeover holds its change, and a failed one says so', async () => {
    const ownTakeover = await change(bob, 550, [], 'promoted', { promotedAt: new Date(Date.now() - 60000), checkState: 'failing' });
    const look = await one(
      `INSERT INTO homeroom_bot_looks (user_id, app_id, session_id, question, kind, state)
       VALUES ($1, $2, $3, 'An update its author asked for', 'update', 'running') RETURNING id`,
      [bob.id, app.id, ownTakeover.id]);
    await ws.refresh(pool, [{ sessionId: ownTakeover.id }]);
    let state = await stored('change', ownTakeover.id);
    assert.deepEqual([state.stage, state.line], ['building', { code: 'fixing' }], 'the bot is fixing what its tests found');
    await pool.query(
      `UPDATE homeroom_bot_looks SET state = 'failed', error = 'the failing check is still failing', ended_at = NOW()
        WHERE id = $1`, [look.id]);
    await ws.refresh(pool, [{ sessionId: ownTakeover.id }]);
    state = await stored('change', ownTakeover.id);
    assert.deepEqual([state.stage, state.line], ['checking', { code: 'bot_fix_failed' }], 'it says the bot could not fix it');
    await pool.query(`UPDATE chat_sessions SET checks_checked_at = NOW() + INTERVAL '1 second' WHERE id = $1`, [ownTakeover.id]);
    await ws.refresh(pool, [{ sessionId: ownTakeover.id }]);
    state = await stored('change', ownTakeover.id);
    assert.deepEqual([state.stage, state.line], ['checking', { code: 'checks_failing' }], 'a verdict after it clears it');
  });

  // #6819: a follow-up turn refreshes the change's stored work state at its
  // start and its end, so the row never says "up for a vote" while the
  // change's page says an update is coming. A shots turn is no update.
  await t.test('#6819: a follow-up turn refreshes the stored work state, and lets go of it', async () => {
    const worker = require('../src/services/worker');
    const voice = require('../src/services/homeroom-bot-voice');
    await pool.query("UPDATE apps SET repo_url = 'https://github.com/seed/swap' WHERE id = $1", [app.id]);
    const followed = await change(bob, 610, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await pool.query("UPDATE chat_sessions SET branch_name = 'seed-swap-610' WHERE id = $1", [followed.id]);
    await ws.refresh(pool, [{ sessionId: followed.id }]);
    const voteOpen = async () => (await one(
      `SELECT vote_open FROM work_states WHERE item_kind = 'change' AND item_ref = $1`, [followed.id])).vote_open;
    assert.deepEqual([(await stored('change', followed.id)).stage, await voteOpen()], ['up_for_vote', true]);

    // The turn starts: the row is read again, without any route's write.
    const persisted = await worker._persistActiveTurn(followed.id, {
      turnId: 'turn-6819', phase: 'dispatch_pending', mode: 'build', journal: 'j6819', branchName: 'seed-swap-610',
    });
    assert.equal(persisted.ok, true);
    let state = await stored('change', followed.id);
    assert.deepEqual([state.stage, state.line], ['building', { code: 'revising' }], 'a build turn is an update under way');
    assert.equal(await voteOpen(), false, 'and not a vote to owe');

    // The turn ends: it asks again.
    await worker.finishTurn(followed.id, { turnId: 'turn-6819', journal: 'j6819' });
    assert.equal((await stored('change', followed.id)).stage, 'up_for_vote');

    // A shots turn is no update, at its start or its end.
    await worker._persistActiveTurn(followed.id, {
      turnId: 'turn-6819-shots', phase: 'dispatch_pending', mode: 'shots', journal: 'j6819s', branchName: 'seed-swap-610',
    });
    assert.equal((await stored('change', followed.id)).stage, 'up_for_vote', 'a shots turn leaves the vote up');
    await worker.finishTurn(followed.id, { turnId: 'turn-6819-shots', journal: 'j6819s' });
    assert.equal((await stored('change', followed.id)).stage, 'up_for_vote');

    // The asks: one taken is an update under way, and one done lets the vote go.
    await one(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, instruction, status)
       VALUES ($1, $2, NULL, 'drop the second line', 'queued') RETURNING id`, [app.id, followed.id]);
    await voice.takeAsks(pool, { sessionId: followed.id, runTag: 'run-6819' });
    state = await stored('change', followed.id);
    assert.deepEqual([state.stage, state.line], ['building', { code: 'revising' }], 'an ask taken is an update under way');
    await voice.finishAsks(pool, { runTag: 'run-6819' });
    assert.equal((await stored('change', followed.id)).stage, 'up_for_vote', 'the update landed: it asks again');
  });

  // Review A3 (19 Nov 2026): "ready to try" has one decider, the stored row.
  // The bot's change machine is told the moment a change's row opens
  // (VoteOpened, in the transaction that stored it), never before, once,
  // and only for a change it follows and has not finished with. The sweep
  // tells it of a row that opened where no event was appended (a Pod of the
  // release before stored it).
  await t.test('A3: the bot\'s change machine hears VoteOpened when its change\'s row opens, and only then', async () => {
    // An instance of the bot's change machine, as the kernel writes one.
    const follow = async (sessionId, state, data = {}) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.wf_writer', 'transition', true)`);
        await client.query(
          `INSERT INTO wf_instances (machine, key, app_id, state, data, machine_version)
           VALUES ('bot-change', $1, $2, $3, $4::jsonb, 4)`,
          [`session:${sessionId}`, app.id, state, JSON.stringify({ sessionId, ...data })]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };
    const opened = async (sessionId) => (await pool.query(
      `SELECT type, payload, source, status, producer FROM wf_events
        WHERE machine = 'bot-change' AND key = $1 AND type = 'VoteOpened' ORDER BY id`, [`session:${sessionId}`])).rows;
    const store = async (sessionId) => ws.pushesOf(pool, await ws.refresh(pool, [{ sessionId }]));

    // The bot's change, up with its checks still running: not open, nothing said.
    const bots = await change(bot, 620, [], 'promoted', { promotedAt: new Date(), checkState: 'pending' });
    await follow(bots.id, 'checking');
    await store(bots.id);
    assert.equal((await stored('change', bots.id)).stage, 'checking');
    assert.deepEqual(await opened(bots.id), [], 'not open for votes: the machine is not told');

    // Its checks pass on its head: the row opens, and the machine hears it once.
    await pool.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [bots.id]);
    await store(bots.id);
    assert.equal((await stored('change', bots.id)).stage, 'up_for_vote');
    const told = await opened(bots.id);
    assert.equal(told.length, 1);
    assert.deepEqual([told[0].payload, told[0].source, told[0].status], [{ sessionId: bots.id }, { kind: 'route', name: 'work-state' }, 'pending']);
    await store(bots.id);
    assert.equal((await opened(bots.id)).length, 1, 'a refresh that changes nothing says nothing again');

    // A change the machine has finished with, and one it does not follow, are never told.
    const done = await change(bot, 621, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await follow(done.id, 'closed');
    const unfollowed = await change(bob, 622, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await store(done.id);
    await store(unfollowed.id);
    assert.equal((await stored('change', done.id)).stage, 'up_for_vote');
    assert.deepEqual([await opened(done.id), await opened(unfollowed.id)], [[], []]);

    // A row that opened with no event (stored by an older Pod): the sweep's
    // backstop tells the machine, once, and not while it has heard already.
    const missed = await change(bot, 623, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await ws.refresh(pool, [{ sessionId: missed.id }]);
    await follow(missed.id, 'checking');
    assert.equal(await ws.botChangesWaiting(pool), 0, 'stored within the last minute: its own refresh may still tell it');
    await pool.query(`UPDATE work_states SET updated_at = NOW() - interval '2 minutes' WHERE item_kind = 'change' AND item_ref = $1`, [missed.id]);
    assert.equal(await ws.botChangesWaiting(pool), 1);
    assert.equal((await opened(missed.id)).length, 1);
    assert.equal(await ws.botChangesWaiting(pool), 0, 'one pending already: not told twice');
    // Told for this approval epoch already (its `told`): nothing to say.
    const toldAlready = await change(bot, 624, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await ws.refresh(pool, [{ sessionId: toldAlready.id }]);
    await follow(toldAlready.id, 'checking', { told: 0 });
    await pool.query(`UPDATE work_states SET updated_at = NOW() - interval '2 minutes' WHERE item_kind = 'change' AND item_ref = $1`, [toldAlready.id]);
    assert.equal(await ws.botChangesWaiting(pool), 0);
    assert.deepEqual(await opened(toldAlready.id), []);
  });

  // Review B3 (19 Nov 2026): one writer at a time per item. A writer takes
  // the item's lock before it reads the facts, and one that finds it taken
  // leaves the item to its holder; the drain puts that item's mark back, so
  // it is derived again after the holder's commit.
  await t.test('B3: a refresh leaves an item another writer is deriving, and the drain marks it again', async () => {
    await pool.query('DELETE FROM work_state_dirty');
    await ask(140, ada, 'Seed labels');
    await ws.refresh(pool, [req(140)]);
    assert.deepEqual((await stored('request', 140)).line, { code: 'waiting' });
    const marks = async () => (await pool.query(
      'SELECT issue_number FROM work_state_dirty WHERE app_id = $1 ORDER BY id', [app.id])).rows.map((r) => Number(r.issue_number));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      assert.equal((await ws.takeItems(holder, [`request:${app.id}:140`])).size, 0, 'the holder takes it');
      assert.equal((await ws.takeItems(holder, [`request:${app.id}:140`])).size, 0, 'and takes it again in its own transaction');
      // A fact moves meanwhile (it marks the request), and another writer comes.
      await pool.query('INSERT INTO homeroom_bot_queue (app_id, issue_number, priority) VALUES ($1, 140, 1)', [app.id]);
      assert.deepEqual(await marks(), [140]);
      const skipped = [];
      assert.deepEqual(await ws.refresh(pool, [req(140)], { skipped }), [], 'nothing stored');
      assert.deepEqual(skipped, [req(140)]);
      assert.deepEqual((await stored('request', 140)).line, { code: 'waiting' }, 'its row is left to its holder');
      // The drain takes the mark, finds the item taken, and marks it again.
      const drained = await ws.drainDirty(pool);
      assert.equal(drained.taken, 1);
      assert.deepEqual(drained.changed, []);
      assert.deepEqual(await marks(), [140], 'marked again, for after the holder');
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    const after = await ws.drainDirty(pool);
    assert.deepEqual(after.changed.map((c) => [c.ref, c.state.line && c.state.line.code]), [[140, 'queued']]);
    // (Its move into the bot's line marks the project's others in it: markPlaces.)
    assert.equal((await marks()).includes(140), false, 'taken, and not marked again');
  });

  // A route's own refresh (on a pool, holding nothing else) waits a moment
  // for a holder rather than leaving its row to the drain.
  await t.test('B3: a route\'s refresh waits a moment for the holder, then writes its row', async () => {
    await ask(145, ada, 'Seed swap trades');
    await ws.refresh(pool, [req(145)]);
    const holder = await pool.connect();
    await holder.query('BEGIN');
    assert.equal((await ws.takeItems(holder, [`request:${app.id}:145`])).size, 0);
    await pool.query('INSERT INTO homeroom_bot_queue (app_id, issue_number, priority) VALUES ($1, 145, 1)', [app.id]);
    const released = new Promise((resolve) => {
      setTimeout(() => { holder.query('COMMIT').finally(() => { holder.release(); resolve(); }); }, 250);
    });
    const out = await ws.touched(pool, [req(145)]);
    await released;
    assert.deepEqual(out.filter((c) => c.kind === 'request').map((c) => [c.ref, c.state.line && c.state.line.code]), [[145, 'queued']]);
  });

  await t.test('B3: a moment rings once while its bell is unread, and a real return to it rings again', async () => {
    await ask(141, ada, 'Swap shelf');
    const up = await change(bot, 641, [141], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    const bells = async () => (await pool.query(
      `SELECT id, kind, bell_key FROM notifications WHERE user_id = $1 AND kind = 'build_ready' AND session_id = $2 ORDER BY id`,
      [ada.id, up.id])).rows;
    await run(141, 'ready', { buildOk: true, proposalSessionId: up.id });
    const opened = (await ws.refresh(pool, [req(141)])).filter((c) => c.kind === 'request');
    assert.deepEqual([opened[0].state.stage, opened[0].bell], ['up_for_vote', 'ready']);
    await ws.pushesOf(pool, opened);
    const [first] = await bells();
    assert.equal(first.bell_key, ws.bellKeyOf(opened[0]));
    assert.match(first.bell_key, new RegExp(`^work:request:${app.id}:141:up_for_vote::\\d{4}-`));
    // The same move stored again (an older reading written over it, then
    // put right): the same item, stage and since, while its bell is unread.
    assert.deepEqual(await ws.bellPushes(pool, opened), [], 'no second bell');
    assert.equal((await bells()).length, 1);
    // Read, and the same moment again: a real return rings.
    await pool.query('UPDATE notifications SET read_at = NOW() WHERE id = $1', [first.id]);
    assert.equal((await ws.bellPushes(pool, opened)).length, 1);
    assert.equal((await bells()).length, 2);
  });

  await t.test('B3: a row a reader makes first is published, and rings its bell', async () => {
    await ask(142, ada, 'Seed calendar export');
    const up = await change(bot, 642, [142], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    await run(142, 'ready', { buildOk: true, proposalSessionId: up.id });
    assert.equal(await stored('request', 142), undefined);
    // A reader finds no row and makes it: what that changed is published.
    const made = await ws.ensure(pool, [req(142)]);
    assert.deepEqual(made.filter((c) => c.kind === 'request').map((c) => [c.ref, c.bell]), [[142, 'ready']]);
    const { rows: rang } = await pool.query(
      `SELECT kind FROM notifications WHERE user_id = $1 AND kind = 'build_ready' AND session_id = $2`, [ada.id, up.id]);
    assert.equal(rang.length, 1, 'the bell its first state rings');
    assert.deepEqual(await ws.ensure(pool, [req(142)]), [], 'a row that exists is not made again');
    // A change's row made by its reader, too: returned, opened for votes.
    const lone = await change(bob, 643, [], 'promoted', { promotedAt: new Date(), checkState: 'passing' });
    const made2 = await ws.ensureChanges(pool, [lone.id]);
    assert.deepEqual(made2.map((c) => [c.kind, c.state.voteOpen, c.prev]), [['change', true, null]]);
    assert.deepEqual(await ws.ensureChanges(pool, [lone.id]), []);
  });

  await t.test('B3: a row whose time alone moved is a row that changed', async () => {
    const at = new Date(Date.now() - 60 * 60 * 1000);
    await ask(143, bob, 'Seed swap map');
    const up = await change(bot, 644, [143], 'promoted', { promotedAt: at, checkState: 'passing' });
    await run(143, 'ready', { buildOk: true, proposalSessionId: up.id });
    await ws.refresh(pool, [req(143)]);
    const before = await one(`SELECT since, updated_at FROM work_states WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 143`, [app.id]);
    // Put up again later (a new promote): the same stage, a new since.
    const later = new Date(at.getTime() + 30 * 60 * 1000);
    await pool.query('UPDATE chat_sessions SET promoted_at = $2 WHERE id = $1', [up.id, later]);
    const moved = (await ws.refresh(pool, [req(143)])).filter((c) => c.kind === 'request');
    assert.equal(moved.length, 1, 'stored, and pushed');
    assert.equal(moved[0].bell, null, 'the same stage rings nothing');
    const after = await one(`SELECT stage, since, updated_at FROM work_states WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 143`, [app.id]);
    assert.equal(after.stage, 'up_for_vote');
    assert.equal(new Date(after.since).toISOString(), later.toISOString());
    assert.ok(new Date(after.updated_at) > new Date(before.updated_at));
  });

  // B3: nothing tested the two sweeps that read a row again by time and by
  // which derive wrote it.
  await t.test('B3: the version sweep derives an older derive\'s rows again, quietly; the due sweep reads rows that are due', async () => {
    await ask(144, ada, 'Seed swap reminders');
    await ws.refresh(pool, [req(144)]);
    const row = () => one(
      `SELECT stage, line, standing, derive_version, updated_at, checked_at FROM work_states
        WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 144`, [app.id]);
    const fresh = await row();
    assert.equal(fresh.derive_version, ws.DERIVE_VERSION, 'its own column');
    assert.equal(fresh.standing.v, ws.DERIVE_VERSION, 'and the standing, for the release before');
    assert.equal(ws.versionOf(fresh), ws.DERIVE_VERSION);
    // Written by an older derive: as before the column, and as a Pod of the
    // release before writes it again (the standing's `v` only).
    const older = async (version, column) => {
      await pool.query(
        `UPDATE work_states SET standing = jsonb_set(standing, '{v}', to_jsonb($2::int)), derive_version = $3,
                checked_at = NOW() - interval '1 hour'
          WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 144`, [app.id, version, column]);
    };
    for (const [v, column] of [[1, null], [ws.DERIVE_VERSION - 1, ws.DERIVE_VERSION]]) {
      await older(v, column);
      const was = await row();
      assert.equal(ws.versionOf(was), v);
      const swept = await ws.sweep(pool, { olderThanMs: 24 * 60 * 60 * 1000, seed: 0 });
      assert.ok(!swept.changed.some((c) => c.kind === 'request' && c.ref === 144), `v${v}: nothing a reader sees changed: no push`);
      const now = await row();
      assert.deepEqual([now.derive_version, now.standing.v], [ws.DERIVE_VERSION, ws.DERIVE_VERSION], `v${v}: derived again`);
      assert.equal(String(now.updated_at), String(was.updated_at), `v${v}: quietly, so no list moves`);
      assert.ok(new Date(now.checked_at) > new Date(was.checked_at));
    }
    // At this derive: not read again by the version sweep.
    const settled = await row();
    await ws.sweep(pool, { olderThanMs: 24 * 60 * 60 * 1000, seed: 0 });
    assert.equal(String((await row()).checked_at), String(settled.checked_at));

    // Due: read again once its due time passes, and not before.
    const due = async (at) => pool.query(
      `UPDATE work_states SET standing = jsonb_set(standing, '{dueAt}', to_jsonb($2::text)), checked_at = NOW() - interval '1 hour'
        WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 144`, [app.id, at.toISOString()]);
    await due(new Date(Date.now() + 60 * 60 * 1000));
    const notYet = await row();
    const quiet = await ws.sweep(pool, { olderThanMs: 24 * 60 * 60 * 1000, seed: 0 });
    assert.equal(String((await row()).checked_at), String(notYet.checked_at), 'not due yet: not read');
    assert.ok(Number.isInteger(quiet.due));
    await due(new Date(Date.now() - 60 * 1000));
    const pastDue = await row();
    const swept = await ws.sweep(pool, { olderThanMs: 24 * 60 * 60 * 1000, seed: 0 });
    assert.ok(swept.due >= 1, 'read as due');
    const read = await row();
    assert.ok(new Date(read.checked_at) > new Date(pastDue.checked_at), 'derived again');
    assert.equal(read.standing.dueAt, undefined, 'a row that moves by nothing has no due time');
    assert.equal(String(read.updated_at), String(pastDue.updated_at), 'its due time alone moved: stored quietly');
  });
});

