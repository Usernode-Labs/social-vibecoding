'use strict';

// The Homeroom bot's proposals for requests that closed some other way, against
// the FULL PostgreSQL schema (src/services/homeroom-bot-closed-requests.js).
//
// 15 October: three of the five proposals the platform project allows the bot
// were for closed requests. #4817 was shipped by a person's PR (#4822) while
// the bot's #4819 stayed up, #4389 was shipped by another change, and #4968
// was closed by a vote while the bot's #5026 stayed up and mergeable. Nothing
// withdrew them, and the bot never read a closed request again, so every
// other ready request on the project was held behind them.
//
// Pinned here:
//   - a proposal of the bot's up for a vote is withdrawn once every request it
//     is linked to is closed, with a line on each request; one linked to a
//     request still open stays;
//   - a person's proposal, one already approved and a headless one are never
//     touched;
//   - the refresh's sweep finds the ones closed on GitHub, trusting GitHub's
//     own answer and never the open list alone, and gives the freed slot to a
//     held request in the same refresh;
//   - a request closed by hand on GitHub also closes the platform's own row
//     the tray's Needs you reads (#5218), for the tracked requests the
//     refresh's open list no longer names, a few at a time, and never the
//     other way round.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const closedRequests = require('../src/services/homeroom-bot-closed-requests');
const bot = require('../src/services/homeroom-bot');
const tray = require('../src/services/homeroom-bot-tray');
// The real closeTwinRows stands in for the stub watcher's close (it is the
// writer the stub must use); only bustAndBroadcast is stood in for.
const realWatcher = require('../src/services/issue-close-watcher');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SEEN = '2026-10-14T09:00:00Z';

test('the bot\'s proposals for closed requests are withdrawn, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_closed_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [lee] } = await pool.query(`INSERT INTO users (username, password) VALUES ('lee', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('plant-pal', 'plant-pal', 'running', 'https://github.com/usernode-bot/plant-pal')
     RETURNING id, slug, name, repo_url`,
  );
  const proposal = async (linked, { status = 'promoted', user = botUser.id, headless = false, title = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, pr_title)
     VALUES ($1, $2, $3, $4, $5, $6::int[], $7) RETURNING id`,
    [app.id, user, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, status, headless, linked, title],
  )).rows[0].id;
  const statusOf = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status;

  // GitHub as the test scripts it: `closed` numbers read closed, `broken`
  // ones fail, `prs` are pull requests, and everything else reads open.
  const gh = ({ closed = [], broken = [], prs = [] } = {}) => {
    const asked = [];
    return {
      asked,
      async getIssue(owner, repo, n) {
        asked.push(n);
        assert.deepEqual([owner, repo], ['usernode-bot', 'plant-pal']);
        if (broken.includes(n)) throw new Error('rate limited');
        return { number: n, state: closed.includes(n) || prs.includes(n) ? 'closed' : 'open', ...(prs.includes(n) ? { pull_request: {} } : {}) };
      },
    };
  };
  // The system archive, as noteRequestMerged's test drives it: the row only.
  const harness = (github) => {
    const archived = [];
    const lines = [];
    const woken = [];
    return {
      archived, lines, woken,
      deps: {
        github,
        sessionLifecycle: {
          async archiveSession(args) {
            archived.push({ sessionId: args.sessionId, reason: args.reason });
            const { rowCount } = await pool.query(
              `UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1 AND status IN ('active', 'promoted', 'paused')`,
              [args.sessionId],
            );
            return { archived: rowCount === 1 };
          },
        },
        ws: { async sendSystemMessage(_pool, appId, content, msgType, metadata, thread) { lines.push({ appId, content, msgType, thread }); } },
        wake(args) { woken.push(args); },
      },
    };
  };

  await t.test('a close withdraws the bot\'s proposals whose requests are all closed, and only those', async () => {
    await pool.query('DELETE FROM chat_sessions');
    const alone = await proposal([10], { title: 'Watering reminders' });
    const pair = await proposal([11, 12]); // #12 is still open on GitHub
    const both = await proposal([13, 14], { title: 'Sunlight log' }); // #14 closed on GitHub already
    const persons = await proposal([10], { user: lee.id });
    const approved = await proposal([10], { status: 'merging' });
    const headless = await proposal([10], { headless: true });
    const elsewhere = await proposal([15]);
    const github = gh({ closed: [14] });
    const h = harness(github);

    const out = await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [10, 11, 13], deps: h.deps });
    assert.deepEqual(out, { withdrawn: [alone, both] });
    assert.deepEqual(h.archived, [
      { sessionId: alone, reason: 'request-closed' },
      { sessionId: both, reason: 'request-closed' },
    ], 'the system archive, which closes the pull request and says so in its own thread');
    assert.deepEqual(github.asked.sort(), [12, 14], 'GitHub is asked only about the linked requests not just closed');
    // The line on each of its requests is the proposal machine's close
    // (reason request-closed), written with the close: a retry cannot lose
    // it (tests/workflow-proposal-postgres.test.js P13). Nothing here writes one.
    assert.deepEqual(h.lines, []);
    assert.equal(closedRequests.closedNote('Watering reminders'), '“Watering reminders” was withdrawn: this request is closed.');
    assert.deepEqual(h.woken, [{ appId: app.id }], 'the bot is woken for the project, so a held request takes the slot');
    assert.equal(await statusOf(pair), 'promoted', 'one of its requests is still open');
    assert.equal(await statusOf(persons), 'promoted', 'a person\'s proposal is theirs');
    assert.equal(await statusOf(approved), 'merging', 'one already approved is past withdrawing');
    assert.equal(await statusOf(headless), 'promoted');
    assert.equal(await statusOf(elsewhere), 'promoted', 'another request\'s is untouched');

    // Once: a second close of the same requests (another Pod) finds nothing.
    const again = harness(gh({ closed: [14] }));
    assert.deepEqual(await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [10, 11, 13], deps: again.deps }), { withdrawn: [] });
    assert.deepEqual(again.woken, [], 'nothing withdrawn, nobody woken');
    // And #12 closing later takes the pair down: GitHub reads #11 closed by then.
    const later = harness(gh({ closed: [11] }));
    assert.deepEqual(await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [12], deps: later.deps }), { withdrawn: [pair] });
  });

  await t.test('whoever asked the bot hears once when somebody else\'s change shipped their request (16 Oct 2026)', async () => {
    await pool.query('DELETE FROM chat_sessions');
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_requesters');
    const { rows: [ada] } = await pool.query(`INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
    const ask = async (n, title, user = lee.id) => {
      await pool.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)`,
        [app.id, n, user, title],
      );
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at) VALUES ($1, $2, 'live', 'ready', $3)`,
        [app.id, n, SEEN],
      );
    };
    const merged = (n, user) => pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues, pr_number, merged_at)
       VALUES ($1, $2, $3, 'merged', $4::int[], $5, NOW())`,
      [app.id, user, `dev/x-${crypto.randomBytes(3).toString('hex')}`, [n], 4800 + n],
    );
    await ask(30, 'Repot alerts'); await merged(30, ada.id); // shipped by ada
    await ask(31, 'Fern mode'); await merged(31, botUser.id); // the bot's own: its Live says it
    await ask(32, 'Soil log'); await merged(32, lee.id); // the requester shipped it
    await ask(33, 'Leaf count'); // closed by hand: nothing shipped it
    const sent = [];
    const noted = [];
    const deps = {
      ...harness(gh()).deps,
      dm: { async sendDm(_pool, args) { sent.push(args); return { messageId: sent.length }; } },
      tray: { noteWorkChanged(userId) { noted.push(userId); } },
    };
    await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [30, 31, 32, 33], deps });
    assert.equal(sent.length, 1, 'only the request somebody else\'s change shipped');
    assert.equal(sent[0].userId, lee.id);
    assert.equal(sent[0].bot.username, 'homeroom_bot');
    assert.equal(sent[0].content, '“Repot alerts” was done another way: a change by @ada did what it asked. There\'s nothing more for me to build here.');
    assert.deepEqual(
      { kind: sent[0].metadata.kind, said: sent[0].metadata.said, doneBy: sent[0].metadata.doneBy, issueNumber: sent[0].metadata.issueNumber },
      { kind: 'request_closed', said: 'done_elsewhere', doneBy: 'ada', issueNumber: 30 },
      'it rings as done another way (homeroom-bot-dm.js STORY_MOMENTS)',
    );
    assert.equal(sent[0].idempotencyKey, `hrbot-done-elsewhere-${app.id}-30-${lee.id}`, 'said once, whichever Pod hears the close');
    assert.deepEqual(noted, [lee.id], 'their open tray re-reads');
    assert.equal(closedRequests.doneElsewhereText({ title: null, username: null }),
      'This request was done another way: another change did what it asked. There\'s nothing more for me to build here.');
    const quiet = [];
    await closedRequests.noteRequestsClosed(pool, {
      appId: app.id, closed: [30], deps: { ...deps, tellDoneElsewhere: false, dm: { async sendDm(_p, a) { quiet.push(a); } } },
    });
    assert.deepEqual(quiet, [], 'a caller can keep it quiet');
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_requesters');
    await pool.query('DELETE FROM chat_sessions');
  });

  await t.test('a failed GitHub read keeps the proposal up; the helper never throws unless strict', async () => {
    await pool.query('DELETE FROM chat_sessions');
    const unsure = await proposal([20, 21]);
    const h = harness(gh({ broken: [21] }));
    assert.deepEqual(await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [20], deps: h.deps }), { withdrawn: [] });
    assert.equal(await statusOf(unsure), 'promoted');
    assert.deepEqual(await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [], deps: h.deps }), { withdrawn: [] });
    const down = { query: () => Promise.reject(new Error('connection lost')) };
    assert.equal(await closedRequests.noteRequestsClosed(down, { appId: app.id, closed: [20], deps: h.deps }), null);
    await assert.rejects(closedRequests.noteRequestsClosed(down, { appId: app.id, closed: [20], strict: true, deps: h.deps }), /connection lost/,
      'the merge-followups machine retries what it could not do');
    // A failed GitHub read is retried by a durable caller, never settled as "open".
    await assert.rejects(closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [20], strict: true, deps: h.deps }), /rate limited/);
    assert.equal(await statusOf(unsure), 'promoted');
  });

  await t.test('the sweep withdraws one whose requests GitHub confirms closed, never on the open list alone', async () => {
    await pool.query('DELETE FROM chat_sessions');
    const open = await proposal([30]);
    const shipped = await proposal([31]);
    const lagging = await proposal([32]); // hidden from the list, still open on GitHub
    const unread = await proposal([33]);
    const pr = await proposal([34]);
    const halfOpen = await proposal([30, 35]);
    const persons = await proposal([36], { user: lee.id });
    const github = gh({ closed: [31, 36], broken: [33], prs: [34] });
    const h = harness(github);

    const out = await closedRequests.sweepClosedRequests(pool, { appId: app.id, openNumbers: [30], deps: h.deps });
    assert.deepEqual(out, { withdrawn: [shipped] });
    assert.deepEqual(github.asked.sort(), [31, 32, 33, 34], 'one with a request on the open list is never looked up');
    for (const id of [open, lagging, unread, pr, halfOpen, persons]) assert.equal(await statusOf(id), 'promoted', String(id));
    assert.deepEqual(h.woken, [], 'the sweep runs inside the refresh, which is the wake');
    const down = { query: () => Promise.reject(new Error('connection lost')) };
    assert.deepEqual(await closedRequests.sweepClosedRequests(down, { appId: app.id, openNumbers: [30], deps: h.deps }), { withdrawn: [] });
  });

  await t.test('the refresh frees a slot held by a request closed on GitHub and gives it to a held request', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM chat_sessions');
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    // Five proposals up for a vote, the cap: four for open requests, one for
    // #41, closed on GitHub since. #40 is ready and held behind them.
    const live = [];
    for (const n of [42, 43, 44, 45]) {
      const id = await proposal([n]);
      live.push(id);
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, proposal_session_id, thread_seen_at)
         VALUES ($1, $2, 'live', 'ready', TRUE, $3, $4)`, [app.id, n, id, SEEN],
      );
    }
    const stale = await proposal([41], { title: 'Repotting reminders' });
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cap_suppressed, thread_seen_at)
       VALUES ($1, 40, 'live', 'ready', 'proposals_per_app', $2)`, [app.id, SEEN],
    );
    const capRoom = await bot.capRoomFor(pool, botUser, app.id);
    assert.equal(capRoom.proposals_per_app, 0, 'the project is at its cap');

    const lifecyclePath = require.resolve('../src/services/session-lifecycle');
    const orig = require.cache[lifecyclePath];
    const archived = [];
    const reasons = [];
    require.cache[lifecyclePath] = {
      id: lifecyclePath, filename: lifecyclePath, loaded: true, paths: [],
      exports: {
        async archiveSession(args) {
          archived.push(args.sessionId);
          reasons.push(args.reason);
          await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [args.sessionId]);
          return { archived: true };
        },
      },
    };
    try {
      const openList = (over = {}) => {
        const github = gh({ closed: [41] });
        return {
          github,
          async fetchPublicIssues() {
            return { issues: [40, 42, 43, 44, 45].map((n) => ({ number: n, state: 'open', createdAt: SEEN, updatedAt: SEEN })), truncatedList: false, ...over };
          },
          getIssue: github.getIssue,
        };
      };

      // A partial or stale list, or an app the bot is not live on: no sweep.
      for (const [why, list, room] of [
        ['a truncated list', openList({ truncatedList: true }), capRoom],
        ['a stale list', openList({ note: 'rate limited', stale: true }), capRoom],
        ['a shadow app', openList(), null],
      ]) {
        await bot.refreshApp(pool, app, { github: list, bot: botUser, capRoom: room });
        assert.deepEqual(list.github.asked, [], why);
        assert.equal(await statusOf(stale), 'promoted', why);
      }

      const out = await bot.refreshApp(pool, app, { github: openList(), bot: botUser, capRoom });
      assert.deepEqual(archived, [stale], 'withdrawn, by the system archive');
      for (const id of live) assert.equal(await statusOf(id), 'promoted');
      const { rows: queue } = await pool.query('SELECT issue_number, reason FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
      assert.deepEqual(queue.map((q) => [q.issue_number, q.reason]), [[40, bot.CAP_FREED_REASON]],
        'the held request takes the freed slot in the same refresh');
      assert.equal(out.queued, 1);
      // Withdrawn as request-closed: the proposal machine's close says so in
      // the request's thread (tests/workflow-proposal-postgres.test.js P13).
      assert.deepEqual(reasons, ['request-closed']);
    } finally {
      if (orig) require.cache[lifecyclePath] = orig; else delete require.cache[lifecyclePath];
    }
  });

  // The ws stub stands in for the real one while these subtests run: what an
  // open tray hears (noteWorkChanged) and what the group chat hears
  // (bustAndBroadcast's github_synced) is how the strip and the panel learn.
  const wsId = require.resolve('../src/services/ws');
  const realWs = require.cache[wsId];
  const stubWs = () => {
    const pushes = [];
    const broadcasts = [];
    require.cache[wsId] = {
      id: wsId, filename: wsId, loaded: true,
      exports: {
        pushToUser(userId, payload) { pushes.push([Number(userId), payload]); return 1; },
        pushIssueUpdate(update) { broadcasts.push(update); },
        pushConversationEvent() { return 0; },
        pushNotificationToUser() { return 1; },
      },
    };
    return { pushes, broadcasts, restore: () => { if (realWs) require.cache[wsId] = realWs; else delete require.cache[wsId]; } };
  };

  await t.test('a request closed by hand on GitHub closes the row the tray\'s Needs you reads (#5218)', async () => {
    const { rows: [mia] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ('mia', 'x', TRUE) RETURNING id`,
    );
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_requesters');
    await pool.query('DELETE FROM issues');
    await pool.query('DELETE FROM chat_sessions');
    // #60 was closed on GitHub by hand; its `general` row still says open.
    // #61 was filed straight on GitHub (no row of ours to close), #62 is
    // still on the open list, #63 is closed here already, #64 GitHub cannot
    // answer about, #65 is a pull request wearing the number.
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, kind, status) VALUES
         ($1, 60, 'Water the ferns', 'general', 'open'),
         ($1, 61, 'Untracked on GitHub', 'general', 'open'),
         ($1, 62, 'Still on the list', 'general', 'open'),
         ($1, 63, 'Already closed here', 'general', 'open'),
         ($1, 64, 'GitHub unreadable', 'general', 'open'),
         ($1, 65, 'A pull request', 'general', 'open')`,
      [app.id],
    );
    await pool.query(`UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = 63`, [app.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES
         ($1, 60, $2, 'Water the ferns'), ($1, 62, $2, 'Still on the list'), ($1, 63, $2, 'Already closed here'),
         ($1, 64, $2, 'GitHub unreadable'), ($1, 65, $2, 'A pull request')`,
      [app.id, mia.id],
    );
    for (const n of [60, 62, 63, 64, 65]) {
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at) VALUES ($1, $2, 'live', 'question', $3)`,
        [app.id, n, SEEN],
      );
    }
    // The ask the strip's Needs you row acts on: the bot's question, open in
    // its DM, waiting on mia.
    const conversation = (await pool.query(
      `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`,
      [mia.id],
    )).rows[0].id;
    const message = (await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'How deep does the pot drain?') RETURNING id`,
      [conversation, botUser.id],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, question_status)
       VALUES ($1, $2, $3, $4, 60, 'question', 'open')`,
      [message, mia.id, conversation, app.id],
    );

    const asMia = { id: mia.id, username: mia.username, isAdmin: false };
    const key = (job) => `${job.appSlug}#${job.issueNumber}`;
    const work = await tray.workFor(pool, { user: asMia });
    assert.ok(work.needsYou.some((job) => key(job) === 'plant-pal#60'),
      'before the reconcile: the row is open, so the request waits on them');

    const github = gh({ closed: [60], broken: [64], prs: [65] });
    const busted = [];
    const w = stubWs();
    try {
      const out = await closedRequests.closeRequestRows(pool, {
        appId: app.id, appSlug: app.slug, repoUrl: app.repo_url,
        openNumbers: [62], deps: { github, watcher: { ...realWatcher, bustAndBroadcast(args) { busted.push(args); } } },
      });
      assert.deepEqual(out, { closed: [60] });
      assert.deepEqual(github.asked.sort((a, b) => a - b), [60, 64, 65],
        'GitHub is asked only about the tracked, row-open numbers off the list; #61 untracked, #62 on the list, #63 already closed');
      assert.deepEqual(busted, [{
        owner: 'usernode-bot', repo: 'plant-pal', appSlug: app.slug, appId: app.id, closed: [60],
      }], 'the same cache bust and broadcast a merge\'s close does');
      assert.deepEqual(w.pushes, [[mia.id, { type: 'homeroom_bot_work_changed' }]], 'the requester\'s open tray re-reads');

      const { rows: after } = await pool.query(
        'SELECT github_issue_number, status FROM issues WHERE app_id = $1 ORDER BY github_issue_number', [app.id],
      );
      assert.deepEqual(after.map((r) => [r.github_issue_number, r.status]), [
        [60, 'closed'], [61, 'open'], [62, 'open'], [63, 'closed'], [64, 'open'], [65, 'open'],
      ], 'only the confirmed close closed a row; nothing reopened');

      const closed = await tray.workFor(pool, { user: asMia });
      assert.ok(!closed.needsYou.some((job) => key(job) === 'plant-pal#60'), 'Needs you lets it go');
      const tile = closed.history.find((job) => key(job) === 'plant-pal#60');
      assert.equal(tile.outcome, 'stopped', 'History says the work stopped');
      assert.equal(tile.ask, undefined, 'its old ask does not put it back');
      assert.equal(tile.answered, false, 'the rest of its story stays');
    } finally {
      w.restore();
    }

    // A second refresh reads only what is still open; nothing reopens.
    const again = { query: () => Promise.reject(new Error('connection lost')) };
    assert.deepEqual(await closedRequests.closeRequestRows(again, {
      appId: app.id, appSlug: app.slug, repoUrl: app.repo_url, openNumbers: [],
    }), { closed: [] }, 'a failed read closes nothing');
    const { rows: status } = await pool.query(
      `SELECT status FROM issues WHERE app_id = $1 AND github_issue_number = 60`, [app.id],
    );
    assert.equal(status[0].status, 'closed', 'still closed');
  });

  await t.test('a request with no row of ours leaves Needs you once it closes, however it closed (16 Oct 2026, #4752)', async () => {
    // #4752 was filed through Suggest an improvement: a GitHub issue and a
    // requester, never a row in issues. Closing a row could not reach it, so
    // its last ask stayed in its requester's Needs you after it closed.
    const { rows: [nia] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ('nia', 'x', TRUE) RETURNING id`,
    );
    for (const table of ['homeroom_bot_runs', 'homeroom_bot_requesters', 'homeroom_bot_closed_requests', 'chat_sessions']) {
      await pool.query(`DELETE FROM ${table}`);
    }
    await pool.query(`DELETE FROM issues WHERE app_id = $1 AND github_issue_number BETWEEN 90 AND 99`, [app.id]);
    const ask = async (n, title) => {
      await pool.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)`,
        [app.id, n, nia.id, title],
      );
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at) VALUES ($1, $2, 'live', 'question', $3)`,
        [app.id, n, SEEN],
      );
    };
    await ask(90, 'Fix missing needs-you area');
    const conversation = (await pool.query(
      `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [nia.id],
    )).rows[0].id;
    const message = (await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Add detail and I will look again.') RETURNING id`,
      [conversation, botUser.id],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, question_status)
       VALUES ($1, $2, $3, $4, 90, 'question', 'open')`,
      [message, nia.id, conversation, app.id],
    );
    const asNia = { id: nia.id, username: nia.username, isAdmin: false };
    const waiting = async () => (await tray.workFor(pool, { user: asNia })).needsYou.some((job) => job.issueNumber === 90);
    assert.equal(await waiting(), true, 'before: it waits on her');

    const w = stubWs();
    try {
      // Closed by hand on GitHub: the reconcile asks about it although it has
      // no row, and records the close GitHub confirms.
      const out = await closedRequests.closeRequestRows(pool, {
        appId: app.id, appSlug: app.slug, repoUrl: app.repo_url, openNumbers: [], deps: { github: gh({ closed: [90] }) },
      });
      assert.deepEqual(out, { closed: [90] });
      assert.equal(await waiting(), false, 'Needs you lets it go');
      const tile = (await tray.workFor(pool, { user: asNia })).history.find((job) => job.issueNumber === 90);
      assert.equal(tile.outcome, 'stopped');
      assert.equal(tile.ask, undefined, 'its old ask does not put it back');
      const tracks = await require('../src/services/homeroom-bot-track').tracksForRequests(pool, { appId: app.id, numbers: [90] });
      assert.equal(tracks.get(90).state, 'closed', 'its track reads closed, on its page too');
      assert.deepEqual(w.pushes, [[nia.id, { type: 'homeroom_bot_work_changed' }]], 'her open tray re-reads');

      // Reopened on GitHub: back on a whole open list, its record goes, and it
      // waits on her again. A close from the last ten minutes is kept, in case
      // the list lagged behind it.
      await closedRequests.closeRequestRows(pool, {
        appId: app.id, appSlug: app.slug, repoUrl: app.repo_url, openNumbers: [90], deps: { github: gh() },
      });
      assert.equal(await waiting(), false, 'a close this recent outlives a list that may lag');
      await pool.query(`UPDATE homeroom_bot_closed_requests SET closed_at = NOW() - INTERVAL '11 minutes' WHERE issue_number = 90`);
      await closedRequests.closeRequestRows(pool, {
        appId: app.id, appSlug: app.slug, repoUrl: app.repo_url, openNumbers: [90], deps: { github: gh() },
      });
      assert.equal(await waiting(), true, 'reopened: it waits on her again');
    } finally {
      w.restore();
    }

    // Closed by a merged change or a passed close vote (noteRequestsClosed):
    // recorded for a request the bot tracks, row or no row; one it does not
    // track is not.
    await ask(91, 'Sort the plants');
    await closedRequests.noteRequestsClosed(pool, {
      appId: app.id, closed: [91, 92], deps: { ...harness(gh()).deps, tellDoneElsewhere: false },
    });
    const { rows: recorded } = await pool.query(
      `SELECT issue_number, closed_at IS NOT NULL AS closed FROM homeroom_bot_closed_requests WHERE app_id = $1 ORDER BY 1`, [app.id],
    );
    assert.deepEqual(recorded.map((r) => [r.issue_number, r.closed]), [[91, true]]);

    // One GitHub keeps not reporting closed (deleted, moved) is remembered as
    // asked, so the next refresh asks about the ones never asked first.
    await ask(97, 'Gone from GitHub');
    await ask(93, 'Never asked yet');
    await closedRequests.closeRequestRows(pool, {
      appId: app.id, appSlug: app.slug, repoUrl: app.repo_url, openNumbers: [90], deps: { github: gh() },
    });
    const { rows: [asked] } = await pool.query(
      `SELECT closed_at, checked_at FROM homeroom_bot_closed_requests WHERE app_id = $1 AND issue_number = 97`, [app.id],
    );
    assert.equal(asked.closed_at, null, 'asked, not closed');
    await ask(95, 'Filed after');
    const { rows: next } = await pool.query(closedRequests.OPEN_TRACKED_SQL, [app.id, [90], 1]);
    assert.deepEqual(next.map((r) => r.github_issue_number), [95], 'a never-asked request comes before one asked already, newer or not');
  });

  await t.test('a backlog of hand-closed requests clears a few at a time, newest first', async () => {
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_requesters');
    await pool.query(`DELETE FROM issues WHERE app_id = $1 AND github_issue_number >= 200`, [app.id]);
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, kind, status)
        SELECT $1, 200 + g, 'Backlog ' || g, 'general', 'open' FROM generate_series(1, 30) g`,
      [app.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
        SELECT $1, 200 + g, $2, 'Backlog ' || g FROM generate_series(1, 30) g`,
      [app.id, lee.id],
    );
    const github = gh({ closed: [...Array(30).keys()].map((g) => 201 + g) });
    const out = await closedRequests.closeRequestRows(pool, {
      appId: app.id, appSlug: app.slug, repoUrl: app.repo_url, openNumbers: [], deps: { github },
    });
    assert.equal(out.closed.length, closedRequests.RECONCILE_LIMIT, 'at most the limit per refresh');
    assert.deepEqual(out.closed, [...Array(30).keys()].map((g) => 230 - g).slice(0, closedRequests.RECONCILE_LIMIT),
      'newest numbers first, GitHub asked about each');
    const second = await closedRequests.closeRequestRows(pool, {
      appId: app.id, appSlug: app.slug, repoUrl: app.repo_url, openNumbers: [], deps: { github },
    });
    assert.deepEqual(second.closed, [205, 204, 203, 202, 201], 'the rest clear on the next refresh');
    const { rows: left } = await pool.query(
      `SELECT count(*)::int AS open FROM issues WHERE app_id = $1 AND github_issue_number >= 200 AND status = 'open'`, [app.id],
    );
    assert.equal(left[0].open, 0);
  });

  await t.test('the refresh reconciles on a whole fresh list, never on a partial one', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_requesters');
    await pool.query('DELETE FROM issues');
    await pool.query('DELETE FROM chat_sessions');
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, kind, status) VALUES ($1, 70, 'Mist the moss', 'general', 'open')`,
      [app.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 70, $2, 'Mist the moss')`,
      [app.id, lee.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at) VALUES ($1, 70, 'live', 'question', $2)`,
      [app.id, SEEN],
    );
    const github = gh({ closed: [70] });
    const list = (over = {}) => ({
      github,
      async fetchPublicIssues() { return { issues: [], truncatedList: false, ...over }; },
      getIssue: github.getIssue,
    });
    const rowStatus = async () => (await pool.query(
      `SELECT status FROM issues WHERE app_id = $1 AND github_issue_number = 70`, [app.id],
    )).rows[0].status;

    const w = stubWs();
    try {
      // A partial list, or GitHub half down: the refresh reconciles nothing.
      for (const [why, over] of [['a truncated list', { truncatedList: true }], ['a stale list', { note: 'rate limited', stale: true }]]) {
        await bot.refreshApp(pool, app, { github: list(over) });
        assert.deepEqual(github.asked, [], why);
        assert.equal(await rowStatus(), 'open', why);
      }

      github.asked.length = 0;
      await bot.refreshApp(pool, app, { github: list() });
      assert.deepEqual(github.asked, [70], 'a whole, fresh list: GitHub is asked about the request it no longer names');
      assert.equal(await rowStatus(), 'closed', 'the row closes within the refresh');
      assert.deepEqual(w.broadcasts, [{
        action: 'github_synced', appSlug: app.slug, appId: app.id, source: 'issue_close_watcher',
      }], 'the group chat refetches, as after a merge\'s close');
      assert.deepEqual(w.pushes, [[lee.id, { type: 'homeroom_bot_work_changed' }]], 'the requester\'s open tray re-reads');
    } finally {
      w.restore();
    }
  });
});
