'use strict';

// The merge-followups and app-delivery machines wired into the platform
// (src/workflow/platform.ts) with a running runtime: a confirmed merge asks
// app-delivery for its deploy and goes live through the real work handlers
// (their I/O stubbed), recovery's report reads the tally again, a later
// deploy reaches the merges still waiting, the admin's Retry delivery works,
// a merge accepted before a restart finishes after it, and a close proposal
// for a request the merge closes is superseded once the close is seen.
// GitHub, the deploy, the worker and WS pushes are stubbed (the watcher is
// the real one for the app whose requests are looked at); everything else
// is the full PostgreSQL schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);

test('merge follow-ups through the platform runtime', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_merge_platform_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // Stubs: the request pool is the test pool; outside I/O records.
  const calls = [];
  const stub = (path, exports) => {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub('../src/db/pool', { getPool: () => pool });
  const realWs = require('../src/services/ws');
  stub('../src/services/ws', {
    ...realWs, broadcast: () => {}, broadcastGlobalScoped: () => {}, pushVoteUpdate: () => {},
    pushIssueUpdate: () => {}, pushNotificationToUser: () => {},
  });
  const realGithub = require('../src/services/github');
  const deploys = { fail: null, sha: null };
  // GitHub's requests, by number: their state, and the closes asked of it.
  const ghIssues = new Map();
  stub('../src/services/github', {
    ...realGithub,
    isEnabled: () => true,
    getPR: async (owner, repo, n) => ({ number: n, body: '', merged: true,
      base: { ref: 'main', repo: { full_name: `${owner}/${repo}`, default_branch: 'main' } } }),
    getIssue: async (owner, repo, n) => ({ number: n, state: ghIssues.get(n) || 'open' }),
    closeIssue: async (owner, repo, n) => { calls.push(['close', n]); ghIssues.set(n, 'closed'); return { number: n, state: 'closed' }; },
    listPullRequestCommitShas: async () => ({ shas: [], complete: true }),
    compareCommitAncestry: async (owner, repo, base, head) => {
      calls.push(['compare', base, head]);
      return { status: head === SHA('c') ? 'ahead' : 'diverged' };
    },
  });
  const realStaging = require('../src/services/staging');
  stub('../src/services/staging', {
    ...realStaging,
    async deployProduction(config, app, opts) {
      calls.push(['deploy', app.id, opts]);
      if (deploys.fail) throw new realStaging.MissingSecretsError(['API_KEY']);
      return { containerId: null, sha: opts.reuseRunningRevision || deploys.sha || SHA('f') };
    },
    async teardownStaging(row) { calls.push(['teardown', row.id, row.status]); return { removed: true }; },
  });
  // The fenced, strict removal: the unfenced one is not used.
  stub('../src/services/worker', {
    ...require('../src/services/worker'),
    removeCcVolume: async (id, { proceed }) => {
      if (!(await proceed())) return { skipped: true };
      calls.push(['retire', id]);
      return { removed: true };
    },
    destroyCcVolume: async () => { throw new Error('the unfenced removal is not used'); },
  });
  // main's unit suite on the merge commit: the main-check machine's work,
  // its run faked green.
  stub('../src/services/main-watch', {
    ...require('../src/services/main-watch'),
    runMainSuite: async (c, p, o) => { calls.push(['main-check', o.sha]); return { state: 'passing', detail: {} }; },
  });
  // The real look for the app whose requests are looked at (`looked`); for
  // the others, nothing to close.
  const realWatcher = require('../src/services/issue-close-watcher');
  const looked = new Set();
  stub('../src/services/issue-close-watcher', {
    ...realWatcher,
    closeAfterMerge: async (o) => {
      calls.push(['look', o.prNumber, o.look]);
      return looked.has(o.appId) ? realWatcher.closeAfterMerge(o) : { closed: [], skipped: [], stillOpen: [], waiting: false, targets: [] };
    },
  });
  stub('../src/services/homeroom-bot', { ...require('../src/services/homeroom-bot'), noteRequestMerged: async () => null });
  stub('../src/services/homeroom-bot-dm', {
    ...require('../src/services/homeroom-bot-dm'),
    noteProposalMerged: async (p, s) => { calls.push(['dm', s.id]); return null; },
  });

  const config = {
    databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2,
  };
  const platform = require('../src/workflow/platform.ts');
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await platform.startWorkflow(config, { loops: true });

  const { rows: [operator] } = await pool.query(
    `INSERT INTO users (username, password, is_admin) VALUES ('operator', 'x', TRUE) RETURNING id, username`);
  let seq = 0;
  const { rows: [author] } = await pool.query(`INSERT INTO users (username, password) VALUES ('author', 'x') RETURNING id`);
  // This is an existing app. The default 'creating' status also starts an
  // unrelated first deploy, which can move main after the merge deploy.
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url, status) VALUES ('Shop', 'shop', $1, 'https://github.com/acme/shop', 'running') RETURNING *`,
    [author.id]);
  const proposal = async (status = 'merging') => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title) VALUES ($1, $2, $3, $4, 'Change') RETURNING *`,
    [app.id, author.id, status, ++seq])).rows[0];
  // One of the Homeroom bot's changes: its DM is the bot's change machine's
  // (src/workflow/bot-change/), told by the merge's own write.
  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`);
  const botProposal = async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, linked_issues) VALUES ($1, $2, 'merging', $3, 'Change', $4) RETURNING *`,
      [app.id, botUser.id, ++seq, [seq]]);
    await pool.query(`INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, $2, 'live', 'ready', $3)`,
      [app.id, seq, s.id]);
    return s;
  };
  const state = async (s) => (await pool.query(
    `SELECT state FROM wf_instances WHERE machine = 'merge-followups' AND key = $1`, [`session:${s.id}`])).rows[0]?.state;
  const until = async (check, what) => {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      if (Date.now() >= deadline) {
        const { rows } = await pool.query(
          `SELECT key, kind, work_key, status, attempt_count, due_at, last_error FROM wf_work
            WHERE machine = 'merge-followups' AND status <> 'settled'
           UNION ALL SELECT key, type, request_key, status, attempts, retry_at, error FROM wf_events
            WHERE machine = 'merge-followups' AND status = 'pending'`);
        assert.fail(`${what}; unsettled: ${JSON.stringify(rows)}`);
      }
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  // Every follow-up settled. Stopping the runtime while one runs leaves it
  // `running` until its lease ends (a minute), so a subtest that stops it
  // waits for this first.
  const quiet = () => until(async () => !(await pool.query(
    `SELECT 1 FROM wf_work WHERE machine = 'merge-followups' AND status <> 'settled'
     UNION ALL SELECT 1 FROM wf_events WHERE machine = 'merge-followups' AND status = 'pending'`)).rows.length,
  'every follow-up settled');

  // GitHub merged it: merge-followups is created by Merged, here appended as
  // the proposal machine's message would bring it (its attempt's report:
  // tests/workflow-merge-postgres.test.js M1; a look's, PrLooked, below).
  const confirmed = (m) => require('../src/workflow/kernel/index.ts').appendEvent(pool, 'merge-followups', `session:${m.sessionId}`,
    { type: 'Merged', payload: { sessionId: m.sessionId, mergeSha: m.mergeSha, mergedAt: m.mergedAt || new Date().toISOString(),
      force: false, observedBy: 'recovery', tally: null } },
    { requestKey: `merged:${m.sessionId}:test`, source: { kind: 'system', name: 'recovery' }, appId: m.appId });

  await t.test('every machine\'s guard is recorded for the ownership triggers', async () => {
    const { rows } = await pool.query(`SELECT key FROM wf_settings WHERE key LIKE 'enabled:%' ORDER BY key`);
    assert.deepEqual(rows.map((r) => r.key),
      ['enabled:app-delivery', 'enabled:bot-request', 'enabled:campaign', 'enabled:governance-proposal', 'enabled:main-check', 'enabled:merge-followups',
        'enabled:merge-queue', 'enabled:preview', 'enabled:proposal', 'enabled:shots'],
      'no machine has a flag: their guards are on in every process');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_settings WHERE key = 'ownership_mode'`)).rows[0].n, 0);
  });

  await t.test('a confirmed merge goes live through the real handlers', async () => {
    const s = await botProposal();
    await confirmed({ sessionId: s.id, appId: app.id, mergeSha: SHA('a') });
    await until(async () => (await state(s)) === 'live', 'live');
    const r = (await pool.query('SELECT status, live_at, merge_commit_sha FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
    assert.equal(r.status, 'merged');
    assert.ok(r.live_at);
    assert.ok(calls.some((c) => c[0] === 'deploy' && c[2].reuseRunningRevision === SHA('a')),
      'app-delivery deploys, offered the merge commit');
    await until(async () => calls.some((c) => c[0] === 'dm' && c[1] === s.id), 'the DM, from the bot\'s change machine');
    assert.equal((await pool.query(`SELECT state FROM wf_instances WHERE machine = 'bot-change' AND key = $1`, [`session:${s.id}`])).rows[0]?.state, 'live');
    // The preview goes at the merge (only a demo-mode deploy reuses its
    // build and waits): the preview machine retires it, asked by the merge.
    const key = `session:${s.id}`;
    await until(async () => (await pool.query(
      `SELECT state FROM wf_instances WHERE machine = 'preview' AND key = $1`, [key])).rows[0]?.state === 'retired', 'the preview retired');
    const { rows: [ask] } = await pool.query(
      `SELECT payload, source FROM wf_events WHERE machine = 'preview' AND key = $1 AND type = 'RetireRequested'`, [key]);
    assert.deepEqual(ask.payload, { sessionId: s.id, reason: 'merged', terminal: true });
    const { rows: [mergedEvent] } = await pool.query(
      `SELECT id FROM wf_events WHERE machine = 'merge-followups' AND key = $1 AND type = 'Merged' ORDER BY id LIMIT 1`, [key]);
    assert.deepEqual(ask.source.from, { machine: 'merge-followups', key, eventId: Number(mergedEvent.id) },
      'asked by the transition that applied the merge');
    assert.ok(!calls.some((c) => c[0] === 'teardown' && c[1] === s.id), 'nothing else tears it down');
    await until(async () => calls.some((c) => c[0] === 'retire' && c[1] === s.id), 'the worker removed, fenced');
    // The merge may be live before the delivery machine records its final transition.
    await until(async () => (await pool.query(
      `SELECT state FROM wf_instances WHERE machine = 'app-delivery' AND key = $1`, [`app:${app.id}`])).rows[0]?.state === 'idle', 'the deployment settled');
    await until(async () => calls.some((c) => c[0] === 'main-check' && c[1] === SHA('a')), 'the main check, run by its machine');
    await until(async () => (await pool.query('SELECT main_check_state FROM apps WHERE id = $1', [app.id])).rows[0].main_check_state === 'passing',
      'its verdict on the row');
    const { rows: [m] } = await pool.query('SELECT main_sha FROM apps WHERE id = $1', [app.id]);
    assert.equal(m.main_sha, SHA('a'));
  });

  await t.test('a merge GitHub made while it was up for a vote, as a look read it, is recorded with the tally read again', async () => {
    const s = await proposal('promoted');
    const { rows: [voter] } = await pool.query(`INSERT INTO users (username, password) VALUES ('voter', 'x') RETURNING id`);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [s.id, voter.id]);
    // The proposal machine decides (PrLooked): up for its vote, a merge.
    assert.equal(await platform.prLooked({ sessionId: s.id, appId: app.id, from: 'promoted', merged: true, closed: true,
      mergeSha: SHA('a'), mergedAt: '2026-10-07T10:00:00Z', closedAt: '2026-10-07T10:00:00Z' }), true);
    await until(async () => (await state(s)) === 'live', 'live');
    const { rows: [i] } = await pool.query(`SELECT data FROM wf_instances WHERE machine = 'merge-followups' AND key = $1`, [`session:${s.id}`]);
    assert.equal(i.data.tally.yes, 1);
    assert.equal(i.data.mergedAt, '2026-10-07T10:00:00.000Z');
  });

  await t.test('a failed deploy goes live when any later deploy contains it', async () => {
    deploys.fail = true;
    const s = await proposal();
    await confirmed({ sessionId: s.id, appId: app.id, mergeSha: SHA('b') });
    await until(async () => (await state(s)) === 'deploy_failed', 'deploy failed');
    deploys.fail = false;
    // The drift poller's deploy of a build that does not contain it, then one that does.
    const idle = async () => (await pool.query(
      `SELECT state FROM wf_instances WHERE machine = 'app-delivery' AND key = $1`, [`app:${app.id}`])).rows[0]?.state === 'idle';
    deploys.sha = SHA('d');
    await platform.requestDeploy(app.id, 'drift');
    await until(async () => calls.some((c) => c[0] === 'compare' && c[2] === SHA('d')), 'checked');
    await until(idle, 'the deploy ended');
    assert.equal(await state(s), 'deploy_failed');
    deploys.sha = SHA('c');
    await platform.requestDeploy(app.id, 'drift');
    await until(async () => (await state(s)) === 'live', 'live after a deploy containing it');
    deploys.sha = null;
  });

  await t.test('an admin retries a failed delivery', async () => {
    deploys.fail = true;
    const s = await proposal();
    await confirmed({ sessionId: s.id, appId: app.id, mergeSha: SHA('e') });
    await until(async () => (await state(s)) === 'deploy_failed', 'deploy failed');
    deploys.fail = false;
    const out = await platform.adminEvent('merge-followups', `session:${s.id}`, 'RetryDelivery', {}, operator);
    assert.ok(['accepted', 'pending'].includes(out.status), out.status);
    await until(async () => (await state(s)) === 'live', 'live after the retry');
    await assert.rejects(platform.adminEvent('merge-followups', `session:${s.id}`, 'Merged', {}, operator),
      /not an admin action/);
  });

  await t.test('a merge accepted before a restart finishes after it', async () => {
    const s = await proposal();
    await quiet();
    await platform.stopWorkflow();
    // Accepted with no loops running: the event waits for a runtime.
    await platform.startWorkflow(config, { loops: false });
    await confirmed({ sessionId: s.id, appId: app.id, mergeSha: SHA('a') });
    await platform.stopWorkflow();
    await platform.startWorkflow(config, { loops: true });
    await until(async () => (await state(s)) === 'live', 'the accepted merge finished');
    await quiet();
  });

  // GitHub did not close the merged PR's `Closes #N`: the first look leaves
  // it to GitHub, the second closes it, and only then is the close proposal
  // for it superseded, by the merge's pull request. Before, the merge work
  // superseded it before it had looked, so a request GitHub (and the
  // platform) left open lost its close proposal anyway.
  await t.test('a close proposal for a request the merge closes is superseded once the close is seen, not before', async () => {
    const { rows: [shop] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url, approvals_required, status) VALUES ('Shop 2', 'shop-2', $1, 'https://github.com/acme/shop-2', 5, 'running') RETURNING *`,
      [author.id]);
    looked.add(shop.id);
    const n = 41;
    const { rows: [close] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'Close #41', 'close_issue', $2, $3) RETURNING id`,
      [shop.id, JSON.stringify({ issueNumber: n, issueTitle: 'Old bug' }), author.id]);
    await platform.fileProposal(close.id, shop.id);
    const gov = async () => (await pool.query(
      `SELECT state FROM wf_instances WHERE machine = 'governance-proposal' AND key = $1`, [`issue:${close.id}`])).rows[0]?.state;
    await until(async () => (await gov()) === 'open', 'filed');
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, linked_issues) VALUES ($1, $2, 'merging', $3, 'Change', $4) RETURNING *`,
      [shop.id, author.id, ++seq, [n]]);
    const key = `session:${s.id}`;
    const items = async () => (await pool.query(
      `SELECT work_key, status FROM wf_work WHERE machine = 'merge-followups' AND key = $1 AND kind = 'issues.closeAfterMerge' ORDER BY created_at`,
      [key])).rows;
    await confirmed({ sessionId: s.id, appId: shop.id, mergeSha: SHA('a') });
    await until(async () => (await items()).length === 2, 'the first look asked for a second');
    assert.ok(calls.some((c) => c[0] === 'look' && c[1] === s.pr_number && c[2] === 1));
    assert.ok(!calls.some((c) => c[0] === 'close' && c[1] === n), 'left to GitHub at the first look');
    assert.equal(await gov(), 'open', 'its request is still open: nothing superseded it');
    assert.equal((await pool.query('SELECT status FROM issues WHERE id = $1', [close.id])).rows[0].status, 'open');
    // Thirty seconds on.
    const [, second] = await items();
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE wf_work SET due_at = NOW() WHERE machine = 'merge-followups' AND key = '${key}' AND work_key = '${second.work_key}'; COMMIT`);
    await pool.query(`SELECT pg_notify('wf_work', 'made due')`);
    await until(async () => (await gov()) === 'superseded', 'superseded once the second look closed its request');
    assert.ok(calls.findIndex((c) => c[0] === 'close' && c[1] === n) > calls.findIndex((c) => c[0] === 'look' && c[1] === s.pr_number && c[2] === 2),
      'closed at the second look');
    const { rows: [row] } = await pool.query('SELECT status, payload FROM issues WHERE id = $1', [close.id]);
    assert.equal(row.status, 'closed');
    assert.equal(row.payload.supersededBy, `pr-merge:#${s.pr_number}`);
    const { rows: told } = await pool.query(
      `SELECT type, result, reason, source FROM wf_events WHERE machine = 'governance-proposal' AND key = $1 AND source->>'kind' = 'message' ORDER BY id`,
      [`issue:${close.id}`]);
    assert.deepEqual(told.map((e) => [e.type, e.result, e.reason, e.source.from.machine]),
      [['Filed', 'rejected', 'already_filed', 'merge-followups'], ['TargetClosed', 'accepted', null, 'merge-followups']],
      'filed already (a no-op), then told, by the merge');
    await quiet();
  });

  await t.test('a conductor booting a build says nothing is live; a process serving it does', async () => {
    // The platform's own app: its merges go live when a build containing
    // them serves (Deployed), not when the merge machine deploys anything.
    const { rows: [own] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url)
       VALUES ('Homeroom', 'homeroom-own', $1, TRUE, 'https://github.com/acme/homeroom') RETURNING *`, [author.id]);
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title) VALUES ($1, $2, 'merging', $3, 'Change') RETURNING *`,
      [own.id, author.id, ++seq]);
    await platform.stopWorkflow();
    await platform.startWorkflow(config, { loops: true });
    await confirmed({ sessionId: s.id, appId: own.id, mergeSha: SHA('a') });
    await until(async () => (await state(s)) === 'delivering', 'waiting for a build that contains it');
    const booted = async () => (await pool.query('SELECT booted_shas FROM apps WHERE id = $1', [own.id])).rows[0].booted_shas;
    const was = process.env.GIT_SHA;
    process.env.GIT_SHA = SHA('c');   // a build that contains the merge
    try {
      // The release's conductor boots first: it runs the workflow and serves
      // nobody.
      await quiet();
      await platform.stopWorkflow();
      await platform.startWorkflow(config, { loops: true });
      await quiet();
      assert.equal(await state(s), 'delivering', 'not live: nobody is served that build yet');
      assert.deepEqual(await booted(), [], 'nor recorded as one production ran');
      // Its web Pods come up and serve it.
      await platform.releaseServing(pool);
      await until(async () => (await state(s)) === 'live', 'live once a serving process runs it');
      assert.deepEqual((await booted()).map((b) => b.sha), [SHA('c')]);
    } finally {
      if (was === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = was;
    }
  });

  await t.test('a booting process records the build it runs; the migration\'s main_sha is not that (review finding, second pass)', async () => {
    const { rows: [self] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url, main_sha)
       VALUES ('Homeroom', 'homeroom-self', $1, TRUE, 'https://github.com/acme/homeroom', $2) RETURNING id`,
      [author.id, SHA('7')]);
    const was = process.env.GIT_SHA;
    const boot = async (sha) => {
      process.env.GIT_SHA = sha;
      await platform.startWorkflow(config, { loops: false });
      await platform.releaseServing(pool);
      await platform.stopWorkflow();
    };
    const history = async () => (await pool.query('SELECT main_sha, booted_shas FROM apps WHERE id = $1', [self.id])).rows[0];
    try {
      await boot(SHA('6'));
      let r = await history();
      assert.equal(r.main_sha, SHA('7'), 'the migration\'s word is left as it is');
      assert.deepEqual(r.booted_shas.map((b) => b.sha), [SHA('6')], 'what booted');
      // A rollout: build 5 boots, then an older Pod of build 6 again. Both are
      // kept, newest boot first, one entry per build.
      await boot(SHA('5'));
      await boot(SHA('6'));
      r = await history();
      assert.deepEqual(r.booted_shas.map((b) => b.sha), [SHA('6'), SHA('5')]);
      assert.ok(r.booted_shas.every((b) => !Number.isNaN(Date.parse(b.at))));
      // At most ten.
      for (const c of 'abcdef0123') await boot(SHA(c));
      r = await history();
      assert.equal(r.booted_shas.length, 10);
      assert.equal(r.booted_shas[0].sha, SHA('3'));
      assert.ok(!r.booted_shas.some((b) => b.sha === SHA('5')), 'the oldest boot fell off');
    } finally {
      if (was === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = was;
    }
  });

  await t.test('a note for the bot\'s change machine reaches it for a change of the bot\'s, and nothing about anybody else\'s', async () => {
    const { rows: [s1] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, linked_issues, check_state, reviewed_head_sha, checks_commit_sha)
       VALUES ($1, $2, 'promoted', $3, 'Older', $4, 'passing', $5, $5) RETURNING *`, [app.id, botUser.id, ++seq, [seq], SHA('e')]);
    await pool.query(`INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, $2, 'live', 'ready', $3)`,
      [app.id, seq, s1.id]);
    await platform.startWorkflow(config, { loops: true });
    // Its first note creates the instance, decided from its row.
    assert.notEqual(await platform.botNote(s1.id, 'Proposed', {}), 0);
    const inst = async (id) => (await pool.query(`SELECT state FROM wf_instances WHERE machine = 'bot-change' AND key = $1`, [`session:${id}`])).rows[0]?.state;
    await until(async () => (await inst(s1.id)) === 'ready', 'decided from its row: ready to try');
    // A session of somebody else's: nothing is appended.
    const theirs = await proposal('promoted');
    assert.equal(await platform.botNote(theirs.id, 'Verdict', { state: 'passing' }), 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE machine = 'bot-change' AND key = $1`, [`session:${theirs.id}`])).rows[0].n, 0);
  });
});
