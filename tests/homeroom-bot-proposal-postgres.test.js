'use strict';

// #3518, executed against the FULL PostgreSQL schema: what the Homeroom bot
// writes onto its build session before it proposes (live.prepareProposal),
// read back by the real pr-metadata the promote route runs, in a throwaway
// database built from src/db/schema.sql as a boot applies it. Only GitHub is
// stubbed. The route's own call is reproduced as it makes it
// (routes/votes.js: the session row, its last user message, `ccSummary: ''`
// and `preferredTitle: session.proposed_pr_title`), and the last test pins
// that call so the two cannot drift apart.
//
// Before: "Build issue 3233: Quota notifications are cryptic codes Edit the
// app…", and no summary. The completion row goes through the real
// history trigger (trg_pr_summary_history), which must not count it as a new
// request, and the real gatherSessionContext query, which must read it.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const live = require('../src/services/homeroom-bot-live');
const github = require('../src/services/github');
const prMetadata = require('../src/services/pr-metadata');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const SPEC = [
  '# Show quota changes as a plain sentence',
  '',
  '## User-facing changes',
  '',
  'When your app allowance changes, the notification says so in a sentence, such as "Your app allowance changed from 0 to 2."',
  '',
  '### Assumptions',
  '- The old wording stays for a change it cannot read.',
  '',
  '## Technical implementation',
  '',
  'Edit the app_quota_changed row in `notifications.js`.',
].join('\n');
const DESCRIPTION = 'Allowance notifications now read as a sentence, for example "Your app allowance changed from 0 to 2", instead of a code.';

test('a bot proposal is named by its spec and led by its own description', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_proposal_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const realCreate = github.createPR;
  const created = [];
  github.createPR = async (_owner, _repo, opts) => {
    created.push(opts);
    return { number: 800 + created.length, html_url: `https://github.com/usernode-bot/todo/pull/${800 + created.length}` };
  };
  t.after(async () => {
    github.createPR = realCreate;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const bot = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  )).rows[0];
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/usernode-bot/todo')
     RETURNING id, slug`,
  )).rows[0];

  // The session buildAndPropose opens, its seed, and (when it wrote one) the
  // spec as persistScoutPublication stores it.
  let issue = 3232;
  async function buildSession({ spec }) {
    issue += 1;
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless,
                                  created_from_issue_number, linked_issues, issue_link_seeded,
                                  session_title, agent_backend, agent_provider, agent_model)
       VALUES ($1, $2, $3, 'paused', FALSE, $4, ARRAY[$4::int], TRUE, $5,
               'codex_openrouter', 'openrouter', 'z-ai/glm-5.3-flash')
       RETURNING id`,
      [app.id, bot.id, `dev/homeroom_bot-${issue}`, issue, `Homeroom bot: #${issue} Quota notifications are cryptic codes`],
    );
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
      [s.id, `Build issue #${issue}: Quota notifications are cryptic codes\n\n`
        + 'Edit the app_quota_changed row so it reads as a sentence. Keep the fallback line.'],
    );
    if (spec) {
      await pool.query('UPDATE chat_sessions SET spec_md = $1 WHERE id = $2', [spec, s.id]);
      await pool.query('INSERT INTO chat_session_specs (session_id, version, content) VALUES ($1, 1, $2)', [s.id, spec]);
    }
    return s.id;
  }

  // What POST /api/sessions/:id/promote does with it, down to applyPrMetadata.
  async function promote(sessionId) {
    const { rows: [session] } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
        WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status IN ('active', 'paused')`,
      [sessionId, bot.id],
    );
    const { rows: msgRows } = await pool.query(
      `SELECT content FROM chat_session_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
    await prMetadata.applyPrMetadata({
      pool, session, repoOwner: 'usernode-bot', repoName: 'todo',
      userMessage: msgRows[0]?.content || '',
      ccSummary: '',
      username: bot.username,
      apiKey: null,
      userId: bot.id,
      allowModelGeneration: false,
      preferredTitle: session.proposed_pr_title || null,
    });
    return (await pool.query(
      `SELECT pr_number, pr_title, session_title, pr_title_fallback, pr_summary_md, pr_summary_source,
              pr_summary_stale, pr_summary_input_version, pr_body, proposed_pr_title
         FROM chat_sessions WHERE id = $1`,
      [sessionId],
    )).rows[0];
  }

  await t.test('the spec names it and the build\'s own block leads it', async () => {
    const id = await buildSession({ spec: SPEC });
    const before = (await pool.query('SELECT pr_summary_input_version FROM chat_sessions WHERE id = $1', [id])).rows[0];
    const prepared = await live.prepareProposal({
      pool, bot, sessionId: id, spec: SPEC, model: 'z-ai/glm-5.3-flash',
      buildText: `Built it.\n\n**What changed**\n- notifications.js\n\n==== DESCRIPTION ====\n${DESCRIPTION}\n==== END DESCRIPTION ====`,
    });
    assert.deepEqual(prepared, { title: 'Show quota changes as a plain sentence', description: DESCRIPTION });
    const after = (await pool.query('SELECT pr_summary_input_version FROM chat_sessions WHERE id = $1', [id])).rows[0];
    assert.equal(Number(after.pr_summary_input_version), Number(before.pr_summary_input_version),
      'a completion row is not a new request: the history trigger leaves the summary inputs alone');

    const row = await promote(id);
    const pr = created.at(-1);
    assert.equal(pr.title, 'Show quota changes as a plain sentence', 'what the change does');
    assert.doesNotMatch(pr.title, /Build issue|#?\d{4}/);
    assert.equal(row.pr_title, 'Show quota changes as a plain sentence');
    assert.equal(row.session_title, row.pr_title, 'the session is named after its proposal');
    assert.equal(row.pr_title_fallback, false);
    assert.equal(row.pr_summary_md, DESCRIPTION, 'the summary the group reads first');
    assert.equal(row.pr_summary_source, 'generated');
    assert.equal(row.pr_summary_stale, false);
    assert.ok(pr.body.startsWith(`${DESCRIPTION}\n\n`), 'the pull request leads with it');
    assert.match(pr.body, new RegExp(`^Closes #${issue}$`, 'm'), 'and still closes its issue');
  });

  await t.test('a build that left its block out is described by the spec\'s user-facing half', async () => {
    const id = await buildSession({ spec: SPEC });
    await live.prepareProposal({ pool, bot, sessionId: id, spec: SPEC, buildText: 'Built it. Changed notifications.js.' });
    const row = await promote(id);
    assert.equal(row.pr_title, 'Show quota changes as a plain sentence');
    assert.equal(row.pr_summary_md,
      'When your app allowance changes, the notification says so in a sentence, such as "Your app allowance changed from 0 to 2."',
      'the plain-English half, without its assumptions');
  });

  await t.test('with no spec the proposal is named after its issue, whole, not the seed', async () => {
    const id = await buildSession({ spec: null });
    await live.prepareProposal({ pool, bot, sessionId: id, spec: null, buildText: '' });
    const row = await promote(id);
    assert.equal(row.proposed_pr_title, null, 'nothing chosen: the route names it');
    assert.equal(row.pr_title, 'Quota notifications are cryptic codes');
    assert.equal(row.pr_summary_md, null, 'nothing was said, so nothing is invented');
  });

  await t.test('a title somebody already chose is kept', async () => {
    const id = await buildSession({ spec: SPEC });
    await pool.query('UPDATE chat_sessions SET proposed_pr_title = $1 WHERE id = $2', ['A name a person gave it', id]);
    await live.prepareProposal({ pool, bot, sessionId: id, spec: SPEC, buildText: '' });
    const row = await promote(id);
    assert.equal(row.pr_title, 'A name a person gave it');
  });

  await t.test('the reproduction above is the call the promote route makes', () => {
    const votes = fs.readFileSync(path.join(__dirname, '..', 'src/routes/votes.js'), 'utf8');
    const call = votes.slice(votes.indexOf('prResult = await prMetadata.applyPrMetadata({'));
    assert.match(call.slice(0, 900), /userMessage: msgRows\[0\]\?\.content \|\| '',\n\s+ccSummary: '',/);
    assert.match(call.slice(0, 900), /preferredTitle: session\.proposed_pr_title \|\| null,/);
    assert.match(votes, /`SELECT content FROM chat_session_messages\n\s+WHERE session_id = \$1 AND role = 'user'\n\s+ORDER BY id DESC LIMIT 1`/);
  });
});

const botService = require('../src/services/homeroom-bot');

// #3638, executed against the FULL PostgreSQL schema: the bot fixes its own
// failing checks. noteProposalChecks is the hook a check verdict reaches;
// runChecksFix is the turn it runs. Only GitHub, the worker, the model loop
// and the thread readers are stubbed; the queue, the runs ledger and the
// session row are real, because the "one look per failing head" rule lives
// in them.
test('a failing verdict on the bot\'s own proposal queues one fix, and the fix speaks once', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_checks_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const bot = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  )).rows[0];
  const person = (await pool.query(
    `INSERT INTO users (username, password) VALUES ('somebody', 'x') RETURNING id`,
  )).rows[0];
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('RecipeBot', 'recipebot', 'running', 'https://github.com/usernode-bot/recipebot')
     RETURNING id, slug, name, repo_url`,
  )).rows[0];
  await pool.query(
    `INSERT INTO platform_settings (key, value)
     VALUES ('homeroom_bot_mode', 'shadow'), ('homeroom_bot_live_apps', '["recipebot"]')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  const HEAD = 'a'.repeat(40);
  const NEW_HEAD = 'b'.repeat(40);
  const RESULTS = {
    check_state: 'failing',
    checks_commit_sha: HEAD,
    reviewed_head_sha: HEAD,
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', failureReason: '' },
      { name: 'Search keeps its query', path: '/', status: 'fail', failureReason: 'Timed out waiting for selector ".query"' },
    ],
  };
  let seq = 0;
  // The proposal the build made, promoted, with its checks verdict on the
  // head the group last reviewed.
  async function buildProposal() {
    seq += 1;
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless,
                                  created_from_issue_number, linked_issues, session_title,
                                  agent_backend, agent_provider, agent_model)
       VALUES ($1, $2, $3, 'promoted', FALSE, 48, ARRAY[48::int], $4,
               'codex_openrouter', 'openrouter', 'z-ai/glm-5.3-flash')
       RETURNING id`,
      [app.id, bot.id, `dev/homeroom_bot-48-checks-${seq}`, `Homeroom bot: #48 checks fix ${seq}`],
    );
    await pool.query(
      `UPDATE chat_sessions
          SET check_state = $2, checks_commit_sha = $3, reviewed_head_sha = $4,
              test_results = $5::jsonb, pr_number = 82
        WHERE id = $1`,
      [s.id, RESULTS.check_state, RESULTS.checks_commit_sha, RESULTS.reviewed_head_sha,
       JSON.stringify(RESULTS.test_results)],
    );
    return s;
  }
  async function queueRow() {
    return (await pool.query(
      'SELECT app_id, issue_number, priority, reason FROM homeroom_bot_queue ORDER BY id',
    )).rows;
  }
  async function queueItemFor() {
    await pool.query('DELETE FROM homeroom_bot_queue');
    const { rows: [q] } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason)
       VALUES ($1, 48, 2, 'checks_failing') RETURNING id`,
      [app.id],
    );
    return q.id;
  }
  async function lookedAt(sessionId) {
    return (await pool.query(
      'SELECT checks_head_sha FROM homeroom_bot_runs WHERE proposal_session_id = $1 AND checks_head_sha IS NOT NULL',
      [sessionId],
    )).rows.map((r) => r.checks_head_sha);
  }

  // The stubs runChecksFix and its turn talk to. `result` is what the
  // worker reports; `workerError` makes the turn a platform fault; the rest
  // only has to succeed. recordFailure is the real one's shape: a failed
  // ledger row WITHOUT checks_head_sha, and the queue kept on an infra fault.
  function checksFixHarness({ sessionId, itemId, result = {}, workerError = null, posts, reconciled, failures }) {
    live.post = async (a) => {
      posts.push({ where: 'issue', kind: a.kind, text: a.text, dm: a.dm || null, proposalSessionId: a.proposalSessionId });
      return { githubCreatedAt: new Date().toISOString() };
    };
    live.postOnProposal = async (a) => {
      posts.push({ where: 'proposal', kind: a.kind, text: a.text });
      return { postId: 1, thread: true, threadCreatedAt: new Date().toISOString() };
    };
    live.mentionTargets = async () => [];
    live.advanceSeen = async () => ({ advanced: true });
    return {
      pool, config: {},
      bot, app, repo: { owner: 'usernode-bot', repo: 'recipebot' },
      item: { id: itemId, app_id: app.id, issue_number: 48, priority: 2, reason: 'checks_failing', thread_seen_at: null },
      issue: { number: 48, title: 'Keep the search query on rotate', state: 'open', body: 'It forgets the query.' },
      proposal: { id: sessionId },
      runMode: 'live', model: 'z-ai/glm-5.3-flash', turnBudgetMs: 1200000, startedMs: Date.now() - 1000,
      comments: [], issueThread: null, proposalThread: null, botLogin: 'usernode-bot',
      seedReadAt: new Date().toISOString(),
      recordFailure: async (error, extra = {}, { infra = false } = {}) => {
        failures.push({ error, infra, extra });
        const { rows: [r] } = await pool.query(
          `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, error, model,
                                          duration_ms, proposal_session_id)
           VALUES ($1, 48, 'live', 'failed', $2, $3, 10, $4) RETURNING id`,
          [app.id, error, 'z-ai/glm-5.3-flash', extra.proposalSessionId || null],
        );
        if (infra) await pool.query('UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = $1', [itemId]);
        else await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [itemId]);
        return infra
          ? { ran: false, reason: 'infra', detail: error, runId: r.id }
          : { ran: true, verdict: 'failed', runId: r.id };
      },
      deps: {
        github: {
          isEnabled: () => true,
          async fetchIssueComments() { return { comments: [] }; },
          async createIssueComment() { return { id: 1, created_at: new Date().toISOString() }; },
        },
        worker: {
          async ensureWorkerImage() { if (workerError) throw new Error(workerError); },
          async ensureWorker() { return 'usernode-worker-x'; },
          async execInWorker() { return result; },
          async stopTurn() {},
        },
        agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
        limits: { async recordSpend() {} },
        managedOpenRouter: { async usesIncludedKey() { return false; } },
        sessions: {
          buildHeadlessSeed: () => 'SEED: keep the search query on rotate',
          async runCodexAttemptLoop({ dispatchOnce }) {
            if (workerError) return { error: `dispatch: ${workerError}` };
            return { result: await dispatchOnce({}), error: null, estimatedCostUsd: 0.01 };
          },
        },
        activeWorkers: new Set(),
        ws: {},
        votes: { async reconcileNativeReviewedHead(call) { reconciled.push(call); return { enforced: true }; } },
        domain: 'app.onhomeroom.com',
      },
    };
  }

  await t.test('noteProposalChecks queues once per failing head, only for the bot\'s own live proposal', async () => {
    const s = await buildProposal();
    // The ledger row the queue reads its issue number from.
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id)
       VALUES ($1, 48, 'live', 'ready', $2)`,
      [app.id, s.id],
    );
    const subject = { ...s, app_id: app.id };

    assert.equal(await botService.noteProposalChecks(pool, subject, 'failing'), true, 'queued');
    assert.deepEqual(await queueRow(), [{ app_id: app.id, issue_number: 48, priority: 2, reason: 'checks_failing' }]);

    // The fix looks at the head (its run row carries checks_head_sha); a
    // second verdict on that same head does not queue again.
    await pool.query('DELETE FROM homeroom_bot_queue');
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha)
       VALUES ($1, 48, 'live', 'failed', $2, $3)`,
      [app.id, s.id, HEAD],
    );
    assert.equal(await botService.noteProposalChecks(pool, subject, 'failing'), false, 'the same head is not queued twice');
    assert.deepEqual(await queueRow(), []);

    // A verdict on a moved head is queued once more: the group reviewed a
    // new head (reviewed_head_sha) and the checks ran on exactly that head.
    await pool.query(
      'UPDATE chat_sessions SET checks_commit_sha = $2, reviewed_head_sha = $2 WHERE id = $1',
      [s.id, NEW_HEAD],
    );
    assert.equal(await botService.noteProposalChecks(pool, subject, 'failing'), true, 'a moved head is queued once more');
    assert.equal((await queueRow()).length, 1);
    await pool.query(
      'UPDATE chat_sessions SET checks_commit_sha = $2, reviewed_head_sha = $2 WHERE id = $1',
      [s.id, HEAD],
    );

    // An error verdict is never acted on.
    assert.equal(await botService.noteProposalChecks(pool, subject, 'error'), false);

    // Not the bot's own: a person's proposal is theirs to look at.
    await pool.query('UPDATE chat_sessions SET user_id = $2 WHERE id = $1', [s.id, person.id]);
    assert.equal(await botService.noteProposalChecks(pool, subject, 'failing'), false, 'not the bot\'s own proposal');
    await pool.query('UPDATE chat_sessions SET user_id = $2 WHERE id = $1', [s.id, bot.id]);

    // Not while it is merging, and not on an app the bot does not act on.
    await pool.query("UPDATE chat_sessions SET status = 'merging' WHERE id = $1", [s.id]);
    assert.equal(await botService.noteProposalChecks(pool, subject, 'failing'), false, 'merging does not qualify');
    await pool.query("UPDATE chat_sessions SET status = 'promoted' WHERE id = $1", [s.id]);
    await pool.query(
      `UPDATE platform_settings SET value = '[]' WHERE key = 'homeroom_bot_live_apps'`,
    );
    assert.equal(await botService.noteProposalChecks(pool, subject, 'failing'), false, 'a shadow app is never acted on');
    await pool.query(
      `UPDATE platform_settings SET value = '["recipebot"]' WHERE key = 'homeroom_bot_live_apps'`,
    );
    // And once the failing head is un-looked-at again, it is queued once more.
    await pool.query('DELETE FROM homeroom_bot_runs WHERE checks_head_sha IS NOT NULL');
    assert.equal(await botService.noteProposalChecks(pool, subject, 'failing'), true);
    await pool.query('DELETE FROM homeroom_bot_queue');
  });

  await t.test('runChecksFix: a moved head is reconciled and said in the proposal thread only', async () => {
    const s = await buildProposal();
    const itemId = await queueItemFor();
    const posts = [];
    const reconciled = [];
    const failures = [];
    const harness = checksFixHarness({ sessionId: s.id, itemId, posts, reconciled, failures, result: {
      pushOk: true, sha: NEW_HEAD,
      lastResultText: '```json\n{"action":"revise","reply":"The search keeps its query across a rotate.","summary":"The query survives a rotate."}\n```',
    } });
    const out = await botService.runChecksFix(harness.pool, harness.config, harness);
    assert.equal(out.verdict, 'revise');
    assert.deepEqual(reconciled.map((c) => [c.fresh, c.notify, c.session.id]), [[true, true, s.id]],
      'the same reconcile a person\'s revision reaches');
    assert.deepEqual(posts.map((p) => [p.where, p.kind]), [['proposal', 'checks_revise']],
      'said once, in the proposal\'s own discussion only');
    assert.match(posts[0].text, /votes were cleared/);
    assert.deepEqual(await lookedAt(s.id), [HEAD], 'the failing head is marked: one look per failing head');
    assert.deepEqual(await queueRow(), [], 'the queue row is spent');
  });

  await t.test('runChecksFix: what it cannot fix is handed to a person with one note in three places', async () => {
    const s = await buildProposal();
    const itemId = await queueItemFor();
    const posts = [];
    const reconciled = [];
    const failures = [];
    const harness = checksFixHarness({ sessionId: s.id, itemId, posts, reconciled, failures, result: {
      pushOk: false,
      lastResultText: '```json\n{"action":"person","reply":"The failing check conflicts with what the group asked for."}\n```',
    } });
    const out = await botService.runChecksFix(harness.pool, harness.config, harness);
    assert.equal(out.verdict, 'person');
    assert.deepEqual(reconciled, [], 'nothing moved, nothing reconciled');
    assert.deepEqual(posts.map((p) => [p.where, p.kind]), [['issue', 'followup_person']],
      'one note: GitHub comment, issue thread, proposal thread, DM');
    assert.deepEqual(posts[0].dm, { reason: 'The failing check conflicts with what the group asked for.' });
    assert.equal(posts[0].proposalSessionId, s.id, 'the proposal\'s discussion carries it too');
    assert.deepEqual(await lookedAt(s.id), [HEAD]);
    assert.deepEqual(await queueRow(), []);
  });

  await t.test('runChecksFix: trouble that is not the proposal\'s is neither fixed nor said', async () => {
    const s = await buildProposal();
    await pool.query(
      `UPDATE chat_sessions SET test_results = $2::jsonb WHERE id = $1`,
      [s.id, JSON.stringify([
        { name: 'Home loads', path: '/', status: 'fail', failureReason: 'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3311' },
        ...Array.from({ length: 42 }, (_, i) => ({ name: `p${i}`, path: '/', status: 'pass', failureReason: '' })),
      ])],
    );
    const itemId = await queueItemFor();
    const posts = [];
    const reconciled = [];
    const failures = [];
    const harness = checksFixHarness({ sessionId: s.id, itemId, posts, reconciled, failures });
    const out = await botService.runChecksFix(harness.pool, harness.config, harness);
    assert.deepEqual(out, { ran: false, reason: 'checks_infra' }, 'no revision spent, nothing said');
    assert.deepEqual(posts, []);
    assert.deepEqual(await lookedAt(s.id), [], 'the head is NOT marked: the platform\'s re-run is still looked at');
    assert.deepEqual(await queueRow(), [], 'but the queue row is released');
  });

  await t.test('runChecksFix: a platform fault keeps the queue and does not mark the head', async () => {
    const s = await buildProposal();
    const itemId = await queueItemFor();
    const posts = [];
    const reconciled = [];
    const failures = [];
    const harness = checksFixHarness({ sessionId: s.id, itemId, posts, reconciled, failures, workerError: 'docker gone' });
    const out = await botService.runChecksFix(harness.pool, harness.config, harness);
    assert.equal(out.ran, false, 'no revision spent');
    assert.deepEqual(failures.map((f) => f.infra), [true], 'recorded as a platform fault');
    assert.deepEqual(posts, [], 'nothing said');
    assert.deepEqual(await lookedAt(s.id), [], 'the head is NOT marked, so the fix is still owed');
    const [q] = await queueRow();
    assert.equal(q.reason, 'checks_failing', 'the queue row survives the fault');
  });

  await t.test('runChecksFix: an out-of-revisions proposal is handed over without a turn', async () => {
    const s = await buildProposal();
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id)
       VALUES ($1, 48, 'live', 'revise', $2), ($1, 48, 'live', 'revise', $2), ($1, 48, 'live', 'revise', $2)`,
      [app.id, s.id],
    );
    const itemId = await queueItemFor();
    const posts = [];
    const reconciled = [];
    const failures = [];
    const harness = checksFixHarness({ sessionId: s.id, itemId, posts, reconciled, failures, result: {} });
    const out = await botService.runChecksFix(harness.pool, harness.config, harness);
    assert.equal(out.verdict, 'person');
    assert.equal(out.ran, true);
    assert.deepEqual(await lookedAt(s.id), [HEAD], 'the head is marked so this head is not asked for again');
    assert.deepEqual(await queueRow(), []);
    assert.deepEqual(posts.map((p) => [p.where, p.kind]), [['issue', 'followup_person']]);
    assert.match(posts[0].text, /out of the revisions/);
  });
});

