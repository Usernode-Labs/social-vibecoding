'use strict';

// 15 Oct 2026: Try again finishes a first version that was built, against
// the full PostgreSQL schema, through a real tap.
//
// A first version built to the end whose proposal was refused stops "built
// but could not be proposed", its session paused with its branch pushed.
// Its Try again used to reach the bot's chat model, which started it over: a
// new plan, a new build, tens of minutes from its maker's allowance. Here the
// maker's tap (their "Try again" replying to the message that said it
// stopped, in the request's thread) proposes the session the build left,
// once however often it is tapped, says so under the tap and then as every
// first version does, and the project's screens stop saying Stopped. What
// cannot be finished that way (its branch gone, any other stop, the proposal
// refused again, other words) goes to the model as before, which starts it
// over. The pure halves: tests/first-version-finish.test.js.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-version-finish-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons. The bot's message in a
// request's thread is written as the real one writes it.
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent: () => 1, pushToUser: () => 1, pushNotificationToUser: () => 1, pushIssueUpdate() {},
    async sendSystemMessage() { return { id: 1 }; },
    async sendBotMessage(db, appId, { user: from, content, metadata = null, thread, msgType = 'message' }) {
      const { rows: [row] } = await db.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [appId, from.id, content, msgType, JSON.stringify(metadata || {}), thread.type, thread.ref],
      );
      return { id: row.id, createdAt: row.created_at };
    },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = { id: pushId, filename: pushId, loaded: true, exports: { scheduleBadgeSync() { return false; } } };

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const { OWN_WORK } = require('../src/services/lifecycle');

const UNPROPOSED = 'the change was built but could not be proposed: Server is restarting';

test('Try again finishes a first version that was built, through a real tap', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `fv_finish_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the new column included

  async function user(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username, has_platform_access AS "hasPlatformAccess"`,
      [username, synthetic],
    );
    return row;
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'live')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Club Votes', 'club-votes', 'running', $1, 'https://github.com/usernode-bot/club-votes') RETURNING *`,
    [ada.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, filed_at)
     VALUES ($1, $2, 'Vote on club things', 'filed', 1, NOW())`,
    [app.id, ada.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
     VALUES ($1, 1, $2, 'First version of Club Votes', TRUE)`,
    [app.id, ada.id],
  );
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, status, created_by) VALUES ($1, 1, 'First version of Club Votes', 'open', $2)`,
    [app.id, ada.id],
  );
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const conversationId = opened.conversationId;
  // The request's card in her chat with the bot: what the bot says about it
  // is said in Main beside it (#6019).
  const card = await dm.sendDm(pool, { bot, userId: ada.id, content: '**Club Votes**, its first version' });
  await pool.query(
    `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind)
     VALUES ($1, $2, $3, $4, 1, 'activity')`,
    [card.messageId, ada.id, conversationId, app.id],
  );

  // GitHub, the promote route and the model, as the tap reaches them.
  const heads = new Map();
  // A one-shot hold a subtest can arm (#5211): while one is armed, the first
  // tap to read the branch on GitHub waits there, and the promote route
  // releases it once its UPDATE has returned, before it answers. That holds
  // the tap whose snapshot was taken before the other tap claimed the run,
  // so its own checks then meet the proposal the other tap made. Disarmed in
  // the subtest's finally, so no later case waits.
  const branchHold = { armed: null, taken: null };
  const github = {
    isEnabled: () => true,
    async getBranchSha(owner, repo, branch) {
      const hold = branchHold.armed;
      if (hold) {
        branchHold.armed = null;
        branchHold.taken = hold;
        await hold.wait;
      }
      if (!heads.has(branch)) throw Object.assign(new Error('Not Found'), { status: 404 });
      return heads.get(branch);
    },
    async fetchPublicIssue() { return { issue: { state: 'open', updatedAt: new Date().toISOString() } }; },
    async fetchIssueComments() { return { comments: [] }; },
    async createIssueComment() { return { id: 1, created_at: new Date().toISOString() }; },
    async getBotUsername() { return 'usernode-bot'; },
  };
  const promotes = [];
  const refuse = new Set();
  const votesRouter = {
    handle(req, res) {
      promotes.push(req);
      const id = Number(req.url.match(/sessions\/(\d+)\/promote/)[1]);
      if (refuse.has(id)) {
        setImmediate(() => res.status(409).json({ error: 'This proposal\'s pull request was closed on GitHub and couldn\'t be reopened.' }));
        return;
      }
      // The route's own work: up for approval, with its pull request.
      pool.query(
        `UPDATE chat_sessions SET status = 'promoted', pr_number = $2, promoted_at = NOW()
          WHERE id = $1 AND status IN ('active', 'paused') RETURNING id`,
        [id, 100 + id],
      ).then(({ rows }) => {
        // The hold is released here, once the session is up and before this
        // answers: the held tap goes on with the proposal on the session.
        if (branchHold.taken) {
          branchHold.taken.release();
          branchHold.taken = null;
        }
        return rows.length
          ? res.status(200).json({ ok: true, prNumber: 100 + id })
          : res.status(404).json({ error: 'Active session not found' });
      });
    },
  };
  let modelTurns = 0;
  const mayor = {
    async decideOffer() { return null; },
    async reviseAttached() { return null; },
    async runDmTurn() { modelTurns += 1; return { model: true }; },
  };
  const deps = {
    bot, mayor, github, votesRouter, domain: 'example.test', proposeRetryMs: [],
    threadContext: { loadIssueThread: async () => ({ messages: [] }), loadProposalThread: async () => ({ messages: [] }) },
  };

  // A first version built and stopped as the build leaves it: its session
  // the bot's, paused, on the branch it pushed, its run the request's newest,
  // and Homeroom bot's message saying so in the request's thread.
  let seq = 0;
  async function stopped({ error = UNPROPOSED, pushed = true } = {}) {
    seq += 1;
    const branch = `hrbot/club-votes-${seq}`;
    const sha = crypto.createHash('sha1').update(branch).digest('hex');
    if (pushed) heads.set(branch, sha);
    const { rows: [session] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, linked_issues)
       VALUES ($1, $2, $3, 'paused', 'First version of Club Votes', ARRAY[1]) RETURNING id`,
      [app.id, bot.id, branch],
    );
    await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content) VALUES ($1, 1, '# Club Votes')`, [session.id],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_error, build_session_id,
                                      build_branch, build_sha, build_commits, build_spec_md)
       VALUES ($1, 1, 'live', 'ready', FALSE, $2, $3, $4, $5, 3, '# Club Votes') RETURNING id`,
      [app.id, error, session.id, branch, sha],
    );
    const said = await dm.relayIssuePost({
      pool, app, issueNumber: 1, kind: 'build_failed', runId: run.id, postId: 9000 + seq, bot, dm: { reason: error },
    });
    assert.ok(said?.messageId, 'said in her chat');
    return { sessionId: session.id, runId: run.id, branch, sha, said };
  }
  const tap = async (built, content = 'Try again') => {
    const sent = await conversations.sendMessage(pool, { id: ada.id, username: ada.username }, conversationId, {
      content, reply_to_id: built.said.messageId,
    });
    assert.ok(sent?.message, 'her reply was sent');
    return dm.noteUserMessage(pool, {}, { user: ada, conversationId, message: sent.message, deps });
  };
  const runRow = async (id) => (await pool.query(
    'SELECT build_ok, build_error, proposal_session_id, build_finish FROM homeroom_bot_runs WHERE id = $1', [id],
  )).rows[0];
  const botSaid = async (afterId) => (await pool.query(
    `SELECT id, content, thread_root_id FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND id > $3 ORDER BY id`,
    [conversationId, bot.id, afterId],
  )).rows;
  const fv = () => dm.firstVersionState(pool, app.id, { viewerId: ada.id });
  // Each case starts from a request with nothing up: an earlier case's
  // proposal is withdrawn, as a closed proposal leaves it.
  const clear = () => pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE app_id = $1 AND status <> 'archived'`, [app.id]);

  await t.test('the message says Try again finishes it, and Try again proposes what was built, once', async () => {
    const built = await stopped();
    const said = (await pool.query('SELECT content, metadata FROM conversation_messages WHERE id = $1', [built.said.messageId])).rows[0];
    assert.equal(said.content, 'I built Club Votes but couldn\'t put it live yet. Tap Try again and I\'ll finish it.');
    assert.deepEqual(said.metadata.homeroomBot.actions, dm.STUCK_ACTIONS.build_failed, 'the same Try again, sent quoting it');
    assert.equal((await fv()).line, 'stopped', 'Stopped on the App tab, the hub and the tile');

    await tap(built);
    assert.equal(promotes.length, 1, 'proposed');
    assert.equal(promotes[0].url, `/api/sessions/${built.sessionId}/promote`, 'the session the build left');
    assert.equal(promotes[0][OWN_WORK], true);
    assert.equal(promotes[0].user.id, bot.id);
    assert.equal(modelTurns, 0, 'decided without the model');
    const run = await runRow(built.runId);
    assert.equal(run.build_ok, true);
    assert.equal(run.proposal_session_id, built.sessionId, 'the run\'s proposal');
    assert.equal(run.build_finish.outcome, 'proposed');
    assert.equal(run.build_finish.by, ada.id);
    assert.equal(run.build_error, `proposed on its maker's Try again after: ${UNPROPOSED}`);
    // Said under the tap, then as every first version says it: built and
    // being tested, in Main (#6019: one conversation, no thread per request).
    const lines = await botSaid(built.said.messageId);
    assert.deepEqual(lines.map((l) => l.content), [
      'Finishing it now. I\'ll tell you here when it\'s ready to try.',
      'Built. Testing it: its checks, and its before and after screens.',
    ]);
    assert.ok(lines.every((l) => l.thread_root_id === null), 'in Main');
    const { rows: posts } = await pool.query(
      'SELECT kind, pending FROM homeroom_bot_posts WHERE run_id = $1 ORDER BY id', [built.runId],
    );
    assert.deepEqual(posts.map((p) => [p.kind, p.pending === true]), [['proposal', false]], 'the proposal said on its request, and sent');
    // The project's screens: no longer Stopped, but being tested.
    const state = await fv();
    assert.equal(state.line, 'testing');
    assert.equal(state.stopped, undefined);
    // Its buttons answered, on every device.
    const meta = (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [built.said.messageId])).rows[0].metadata.homeroomBot;
    assert.deepEqual([meta.status, meta.chosen], ['answered', 'try_again']);

    // Tapped again (another device, or the words again): nothing more.
    const before = (await botSaid(0)).at(-1).id;
    await tap(built);
    assert.equal(promotes.length, 1, 'proposed once');
    assert.equal(modelTurns, 0);
    assert.deepEqual((await botSaid(before)).map((l) => l.content),
      ['I\'m already finishing it. I\'ll tell you here when it\'s ready to try.']);
  });

  await t.test('two taps at once propose it once', async () => {
    await clear();
    const built = await stopped();
    const proposedBefore = promotes.length;
    await Promise.all([tap(built), tap(built)]);
    assert.equal(promotes.length, proposedBefore + 1);
    assert.equal(modelTurns, 0);
    const lines = (await botSaid(built.said.messageId)).map((l) => l.content);
    assert.equal(lines.filter((l) => l.startsWith('Finishing it now.')).length, 1);
    assert.equal(lines.filter((l) => l.startsWith('I\'m already finishing it.')).length, 1);
    assert.equal((await runRow(built.runId)).proposal_session_id, built.sessionId);
  });

  await t.test('a tap that read it before another tap proposed it is told it is already finishing', async () => {
    await clear();
    const built = await stopped();
    // The losing ordering (#5211), forced: the first tap to read the branch
    // waits there while the other claims the run and puts its proposal up.
    // Released by the promote route, it goes on through its own checks,
    // which meet that proposal and used to read it as a reason to start the
    // request over; they look once more at the claim instead, and answer
    // already.
    const hold = {};
    hold.wait = new Promise((resolve) => { hold.release = resolve; });
    branchHold.armed = hold;
    try {
      const proposedBefore = promotes.length;
      const turns = modelTurns;
      await Promise.all([tap(built), tap(built)]);
      assert.equal(promotes.length, proposedBefore + 1, 'proposed once');
      assert.equal(modelTurns, turns, 'decided without the model');
      const lines = (await botSaid(built.said.messageId)).map((l) => l.content);
      assert.equal(lines.filter((l) => l.startsWith('Finishing it now.')).length, 1);
      assert.equal(lines.filter((l) => l.startsWith('I\'m already finishing it.')).length, 1);
      const run = await runRow(built.runId);
      assert.equal(run.proposal_session_id, built.sessionId, 'the run\'s proposal');
      assert.equal(run.build_finish.outcome, 'proposed');
    } finally {
      branchHold.armed = null;
      if (branchHold.taken) {
        branchHold.taken.release();
        branchHold.taken = null;
      }
    }
  });

  await t.test('what cannot be finished goes to the model, which starts it over', async (tt) => {
    await tt.test('its branch is gone', async () => {
      await clear();
      const built = await stopped({ pushed: false });
      const proposedBefore = promotes.length;
      const turns = modelTurns;
      await tap(built);
      assert.equal(promotes.length, proposedBefore, 'nothing proposed');
      assert.equal(modelTurns, turns + 1, 'the model has it: start_request');
      assert.equal((await runRow(built.runId)).build_finish, null, 'nothing claimed');
      assert.equal((await fv()).line, 'stopped', 'still Stopped until it is started over');
    });
    await tt.test('it stopped for another reason, and said it would start over', async () => {
      await clear();
      const built = await stopped({ error: 'the build ran past its time limit' });
      const said = (await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [built.said.messageId])).rows[0];
      assert.equal(said.content, 'I couldn\'t finish building Club Votes: it took longer than I\'m allowed. Tap Try again and I\'ll start over.');
      const proposedBefore = promotes.length;
      const turns = modelTurns;
      await tap(built);
      assert.equal(promotes.length, proposedBefore);
      assert.equal(modelTurns, turns + 1);
    });
    await tt.test('the proposal is refused again', async () => {
      await clear();
      const built = await stopped();
      refuse.add(built.sessionId);
      const proposedBefore = promotes.length;
      const turns = modelTurns;
      await tap(built);
      assert.equal(promotes.length, proposedBefore + 1, 'tried');
      assert.equal(modelTurns, turns + 1, 'then started over by the model');
      const run = await runRow(built.runId);
      assert.equal(run.build_ok, false, 'still stopped');
      assert.equal(run.build_finish.outcome, 'failed');
      assert.equal((await fv()).line, 'stopped');
      assert.deepEqual((await botSaid(built.said.messageId)).map((l) => l.content), [], 'nothing said under the tap');
      // Tapped again: started over again, never proposed twice.
      await tap(built);
      assert.equal(promotes.length, proposedBefore + 1);
      assert.equal(modelTurns, turns + 2);
    });
    await tt.test('other words under the message', async () => {
      await clear();
      const built = await stopped();
      const proposedBefore = promotes.length;
      const turns = modelTurns;
      await tap(built, 'Can you try again but make it blue?');
      assert.equal(promotes.length, proposedBefore);
      assert.equal(modelTurns, turns + 1);
    });
  });
});
