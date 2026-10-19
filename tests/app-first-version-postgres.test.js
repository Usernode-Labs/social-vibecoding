'use strict';

// #15 (D9): "being built from your description".
//
// While the Homeroom bot builds a project's first version from its
// description, the running app is the starter its repo was scaffolded with,
// which tells its creator to "Start a new change" for a change already being
// made. GET /api/apps/:slug now says so (`first_version`), from
// services/homeroom-bot-dm.js firstVersionState, and the App tab shows that
// state in place of the starter (tests/app-status-placeholder.test.js and
// tests/app-frame-identity.test.js pin the client half).
//
// What only a real database can show: each record the bot leaves behind
// moves the step (set up, read, a question, the vote), a merged proposal or
// any other ending is the end of the state, and only the person whose
// description it is gets their DM with the bot and its question.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Realtime and push are process-wide singletons (the bot's DM sends through
// them), and the apps router's infrastructure is not what this is about.
stub(require.resolve('../src/services/ws'), {
  pushConversationEvent: () => 1, pushToUser: () => 1, pushNotificationToUser: () => 1,
  sendSystemMessage: async () => ({ id: 1 }), pushIssueUpdate() {},
});
stub(require.resolve('../src/services/mobile-push'), { scheduleBadgeSync() { return false; } });
stub(require.resolve('../src/services/app-creator'), { createApp: async () => {} });
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {} });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test`, USERNODE_DOMAIN: 'example.test' });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
stub(require.resolve('../src/services/github'), { parseGithubUrl: () => null, isEnabled: () => false });
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/rename-pr'), {});
stub(require.resolve('../src/services/staging'), { MissingSecretsError: class extends Error {} });

let pool = null;
require('../src/db/pool').getPool = () => pool;

const dm = require('../src/services/homeroom-bot-dm');
const conversations = require('../src/services/conversations');
const governance = require('../src/services/governance');
const activeUsers = require('../src/services/active-users');
const { appRoutes } = require('../src/routes/apps');

test('the first version being built, from the records the bot leaves', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `first_version_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Plant Pal', 'plant-pal', 'creating', $1, 'https://github.com/usernode-bot/plant-pal') RETURNING *`,
    [ada.id],
  );
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const state = () => dm.firstVersionState(pool, app.id);
  const steps = (s) => s && { step: s.step, of: s.of, line: s.line, question: s.question, ready: s.ready };
  let proposal = null;

  await t.test('nothing recorded, or a description the bot does not build, is no state', async () => {
    assert.equal(await state(), null);
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds) VALUES ($1, $2, 'Water my plants on time', FALSE)`,
      [app.id, ada.id],
    );
    assert.equal(await state(), null, 'a first request left to the group is not the bot building anything');
    await pool.query('UPDATE homeroom_bot_first_versions SET bot_builds = TRUE WHERE app_id = $1', [app.id]);
  });

  await t.test('set up: step 1, whose description, and their DM with the bot', async () => {
    const s = await state();
    assert.deepEqual(steps(s), { step: 1, of: 7, line: 'planning', question: false, ready: false });
    assert.equal(s.userId, ada.id);
    assert.equal(s.creator, ada.username);
    assert.equal(s.conversationId, opened.conversationId);
    await pool.query(`UPDATE apps SET status = 'error' WHERE id = $1`, [app.id]);
    assert.equal(await state(), null, 'a project that failed to set up is the failure, not a build');
    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [app.id]);
    assert.equal((await state()).step, 1, 'running, its request is still being filed');
  });

  await t.test('filed: read, a question for its creator, then the vote', async () => {
    await pool.query(
      `UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = 1, filed_at = NOW() WHERE app_id = $1`,
      [app.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
       VALUES ($1, 1, $2, 'First version of Plant Pal', TRUE)`,
      [app.id, ada.id],
    );
    assert.deepEqual(steps(await state()), { step: 2, of: 7, line: 'planning', question: false, ready: false },
      'filed and not picked up yet: next to be read');
    await pool.query(`INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 1, 1, 'new')`, [app.id]);
    assert.equal((await state()).step, 2, 'queued to be read');
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);

    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 1, 'live', 'question') RETURNING id`,
      [app.id],
    );
    const asked = await dm.sendDm(pool, { bot, userId: ada.id, content: 'How often should it remind you?' });
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id, question_status)
       VALUES ($1, $2, $3, $4, 1, 'question', $5, 'open')`,
      [asked.messageId, ada.id, asked.conversationId, app.id, run.id],
    );
    assert.deepEqual(steps(await state()), { step: 2, of: 7, line: 'planning', question: true, ready: false },
      'the bot waits on an answer from its creator; anyone else reads that it is planning');
    assert.equal((await dm.firstVersionState(pool, app.id, { viewerId: ada.id })).line, 'question',
      '#4053: its creator reads that it has a question for them');
    await pool.query(`UPDATE homeroom_bot_dm_messages SET question_status = 'answered' WHERE message_id = $1`, [asked.messageId]);

    ({ rows: [proposal] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state)
       VALUES ($1, $2, 'hrbot/plant-pal-1', 'promoted', 'First version of Plant Pal', NOW(), 'passing') RETURNING id`,
      [app.id, bot.id],
    ));
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, proposal_session_id)
       VALUES ($1, 1, 'live', 'ready', TRUE, $2)`,
      [app.id, proposal.id],
    );
    assert.deepEqual(steps(await state()), { step: 6, of: 7, line: 'ready', question: false, ready: true },
      'up for its vote: ready to try');
  });

  await t.test('the route: the creator gets their chat; anybody else, whose description it is', async () => {
    let viewer = ada;
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.user = { id: viewer.id, username: viewer.username }; next(); });
    server.use(appRoutes({}));
    const listening = server.listen(0);
    await new Promise((resolve) => listening.once('listening', resolve));
    try {
      const get = async () => {
        const res = await fetch(`http://127.0.0.1:${listening.address().port}/api/apps/plant-pal?manifest=summary`);
        assert.equal(res.status, 200);
        return (await res.json()).app.first_version;
      };
      // 13 Oct 2026 (D1): a project's first version goes live without a
      // vote, whoever is in it. Run four's Club Votes waited all night on its
      // maker's own Yes, which nothing on the App tab let them give. Nobody
      // must approve it now, nobody is waited on, and it goes live as soon
      // as it can (its checks passed: it is ready to try).
      const noVote = {
        sessionId: proposal.id, noVote: true, mustApprove: false, approved: false, waitingOn: [], more: 0, missing: 0, goesLiveAt: null, soon: true,
      };
      assert.deepEqual((await get()).approval, noVote, 'nobody else is in it yet, and she is not a member: nothing asked');
      const { rows: [{ community_id: communityId }] } = await pool.query('SELECT community_id FROM apps WHERE id = $1', [app.id]);
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [communityId, ada.id]);
      assert.deepEqual(await get(), {
        building: true, mine: true, step: 6, of: 7, line: 'ready', creator: ada.username,
        ready: true, question: false, conversationId: opened.conversationId,
        approval: noVote,
      }, 'Just you: her own first version needs no Yes from her');

      // A group of two, both active: still nobody's to approve.
      await pool.query(`UPDATE apps SET view_visibility = 'private', collab_visibility = 'private' WHERE id = $1`, [app.id]);
      for (const m of [ada, sam]) {
        await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [communityId, m.id]);
        await pool.query(
          `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, m.id],
        );
        await pool.query(
          `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120) ON CONFLICT DO NOTHING`,
          [app.id, m.id],
        );
      }
      governance.invalidateGovernance(app.id);
      assert.deepEqual((await get()).approval, noVote, 'its maker is not asked, and nor is the other member');
      viewer = sam;
      assert.deepEqual(await get(), {
        building: true, mine: false, step: 6, of: 7, line: 'ready', creator: ada.username,
        ready: true, question: false, conversationId: null,
        approval: noVote,
      }, 'somebody else\'s DM is never handed out; what it waits on is the same for everyone');

      // A Yes changes nothing: there was none to give.
      await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [proposal.id, ada.id]);
      viewer = ada;
      assert.deepEqual((await get()).approval, noVote);

      // A project that names its approvers: the same.
      await pool.query(`UPDATE apps SET approver_policy = 'invited' WHERE id = $1`, [app.id]);
      await pool.query(`INSERT INTO app_approvers (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, sam.id]);
      governance.invalidateGovernance(app.id);
      viewer = sam;
      assert.deepEqual((await get()).approval, noVote);
      await pool.query(`UPDATE apps SET approver_policy = 'anyone' WHERE id = $1`, [app.id]);
      await pool.query('DELETE FROM app_approvers WHERE app_id = $1', [app.id]);
      governance.invalidateGovernance(app.id);

      // A first version that changes protected settings is the one that
      // still asks a Yes (that rule is not the vote's): whom it waits on, and
      // no day promised, since such a change has no clock.
      await pool.query('UPDATE chat_sessions SET requires_explicit_approval = TRUE WHERE id = $1', [proposal.id]);
      const waits = (over) => ({
        sessionId: proposal.id, mustApprove: false, approved: false, waitingOn: [], more: 0, missing: 2, goesLiveAt: null, soon: false, noVote: false, ...over,
      });
      viewer = ada;
      assert.deepEqual((await get()).approval, waits({ approved: true, waitingOn: [sam.username], missing: 1 }));
      viewer = sam;
      assert.deepEqual((await get()).approval, waits({ mustApprove: true, missing: 1 }));
      await pool.query('UPDATE chat_sessions SET requires_explicit_approval = NULL WHERE id = $1', [proposal.id]);

      // A read of who it waits on that fails leaves the rest of the state.
      const realGate = governance.governedGate;
      governance.governedGate = async () => { throw new Error('boom'); };
      try {
        const fv = await get();
        assert.equal(fv.ready, true);
        assert.equal(fv.approval, undefined);
      } finally {
        governance.governedGate = realGate;
      }

      // #4053 (owner, 7 Oct): the Home tile says the same line, read from
      // the list (GET /api/apps) for whoever is looking.
      const listed = async () => {
        const res = await fetch(`http://127.0.0.1:${listening.address().port}/api/apps`);
        assert.equal(res.status, 200);
        return (await res.json()).apps.find((a) => a.slug === 'plant-pal');
      };
      viewer = ada;
      assert.equal((await listed()).first_version_line, 'ready');
      viewer = sam;
      assert.equal((await listed()).first_version_line, 'ready');

      // A read that fails is no state, never a failed page.
      viewer = ada;
      const real = dm.firstVersionState;
      dm.firstVersionState = async () => { throw new Error('boom'); };
      try {
        assert.equal(await get(), null);
        assert.equal((await listed()).first_version_line, null, 'the tile says what it said before');
      } finally {
        dm.firstVersionState = real;
      }
    } finally {
      if (typeof listening.closeAllConnections === 'function') listening.closeAllConnections();
      listening.close();
    }
  });

  await t.test('merged: the app is the first version now', async () => {
    // Merged and live: the merge-followups machine stamps live_at once
    // production runs it, so the fixture writes both.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [proposal.id]);
    assert.equal(await state(), null);
    // Its tile says nothing more (routes/apps.js firstVersionLinesFor).
    const routes = require('../src/routes/apps');
    assert.equal(typeof routes.firstVersionLinesFor, 'function');
    assert.equal((await routes.firstVersionLinesFor(pool, [app], ada.id)).size, 0);
  });

  // 14 Oct 2026 (newcomer run eight, Club Votes): a build that stopped was
  // no state, so the App tab framed the starter template. It says Stopped,
  // and its maker's way to Try again.
  await t.test('a build that stopped is said, with where its maker can try again', async () => {
    await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1', [app.id]);
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_error)
       VALUES ($1, 1, 'live', 'ready', FALSE, 'the change was built but could not be proposed: Server is restarting') RETURNING id`,
      [app.id],
    );
    const stopped = await state();
    assert.deepEqual(steps(stopped), { step: 4, of: 7, line: 'stopped', question: false, ready: false });
    assert.deepEqual(stopped.stopped, {}, 'not said in her chat yet: nothing to point at');
    assert.equal(stopped.steps, undefined, 'nothing is under way');
    // Homeroom bot said it in the request's thread, with Try again under it.
    const card = await dm.sendDm(pool, { bot, userId: ada.id, content: 'Plant Pal, its first version' });
    const said = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'I built Plant Pal but couldn\'t put it live yet. Tap Try again and I\'ll finish it.',
      threadRootId: card.messageId,
    });
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id)
       VALUES ($1, $2, $3, $4, 1, 'build_failed', $5)`,
      [said.messageId, ada.id, said.conversationId, app.id, run.id],
    );
    const where = { conversationId: opened.conversationId, messageId: said.messageId, threadRootId: card.messageId };
    assert.deepEqual((await state()).stopped, where);
    assert.equal((await dm.firstVersionState(pool, app.id, { viewerId: sam.id })).line, 'stopped', 'for everyone');

    let viewer = ada;
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.user = { id: viewer.id, username: viewer.username }; next(); });
    server.use(appRoutes({}));
    const listening = server.listen(0);
    await new Promise((resolve) => listening.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${listening.address().port}`;
      const get = async () => (await (await fetch(`${base}/api/apps/plant-pal?manifest=summary`)).json()).app.first_version;
      const listed = async () => (await (await fetch(`${base}/api/apps`)).json()).apps.find((a) => a.slug === 'plant-pal');
      assert.deepEqual(await get(), {
        building: true, mine: true, step: 4, of: 7, line: 'stopped', creator: ada.username,
        ready: false, question: false, conversationId: opened.conversationId,
        stopped: true, thread: { conversationId: opened.conversationId, threadRootId: card.messageId, messageId: said.messageId },
      }, 'its maker: Stopped, and the thread where Try again is');
      assert.equal((await listed()).first_version_line, 'stopped', 'the Home tile says it');
      viewer = sam;
      const theirs = await get();
      assert.deepEqual([theirs.line, theirs.stopped, theirs.thread, theirs.conversationId, theirs.member],
        ['stopped', true, undefined, null, undefined], 'nobody else is handed her chat, nor a "While you wait"');
      assert.equal((await listed()).first_version_line, 'stopped');
    } finally {
      if (typeof listening.closeAllConnections === 'function') listening.closeAllConnections();
      listening.close();
    }

    // Try again (homeroom-bot-mayor.js start_request) puts it first in the
    // queue: it is on its way again, read before it is planned.
    await pool.query(`INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 1, 0, 'dm_start')`, [app.id]);
    const again = await state();
    assert.equal(again.line, 'planning');
    assert.equal(again.stopped, undefined);
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
  });

  await t.test('any other ending is the end of the state too', async () => {
    await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1', [app.id]);
    await pool.query(`INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 1, 'live', 'person')`, [app.id]);
    assert.equal(await state(), null, 'left for the group to decide');
    for (const error of ['skipped: its request was closed', 'blocked: needs a payment provider']) {
      await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1', [app.id]);
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_error)
         VALUES ($1, 1, 'live', 'ready', FALSE, $2)`,
        [app.id, error],
      );
      assert.equal(await state(), null, error);
    }
    await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1', [app.id]);
    assert.equal((await state()).step, 2, 'with nothing recorded it waits to be read again');
    await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'failed' WHERE app_id = $1`, [app.id]);
    assert.equal(await state(), null, 'filing gave up');
  });
});
