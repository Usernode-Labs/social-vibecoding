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
    assert.equal(changed.length, 7);
    const s1 = await stored('request', 1);
    assert.deepEqual([s1.stage, s1.line, s1.whose_move, Number(s1.requester_id)], ['reading', { code: 'queued', place: 2 }, 'bot', ada.id]);
    assert.deepEqual((await stored('request', 2)).line, { code: 'queued', place: 1 });
    const s3 = await stored('request', 3);
    assert.deepEqual([s3.stage, s3.line], ['building', { code: 'held_builds' }]);
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
    assert.equal(changed.length, 1);
    assert.deepEqual([changed[0].kind, changed[0].ref, changed[0].state.stage, changed[0].bell], ['request', 5, 'up_for_vote', 'ready']);
    assert.equal(Number(changed[0].sessionId), failing.id);
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
    const before = await one('SELECT checked_at FROM work_states WHERE app_id = $1 AND item_ref = 7', [app.id]);
    const again = await ws.sweep(pool, { olderThanMs: 0, limit: 100 });
    assert.equal(again.seeded, 0);
    assert.ok(again.checked >= 1);
    const after = await one('SELECT checked_at FROM work_states WHERE app_id = $1 AND item_ref = 7', [app.id]);
    assert.ok(new Date(after.checked_at) > new Date(before.checked_at), 'an unchanged row is still marked checked');
    assert.equal((await stored('request', 3)).stage, 'closed');
    const closedChecked = await one('SELECT checked_at, updated_at FROM work_states WHERE app_id = $1 AND item_ref = 3', [app.id]);
    assert.equal(String(closedChecked.checked_at), String(closedChecked.updated_at), 'a closed row is not swept');
  });

  await t.test('readers: a person\'s own rows, and a project\'s by number', async () => {
    const hers = await ws.forRequester(pool, ada.id);
    assert.deepEqual(hers.map((r) => r.ref).sort(), [1, 2, 3, 4]);
    assert.equal(hers[0].app.slug, 'ws-seeds');
    const byNumber = await ws.forRequests(pool, app.id, [5, 6, 99]);
    assert.deepEqual([...byNumber.keys()].sort(), [5, 6]);
    assert.equal(byNumber.get(6).stage, 'live');
  });
});
