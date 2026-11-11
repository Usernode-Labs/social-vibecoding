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
    assert.equal(await stored('request', 7), undefined);
    const first = await ws.sweep(pool, { olderThanMs: 0 });
    assert.equal(first.seeded, 1);
    assert.equal((await stored('request', 7)).stage, 'reading');
    const before = await one(`SELECT checked_at FROM work_states WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 7`, [app.id]);
    const again = await ws.sweep(pool, { olderThanMs: 0, limit: 100 });
    assert.equal(again.seeded, 0);
    assert.ok(again.checked >= 1);
    const after = await one(`SELECT checked_at FROM work_states WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 7`, [app.id]);
    assert.ok(new Date(after.checked_at) > new Date(before.checked_at), 'an unchanged row is still marked checked');
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
    await pool.query("UPDATE chat_sessions SET status = 'closed' WHERE id = $1", [up.id]);
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
});

