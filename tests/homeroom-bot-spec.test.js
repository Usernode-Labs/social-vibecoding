// The Homeroom bot writes a spec before it builds, the way a person's dev
// session does: a read-only scout turn in the build's own session, stored as
// that session's spec doc, then handed to the build as authoritative. On a
// live app the spec is posted on the issue as soon as it is written (a
// GitHub comment and a spec card in the thread) and on the proposal once it
// is up. For reference only: the build never waits on it. A shadow build
// writes one too, and shows it to nobody but the dashboard.
//
// Run with: node --test tests/homeroom-bot-spec.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'rss-reader-4113da', name: 'RSS', repo_url: 'https://github.com/usernode-bot/rss', self_hosted: false };
const REPO = { owner: 'usernode-bot', repo: 'rss' };
const BOT = { id: 77, username: 'homeroom_bot' };
const SPEC = [
  '# Hourly feed refresh',
  '',
  'Feeds refresh on their own every hour.',
  '',
  '## User-facing changes',
  'Feeds update without pressing Refresh.',
  '',
  '## Technical implementation',
  'Schedule the poller in `server/poller.js`.',
].join('\n');

function harness({ spec = SPEC, specHang = false, onSpecThrows = false } = {}) {
  const calls = { order: [], published: [], stopped: [], ensured: 0, prompts: {}, loops: {}, promoted: [] };
  const pool = {
    async query(sql) {
      if (/INSERT INTO chat_sessions/.test(String(sql))) return { rows: [{ id: 5001, app_id: APP.id, user_id: BOT.id }] };
      return { rows: [] };
    },
  };
  let release;
  const hung = new Promise((r) => { release = r; });
  calls.release = () => release();
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => { calls.promoted.push(req.params.id); res.json({ ok: true, prNumber: 42 }); });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { calls.ensured += 1; return 'usernode-worker-5001'; },
      async execInWorker(_id, opts) {
        calls.order.push(`exec:${opts.mode}`);
        calls.prompts[opts.mode] = opts.prompt;
        return opts.mode === 'scout' ? { lastResultText: spec } : { pushOk: true, ahead: 1, sha: 'a'.repeat(40) };
      },
      stopTurn(id) { calls.stopped.push(id); release(); return Promise.resolve(); },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        calls.loops[args.mode] = args;
        const r = await args.dispatchOnce({});
        if (args.mode === 'scout' && specHang) await hung;
        return { result: r, error: null, estimatedCostUsd: args.mode === 'scout' ? 0.01 : 0.05 };
      },
      async persistScoutPublication(args) { calls.published.push(args); return { specVersion: 3 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `homeroom_bot/s${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: router,
  };
  const onSpec = async (s) => {
    calls.order.push('onSpec');
    calls.spec = s;
    if (onSpecThrows) throw new Error('GitHub is down');
  };
  return { pool, deps, calls, onSpec };
}

const ARGS = {
  config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12,
  issue: { title: 'Refresh feeds every hour' }, seed: 'Please work on GitHub issue #12.',
  buildNote: 'Add an hourly refresh to the feed poller.', turnBudgetMs: 20 * 60 * 1000, model: 'z-ai/glm-5.3-flash',
};

// ── The spec turn, and the build that works from it ─────────────────────

test('a spec is written first, read-only, stored as the session\'s spec doc, posted, then built from', async () => {
  const h = harness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, onSpec: h.onSpec });
  assert.deepEqual(h.calls.order, ['exec:scout', 'onSpec', 'exec:build'], 'posted before the build, and not waited on beyond the post');

  const scout = h.calls.loops.scout;
  assert.equal(scout.telemetryComponent, 'homeroom_bot_spec');
  assert.equal(scout.resumeThreadId, null);
  const sp = h.calls.prompts.scout;
  assert.match(sp, /PLAN MODE/);
  assert.match(sp, /do not edit, create, delete, commit, or push/);
  assert.match(sp, /"## User-facing changes" then\n\s*"## Technical implementation"/);
  assert.match(sp, /Do not write a "### Questions"/, 'unattended: nobody is there to answer');
  assert.match(sp, /Add an hourly refresh to the feed poller\./, 'from the triage\'s plan');
  assert.match(sp, /DESIGN BRIEF/, 'the same design brief every scout gets');

  assert.deepEqual(h.calls.published, [{
    pool: h.pool, sessionId: 5001, content: SPEC, hadSpec: false,
    agentBackend: 'codex_openrouter', agentModel: 'z-ai/glm-5.3-flash',
  }], 'spec_md, a numbered version, and the card in the session\'s own transcript');
  assert.deepEqual(h.calls.spec, { sessionId: 5001, version: 3, specMd: SPEC });

  const bp = h.calls.prompts.build;
  assert.ok(bp.includes(`==== SPEC (written for this request just before this build; authoritative for what to build) ====\n\n${SPEC}\n\n==== END SPEC ====`));
  assert.match(bp, /where they differ,\nthe spec wins/);
  assert.equal(h.calls.loops.build.telemetryComponent, 'homeroom_bot_build');

  assert.deepEqual(out, { ok: true, sessionId: 5001, prNumber: 42, costUsd: 0.060000000000000005, specMd: SPEC, specVersion: 3 });
});

test('a spec wrapped in one fence is unwrapped; a spec that is really an API error is no spec', async () => {
  const fenced = harness({ spec: `\`\`\`markdown\n${SPEC}\n\`\`\`` });
  const a = await live.buildAndPropose({ pool: fenced.pool, deps: fenced.deps, ...ARGS, onSpec: fenced.onSpec });
  assert.equal(a.specMd, SPEC);

  const broken = harness({ spec: 'API Error: Connection lost mid-response' });
  const b = await live.buildAndPropose({ pool: broken.pool, deps: broken.deps, ...ARGS, onSpec: broken.onSpec });
  assert.equal(b.ok, true, 'the build goes ahead from the plan');
  assert.equal(b.specMd, undefined);
  assert.deepEqual(broken.calls.order, ['exec:scout', 'exec:build'], 'nothing posted');
  assert.deepEqual(broken.calls.published, []);
  assert.doesNotMatch(broken.calls.prompts.build, /==== SPEC/);

  const empty = harness({ spec: '   ' });
  const c = await live.buildAndPropose({ pool: empty.pool, deps: empty.deps, ...ARGS, onSpec: empty.onSpec });
  assert.equal(c.ok, true);
  assert.deepEqual(empty.calls.order, ['exec:scout', 'exec:build']);
});

test('a post that fails does not stop the build', async () => {
  const h = harness({ onSpecThrows: true });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, onSpec: h.onSpec });
  assert.equal(out.ok, true);
  assert.deepEqual(h.calls.promoted, ['5001']);
  assert.equal(out.specMd, SPEC);
});

test('the spec has a clock of its own, shorter than the build\'s; a stopped spec gets a fresh worker and the build goes on', async (t) => {
  const h = harness({ specHang: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, onSpec: h.onSpec });
  for (let i = 0; i < 200 && !h.calls.order.includes('exec:scout'); i += 1) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(live.SPEC_TURN_MAX_MS - 1);
  assert.deepEqual(h.calls.stopped, [], 'still inside its ten minutes');
  t.mock.timers.tick(1);
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  if (!h.calls.stopped.length) h.calls.release();
  const out = await running;
  assert.deepEqual(h.calls.stopped, [5001], 'stopped at ten minutes, not the build\'s twenty');
  assert.equal(h.calls.ensured, 2, 'stopping a turn takes its container, so the build gets a new one');
  assert.equal(out.ok, true);
  assert.equal(out.specMd, undefined);
  assert.deepEqual(h.calls.order, ['exec:scout', 'exec:build']);
});

test('a shadow build writes its spec too, and posts it nowhere', async () => {
  const h = harness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, propose: false });
  assert.equal(out.ok, true);
  assert.equal(out.specMd, SPEC);
  assert.equal(out.specVersion, 3);
  assert.deepEqual(h.calls.order, ['exec:scout', 'exec:build'], 'no onSpec: nothing is posted');
  assert.deepEqual(h.calls.promoted, []);
});

test('a failed build still says what it meant to build', async () => {
  const h = harness();
  h.deps.worker.execInWorker = async (_id, opts) => (opts.mode === 'scout' ? { lastResultText: SPEC } : { pushOk: true, ahead: 0 });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, propose: false });
  assert.equal(out.ok, false);
  assert.equal(out.specMd, SPEC);
  assert.equal(out.costUsd, 0.060000000000000005, 'both turns are the build\'s cost');
});

// ── What is posted ───────────────────────────────────────────────────────

test('the GitHub comment says what the spec is for and folds the document away', () => {
  const text = live.specCommentText(SPEC);
  assert.match(text, /^Homeroom bot wrote a spec for this request and is building it now\. It is here for reference: nobody needs to approve it/);
  assert.ok(text.includes(`<details><summary>The spec</summary>\n\n${SPEC}\n\n</details>`));
  const long = live.specCommentText('x'.repeat(70_000));
  assert.ok(long.length < 65_536, 'GitHub refuses a comment over 65,536 characters');
  assert.ok(!/—/.test(text));
});

test('the thread card is the same spec card a person\'s Share posts', () => {
  const card = live.specCard({ sessionId: 5001, version: 3, spec: SPEC, bot: BOT });
  assert.equal(card.msgType, 'spec_share');
  assert.deepEqual(card.metadata.specShare, {
    sessionId: 5001, version: 3, builtAt: null, commitSha: null, prNumber: null,
    title: 'Hourly feed refresh',
    snippet: SPEC.split('\n').slice(2).join('\n'),
    totalChars: SPEC.length,
    sharedBy: { id: 77, username: 'homeroom_bot' },
  });
  assert.match(card.content, /Homeroom bot's spec for this request: "Hourly feed refresh"\. It is building it now; this is for reference, not for approval\./);
  assert.match(live.specCard({ sessionId: 5001, version: 3, spec: SPEC, bot: BOT, proposed: true }).content,
    /The spec this proposal was built from: "Hourly feed refresh"/);
  assert.equal(live.specTitle('## Only a section\n# Real title'), 'Real title');
  assert.equal(live.specTitle('no title'), null);
});

test('live.post puts the card in the thread and the full spec on GitHub', async () => {
  const sent = [];
  const comments = [];
  const pool = { async query(sql) { return /INSERT INTO homeroom_bot_posts/.test(String(sql)) ? { rows: [{ id: 1 }] } : { rows: [] }; } };
  const ws = { async sendBotMessage(_p, appId, args) { sent.push({ appId, ...args }); return { id: 200 }; } };
  const github = { async createIssueComment(_o, _r, n, body) { comments.push({ n, body }); return { id: 1, created_at: '2026-09-28T10:00:00Z' }; } };
  const card = live.specCard({ sessionId: 5001, version: 3, spec: SPEC, bot: BOT });
  const out = await live.post({
    pool, github, ws, app: APP, repo: REPO, issueNumber: 12, kind: 'spec', text: live.specCommentText(SPEC),
    sender: BOT, threadMessage: card,
  });
  assert.equal(out.githubCreatedAt, '2026-09-28T10:00:00Z', 'so the bot does not read its own comment as a change');
  assert.equal(comments[0].body, live.specCommentText(SPEC));
  assert.deepEqual(sent, [{
    appId: 9, user: BOT, content: card.content, metadata: card.metadata,
    thread: { type: 'issue', ref: 12 }, msgType: 'spec_share',
  }]);
  assert.equal(live.tagsPoster('spec'), false, 'a notice, not a question: nobody is @-mentioned');
});

function actHarness() {
  const posts = [];
  const queries = [];
  const sent = [];
  const pool = { async query(sql, params) { queries.push({ sql: String(sql), params }); return { rows: [] }; } };
  const deps = {
    github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
    ws: { async sendBotMessage(_p, appId, args) { sent.push({ appId, ...args }); return { id: 300 }; } },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    limits: { async recordSpend() {} },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    domain: 'app.onhomeroom.com',
  };
  return { pool, deps, posts, queries, sent };
}

test('live: the spec goes on the issue before the build, and on the proposal once it is up', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { h.posts.push(args); return { githubCreatedAt: '2026-09-28T10:00:05Z' }; };
  live.buildAndPropose = async (args) => {
    await args.onSpec({ sessionId: 5001, version: 3, specMd: SPEC });
    h.posts.push({ kind: '(build ran)' });
    return { ok: true, sessionId: 5001, prNumber: 42, costUsd: 0, specMd: SPEC, specVersion: 3 };
  };
  const postedAt = [];
  const acted = await bot.actOnVerdict({
    pool: h.pool, config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12, issue: { title: 'x' },
    parsed: { verdict: 'ready', buildNote: 'x' }, capSuppressed: null, runId: 900, seed: 'seed',
    seedReadAt: '2026-09-28T09:59:00Z', postedAt, turnBudgetMs: 1000, model: 'm', deps: h.deps,
  });
  assert.equal(acted, 'proposed');
  assert.deepEqual(h.posts.map((p) => p.kind), ['spec', '(build ran)', 'proposal']);
  const spec = h.posts[0];
  assert.equal(spec.text, live.specCommentText(SPEC));
  assert.deepEqual(spec.threadMessage, live.specCard({ sessionId: 5001, version: 3, spec: SPEC, bot: BOT }));
  assert.equal(spec.mention, null);
  assert.ok(postedAt.length >= 1, 'its GitHub comment counts as the bot\'s own');

  const shares = h.queries.filter((q) => /SET shared_to_group_at = NOW\(\)/.test(q.sql));
  assert.deepEqual(shares.map((q) => q.params), [[5001, 3], [5001, 3]], 'readable by everyone who sees a card');
  assert.deepEqual(h.sent, [{
    appId: 9, user: BOT,
    content: live.specCard({ sessionId: 5001, version: 3, spec: SPEC, bot: BOT, proposed: true }).content,
    metadata: live.specCard({ sessionId: 5001, version: 3, spec: SPEC, bot: BOT, proposed: true }).metadata,
    thread: { type: 'session', ref: 5001 }, msgType: 'spec_share',
  }], 'the proposal\'s own discussion gets the card');
  const recorded = h.queries.find((q) => /SET build_spec_md = \$2/.test(q.sql));
  assert.deepEqual(recorded.params, [900, SPEC], 'the dashboard and the export carry it');
});

test('live: no spec, no spec posts; a build that fails still records the spec it had', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { h.posts.push(args); return {}; };
  live.buildAndPropose = async () => ({ ok: true, sessionId: 5001, prNumber: 42, costUsd: 0 });
  const args = {
    pool: h.pool, config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12, issue: { title: 'x' },
    parsed: { verdict: 'ready', buildNote: 'x' }, capSuppressed: null, runId: 900, seed: 'seed',
    seedReadAt: '2026-09-28T09:59:00Z', postedAt: [], turnBudgetMs: 1000, model: 'm', deps: h.deps,
  };
  await bot.actOnVerdict(args);
  assert.deepEqual(h.posts.map((p) => p.kind), ['proposal']);
  assert.deepEqual(h.sent, []);

  h.posts.length = 0;
  live.buildAndPropose = async () => ({ ok: false, sessionId: 5002, error: 'the build produced no change to propose', costUsd: 0, specMd: SPEC, specVersion: 1 });
  assert.equal(await bot.actOnVerdict(args), 'build_failed');
  assert.ok(h.queries.some((q) => /SET build_spec_md = \$2/.test(q.sql) && q.params[1] === SPEC));
  assert.deepEqual(h.sent, [], 'no proposal, so nothing to post it on');
});

// ── Recorded and shown ──────────────────────────────────────────────────

test('a shadow build records the spec on its run', async (t) => {
  bot._resetForTests();
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/FROM apps WHERE id = \$1/.test(String(sql))) return { rows: [APP] };
      return { rows: [], rowCount: 1 };
    },
  };
  const realBuild = live.buildAndPropose;
  t.after(() => { live.buildAndPropose = realBuild; });
  live.buildAndPropose = async (args) => {
    assert.equal(args.onSpec, undefined, 'nowhere to post it');
    return { ok: true, sessionId: 6001, branchName: 'dev/b', sha: 'c'.repeat(40), commits: 1, costUsd: 0.02, specMd: SPEC, specVersion: 1 };
  };
  const deps = {
    github: {
      isEnabled: () => true, getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 12, title: 't', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    limits: { async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: { buildHeadlessSeed: () => 'seed' },
    worker: {}, agentTurn: {}, activeWorkers: new Set(), sessionLifecycle: {},
  };
  const settings = { mode: 'shadow', liveApps: [], pausedApps: [], shadowBuilds: true, turnSeconds: 1200 };
  assert.equal(await bot.runQueuedBuild(pool, {}, {
    bot: BOT, claim: { id: 900, app_id: 9, issue_number: 12, build_note: 'x' }, settings, deps,
  }), 'shadow_built');
  const rec = queries.find((q) => /SET build_ok = \$2/.test(q.sql));
  assert.match(rec.sql, /build_spec_md = \$9/);
  assert.equal(rec.params[8], SPEC);
});

test('the spec turn is its own telemetry component, the run keeps the spec, and the dashboard shows it', () => {
  assert.match(read('src/services/llm-telemetry.js'), /'homeroom_bot_spec',/);
  assert.match(read('src/db/schema.sql'), /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_spec_md TEXT;/);
  assert.equal(bot.EXPORT_COLUMNS.at(-1), 'build_spec_md');
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const fn = tsx.slice(tsx.indexOf('function BuildSpec('), tsx.indexOf('function VerdictBody('));
  assert.match(fn, /<details className="text-sm" data-build-spec>/);
  assert.match(fn, /\{run\.build_spec_md\}/, 'plain text, as the rest of the table is');
  assert.doesNotMatch(fn, /dangerouslySetInnerHTML/);
  assert.match(tsx, /<BuildSpec run=\{run\} \/>/);
});
