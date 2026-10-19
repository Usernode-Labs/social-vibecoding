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
//     agent-turn resolveCodexRuntimeContext), the same harness (the
//     platform's per-model choice of CLI, 'auto', as the bot's own turns
//     ask for it), the same reasoning effort and the same wall clocks the
//     bot's own turns get, whatever the model;
//   * a session per trial, stamped with the trial's model, so the model that
//     ran is the model the turn resolved (and agent_turns says so).
//
// What it may NOT do, and how that is made structural rather than polite:
//   * post, comment, DM, notify, open a pull request or a proposal. The
//     trial never calls live.post, live.postOnProposal, live.promoteAsBot or
//     anything in homeroom-bot-dm; buildAndPropose runs with propose:false,
//     no votes router, and no onSpec but a first version's, which keeps the
//     spec on its own trial and nothing more; and the GitHub client a trial
//     is handed is guardedGithub's: reads, plus branches under `bench/` and
//     nothing else. Any other call throws BenchSideEffectError
//     (tests/bench-runner.test.js spies on all of them).
//   * spend the bot's money. Trials run as their own synthetic user,
//     `homeroom_bench`, with its own included key and weekly allowance, so a
//     benchmark can never take the live bot's budget, and its spend is
//     debited there.
//   * read anything newer than the task. Every turn starts on a branch of
//     its own, `bench/r<run>-t<trial>`, cut at the snapshot's base commit;
//     nothing pushes anywhere but that branch, and the branch is deleted
//     once nothing needs it (services/bench/lane.js). The branch alone was
//     not enough: the worker cloned today's main beside it, so a model could
//     read the later fix in `git log origin/main`. Every worker a trial
//     starts is now SEALED at that base (sealedWorker): its checkout holds
//     the session branch alone, main and origin/main are the base, and
//     origin has no fetch URL (worker/session-branch.sh). Its turns get no
//     read-only Homeroom tools and an empty usernode-issues, which read the
//     platform and GitHub as they are now (worker.js mintHomeroomReadGrant,
//     routes/internal.js).
//
// A trial's session is the bench user's and is archived when the trial
// ends. A trial runs as a durable build (services/build-runs.js, lane.js
// runTrial): each part of its stage below is a durable step, kept as it ends
// (services/durable-steps.js), so a restart's next attempt carries the trial
// on from the last part it finished, follows a turn the restart caught
// (services/durable-turn.js), and never cuts its branch again. Its sessions
// carry the build that owns them (chat_sessions.workflow_owner), which
// restart recovery in server.js leaves them to. A trial that ran with no
// workflow runtime is never recovered into the dev-chat tail either
// (server.js adoptOrphanWorker, isBenchSession): its turn is abandoned and
// the trial run again from the start (services/bench/lane.js).

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('../logger');
const snapshots = require('../homeroom-bot-snapshots');
const stageCosts = require('../stage-costs');
const durableSteps = require('../durable-steps');
const durableTurn = require('../durable-turn');
const sharedPlans = require('./shared-plans');

const BENCH_USERNAME = 'homeroom_bench';
// The bench user's own weekly allowance: a backstop behind every run's cap
// (an admin can change it on the user in Admin > Limits). Its included
// OpenRouter key carries the same weekly limit. $500: $100 ran out partway
// through a run (14 Oct 2026); src/db/schema.sql raised the existing account.
const DEFAULT_BENCH_WEEKLY_CENTS = 50000;
const RAW_OUTPUT_CHARS = 20000;
// A trial's diff as stored, which a judge reads a part at a time (grading.js
// diffParts): ten parts. At 60,000 compareFiles dropped every file after the
// one that would not fit, and run 208's largest builds lost the very tests
// they had edited (testEdits found no hunk for them).
const DIFF_CHARS = 400000;
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
  'compareRefs', 'getProposalDiff', 'fetchPublicIssue', 'fetchIssueComments', 'getPR', 'getCommitAt',
]);

// A trial's own branch, `bench/r<run>-t<trial>`, or the first commit a
// run's first versions share, `bench/r<run>-s<id>` (services/bench/scaffold.js).
function assertBenchBranch(branch) {
  if (typeof branch !== 'string' || !/^bench\/r\d+-[ts]\d+$/.test(branch)) {
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
    // #3737: a first-version trial's starting point, a commit with no
    // history holding the rendered starter, and the trial's branch pointed
    // at it (any earlier attempt's branch of the same trial removed first).
    // Resolves the commit's sha.
    async createBenchScaffold(owner, repo, branch, files, message) {
      assertBenchBranch(branch);
      const sha = await github.createRootCommit(owner, repo, files, { message });
      await github.deleteBenchBranch(owner, repo, branch);
      await github.ensureBranchAtSha(owner, repo, branch, sha);
      return sha;
    },
    // A first version's review put back on the last commit that booted
    // (homeroom-bot-live.js rollbackReviewBranch): the trial's own branch.
    resetBenchBranch(owner, repo, branch, sha) {
      assertBenchBranch(branch);
      return github.forceBranchToSha(owner, repo, branch, sha);
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

/**
 * Whether restart recovery must see to a benchmark session's worker: an
 * active session's, or a paused one's with a turn in flight (a build's nudge
 * and a review's fix turns run on a session its build turn left paused, as
 * the live bot's do). A trial that is a durable build owns its sessions, and
 * server.js leaves them to the build; this is for one that is not, whose
 * turn is abandoned and the trial put back in the queue (server.js
 * abandonOrphanBenchTurn). Until 13 Oct 2026 server.js destroyed such a
 * worker in silence, its turn record left, and the trial sat running until
 * the watchdog or releaseStale gave it back. Pure.
 */
function isRecoveredBenchSession(session) {
  return isBenchSession(session)
    && (session.status === 'active' || (session.status === 'paused' && !!session.active_turn));
}

// ── Sessions, branches and turns ────────────────────────────────────────
//
// Each part a stage runs is a durable step (above): the branch is cut once
// and never pinned again, so a turn that pushed after the last step was
// saved keeps its commits (bench run 193 pinned a branch back to the build
// its checkpoint named, under the review fix that landed after it); each
// session is opened once and read back; each turn is attached to or started.
// Outside a durable build (a test, no workflow runtime) every step runs.

/** The durable steps a trial's stage runs on (ctx.deps.durable), or the inert ones. */
function stepsOf(ctx) {
  return durableSteps.of(ctx?.deps);
}
/**
 * The worker a trial is handed: the real one, except that every worker it
 * starts is sealed at the trial's base commit (worker.ensureWorker's
 * pinnedBase; worker/session-branch.sh), so the checkout reaches nothing
 * later. `getBase` is the base the stage put on the trial before starting a
 * worker (runStage reads it from onSession); with none, the worker is
 * refused rather than started unsealed.
 */
function sealedWorker(worker, getBase) {
  return new Proxy(worker, {
    get(target, prop) {
      if (prop === 'ensureWorker') {
        return async (sessionId, opts = {}) => {
          const base = getBase();
          if (!base) throw new BenchSideEffectError('start a worker before its base commit is pinned');
          return target.ensureWorker(sessionId, { ...opts, pinnedBase: base });
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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

/**
 * The trial's branch, cut at `sha` once (main's tip when there is none): a
 * later attempt of the same trial takes the base it was cut at and leaves
 * the branch where the trial's turns left it. `fresh` removes an earlier
 * claim's branch of the same trial first, for a stage whose turns push to it
 * (github.ensureBranchAtSha refuses a branch at any other commit). The base
 * pins the trial's workers before any starts (runStage). Resolves
 * { base, branch } or { error, branch }.
 */
async function cutBranch(ctx, sha, { fresh = false } = {}) {
  const { deps, repo, trial } = ctx;
  const branch = branchFor(trial);
  const cut = await stepsOf(ctx).once('branch', async () => {
    try {
      if (fresh) await deps.github.deleteBenchBranch(repo.owner, repo.repo, branch);
      return { base: await pinBranch(deps.github, repo, branch, sha) };
    } catch (err) {
      durableSteps.rethrowStop(err, 'branch');
      return { error: err.message };
    }
  });
  if (cut?.error || !cut?.base) return { error: cut?.error || 'no base commit', branch };
  ctx.pinBase?.(cut.base);
  return { base: cut.base, branch };
}

/** A session row with the app fields a turn reads off it. */
function withApp(session, app) {
  session.app_slug = app.slug;
  session.app_name = app.name;
  session.repo_url = app.repo_url;
  session.app_self_hosted = app.self_hosted;
  return session;
}

async function openSession(pool, config, { user, app, model, branch, title, owner = null, step = null }) {
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                session_title, agent_backend, agent_provider, agent_model, agent_reasoning_effort,
                                workflow_owner, workflow_step)
     VALUES ($1, $2, $3, 'paused', FALSE, '{}', $4, 'codex_openrouter', 'openrouter', $5, $6, $7, $8)
     RETURNING *`,
    [app.id, user.id, branch, title, model, config.openrouterDefaultCodexReasoning || 'low', owner, owner ? step : null],
  );
  return withApp(rows[0], app);
}

/**
 * The session of a trial's part `key` ('triage', 'spec', …), opened once and
 * read back on a later attempt, so a restart finds the worker (and any turn
 * under way in it) and the ledger the trial already has. It carries the
 * build that owns it, which restart recovery in server.js leaves it to. On
 * the trial (ctx.onSession) before any turn runs, on every attempt: its base
 * pins the trial's workers (runStage).
 */
async function trialSession(ctx, key, { model, branch, base }) {
  const { pool, config, user, app } = ctx;
  const steps = stepsOf(ctx);
  let session = null;
  const kept = await steps.once(`session:${key}`, async () => {
    // A restart between the insert and this step's save finds the row.
    const step = steps.path(`session:${key}`);
    if (steps.owner) {
      const { rows: [mine] } = await pool.query(
        'SELECT * FROM chat_sessions WHERE workflow_owner = $1 AND workflow_step = $2 ORDER BY id LIMIT 1', [steps.owner, step],
      );
      if (mine) {
        session = withApp(mine, app);
        return { id: Number(mine.id) };
      }
    }
    session = await openSession(pool, config, { user, app, model, branch, title: ctx.title, owner: steps.owner, step });
    return { id: Number(session.id) };
  });
  if (!session) {
    const { rows: [row] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [Number(kept?.id)]);
    if (!row) throw new Error(`the trial's ${key} session is gone`);
    session = withApp(row, app);
  }
  await ctx.onSession?.(session.id, { baseSha: base, branch });
  return session;
}

/**
 * The worker of a trial's session: after a restart, the one still running
 * (and any turn in it), else one started, sealed at the trial's base as
 * every worker of the trial is (sealedWorker). Resolves its name.
 */
function trialWorker(ctx, session, branch) {
  return require('../homeroom-bot-live').ensureBuildWorker({
    worker: ctx.deps.worker, session, repo: ctx.repo, branchName: branch, steps: stepsOf(ctx),
  });
}

/**
 * One turn on a trial's session, the way the bot runs its own: a fresh
 * thread, the session's model stamped, the wall clock as the stop. `prompt`
 * is the text, or a function of the runtime the turn resolved for a prompt
 * that depends on it (the triage's, whose design self-check follows what the
 * model can see). `key` names the turn as a durable step of `steps`
 * (services/durable-turn.js): a restart's next attempt follows the turn it
 * caught or takes the result it kept, and a turn that commits and lost its
 * record is read off its branch. Resolves { routed, result, stopped, infra,
 * costUsd, usage, prompt }, `prompt` being what was sent; throws only a stop.
 */
async function runTurn({
  pool, config, user, session, repo, prompt, mode, model, budgetMs, deps, commitMsg = '', onActivity = null,
  key = 'turn', steps = durableSteps.none(),
}) {
  const { worker, sessions, agentTurn } = deps;
  let containerName;
  try {
    containerName = await require('../homeroom-bot-live').ensureBuildWorker({
      worker, session, repo, branchName: session.branch_name, steps,
    });
  } catch (err) {
    durableSteps.rethrowStop(err, 'worker');
    return { routed: { error: `worker: ${err.message}` }, result: {}, stopped: false, infra: true, costUsd: null, usage: {} };
  }
  // The trial's session takes its slot for the turn (the proposal machine;
  // never a closed one: bug 21).
  await require('../session-lifecycle').takeSlot({ pool, sessionId: session.id, source: 'bench' });
  await pool.query('UPDATE chat_sessions SET agent_thread_id = NULL, agent_model = $2 WHERE id = $1', [session.id, model]);
  session.agent_thread_id = null;
  session.agent_model = model;
  let pricing = null;
  // A prompt rendered for the runtime is kept as it was sent, so a turn a
  // restart caught is read against the prompt it had.
  const promptKey = `prompt:${key}`;
  let sent = typeof prompt === 'function' ? (steps.get(promptKey) ?? null) : prompt;
  // A studio trial's watch (services/bench/progress.js); nothing else.
  const onProgress = typeof onActivity === 'function'
    ? (line) => { try { onActivity(line); } catch { /* a watcher never stops a turn */ } }
    : () => {};
  const dispatch = (extra = {}) => sessions.runCodexAttemptLoop({
    pool, session, userId: user.id, config, isCodexSession: true,
    turnModel: model, resumeThreadId: null, mode,
    telemetryComponent: TELEMETRY,
    // The trial's build item (its steps', durable-turn hands it on).
    owner: extra.owner || null,
    resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
      pool, session, userId: user.id, model, resumeThreadId: null, config,
      // As the bot's own turns ask for it (#3296).
      harness: 'auto',
    }),
    dispatchOnce: async (ctx) => {
      pricing = ctx?.pricingSnapshot || pricing;
      sent = typeof prompt === 'function' ? prompt(ctx) : prompt;
      if (typeof prompt === 'function') await steps.set(promptKey, sent);
      return worker.execInWorker(session.id, {
        mode, prompt: sent, model, commitMsg, resumeSessionId: null, branchName: session.branch_name,
        // As the bot's follow-up asks: a failed turn's work is not kept.
        discardFailedTurn: true,
        ...(ctx || {}), ...extra, telemetryComponent: TELEMETRY, onProgress,
      });
    },
    retryPredicate: () => null,
    sendStatus: async () => {},
    waitForStopped: async () => {},
    prepareRetry: async () => false,
    classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
    containerName,
  });
  // A turn that commits (a follow-up's revision) and lost its record before
  // its end was kept: the branch tip is its result, since the worker pushes a
  // turn's work only when the turn succeeded (discardFailedTurn).
  const head = mode === 'build' && deps.github
    ? () => deps.github.getBranchSha(repo.owner, repo.repo, session.branch_name)
    : null;
  const observe = head
    ? async ({ tip }) => ({ result: { pushOk: true, sha: tip, ahead: 1, lastResultText: '', observed: true }, estimatedCostUsd: null })
    : null;
  let ran;
  try {
    ran = await durableTurn.runTurn(steps, key, {
      pool, session, mode, budgetMs, dispatch, head, observe, onProgress,
      stop: () => durableTurn.clockStop(worker, pool, session.id, steps.turnOwner),
      deps: { worker, agentTurn },
    });
  } finally {
    // A stop leaves the session as it is: its turn is the trial's next owner's.
    if (!steps.stopped) {
      await require('../session-lifecycle').restSession({ pool, sessionId: session.id }).catch(() => {});
    }
  }
  const routed = ran.routed;
  const result = (routed && routed.result) || {};
  const bot = require('../homeroom-bot');
  const relay = bot.relaySpend(result.relayUsage, pricing, agentTurn);
  const ledger = Number.isFinite(routed?.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  return {
    routed, result, stopped: !!ran.stopped, infra: false, prompt: sent,
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

/** What a turn left behind that every stage records, whatever it said. */
function turnFields(turn) {
  return {
    cost_usd: turn.costUsd, input_tokens: turn.usage.inputTokens, output_tokens: turn.usage.outputTokens,
    raw_output: rawOf(turn.result.lastResultText),
  };
}

function triagePrompt(snapshot, seed, readsImages = false, guidance = null) {
  const bot = require('../homeroom-bot');
  return bot.triagePromptFor({
    seed, issueNumber: snapshot.issueNumber, firstVersion: !!snapshot.extra?.firstVersion, readsImages,
    // #3772: who decided on the project when the original look ran.
    decider: snapshot.extra?.decider || null,
    // A first version's people when the original look ran (membersNote).
    members: snapshot.extra?.members || null,
    // The game starter its first version builds on (firstVersionNote).
    starter: snapshot.extra?.starter || null,
    // A studio trial's context pack (services/bench/packs.js).
    guidance,
  });
}

/**
 * A triage turn's patch, read from how it ended. Shared by a triage trial,
 * a first version's triage and each turn of a DM conversation.
 */
function triageResult({ turn, out, prompt, snapshot }) {
  const bot = require('../homeroom-bot');
  const ended = turnStatus(turn);
  if (ended) return { ...out, ...ended };
  const parsed = bot.parseVerdict(turn.result.lastResultText);
  if (!parsed) return { ...out, status: 'model_fail', error: 'unparseable: no verdict block' };
  return {
    ...out,
    status: 'ok',
    parsed: {
      verdict: parsed.verdict,
      question: parsed.question,
      questionDefault: parsed.questionDefault,
      questionAnswers: parsed.questionAnswers,
      // B6: a first version's plan, or a second question.
      plan: parsed.plan || null,
      buildNote: parsed.buildNote,
      reason: parsed.reason,
      assumptions: parsed.assumptions,
      demoted: parsed.demoted,
      // Whether today's triage prompt is the prompt the run read.
      promptMatchesSnapshot: snapshots.hashText(prompt) === snapshot.promptHash,
    },
  };
}

/**
 * A triage trial, a first version's triage, or one turn of a DM
 * conversation (`seedOverride`, on the conversation's `session`, its turn
 * named by `turnKey`). `baseSha` is a branch its caller cut already.
 */
async function triageStage(ctx) {
  const { pool, config, snapshot, model, user, repo, trial, deps, budgets } = ctx;
  const seed = ctx.seedOverride || snapshot.texts.seed;
  if (!seed) return { status: 'infra_fail', error: 'the snapshot has no seed' };
  const branch = branchFor(trial);
  let base = ctx.baseSha || null;
  if (!base) {
    const cut = await cutBranch(ctx, snapshot.baseSha);
    if (cut.error) return { status: 'infra_fail', error: `branch: ${cut.error}` };
    base = cut.base;
  }
  const session = ctx.session || await trialSession(ctx, 'triage', { model, branch, base });
  // Rendered at dispatch for what the trial's model can see, as the bot's
  // own triage is (homeroom-bot.js runTriage).
  const guidance = ctx.guidance?.triage || null;
  const turn = await runTurn({
    pool, config, user, session, repo, mode: 'scout', model, budgetMs: budgets.turnMs, deps, onActivity: ctx.onActivity,
    prompt: (runtime) => triagePrompt(snapshot, seed, require('../prompts').runtimeReadsImages(runtime), guidance),
    key: ctx.turnKey || 'triage', steps: stepsOf(ctx),
  });
  const out = { session_id: session.id, base_sha: base, build_branch: branch, ...turnFields(turn), session };
  return triageResult({ turn, out, prompt: turn.prompt || triagePrompt(snapshot, seed, false, guidance), snapshot });
}

async function specStage(ctx) {
  const { pool, config, snapshot, model, user, deps, budgets } = ctx;
  const live = require('../homeroom-bot-live');
  const cut = await cutBranch(ctx, snapshot.baseSha);
  if (cut.error) return { status: 'infra_fail', error: `branch: ${cut.error}` };
  const { base, branch } = cut;
  const session = await trialSession(ctx, 'spec', { model, branch, base });
  let containerName;
  try {
    containerName = await trialWorker(ctx, session, branch);
  } catch (err) {
    durableSteps.rethrowStop(err, 'worker');
    return { session_id: session.id, base_sha: base, build_branch: branch, status: 'infra_fail', error: `worker: ${err.message}`, session };
  }
  // A step: run again after a restart, the plan is not read (or published)
  // a second time.
  const spec = await stepsOf(ctx).once('spec', () => live.draftSpec({
    pool, config, bot: user, session, containerName, seed: snapshot.texts.seed,
    buildNote: snapshot.texts.build_note || '', turnBudgetMs: budgets.turnMs, model, specBudgetMs: budgets.specMs,
    // Its turn a durable step (draftSpec's `spec` turn).
    deps: {
      worker: deps.worker, sessions: deps.sessions, agentTurn: deps.agentTurn, activeWorkers: deps.activeWorkers,
      durable: stepsOf(ctx),
    },
    telemetryComponent: TELEMETRY,
    // #3737: a first version's spec decides its look, as the live one does.
    firstVersion: !!snapshot.extra?.firstVersion,
  }));
  const out = { session_id: session.id, base_sha: base, build_branch: branch, cost_usd: spec.costUsd ?? null, session };
  if (spec.stopped) return { ...out, status: 'timeout', error: spec.error };
  if (spec.ok) return { ...out, status: 'ok', raw_output: rawOf(spec.specMd), parsed: { spec: spec.specMd } };
  if (spec.blocked) return { ...out, status: 'ok', parsed: { blocked: spec.blocked }, raw_output: rawOf(`BLOCKED: ${spec.blocked}`) };
  const m = String(spec.error || '').match(/failed \((.+)\)$/);
  const bot = require('../homeroom-bot');
  const infra = !!m && (bot.INFRA_ERRORS.has(m[1]) || m[1].startsWith('dispatch:'));
  return { ...out, status: infra ? 'infra_fail' : 'model_fail', error: spec.error || 'no spec' };
}

/**
 * A build's patch, from what buildAndPropose returned: its status, and for
 * a build that landed, the diff from the base and the hidden checks.
 */
async function buildResult({ built, base, branch, sessionId = null, deps, repo, task, trial }) {
  const bot = require('../homeroom-bot');
  const out = {
    session_id: built.sessionId || sessionId, base_sha: base, build_branch: branch,
    cost_usd: built.costUsd ?? null, build_sha: built.sha || null,
    build_commits: Number.isFinite(built.commits) ? built.commits : null,
  };
  const parsed = {
    built: !!built.ok, spec: built.specMd || null, specNote: built.specNote || null,
    // How much its drawn screens hold (spec-html.js screenStats), and what
    // each stage cost on its model (services/stage-costs.js).
    ...(Array.isArray(built.specScreens) && built.specScreens.length ? { specScreens: built.specScreens } : {}),
    ...(built.stageCosts ? { costParts: stageCosts.fromStages(built.stageCosts) } : {}),
    // A build turn that changed nothing: what it said and did, and its nudge
    // (homeroom-bot-live.js buildNudgePrompt), as a live run keeps it.
    ...(built.noChange ? { noChange: built.noChange } : {}),
  };
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

/**
 * A build's spec and build turns (buildAndPropose, never proposed), and for
 * a configuration with a reviewer its review. The build runs on the trial's
 * durable steps (its own scope of them), so a restart carries it on from the
 * last step it saved, as a live build is carried on: a spec it wrote is not
 * written again, a turn the restart caught is followed, and a review goes on
 * from its saved state (homeroom-bot-live.js reviewLanded).
 */
async function buildStage(ctx) {
  const { pool, config, snapshot, model, user, app, repo, trial, task, deps, budgets, title } = ctx;
  const live = require('../homeroom-bot-live');
  const steps = stepsOf(ctx);
  const branch = branchFor(trial);
  // The commit it builds from, read once (main's tip when the snapshot names
  // none), and the base the trial's workers are sealed at.
  const based = await steps.once('base', async () => ({
    sha: snapshot.baseSha || await deps.github.getBranchSha(repo.owner, repo.repo, 'main'),
  }));
  const base = based.sha;
  ctx.pinBase?.(base);
  let sessionId = null;
  // The build's session gets its branch here instead of from
  // session-lifecycle, which would cut a dev/ branch from main's tip: the
  // trial's branch is cut at the base, once (buildAndPropose's `branch`
  // step), an earlier claim's branch of the same trial removed first.
  const sessionLifecycle = {
    async ensureSessionBranch({ sessionId: id }) {
      await deps.github.deleteBenchBranch(repo.owner, repo.repo, branch);
      await pinBranch(deps.github, repo, branch, base);
      await pool.query('UPDATE chat_sessions SET branch_name = $2 WHERE id = $1', [id, branch]);
      await ctx.onSession?.(id, { baseSha: base, branch });
      return { branchName: branch, created: true };
    },
  };
  // Whether the build could look at its own screens, recorded on the trial
  // (`parsed.sight`): `told` is what its prompt said (the design self-check
  // asks for screenshots or for the page's text snapshot), decided here the
  // way buildAndPropose decides it and handed to it, so the two cannot
  // differ; `passed` is what the runtime of its turns said the model takes
  // in, which is what makes the worker hand it an image or a note in its
  // place (AGENT_MODEL_SUPPORTS_IMAGES). The lane adds the looks it took.
  // Both are kept as steps: a turn a restart caught is followed, and resolves
  // no runtime.
  const told = await steps.once('sight_told', () => live.buildSeesImages({ pool, config, userId: user.id, model }));
  const sight = { told, passed: steps.get('sight_passed') ?? null };
  const agentTurn = observedRuntime(deps.agentTurn, async (runtime) => {
    const takesImages = runtime?.agentModelMetadata?.supportsImages;
    if (typeof takesImages !== 'boolean') return;
    sight.passed = takesImages;
    await steps.set('sight_passed', takesImages);
  });
  const built = await live.buildAndPropose({
    pool, config, bot: user, app, repo, issueNumber: snapshot.issueNumber,
    issue: { title: snapshot.thread?.issue?.title || `Issue #${snapshot.issueNumber}` },
    seed: snapshot.texts.seed, buildNote: snapshot.texts.build_note || '',
    turnBudgetMs: budgets.buildMs, specBudgetMs: budgets.specMs, model,
    deps: {
      worker: deps.worker, sessions: deps.sessions, agentTurn,
      activeWorkers: deps.activeWorkers, sessionLifecycle, seesImages: sight.told,
      // Its reads only: whether a later build's repository has the
      // frontend-design skill, as a live build asks (services/design-skill.js).
      github: deps.github,
      // The build's own steps, apart from the stage's.
      durable: steps.scope('build'),
    },
    // Never proposed, never posted: no ceiling, no votes router, and no
    // onSpec but a shared plan's maker's, which hands its spec to the other
    // arms (firstVersionStage).
    propose: false,
    onSpec: ctx.onSpec || null,
    proposalCeiling: null,
    // A first version's early first look, for its spec to start its main
    // screen from, and a shared plan's spec, built from as it is.
    ...(ctx.earlyLook ? { earlyLook: () => ctx.earlyLook } : {}),
    ...(ctx.presetSpec ? { presetSpec: ctx.presetSpec, ...(ctx.presetSpecHtml ? { presetSpecHtml: ctx.presetSpecHtml } : {}) } : {}),
    platformRepo: !!snapshot.extra?.platformRepo,
    firstVersion: !!snapshot.extra?.firstVersion,
    starter: snapshot.extra?.starter || null,
    sessionTitle: title,
    telemetry: TELEMETRY,
    // A turn that changed nothing is nudged as a live build's is, and
    // counted under its own lane.
    origin: { lane: 'bench', trialId: trial.id },
    onSession: async (s) => { sessionId = s.id; await ctx.onSession?.(s.id, { branch }); },
    // A first version's spec model when it differs from its build's (the
    // `today` preset: the bot's own model for each stage), and a studio
    // trial's pack and watch. None of them for any other build task.
    ...(ctx.specModel ? { specModel: ctx.specModel } : {}),
    ...(ctx.guidance ? { specGuidance: ctx.guidance.spec || null, buildGuidance: ctx.guidance.build || null } : {}),
    ...(ctx.onActivity ? { onProgress: ctx.onActivity } : {}),
    ...(ctx.onStep ? { onStage: ctx.onStep } : {}),
    // A studio trial an admin cancelled stops before its build turn.
    ...(ctx.skipCheck ? { skipCheck: ctx.skipCheck } : {}),
    // A configuration's (services/bot-configs.js, through the lane's
    // studioContext): which CLI each model runs in, and its review.
    ...(ctx.harnessOf ? { harnessOf: ctx.harnessOf } : {}),
    ...(ctx.reviewer ? { review: { reviewer: ctx.reviewer, owner: { trialId: trial.id }, onState: null } } : {}),
    // And its build-speed tweaks (bot-configs.js TWEAKS), a first version's.
    ...(ctx.tweaks?.length ? { tweaks: ctx.tweaks } : {}),
  });
  if (ctx.onBuilt) {
    try { await ctx.onBuilt({ ...built, sight }); } catch (err) { durableSteps.rethrowStop(err, 'built'); }
  }
  const out = await buildResult({ built, base, branch, sessionId, deps, repo, task, trial });
  const reviewed = built.review ? require('../bot-review').slimState(built.review) : null;
  const costParts = out.parsed?.costParts ? await stageCosts.withLedgerTokens(pool, out.parsed.costParts) : null;
  return {
    ...out,
    parsed: { ...(out.parsed || {}), sight, ...(reviewed ? { review: reviewed } : {}), ...(costParts ? { costParts } : {}) },
    // The reviewer calls are not agent turns, so the ledger the lane reads a
    // trial's cost from does not hold them (lane.recordTrial).
    ...(built.review ? { review_cost_usd: reviewerCost(built.review) } : {}),
  };
}

/** What a review's reviewer calls cost, together (bot-review.js reviewerCost). Pure. */
function reviewerCost(review) {
  return require('../bot-review').reviewerCost(review);
}

// ── A configuration's side builds ───────────────────────────────────────
//
// A side build (services/bot-configs.js spawnSideBuilds) is a build trial
// like any other: its spec, its build and its review run on the trial's
// durable steps (buildStage), so a restart carries it on from the last one
// it saved. Until 7 Oct 2026 every restart threw its turn away and ran it
// again: the platform restarts on each merge to main, 60 to 80 times a day,
// and a side build takes 10 to 20 minutes, so almost none finished.

/**
 * A SIDE BUILD of a live first version (services/bot-configs.js
 * spawnSideBuilds): one configuration's spec, build and review of the request
 * the live build is building, on the live project's own repository, from the
 * commit the live build started at. No first commit and no triage: the live
 * run's triage outcome and plan (its build snapshot's seed and build note,
 * with the creator's choices in it) are replayed as they are, so only the
 * spec, the build and the review differ. Then the screenshot step, as a
 * first version's.
 */
async function sideBuildStage(ctx) {
  const { snapshot } = ctx;
  if (!snapshot?.texts?.seed || !snapshot.baseSha) {
    return { status: 'infra_fail', error: 'the live run recorded no build snapshot to replay' };
  }
  const models = firstVersionModels(ctx);
  const step = (name) => { try { ctx.onStep?.(name); } catch { /* a watcher never stops a trial */ } };
  const replay = { ...snapshot, extra: { ...(snapshot.extra || {}), firstVersion: true } };
  // A reviewed build's final state, as its review captured it.
  let reviewedCapture = null;
  step('spec');
  const built = await buildStage({
    ...ctx,
    model: models.build,
    specModel: models.spec !== models.build ? models.spec : null,
    snapshot: replay,
    // A first version's own clocks (homeroom-bot buildBudgets, firstVersion).
    budgets: ctx.budgets.firstVersion || ctx.budgets,
    onBuilt: async (b) => {
      reviewedCapture = b?.review?.finalCapture || null;
      if (ctx.onBuilt) await ctx.onBuilt(b);
    },
  });
  const out = {
    ...built,
    session_ids: [built.session_id].filter(Boolean).map(Number),
    parsed: { ...(built.parsed || {}), models, side: { botRunId: ctx.sideBuild?.botRunId || null } },
  };
  if (built.status !== 'ok' || !built.parsed?.built || !built.session_id) return out;
  // Its review captured the final state already, and when a fix broke the
  // app that is the commit the branch went back to, which the worker's own
  // checkout no longer is: taken as it is, not captured again.
  if (reviewedCapture) return { ...out, capture: reviewedCapture };
  step('capture');
  const shot = await screenshotStep(ctx, Number(built.session_id));
  if (!shot.ok) return { ...out, status: 'infra_fail', error: shot.error };
  return { ...out, capture: shot.capture };
}

/** A BUILD task's trial (a recorded build replayed on a candidate model): its spec and build turns (buildStage). */
function replayBuildStage(ctx) {
  return buildStage(ctx);
}

/**
 * The live build's own spec, for a later change's side build whose recipe
 * plans as the live one does (bot-configs.js plansAlike): waited for while
 * it is written, as a durable step, so a restart builds from the same one.
 * Resolves { spec: { sessionId, version, specMd, specHtml } } to build
 * from; { outcome } when there is nothing to build: the live plan found the
 * request impossible or already done (`not_applicable`, which its result
 * records skipped, never as a build that failed: its pair is left out
 * either way, since the live side did not build), or an admin cancelled
 * the trial; or {} for a side that writes its own spec, as every side did
 * before: its recipe plans differently, the live build ended without a
 * spec for any other reason, none came in time, or it could not be read.
 */
async function livePlanFor(ctx) {
  const { pool, sideBuild } = ctx;
  if (!sideBuild?.botRunId || !sideBuild?.versionId) return {};
  const configs = require('../bot-configs');
  const wait = ctx.deps?.livePlanWait || {};
  const waitMs = wait.waitMs ?? configs.LIVE_SPEC_WAIT_MS;
  const pollMs = wait.pollMs ?? configs.LIVE_SPEC_POLL_MS;
  const sleep = wait.sleep || ((ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (typeof t.unref === 'function') t.unref(); }));
  const found = await stepsOf(ctx).once('live_plan', async () => {
    const until = Date.now() + waitMs;
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const state = await configs.liveSpecState(pool, sideBuild);
        if (!state.share) return { own: 'its recipe plans differently' };
        if (state.spec) return { spec: state.spec };
        if (state.ended?.blocked) return { blocked: state.ended.error };
        if (state.ended) return { own: 'the live build ended without a spec' };
        // eslint-disable-next-line no-await-in-loop
        const stop = ctx.skipCheck ? await ctx.skipCheck() : null;
        if (stop) return { stopped: stop };
        if (Date.now() + pollMs > until) return { own: 'the live build\'s spec was not written in time' };
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollMs);
      }
    } catch (err) {
      durableSteps.rethrowStop(err, 'live plan');
      log.warn('bench', 'Could not read the live build\'s plan; the side build writes its own', { trialId: ctx.trial?.id, err: err.message });
      return { own: 'the live build\'s plan could not be read' };
    }
  });
  if (found.stopped) return { outcome: { status: 'cancelled', error: found.stopped } };
  if (found.blocked) {
    return { outcome: { status: 'not_applicable', error: `the live build stopped at its plan: ${String(found.blocked).slice(0, 400)}` } };
  }
  if (!found.spec) return {};
  const text = await require('../bot-configs').liveSpecText(pool, found.spec).catch(() => null);
  return text ? { spec: { ...found.spec, ...text } } : {};
}

/**
 * A SIDE BUILD of a LATER change (services/bot-configs.js spawnSideBuilds,
 * scope `later`): one configuration's build of the request the bot's own
 * build (live or shadow) is building, on the project's own repository from
 * the commit that build started at, replaying its request and its triage's
 * plan (the build snapshot's seed and build note) as they are. A recipe
 * that plans as the live one does builds from the live build's own spec
 * (livePlanFor), so only the build differs; any other writes its own, a
 * later change's (no first-version design brief), on the build's own
 * clocks. No review and no screenshot step. Never proposed, never posted:
 * buildStage's propose:false on the trial's guarded GitHub.
 */
async function laterSideBuildStage(ctx) {
  const { snapshot } = ctx;
  if (!snapshot?.texts?.seed || !snapshot.baseSha) {
    return { status: 'infra_fail', error: 'the run recorded no build snapshot to replay' };
  }
  const models = firstVersionModels(ctx);
  const side = { botRunId: ctx.sideBuild?.botRunId || null };
  const plan = await livePlanFor(ctx);
  if (plan.outcome) return { ...plan.outcome, parsed: { models, side, built: false } };
  const shared = plan.spec || null;
  try { ctx.onStep?.(shared ? 'build' : 'spec'); } catch { /* a watcher never stops a trial */ }
  const built = await buildStage({
    ...ctx,
    model: models.build,
    specModel: models.spec !== models.build ? models.spec : null,
    snapshot: { ...snapshot, extra: { ...(snapshot.extra || {}), firstVersion: false } },
    budgets: ctx.budgets,
    reviewer: null,
    ...(shared ? { presetSpec: shared.specMd, presetSpecHtml: shared.specHtml } : {}),
  });
  return {
    ...built,
    session_ids: [built.session_id].filter(Boolean).map(Number),
    parsed: {
      ...(built.parsed || {}), models, side,
      // Which spec it built from, for its result's cost (bot-configs.js finishSideTrial).
      ...(shared ? { livePlan: { sessionId: shared.sessionId, version: shared.version } } : {}),
    },
  };
}

/**
 * The agent-turn module a build is handed, the same but for
 * resolveCodexRuntimeContext, whose runtime is shown to `onRuntime` (the
 * last one a build resolves is its build turn's) and then returned as it
 * is. A watcher that throws never stops the turn.
 */
function observedRuntime(agentTurn, onRuntime) {
  if (!agentTurn) return agentTurn;
  return new Proxy(agentTurn, {
    get(target, prop) {
      if (prop === 'resolveCodexRuntimeContext') {
        return async (...args) => {
          const runtime = await target.resolveCodexRuntimeContext(...args);
          try { await onRuntime(runtime); } catch { /* a watcher never stops a turn */ }
          return runtime;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A follow-up's prompt and mode, rebuilt from its snapshot. */
function followupTurn(snapshot, kind) {
  const followup = require('../homeroom-bot-followup');
  const seed = snapshot.texts.seed;
  const prNumber = snapshot.extra?.prNumber || null;
  if (kind === 'checks_fix') {
    let failing = [];
    try { failing = JSON.parse(snapshot.texts.failing || '[]'); } catch { failing = []; }
    return {
      prompt: followup.checksFixPrompt({
        seed, proposalBlock: snapshot.texts.proposal_block || '', prNumber, failing, total: snapshot.extra?.total || failing.length,
      }),
      mode: 'build',
    };
  }
  let replies = [];
  try { replies = JSON.parse(snapshot.texts.replies || '[]'); } catch { replies = []; }
  const canRevise = snapshot.extra?.canRevise !== false;
  return {
    prompt: followup.followUpPrompt({
      seed, proposalBlock: snapshot.texts.proposal_block || '', spec: snapshot.texts.spec || '', prNumber, replies, canRevise,
    }),
    mode: canRevise ? 'build' : 'scout',
  };
}

/**
 * A follow-up or checks-fix turn's patch, read from how it ended: its action
 * and, when it moved the head, the diff from the base.
 */
async function followupResult({ turn, out, mode, base, branch, repo, deps }) {
  const followup = require('../homeroom-bot-followup');
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

async function followupStage(ctx, kind) {
  const { pool, config, snapshot, model, user, repo, deps, budgets, trial } = ctx;
  const seed = snapshot.texts.seed;
  if (!seed || !snapshot.baseSha) return { status: 'infra_fail', error: 'the snapshot has no seed or no proposal head' };
  const { prompt, mode } = followupTurn(snapshot, kind);
  // Its turn may push a revision: an earlier claim's branch goes first.
  const cut = await cutBranch(ctx, snapshot.baseSha, { fresh: true });
  if (cut.error) return { status: 'infra_fail', error: `branch: ${cut.error}` };
  const { base, branch } = cut;
  const session = await trialSession(ctx, kind, { model, branch, base });
  const turn = await runTurn({
    pool, config, user, session, repo, prompt, mode, model, budgetMs: budgets.turnMs, deps,
    commitMsg: `Homeroom benchmark: trial ${trial.id}`,
    // Its lines in the studio's watch, as a triage's are.
    onActivity: ctx.onActivity,
    key: kind, steps: stepsOf(ctx),
  });
  const out = { session_id: session.id, base_sha: base, build_branch: branch, session, ...turnFields(turn) };
  return followupResult({ turn, out, mode, base, branch, repo, deps });
}

// ── The taste eval (#3737, services/bench/taste.js) ─────────────────────

/**
 * The screenshot step on a session's worker (services/bench/capture.js), a
 * durable step `key`: run detached, so a restart in it harvests the step its
 * worker is still running, and one after it takes what it took. Resolves
 * { ok: true, capture } (booted or not: an app that would not boot is a
 * result) or { ok: false, error } when the platform could not run it.
 */
async function screenshotStep(ctx, sessionId, key = 'capture') {
  const { pool, deps, trial, app, repo } = ctx;
  const steps = stepsOf(ctx);
  return steps.once(`shot:${key}`, async () => {
    let containerName;
    try {
      containerName = await require('../homeroom-bot-live').ensureBuildWorker({
        worker: deps.worker, session: { id: Number(sessionId) }, repo, branchName: branchFor(trial), steps,
      });
    } catch (err) {
      durableSteps.rethrowStop(err, 'worker');
      return { ok: false, error: `worker: ${err.message}` };
    }
    const step = deps.captureStep || ((args) => require('./capture').captureTrial(args));
    return step({
      pool, trialId: trial.id, worker: deps.worker, containerName, appId: app.id,
      ...(steps.active ? {
        detached: {
          sessionId: Number(sessionId),
          prior: steps.get(`shot_job:${key}`) || null,
          onStarted: (job) => steps.set(`shot_job:${key}`, job),
          fence: steps.fence,
        },
      } : {}),
    });
  });
}

/**
 * A capture trial (the "before" arm): the app's repository at the task's
 * commit, in a sealed worker, and only the screenshot step. No model turn,
 * so nothing is spent on a model.
 */
async function captureStage(ctx) {
  const { snapshot, model } = ctx;
  const input = require('./taste').inputOf(snapshot);
  if (!input.sha) return { status: 'infra_fail', error: 'the task names no commit' };
  const cut = await cutBranch(ctx, input.sha);
  if (cut.error) return { status: 'infra_fail', error: `branch: ${cut.error}` };
  const { base, branch } = cut;
  const session = await trialSession(ctx, 'capture', { model, branch, base });
  const out = { session_id: session.id, base_sha: base, build_branch: branch, cost_usd: 0, session };
  const shot = await screenshotStep(ctx, session.id);
  if (!shot.ok) return { ...out, status: 'infra_fail', error: shot.error };
  return { ...out, status: 'ok', parsed: { captured: true }, capture: shot.capture };
}

/**
 * The model each turn of a first version runs on: the trial's own for all
 * three, or, for the studio's `today` preset (services/bench/studio.js),
 * what the live bot runs each stage on now. Pure.
 */
function firstVersionModels(ctx) {
  const m = ctx.stageModels || {};
  return { triage: m.triage || ctx.model, spec: m.spec || ctx.model, build: m.build || ctx.model };
}

/**
 * A first version's plan and its early first look, as a live first version
 * gets them since newcomer run six (#5062): the plan written from the
 * description in one call at Make it (first-version-plan.js makePlan), and
 * its main screen drawn from that plan in a call of its own
 * (first-version-early-look.js drawScreen), which the spec then starts its
 * own main screen from. Each is a durable step, and neither writes the
 * project's own rows: the trial keeps what they made. What they cost is the
 * trial's, beside its turns' ledger (helper_cost_usd); it is metered here
 * and not also recorded against the bench user, which the lane charges once
 * for the whole trial (lane.recordTrial). Resolves { planned, looked }:
 * `planned.plan` is null when no plan could be written, and `looked.screen`
 * null when no look was drawn (or HOMEROOM_BOT_EARLY_FIRST_LOOK=0).
 */
async function earlySteps(ctx, { input, starter }) {
  const { pool, user, app, deps } = ctx;
  const steps = stepsOf(ctx);
  const fvPlan = deps.firstVersionPlan || require('../first-version-plan');
  const early = deps.earlyLook || require('../first-version-early-look');
  // The project as a plan at Make it sees it: its own name, nobody else in
  // it yet, and the task's game starter when it has one.
  const project = { ...app, name: input.appName };
  const botView = { projectMembers: async () => null, starterOfApp: async () => starter || null };
  const metered = () => {
    let cents = 0;
    return {
      limits: { recordSpend: async (_pool, _userId, c) => { cents += Number(c) || 0; } },
      usd: () => Math.round(cents * 1e4) / 1e6,
    };
  };
  const planned = await steps.once('early_plan', async () => {
    const meter = metered();
    const t0 = Date.now();
    const made = await fvPlan.makePlan(pool, {
      app: project, user, brief: input.brief, deps: { ...(deps.planDeps || {}), limits: meter.limits, bot: botView },
    });
    return {
      plan: made && made.plan ? made.plan : null, model: made?.model || null,
      error: made && made.plan ? null : String(made?.error || 'failed').slice(0, 200), usd: meter.usd(), ms: Date.now() - t0,
    };
  });
  if (!planned.plan) return { planned, looked: null };
  const looked = !early.enabled() ? null : await steps.once('early_look', async () => {
    const meter = metered();
    const t0 = Date.now();
    const drawn = await early.drawScreen(pool, { app: project, user, brief: input.brief, plan: planned.plan }, {
      ...(deps.lookDeps || {}), limits: meter.limits, bot: botView,
    });
    return {
      screen: drawn && drawn.screen ? String(drawn.screen) : null, model: drawn?.model || null,
      error: drawn && drawn.screen ? null : String(drawn?.error || 'failed').slice(0, 200), usd: meter.usd(), ms: Date.now() - t0,
    };
  });
  return { planned, looked };
}

/**
 * The plan a first version is built from, the way a live one gets it: the
 * plan at Make it with its early first look (earlySteps) or, when no plan
 * could be written, the triage turn, as the live bot reads the request when
 * its plan from Make it failed (homeroom-bot.js planFromEarly). Then its
 * creator answers the plan's questions with the suggested answers, so the
 * build note gets exactly the lines Build it adds for them
 * (creatorChoiceNote). Resolves { triage, plan, chosen, buildNote,
 * earlyLook, triaged, planPart, helperUsd, meta } to build from, or with
 * `outcome` (the trial's status, error, session and cost) when nothing is to
 * be built: a triage that failed or did not answer `ready`.
 */
async function planFirstVersion(ctx, { input, starter, replay, base, models }) {
  const bot = require('../homeroom-bot');
  const steps = stepsOf(ctx);
  const step = (name) => { try { ctx.onStep?.(name); } catch { /* a watcher never stops a trial */ } };
  step('plan');
  const { planned, looked } = await earlySteps(ctx, { input, starter });
  const helperUsd = (Number(planned.usd) || 0) + (Number(looked?.usd) || 0);
  const meta = {
    earlyPlan: { model: planned.model, ms: planned.ms, costUsd: planned.usd, error: planned.error },
    earlyLook: looked
      ? { model: looked.model, ms: looked.ms, costUsd: looked.usd, error: looked.error, chars: looked.screen ? looked.screen.length : 0 }
      : null,
  };
  let triaged = null;
  let triage;
  let plan;
  if (planned.plan) {
    triage = {
      verdict: 'ready', question: null, buildNote: planned.plan.buildNote, reason: null,
      assumptions: planned.plan.assumptions || [], fromMakeIt: true,
    };
    plan = { bullets: planned.plan.bullets, questions: planned.plan.questions };
  } else {
    step('triage');
    triaged = await steps.once('triage', async () => keptTriage(await triageStage({
      ...ctx, model: models.triage, snapshot: replay, baseSha: base,
    })));
    triage = triaged.parsed ? {
      verdict: triaged.parsed.verdict, question: triaged.parsed.question || null, buildNote: triaged.parsed.buildNote || null,
      reason: triaged.parsed.reason || null, assumptions: triaged.parsed.assumptions || [],
    } : null;
    const outcomeOf = (status) => ({
      status, error: triaged.error || null, session_id: triaged.session_id || null,
      cost_usd: triaged.cost_usd ?? null, raw_output: triaged.raw_output ?? null,
    });
    if (triaged.status !== 'ok') return { triage, triaged, helperUsd, meta, outcome: outcomeOf(triaged.status) };
    if (triage.verdict !== 'ready') return { triage, triaged, helperUsd, meta, outcome: outcomeOf('ok') };
    plan = bot.planFor(triaged.parsed);
  }
  const chosen = bot.choicesFrom(plan.questions, []);
  const buildNote = `${triage.buildNote || ''}${bot.creatorChoiceNote(chosen, { bullets: plan.bullets })}`;
  return {
    triage, plan, chosen, buildNote, triaged, helperUsd, meta,
    earlyLook: looked?.screen || null,
    planPart: planned.plan ? stageCosts.part({ usd: planned.usd, model: planned.model }) : null,
  };
}

/**
 * A first version's plan in a run that shares its plans (bench/shared-plans.js):
 * the first trial of its brief, pack and repeat to need it makes it
 * (planFirstVersion) and hands its spec to the others as it is written; the
 * others wait for that spec and build from it as it is, with the plan and
 * build note it went with. Resolves what planFirstVersion does, with
 * `makes` (the shared plan's id) for its maker, `presetSpec` and
 * `presetSpecHtml` for the others, and `meta.sharedPlan` either way.
 */
async function sharedFirstVersionPlan(ctx, args) {
  const { pool, trial, task } = ctx;
  const steps = stepsOf(ctx);
  const where = { runId: trial.run_id, taskId: task?.id, packId: ctx.pack?.id || null, key: ctx.sharedPlan.key };
  const which = (id, made, makerTrialId) => ({ id, key: where.key, made, makerTrialId: makerTrialId ?? null });
  let role = await steps.once('shared_plan', () => sharedPlans.claim(pool, { ...where, trialId: trial.id }));
  for (;;) {
    if (role.role === 'maker') {
      // eslint-disable-next-line no-await-in-loop
      const planned = await planFirstVersion(ctx, args);
      const meta = { ...planned.meta, sharedPlan: which(role.id, true, trial.id) };
      if (planned.outcome) {
        // eslint-disable-next-line no-await-in-loop
        await sharedPlans.saveFailed(pool, role.id, planned.outcome.error || `the triage answered ${planned.triage?.verdict || 'nothing'}`);
        return { ...planned, meta };
      }
      // eslint-disable-next-line no-await-in-loop
      await steps.once('shared_planned', async () => {
        await sharedPlans.savePlanned(pool, role.id, {
          plan: { ...planned.plan, chosen: planned.chosen, triage: planned.triage },
          buildNote: planned.buildNote, earlyLook: planned.earlyLook,
          planUsd: planned.meta?.earlyPlan?.costUsd ?? null, lookUsd: planned.meta?.earlyLook?.costUsd ?? null,
        });
        return true;
      });
      return { ...planned, meta, makes: role.id };
    }
    // eslint-disable-next-line no-await-in-loop
    const got = role.role === 'ready'
      ? { row: await sharedPlans.readById(pool, role.id) }
      // eslint-disable-next-line no-await-in-loop
      : await sharedPlans.waitFor(pool, role.id, { trialId: trial.id, stopped: ctx.skipCheck || null, ...(ctx.deps.sharedPlanWait || {}) });
    if (got.take) {
      role = { role: 'maker', id: role.id };
      // eslint-disable-next-line no-await-in-loop
      await steps.set('shared_plan', role);
      continue;
    }
    if (!got.row || !got.row.specMd) {
      return {
        triage: null, helperUsd: 0, meta: { sharedPlan: which(role.id, false) },
        outcome: { status: got.stopped ? 'cancelled' : 'infra_fail', error: `shared plan: ${got.error || 'it has no spec'}` },
      };
    }
    const { row } = got;
    const kept = row.plan || {};
    return {
      triage: kept.triage ? { ...kept.triage, shared: true } : { verdict: 'ready', buildNote: row.buildNote, shared: true },
      plan: { bullets: kept.bullets || [], questions: kept.questions || [] },
      chosen: kept.chosen || [],
      buildNote: row.buildNote,
      presetSpec: row.specMd,
      presetSpecHtml: row.specHtml,
      triaged: null,
      helperUsd: 0,
      planPart: null,
      meta: {
        sharedPlan: which(row.id, false, row.makerTrialId),
        ...(row.earlyLook ? { earlyLook: { chars: row.earlyLook.length, shared: true } } : {}),
      },
    };
  }
}

/**
 * A first-version trial: the bot's real first-version path from a brief,
 * the way a project's first version is made today.
 *
 *   1. The new project's first commit (services/bench/scaffold.js): today's
 *      starter rendered for the app's name, the first session's card of the
 *      idea, and the context pack's files, made once per run, task and pack
 *      and shared by every arm; the trial's branch is cut at it.
 *   2. The brief filed as the project's first request, quoting the card as
 *      the live one does (homeroom-bot-dm firstVersionIssue).
 *   3. The plan, as a live first version gets it since newcomer run six
 *      (#5062): written from the description in one call at Make it, and
 *      its main screen drawn from it as the early first look (earlySteps).
 *      When no plan could be written, the triage reads the request with the
 *      first-version note (and the pack's guidance), as the live bot does.
 *      The creator's answers are the suggested ones, so the build note gets
 *      exactly the lines Build it adds for them (creatorChoiceNote).
 *   4. The spec, starting its main screen from the early first look, and the
 *      build, on the first version's longer clocks (buildAndPropose, never
 *      proposed), each on its own model. In a run that shares its plans the
 *      plan and the spec are made once per brief, pack and repeat, and every
 *      arm builds from that spec (sharedFirstVersionPlan).
 *   5. The screenshot step on the build's worker.
 *
 * A triage that does not answer `ready` builds nothing, as the bot would
 * not, and the trial says what it answered instead.
 *
 * Each part is a durable step: a restart carries the trial on from the last
 * one it saved, and the branch, once cut at the first commit, is never cut
 * again, so a turn that pushed after the last save keeps its commits.
 */
async function firstVersionStage(ctx) {
  const { pool, snapshot, repo, deps, budgets } = ctx;
  const taste = require('./taste');
  const scaffold = require('./scaffold');
  const steps = stepsOf(ctx);
  const input = taste.inputOf(snapshot);
  if (!input.brief || !input.appName) return { status: 'infra_fail', error: 'the task has no brief' };
  const step = (name) => { try { ctx.onStep?.(name); } catch { /* a watcher never stops a trial */ } };
  const models = firstVersionModels(ctx);
  step('scaffold');
  const made = await steps.once('scaffold', () => (deps.scaffold || scaffold.ensure)(pool, {
    runId: ctx.trial.run_id, taskId: ctx.task?.id, pack: ctx.pack || null, input, repo, github: deps.github, user: ctx.user, deps,
    claimant: steps.active && ctx.trial?.id ? `trial:${ctx.trial.id}` : null,
  }));
  if (!made || !made.ok) return { status: 'infra_fail', error: `scaffold: ${made?.error || 'not made'}` };
  // An earlier claim's branch of the same trial goes first.
  const cut = await cutBranch(ctx, made.sha, { fresh: true });
  if (cut.error) return { status: 'infra_fail', error: `branch: ${cut.error}` };
  const { base, branch } = cut;
  const card = scaffold.requestCard(made.sketch);
  const botLogin = await steps.once('bot_login', () => require('../homeroom-bot-live').botUsernameOf(deps.github).catch(() => null));
  const request = taste.firstVersionRequest(input, card);
  const seed = taste.seedFor(input, botLogin, card);
  const replay = {
    ...snapshot, issueNumber: taste.ISSUE_NUMBER, baseSha: base, promptHash: null,
    texts: { seed, build_note: '' }, thread: { issue: { title: request.title } },
    extra: {
      ...(snapshot.extra || {}), firstVersion: true,
      // A task scaffolded from a game starter (taste.js `template`) is
      // planned, specced and built on it, as a live project made from it is.
      ...(require('../app-templates').botStarter(input.template) ? { starter: input.template } : {}),
    },
  };
  const started = {
    scaffold: { sha: made.sha, branch: made.branch || null },
    sketch: card ? { emoji: card.emoji || null, tagline: card.tagline || null, points: card.points || [] } : null,
    models,
    ...(steps.lostAttempts > 0 ? { resumedAfterRestart: steps.lostAttempts } : {}),
  };
  // The plan it is built from: the plan at Make it and its early first
  // look, the way a live first version starts since newcomer run six, or the
  // triage when no plan could be written (planFirstVersion); in a run that
  // shares its plans, made once for every arm (sharedFirstVersionPlan).
  const starter = replay.extra.starter || null;
  const planned = ctx.sharedPlan
    ? await sharedFirstVersionPlan(ctx, { input, starter, replay, base, models })
    : await planFirstVersion(ctx, { input, starter, replay, base, models });
  const sessionIds = [planned.triaged?.session_id].filter(Boolean);
  const common = { base_sha: base, build_branch: branch, session_ids: sessionIds };
  const { triage } = planned;
  const before = {
    ...started, triage, ...(planned.meta || {}),
  };
  if (planned.outcome) {
    return { ...planned.outcome, ...common, helper_cost_usd: planned.helperUsd || 0, parsed: { ...before, built: false } };
  }
  // An admin's cancel (services/bench/lane.js cancelTrial) ends it here.
  const stopped = ctx.skipCheck ? await ctx.skipCheck() : null;
  if (stopped) {
    if (planned.makes) await sharedPlans.saveFailed(pool, planned.makes, stopped);
    return {
      ...common, session_id: planned.triaged?.session_id || null, status: 'cancelled', error: stopped,
      cost_usd: planned.triaged?.cost_usd ?? null, helper_cost_usd: planned.helperUsd || 0, parsed: { ...before, built: false },
    };
  }
  const { plan, chosen, buildNote } = planned;
  step('spec');
  const built = await buildStage({
    ...ctx,
    model: models.build,
    specModel: models.spec !== models.build ? models.spec : null,
    snapshot: { ...replay, texts: { seed, build_note: buildNote } },
    // A first version's own clocks (homeroom-bot buildBudgets, firstVersion).
    budgets: budgets.firstVersion || budgets,
    // Its spec starts its main screen from the early first look, as a live
    // one's does (homeroom-bot.js buildLive earlyLook); a shared plan's spec
    // is built from as it is (buildAndPropose's presetSpec), and the maker
    // of one hands its spec to the other arms the moment it is written.
    ...(planned.earlyLook ? { earlyLook: planned.earlyLook } : {}),
    ...(planned.presetSpec ? { presetSpec: planned.presetSpec, presetSpecHtml: planned.presetSpecHtml || null } : {}),
    ...(planned.makes ? {
      onSpec: async ({ specMd, specHtml }) => sharedPlans.saveSpec(pool, planned.makes, { specMd, specHtml }),
    } : {}),
  });
  // A maker whose spec was never written leaves the plan to the next arm.
  if (planned.makes && !built.parsed?.spec) await sharedPlans.saveFailed(pool, planned.makes, built.error || 'no spec was written');
  const ids = [...sessionIds, built.session_id].filter(Boolean).map(Number);
  const cost = [planned.triaged?.cost_usd, built.cost_usd].filter(Number.isFinite);
  // The plan's part of the cost breakdown under the triage it replaces: the
  // plan at Make it's call, or the triage's own session's ledger.
  const triagePart = planned.triaged
    ? (await stageCosts.sessionPart(pool, planned.triaged.session_id, models.triage)
      || stageCosts.part({ usd: planned.triaged.cost_usd, model: models.triage }))
    : planned.planPart || null;
  const costParts = { ...(triagePart ? { triage: triagePart } : {}), ...(built.parsed?.costParts || {}) };
  const merged = {
    ...built, base_sha: base, build_branch: branch, session_id: built.session_id || planned.triaged?.session_id || null,
    session_ids: [...new Set(ids)],
    cost_usd: cost.length ? cost.reduce((a, b) => a + b, 0) : null,
    // The plan's and the early first look's calls, beside the turns' ledger
    // (lane.recordTrial).
    helper_cost_usd: planned.helperUsd || 0,
    parsed: {
      ...before, ...(built.parsed || {}), plan: { bullets: plan.bullets, questions: plan.questions, chosen },
      ...(Object.keys(costParts).length ? { costParts } : {}),
    },
  };
  if (built.status !== 'ok' || !built.parsed?.built || !built.session_id) return merged;
  step('capture');
  const shot = await screenshotStep(ctx, built.session_id);
  // The platform failing to run the step is not the build's fault: the
  // trial is a fault, kept out of quality, with its build still recorded.
  if (!shot.ok) return { ...merged, status: 'infra_fail', error: shot.error };
  return { ...merged, capture: shot.capture };
}

/** A triage's outcome as a step keeps it: everything but the live session. */
function keptTriage(t) {
  return {
    status: t.status, error: t.error || null, session_id: t.session_id || null, cost_usd: t.cost_usd ?? null,
    raw_output: t.raw_output ?? null, parsed: t.parsed || null,
  };
}

/**
 * A reference build (services/bench/studio.js submitReference): an app a
 * Claude Code session built from the same first commit and pack, copied
 * into the trial's branch when it was handed in (capture_sha). It is judged
 * like the bot's builds and so goes through the same screenshot step, in the
 * same sealed worker, with no model turn: nothing is spent on a model. Its
 * diff is read against the first commit it was built on.
 */
async function referenceStage(ctx) {
  const { trial, deps, repo } = ctx;
  const sha = trial.capture_sha;
  if (!sha) return { status: 'infra_fail', error: 'the reference names no commit' };
  const scaffoldSha = trial.base_sha || null;
  const cut = await cutBranch(ctx, sha);
  if (cut.error) return { status: 'infra_fail', error: `branch: ${cut.error}` };
  const { base: tip, branch } = cut;
  // Sealed at the first commit it was built on, as a built first version's
  // worker is at capture time.
  const session = await trialSession(ctx, 'reference', { model: ctx.sessionModel || ctx.model, branch, base: scaffoldSha || tip });
  const out = {
    session_id: session.id, base_sha: scaffoldSha || tip, build_branch: branch, build_sha: sha, cost_usd: 0, session,
    build_commits: Number.isFinite(trial.build_commits) && trial.build_commits > 0 ? trial.build_commits : 1,
  };
  const compared = scaffoldSha ? await branchDiff(deps.github, repo, scaffoldSha, branch) : null;
  try { ctx.onStep?.('capture'); } catch { /* a watcher never stops a trial */ }
  const shot = await screenshotStep(ctx, session.id);
  const parsed = { built: true, reference: true, label: trial.reference_label || null, scaffold: { sha: scaffoldSha } };
  const files = compared ? { diff: compared.diff, changed_files: { files: compared.files, complete: compared.complete, truncated: compared.truncated } } : {};
  if (!shot.ok) return { ...out, ...files, status: 'infra_fail', error: shot.error, parsed };
  return { ...out, ...files, status: 'ok', parsed, capture: shot.capture };
}

const STAGE_RUNNERS = Object.freeze({
  triage: triageStage,
  spec: specStage,
  // A side build of a later change replays its plan (laterSideBuildStage).
  build: (ctx) => (ctx.sideBuild ? laterSideBuildStage(ctx) : replayBuildStage(ctx)),
  followup: (ctx) => followupStage(ctx, 'followup'),
  checks_fix: (ctx) => followupStage(ctx, 'checks_fix'),
  // A DM task is a conversation of triage turns (services/bench/dm-sim.js).
  dm: (ctx) => require('./dm-sim').dmStage(ctx),
  // A reference build handed in from outside is a first version too,
  // only captured (referenceStage).
  first_version: (ctx) => {
    if (ctx.trial?.reference_label) return referenceStage(ctx);
    // A side build of a live first version replays its plan (sideBuildStage).
    return ctx.sideBuild ? sideBuildStage(ctx) : firstVersionStage(ctx);
  },
  capture: captureStage,
});

/**
 * Run one stage of one task on one model, with nothing leaving the
 * benchmark. Resolves the trial's patch: its status, what it said, what it
 * cost, and (for a build) its branch and diff. A refused side effect or
 * anything unexpected is an infra failure with its reason; it throws only a
 * stop (the trial is no longer this process's: services/durable-steps.js).
 */
async function runStage(ctx) {
  const runner = STAGE_RUNNERS[ctx.stage];
  if (!runner) return { status: 'not_applicable', error: `no runner for ${ctx.stage}` };
  const startedMs = Date.now();
  // Every stage puts its base on the trial (cutBranch, onSession) before it
  // starts a worker; the worker it is handed is sealed at that base.
  let pinned = null;
  const sealed = {
    ...ctx,
    pinBase: (sha) => { if (sha) pinned = sha; },
    onSession: async (id, info = {}) => {
      if (info?.baseSha) pinned = info.baseSha;
      return ctx.onSession?.(id, info);
    },
    deps: ctx.deps?.worker ? { ...ctx.deps, worker: sealedWorker(ctx.deps.worker, () => pinned) } : ctx.deps,
  };
  let out;
  try {
    out = await runner(sealed);
  } catch (err) {
    durableSteps.rethrowStop(err, `trial ${ctx.trial?.id}`);
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
  const budgets = { turnMs: stage === 'build' || stage === 'spec' ? built.turnBudgetMs : turnMs, buildMs: built.turnBudgetMs, specMs: built.specBudgetMs };
  if (stage !== 'first_version') return budgets;
  // A first version's triage has a triage's clock; its spec and build get
  // the longer ones the bot gives a first version.
  const first = bot.buildBudgets(app, config, turnMs, { firstVersion: true });
  return { ...budgets, firstVersion: { turnMs, buildMs: first.turnBudgetMs, specMs: first.specBudgetMs } };
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
  sealedWorker,
  assertBenchBranch,
  ensureBenchUser,
  isBenchSession,
  isRecoveredBenchSession,
  stepsOf,
  branchFor,
  pinBranch,
  cutBranch,
  openSession,
  trialSession,
  runTurn,
  turnStatus,
  sessionUsage,
  branchDiff,
  hiddenChecksUnavailable,
  runStage,
  budgetsFor,
  STAGE_RUNNERS,
  triageStage,
  firstVersionStage,
  sideBuildStage,
  laterSideBuildStage,
  replayBuildStage,
  reviewerCost,
  firstVersionModels,
  referenceStage,
  captureStage,
  screenshotStep,
  triageResult,
  followupResult,
  buildResult,
  keptTriage,
  earlySteps,
  planFirstVersion,
  sharedFirstVersionPlan,
};
