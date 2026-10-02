'use strict';

// #3654: one benchmark TRIAL: a task's snapshot, through one stage of the
// Homeroom bot, on one candidate model, with nothing leaving the benchmark.
//
// What it reuses, so a trial measures the bot and not a copy of it:
//   * the real prompt builders and parsers: homeroom-bot triagePromptFor /
//     parseVerdict, homeroom-bot-live draftSpec / buildAndPropose /
//     buildPrompt, homeroom-bot-followup followUpPrompt / checksFixPrompt /
//     parseFollowUp / headMoved;
//   * the same worker and OpenRouter path (sessions.runCodexAttemptLoop with
//     agent-turn resolveCodexRuntimeContext), the same codex harness, the
//     same reasoning effort and the same wall clocks the bot's own turns get,
//     whatever the model;
//   * a session per trial, stamped with the trial's model, so the model that
//     ran is the model the turn resolved (and agent_turns says so).
//
// What it may NOT do, and how that is made structural rather than polite:
//   * post, comment, DM, notify, open a pull request or a proposal. The
//     trial never calls live.post, live.postOnProposal, live.promoteAsBot or
//     anything in homeroom-bot-dm; buildAndPropose runs with propose:false,
//     no onSpec and no votes router; and the GitHub client a trial is handed
//     is guardedGithub's: reads, plus branches under `bench/` and nothing
//     else. Any other call throws BenchSideEffectError
//     (tests/bench-runner.test.js spies on all of them).
//   * spend the bot's money. Trials run as their own synthetic user,
//     `homeroom_bench`, with its own included key and weekly allowance, so a
//     benchmark can never take the live bot's budget, and its spend is
//     debited there.
//   * read anything newer than the task. Every turn starts on a branch of
//     its own, `bench/r<run>-t<trial>`, cut at the snapshot's base commit;
//     nothing pushes anywhere but that branch, and the branch is deleted
//     once nothing needs it (services/bench/lane.js).
//
// A trial's session is the bench user's and is archived when the trial
// ends; a restart in the middle is abandoned, never recovered into the
// dev-chat tail (server.js adoptOrphanWorker, isBenchSession).

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('../logger');
const snapshots = require('../homeroom-bot-snapshots');

const BENCH_USERNAME = 'homeroom_bench';
// The bench user's own weekly allowance: a backstop behind every run's cap
// (an admin can change it on the user in Admin > Limits).
const DEFAULT_BENCH_WEEKLY_CENTS = 10000;
const RAW_OUTPUT_CHARS = 20000;
const DIFF_CHARS = 60000;
const TELEMETRY = 'homeroom_bench';
// Said on every build trial with hidden checks, until they can run (see
// hiddenChecksUnavailable).
const HIDDEN_CHECKS_GAP = 'hidden checks are not run on benchmark branches yet: graded on the build signals and the judge';

class BenchSideEffectError extends Error {
  constructor(what) {
    super(`benchmark trials may not ${what}`);
    this.code = 'bench_side_effect';
  }
}

// ── The GitHub a trial may use ──────────────────────────────────────────

const GITHUB_READS = Object.freeze([
  'isEnabled', 'getBotUsername', 'getBranchSha', 'getFileContent', 'compareFiles', 'listChangedFiles',
  'getProposalDiff', 'fetchPublicIssue', 'fetchIssueComments', 'getPR', 'getCommitAt',
]);

function assertBenchBranch(branch) {
  if (typeof branch !== 'string' || !/^bench\/r\d+-t\d+$/.test(branch)) {
    throw new BenchSideEffectError(`touch the branch ${branch}`);
  }
}

/**
 * The GitHub client a trial is handed: the reads above, a branch made or
 * removed under `bench/`, and nothing else. Every other property is a
 * function that throws, so a comment, an issue, a pull request or a merge is
 * impossible rather than merely unused.
 */
function guardedGithub(github) {
  const allowed = {
    ensureBranchAtSha(owner, repo, branch, sha) {
      assertBenchBranch(branch);
      return github.ensureBranchAtSha(owner, repo, branch, sha);
    },
    deleteBenchBranch(owner, repo, branch) {
      assertBenchBranch(branch);
      return github.deleteBenchBranch(owner, repo, branch);
    },
  };
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (Object.prototype.hasOwnProperty.call(allowed, prop)) return allowed[prop];
      if (GITHUB_READS.includes(prop)) {
        return typeof github[prop] === 'function' ? (...args) => github[prop](...args) : undefined;
      }
      return () => { throw new BenchSideEffectError(`call github.${prop}`); };
    },
  });
}

// ── The bench user ───────────────────────────────────────────────────────

async function ensureBenchUser(pool, config = {}) {
  const { rows: found } = await pool.query(
    'SELECT id, username, is_synthetic, weekly_limit_cents FROM users WHERE username = $1', [BENCH_USERNAME],
  );
  let user = found[0] || null;
  if (user && user.is_synthetic !== true) throw new Error(`users row '${BENCH_USERNAME}' exists and is not synthetic`);
  if (!user) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      `INSERT INTO users (username, password, is_admin, can_create_apps, is_synthetic, weekly_limit_cents, daily_limit_cents)
       VALUES ($1, $2, FALSE, FALSE, TRUE, $3, $3)
       ON CONFLICT (username) DO NOTHING`,
      [BENCH_USERNAME, hash, DEFAULT_BENCH_WEEKLY_CENTS],
    );
    const { rows } = await pool.query(
      'SELECT id, username, is_synthetic, weekly_limit_cents FROM users WHERE username = $1', [BENCH_USERNAME],
    );
    user = rows[0];
    if (!user) throw new Error(`Could not create the ${BENCH_USERNAME} user`);
    log.info('bench', 'Benchmark user created', { userId: user.id });
  }
  try {
    const managedOpenRouter = require('../openrouter-managed-keys');
    await managedOpenRouter.ensureIncludedKey({ pool, userId: user.id, config, reason: 'homeroom_bench' });
  } catch (err) {
    log.warn('bench', 'Included key check failed', { err: err.message });
  }
  return user;
}

/** True for a session a benchmark trial owns (restart recovery abandons it). */
function isBenchSession(session) {
  return !!session && session.username === BENCH_USERNAME && session.user_is_synthetic === true;
}

// ── Sessions, branches and turns ────────────────────────────────────────

function branchFor(trial) {
  return `bench/r${Number(trial.run_id)}-t${Number(trial.id)}`;
}

/** Cut the trial's branch at `sha` (or main's tip when the snapshot has none). */
async function pinBranch(github, repo, branch, sha) {
  let base = sha;
  if (!base) base = await github.getBranchSha(repo.owner, repo.repo, 'main');
  await github.ensureBranchAtSha(repo.owner, repo.repo, branch, base);
  return base;
}

async function openSession(pool, config, { user, app, model, branch, title }) {
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                session_title, agent_backend, agent_provider, agent_model, agent_reasoning_effort)
     VALUES ($1, $2, $3, 'paused', FALSE, '{}', $4, 'codex_openrouter', 'openrouter', $5, $6)
     RETURNING *`,
    [app.id, user.id, branch, title, model, config.openrouterDefaultCodexReasoning || 'low'],
  );
  const session = rows[0];
  session.app_slug = app.slug;
  session.app_name = app.name;
  session.repo_url = app.repo_url;
  session.app_self_hosted = app.self_hosted;
  return session;
}

/**
 * One turn on a trial's session, the way the bot runs its own: a fresh
 * thread, the session's model stamped, the wall clock as the stop. Resolves
 * { routed, result, stopped, infra, costUsd, usage }; never throws.
 */
async function runTurn({ pool, config, user, session, repo, prompt, mode, model, budgetMs, deps, commitMsg = '' }) {
  const { worker, sessions, agentTurn, activeWorkers } = deps;
  let containerName;
  try {
    await worker.ensureWorkerImage();
    containerName = await worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName: session.branch_name, temporary: true, onProgress: () => {},
    });
  } catch (err) {
    return { routed: { error: `worker: ${err.message}` }, result: {}, stopped: false, infra: true, costUsd: null, usage: {} };
  }
  await pool.query(
    "UPDATE chat_sessions SET status = 'active', agent_thread_id = NULL, agent_model = $2, last_activity_at = NOW() WHERE id = $1",
    [session.id, model],
  );
  session.agent_thread_id = null;
  session.agent_model = model;
  activeWorkers.add(session.id);
  let stopped = false;
  let stopping = null;
  const timer = setTimeout(() => {
    stopped = true;
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch(() => {});
  }, budgetMs);
  if (typeof timer.unref === 'function') timer.unref();
  let pricing = null;
  let routed;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: user.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode,
      telemetryComponent: TELEMETRY,
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: user.id, model, resumeThreadId: null, config,
      }),
      dispatchOnce: (ctx) => {
        pricing = ctx?.pricingSnapshot || pricing;
        return worker.execInWorker(session.id, {
          mode, prompt, model, commitMsg, resumeSessionId: null, branchName: session.branch_name,
          ...(ctx || {}), telemetryComponent: TELEMETRY, onProgress: () => {},
        });
      },
      retryPredicate: () => null,
      sendStatus: async () => {},
      waitForStopped: async () => {},
      prepareRetry: async () => false,
      classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
      containerName,
    });
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    clearTimeout(timer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
    await pool.query(
      "UPDATE chat_sessions SET status = 'paused', last_activity_at = NOW() WHERE id = $1 AND status = 'active'",
      [session.id],
    ).catch(() => {});
  }
  const result = (routed && routed.result) || {};
  const bot = require('../homeroom-bot');
  const relay = bot.relaySpend(result.relayUsage, pricing, agentTurn);
  const ledger = Number.isFinite(routed?.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  return {
    routed, result, stopped, infra: false,
    costUsd: ledger ?? relay?.costUsd ?? null,
    usage: {
      inputTokens: Number.isFinite(result.inputTokens) ? result.inputTokens : (relay?.inputTokens ?? null),
      outputTokens: Number.isFinite(result.outputTokens) ? result.outputTokens : (relay?.outputTokens ?? null),
    },
  };
}

/** How a turn ended, before its answer is read: null when it produced one. */
function turnStatus(turn) {
  if (turn.infra) return { status: 'infra_fail', error: String(turn.routed?.error || 'worker unavailable') };
  if (turn.stopped) return { status: 'timeout', error: 'the turn ran past its time limit' };
  if (!turn.routed) return { status: 'infra_fail', error: 'the turn did not run' };
  if (turn.routed.error) {
    const code = String(turn.routed.error);
    const bot = require('../homeroom-bot');
    const infra = bot.INFRA_ERRORS.has(code) || bot.REFUSAL_ERRORS.has(code) || code.startsWith('dispatch:') || code.startsWith('worker:');
    return { status: infra ? 'infra_fail' : 'model_fail', error: code };
  }
  return null;
}

function rawOf(text) {
  const s = String(text || '');
  return s.length > RAW_OUTPUT_CHARS ? `${s.slice(0, RAW_OUTPUT_CHARS)}\n[truncated]` : s;
}

/** What the trial's own session spent, from the ledger: exact, failed attempts included. */
async function sessionUsage(pool, sessionId) {
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost,
            COUNT(estimated_cost_usd)::int AS priced,
            COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COUNT(*)::int AS turns,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT routed_model), NULL) AS routed_models
       FROM agent_turns WHERE session_id = $1`,
    [sessionId],
  );
  return rows[0] || null;
}

/** The files and diff a trial's branch made against its base. */
async function branchDiff(github, repo, base, branch) {
  try {
    const out = await github.compareFiles(repo.owner, repo.repo, `${base}...${branch}`, DIFF_CHARS);
    return { files: out.files, diff: out.diff, complete: out.complete, truncated: out.truncated };
  } catch (err) {
    log.warn('bench', 'Could not read a trial branch\'s diff', { branch, err: err.message });
    return null;
  }
}

/**
 * The hidden checks of a build task, run on its branch. Not available in
 * this change, and said so on every trial that has some (#3654): declared
 * checks run against a staging preview (services/visuals.js
 * captureForSession), which is bound to a proposal's session, writes its
 * verdict onto it, patches its pull request and can merge it; and the
 * in-loop runner (worker/usernode-run-checks) needs a build turn's INLOOP_*
 * environment, which only an agent turn is given. Either path run against a
 * bench branch would have to be made side-effect free first. Until then a
 * build trial is graded on its deterministic build signals (commits, the
 * diff-scope rule) and the judge, who sees the hidden checks with the diff.
 */
async function hiddenChecksUnavailable({ task }) {
  const hidden = Array.isArray(task?.reference?.hidden_checks) ? task.reference.hidden_checks : [];
  if (!hidden.length) return null;
  return { ran: false, total: hidden.length, reason: HIDDEN_CHECKS_GAP };
}

// ── The stages ──────────────────────────────────────────────────────────

async function triageStage(ctx) {
  const { pool, config, snapshot, model, user, app, repo, trial, deps, budgets, title } = ctx;
  const bot = require('../homeroom-bot');
  const seed = ctx.seedOverride || snapshot.texts.seed;
  if (!seed) return { status: 'infra_fail', error: 'the snapshot has no seed' };
  const prompt = bot.triagePromptFor({
    seed, issueNumber: snapshot.issueNumber, firstVersion: !!snapshot.extra?.firstVersion,
  });
  const branch = branchFor(trial);
  let base;
  try {
    base = ctx.baseSha || await pinBranch(deps.github, repo, branch, snapshot.baseSha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = ctx.session || await openSession(pool, config, { user, app, model, branch, title });
  ctx.onSession?.(session.id);
  const turn = await runTurn({
    pool, config, user, session, repo, prompt, mode: 'scout', model, budgetMs: budgets.turnMs, deps,
  });
  const out = {
    session_id: session.id, base_sha: base, build_branch: branch,
    cost_usd: turn.costUsd, input_tokens: turn.usage.inputTokens, output_tokens: turn.usage.outputTokens,
    raw_output: rawOf(turn.result.lastResultText),
  };
  const ended = turnStatus(turn);
  if (ended) return { ...out, ...ended, session };
  const parsed = bot.parseVerdict(turn.result.lastResultText);
  if (!parsed) return { ...out, status: 'model_fail', error: 'unparseable: no verdict block', session };
  return {
    ...out,
    session,
    status: 'ok',
    parsed: {
      verdict: parsed.verdict,
      question: parsed.question,
      questionDefault: parsed.questionDefault,
      questionAnswers: parsed.questionAnswers,
      buildNote: parsed.buildNote,
      reason: parsed.reason,
      assumptions: parsed.assumptions,
      demoted: parsed.demoted,
      // Whether today's triage prompt is the prompt the run read.
      promptMatchesSnapshot: snapshots.hashText(prompt) === snapshot.promptHash,
    },
  };
}

async function specStage(ctx) {
  const { pool, config, snapshot, model, user, app, repo, trial, deps, budgets, title } = ctx;
  const live = require('../homeroom-bot-live');
  const branch = branchFor(trial);
  let base;
  try {
    base = await pinBranch(deps.github, repo, branch, snapshot.baseSha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = await openSession(pool, config, { user, app, model, branch, title });
  ctx.onSession?.(session.id);
  let containerName;
  try {
    await deps.worker.ensureWorkerImage();
    containerName = await deps.worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName: branch, temporary: true, onProgress: () => {},
    });
  } catch (err) {
    return { session_id: session.id, base_sha: base, build_branch: branch, status: 'infra_fail', error: `worker: ${err.message}`, session };
  }
  const spec = await live.draftSpec({
    pool, config, bot: user, session, containerName, seed: snapshot.texts.seed,
    buildNote: snapshot.texts.build_note || '', turnBudgetMs: budgets.turnMs, model, specBudgetMs: budgets.specMs,
    deps: { worker: deps.worker, sessions: deps.sessions, agentTurn: deps.agentTurn, activeWorkers: deps.activeWorkers },
    telemetryComponent: TELEMETRY,
  });
  const out = { session_id: session.id, base_sha: base, build_branch: branch, cost_usd: spec.costUsd ?? null, session };
  if (spec.stopped) return { ...out, status: 'timeout', error: spec.error };
  if (spec.ok) return { ...out, status: 'ok', raw_output: rawOf(spec.specMd), parsed: { spec: spec.specMd } };
  if (spec.blocked) return { ...out, status: 'ok', parsed: { blocked: spec.blocked }, raw_output: rawOf(`BLOCKED: ${spec.blocked}`) };
  const m = String(spec.error || '').match(/failed \((.+)\)$/);
  const bot = require('../homeroom-bot');
  const infra = !!m && (bot.INFRA_ERRORS.has(m[1]) || m[1].startsWith('dispatch:'));
  return { ...out, status: infra ? 'infra_fail' : 'model_fail', error: spec.error || 'no spec' };
}

async function buildStage(ctx) {
  const { pool, config, snapshot, model, user, app, repo, trial, task, deps, budgets, title } = ctx;
  const live = require('../homeroom-bot-live');
  const bot = require('../homeroom-bot');
  const branch = branchFor(trial);
  let base = snapshot.baseSha || null;
  let sessionId = null;
  // The build's session gets its branch here instead of from
  // session-lifecycle, which would cut a dev/ branch from main's tip: the
  // trial's branch is cut at the snapshot's base commit.
  const sessionLifecycle = {
    async ensureSessionBranch({ sessionId: id }) {
      base = await pinBranch(deps.github, repo, branch, base);
      await pool.query('UPDATE chat_sessions SET branch_name = $2 WHERE id = $1', [id, branch]);
      return { branchName: branch, created: true };
    },
  };
  const built = await live.buildAndPropose({
    pool, config, bot: user, app, repo, issueNumber: snapshot.issueNumber,
    issue: { title: snapshot.thread?.issue?.title || `Issue #${snapshot.issueNumber}` },
    seed: snapshot.texts.seed, buildNote: snapshot.texts.build_note || '',
    turnBudgetMs: budgets.buildMs, specBudgetMs: budgets.specMs, model,
    deps: {
      worker: deps.worker, sessions: deps.sessions, agentTurn: deps.agentTurn,
      activeWorkers: deps.activeWorkers, sessionLifecycle,
    },
    // Never proposed, never posted: no onSpec, no ceiling, no votes router.
    propose: false,
    onSpec: null,
    proposalCeiling: null,
    platformRepo: !!snapshot.extra?.platformRepo,
    sessionTitle: title,
    telemetry: TELEMETRY,
    onSession: (s) => { sessionId = s.id; ctx.onSession?.(s.id); },
  });
  const out = {
    session_id: built.sessionId || sessionId, base_sha: base, build_branch: branch,
    cost_usd: built.costUsd ?? null, build_sha: built.sha || null,
    build_commits: Number.isFinite(built.commits) ? built.commits : null,
  };
  const parsed = { built: !!built.ok, spec: built.specMd || null, specNote: built.specNote || null };
  if (built.blocked) return { ...out, status: 'ok', parsed: { ...parsed, blocked: built.blocked }, raw_output: rawOf(`BLOCKED: ${built.blocked}`) };
  if (!built.ok) {
    const error = String(built.error || 'unknown');
    if (/ran past its time limit/.test(error)) return { ...out, status: 'timeout', error, parsed };
    if (bot.isInfraBuildError(error)) return { ...out, status: 'infra_fail', error, parsed };
    return { ...out, status: 'model_fail', error, parsed };
  }
  const compared = await branchDiff(deps.github, repo, base, branch);
  const checks = await (deps.runHiddenChecks || hiddenChecksUnavailable)({ task, trial, repo, branch, base });
  return {
    ...out,
    status: 'ok',
    parsed,
    raw_output: rawOf(built.specMd || ''),
    diff: compared ? compared.diff : null,
    changed_files: compared ? { files: compared.files, complete: compared.complete, truncated: compared.truncated } : null,
    checks,
  };
}

async function followupStage(ctx, kind) {
  const { pool, config, snapshot, model, user, app, repo, trial, deps, budgets, title } = ctx;
  const followup = require('../homeroom-bot-followup');
  const seed = snapshot.texts.seed;
  if (!seed || !snapshot.baseSha) return { status: 'infra_fail', error: 'the snapshot has no seed or no proposal head' };
  const prNumber = snapshot.extra?.prNumber || null;
  let prompt;
  let mode;
  if (kind === 'checks_fix') {
    let failing = [];
    try { failing = JSON.parse(snapshot.texts.failing || '[]'); } catch { failing = []; }
    prompt = followup.checksFixPrompt({
      seed, proposalBlock: snapshot.texts.proposal_block || '', prNumber, failing, total: snapshot.extra?.total || failing.length,
    });
    mode = 'build';
  } else {
    let replies = [];
    try { replies = JSON.parse(snapshot.texts.replies || '[]'); } catch { replies = []; }
    const canRevise = snapshot.extra?.canRevise !== false;
    prompt = followup.followUpPrompt({ seed, proposalBlock: snapshot.texts.proposal_block || '', prNumber, replies, canRevise });
    mode = canRevise ? 'build' : 'scout';
  }
  const branch = branchFor(trial);
  let base;
  try {
    base = await pinBranch(deps.github, repo, branch, snapshot.baseSha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = await openSession(pool, config, { user, app, model, branch, title });
  ctx.onSession?.(session.id);
  const turn = await runTurn({
    pool, config, user, session, repo, prompt, mode, model, budgetMs: budgets.turnMs, deps,
    commitMsg: `Homeroom benchmark: trial ${trial.id}`,
  });
  const out = {
    session_id: session.id, base_sha: base, build_branch: branch, session,
    cost_usd: turn.costUsd, input_tokens: turn.usage.inputTokens, output_tokens: turn.usage.outputTokens,
    raw_output: rawOf(turn.result.lastResultText),
  };
  const ended = turnStatus(turn);
  if (ended) return { ...out, ...ended };
  const parsed = followup.parseFollowUp(turn.result.lastResultText);
  const moved = followup.headMoved({ mode, result: turn.result, reviewedHeadSha: base, action: parsed?.action });
  if (!parsed && !moved) return { ...out, status: 'model_fail', error: 'unparseable: no action block' };
  const compared = moved ? await branchDiff(deps.github, repo, base, branch) : null;
  return {
    ...out,
    status: 'ok',
    build_sha: moved ? turn.result.sha : null,
    build_commits: moved ? (Number(turn.result.ahead) || null) : null,
    parsed: {
      action: moved ? 'revise' : parsed.action,
      reply: parsed?.reply || null,
      answers: parsed?.answers || null,
      summary: parsed?.summary || null,
      moved: !!moved,
    },
    diff: compared ? compared.diff : null,
    changed_files: compared ? { files: compared.files, complete: compared.complete, truncated: compared.truncated } : null,
  };
}

const STAGE_RUNNERS = Object.freeze({
  triage: triageStage,
  spec: specStage,
  build: buildStage,
  followup: (ctx) => followupStage(ctx, 'followup'),
  checks_fix: (ctx) => followupStage(ctx, 'checks_fix'),
  // A DM task is a conversation of triage turns (services/bench/dm-sim.js).
  dm: (ctx) => require('./dm-sim').dmStage(ctx),
});

/**
 * Run one stage of one task on one model, with nothing leaving the
 * benchmark. Resolves the trial's patch: its status, what it said, what it
 * cost, and (for a build) its branch and diff. Never throws: a refused side
 * effect or anything unexpected is an infra failure with its reason.
 */
async function runStage(ctx) {
  const runner = STAGE_RUNNERS[ctx.stage];
  if (!runner) return { status: 'not_applicable', error: `no runner for ${ctx.stage}` };
  const startedMs = Date.now();
  let out;
  try {
    out = await runner(ctx);
  } catch (err) {
    log.warn('bench', 'A trial threw', { trialId: ctx.trial?.id, stage: ctx.stage, err: err.message });
    out = { status: 'infra_fail', error: `${err.code === 'bench_side_effect' ? 'refused: ' : 'threw: '}${err.message}` };
  }
  return { ...out, duration_ms: Date.now() - startedMs };
}

/** The clocks a trial gets: the bot's own, from its settings and the app. */
function budgetsFor(settings, app, config, stage) {
  const bot = require('../homeroom-bot');
  const turnMs = 1000 * (Number(settings?.turnSeconds) || bot.DEFAULTS.turnSeconds);
  const built = bot.buildBudgets(app, config, turnMs);
  return { turnMs: stage === 'build' || stage === 'spec' ? built.turnBudgetMs : turnMs, buildMs: built.turnBudgetMs, specMs: built.specBudgetMs };
}

module.exports = {
  BENCH_USERNAME,
  DEFAULT_BENCH_WEEKLY_CENTS,
  RAW_OUTPUT_CHARS,
  DIFF_CHARS,
  TELEMETRY,
  HIDDEN_CHECKS_GAP,
  GITHUB_READS,
  BenchSideEffectError,
  guardedGithub,
  assertBenchBranch,
  ensureBenchUser,
  isBenchSession,
  branchFor,
  pinBranch,
  openSession,
  runTurn,
  turnStatus,
  sessionUsage,
  branchDiff,
  hiddenChecksUnavailable,
  runStage,
  budgetsFor,
  STAGE_RUNNERS,
  triageStage,
};
