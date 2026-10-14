'use strict';

// What leaves the box, faked for a bot build in a workflow child
// (tests/lib/bot-build-crash-child.js, tests/bot-build-crash-postgres.test.js):
//
//   the coding worker   services/worker.js: turns are rows of the test's
//                       crash_world_turns, finished by the TEST process
//                       (tests/lib/bot-build-crash.js settleTurns), so one
//                       dispatched before a kill keeps going after it. The
//                       turn record (chat_sessions.active_turn) is written
//                       here exactly as the real worker writes it, through
//                       turn-lifecycle.js; the journal is replayed through
//                       the worker's own parser.
//   GitHub              services/github.js: branches, commits, comments in
//                       the crash_world_* tables.
//   the pull request    routes/votes.js's promote route: opens the pull
//                       request on the fake GitHub, adopting one already
//                       open for the branch, then marks the session promoted.
//   the model           the OpenRouter key and catalog (credential-store,
//                       agent-models), the reviewer's client (openrouter-
//                       mayor), the included key (openrouter-managed-keys).
//   the platform's own  docker, kubernetes, llm, firebase: anything reached
//   outside clients     is refused and recorded as `fake.unexpected`.
//
// Everything else is the platform's: build-runs.js, durable-steps.js,
// durable-turn.js, the kernel, homeroom-bot.js, homeroom-bot-live.js,
// bot-review.js, bench/capture.js, agent-turn.js (its ledger and the turn
// record it registers), routes/sessions.js runCodexAttemptLoop, limits.js.

const crypto = require('node:crypto');
const path = require('node:path');
const { captureStdout, MAIN_SHA, sha1 } = require('../lib/bot-build-crash');

const SRC = path.join(__dirname, '..', '..', 'src');
const isClass = (fn) => /^class\b/.test(Function.prototype.toString.call(fn));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The module with every function replaced by one that fails, except the
// ones kept real and the overrides (as tests/fixtures/workflow-outside-fakes.js).
function outside(world, rel, { keep = [], overrides = {}, drop = [] }) {
  const real = require(path.join(SRC, rel));
  const kept = new Set(keep);
  const out = {};
  for (const [name, value] of Object.entries(real)) {
    if (drop.includes(name)) continue;
    if (typeof value !== 'function' || isClass(value) || kept.has(name)) { out[name] = value; continue; }
    out[name] = () => {
      world.record('fake.unexpected', { module: rel, fn: name }).catch(() => {});
      throw Object.assign(new Error(`${rel}.${name} reaches an outside service this test does not fake`), { code: 'ECONNREFUSED' });
    };
  }
  world.stub(path.join(SRC, rel), { ...out, ...overrides });
  return real;
}

const repoOf = (url) => {
  const m = String(url || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
};

module.exports = function install(world) {
  const { pool } = world;
  const loaded = (rel) => !!require.cache[require.resolve(path.join(SRC, rel))];
  if (loaded('services/agent-turn') || loaded('services/bot-review')) {
    throw new Error('bot-build crash fakes: install them before the platform loads');
  }

  // ── The platform's own outside clients ────────────────────────────────
  outside(world, 'services/docker', { keep: ['containerHostname', 'parseDockerBuildLine', 'STOP_GRACE_SEC', 'STAGING_STOP_GRACE_SEC'] });
  outside(world, 'services/kubernetes', { keep: ['dnsName'] });
  outside(world, 'services/llm', { keep: ['init'], overrides: { isEnabled: () => false } });
  const firebase = (name, exports) => world.stub(require.resolve(name, { paths: [SRC] }), exports);
  firebase('firebase-admin/app', { initializeApp: (o, name) => ({ name }), cert: (account) => account, deleteApp: async () => {} });
  firebase('firebase-admin/messaging', { getMessaging: () => ({ async send() { return 'projects/test/messages/1'; } }) });

  async function planOf(appId) {
    if (appId == null) return {};
    const { rows: [r] } = await pool.query('SELECT plan FROM crash_world_plans WHERE app_id = $1', [appId]);
    return r?.plan || {};
  }
  async function sessionWorld(sessionId) {
    const { rows: [r] } = await world.appPool().query(
      `SELECT cs.app_id, cs.branch_name, cs.workflow_step, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
      [Number(sessionId)]);
    return { appId: r?.app_id ?? null, branch: r?.branch_name ?? null, repo: repoOf(r?.repo_url), workflowStep: r?.workflow_step ?? null };
  }
  // The app a repository is (each run has its own), for the effects GitHub records.
  async function appOfRepo(owner, repo) {
    const { rows: [a] } = await world.appPool().query('SELECT id FROM apps WHERE repo_url = $1', [`https://github.com/${owner}/${repo}`]);
    return a ? a.id : null;
  }

  // ── GitHub ────────────────────────────────────────────────────────────
  let comments = 0;
  world.onReset(() => { comments = 0; });
  outside(world, 'services/github', {
    keep: ['parseGithubUrl', 'safeMention', 'noteIssuesClosed', 'unsuppressIssues', 'invalidateIssuesCache',
      'noteIssueCreated', 'describeGithubError', 'credentialClass', 'clipIssueComments', '_resetSingleIssueCache'],
    overrides: {
      async init() {},
      isEnabled: () => true,
      async getBotUsername() { return 'usernode-bot'; },
      async fetchPublicIssue(owner, repo, number) {
        return { issue: {
          number, title: `Request ${number}`, state: 'open', body: 'Please add it.', user: 'someone',
          updatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
        } };
      },
      async fetchIssueComments(owner, repo, number) {
        const { rows } = await pool.query(
          `SELECT data, at FROM crash_world_effects WHERE kind = 'github.comment' AND data->>'repo' = $1 AND (data->>'number')::int = $2 ORDER BY id`,
          [`${owner}/${repo}`, Number(number)]);
        return { comments: rows.map((r) => ({ author: 'usernode-bot', body: r.data.body, createdAt: r.at.toISOString() })), truncated: false };
      },
      // GitHub creates the comment, then its answer may never arrive: the
      // `comment:<n>:after` point is between the two.
      async createIssueComment(owner, repo, number, body) {
        comments += 1;
        const n = comments;
        await world.kill(`comment:${n}:before`, { number });
        const at = new Date();
        await world.record('github.comment', { repo: `${owner}/${repo}`, number: Number(number), body: String(body).slice(0, 200) });
        await world.kill(`comment:${n}:after`, { number });
        return { id: Number(`${Date.now()}${n}`), created_at: at.toISOString() };
      },
      async getFileContent() { return null; },
      // The bench's own writes (bench/runner.js guardedGithub): a first
      // version's first commit, and its branches under bench/.
      async createRootCommit(owner, repo, files, { message = 'Initial commit' } = {}) {
        const appId = await appOfRepo(owner, repo);
        await world.kill('rootCommit:before');
        // The same tree on every run, so two runs of one trial end on the same shas.
        const sha = sha1(`root|${message}|${(files || []).length}`);
        await pool.query('INSERT INTO crash_world_commits (sha, parent, ahead, step) VALUES ($1, NULL, 0, $2) ON CONFLICT DO NOTHING', [sha, 'root']);
        await world.record('github.rootCommit', { repo: `${owner}/${repo}`, sha }, appId);
        await world.kill('rootCommit:after');
        return sha;
      },
      async deleteBenchBranch(owner, repo, branch) {
        const { rowCount } = await pool.query('DELETE FROM crash_world_branches WHERE repo = $1 AND branch = $2', [`${owner}/${repo}`, branch]);
        await world.record('github.deleteBranch', { repo: `${owner}/${repo}`, branch, existed: rowCount > 0 }, await appOfRepo(owner, repo));
        return rowCount > 0;
      },
      // As GitHub's: made at `sha`, kept when it is there, refused at another commit.
      async ensureBranchAtSha(owner, repo, branch, sha) {
        const key = `${owner}/${repo}`;
        const { rows: [b] } = await pool.query('SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2', [key, branch]);
        const appId = await appOfRepo(owner, repo);
        if (b && b.sha !== sha) {
          await world.record('github.ensureBranch', { repo: key, branch, sha, outcome: 'conflict' }, appId);
          throw Object.assign(new Error('The branch already exists at a different commit'), { code: 'branch_conflict' });
        }
        if (!b) await pool.query('INSERT INTO crash_world_branches (repo, branch, sha) VALUES ($1, $2, $3)', [key, branch, sha]);
        await world.record('github.ensureBranch', { repo: key, branch, sha, outcome: b ? 'kept' : 'created' }, appId);
        return { sha, created: !b };
      },
      async compareFiles(owner, repo, basehead) {
        const [base, head] = String(basehead).split('...');
        const { rows: [b] } = await pool.query('SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2', [`${owner}/${repo}`, head]);
        const tip = b?.sha || head;
        const { rows: [c] } = await pool.query('SELECT ahead FROM crash_world_commits WHERE sha = $1', [tip]);
        const n = tip === base ? 0 : Math.max(0, Number(c?.ahead) || 0);
        const files = Array.from({ length: n }, (_, i) => ({ filename: `src/part-${i + 1}.js`, status: 'added', additions: 3, deletions: 0, previous: null }));
        return { files, diff: files.map((f) => `+++ ${f.filename}`).join('\n'), complete: true, truncated: false };
      },
      async createBranch(owner, repo, branch) {
        await pool.query(
          'INSERT INTO crash_world_branches (repo, branch, sha) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [`${owner}/${repo}`, branch, MAIN_SHA]);
        await world.record('github.createBranch', { repo: `${owner}/${repo}`, branch });
        return { ref: `refs/heads/${branch}`, sha: MAIN_SHA };
      },
      async getBranchSha(owner, repo, branch) {
        if (branch === 'main') return MAIN_SHA;
        const { rows: [b] } = await pool.query('SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2', [`${owner}/${repo}`, branch]);
        return b?.sha || null;
      },
      async compareCommitAncestry(owner, repo, base, head) {
        const { rows: [c] } = await pool.query('SELECT ahead FROM crash_world_commits WHERE sha = $1', [head]);
        const aheadBy = c ? Number(c.ahead) : 0;
        return { status: base === head ? 'identical' : aheadBy > 0 ? 'ahead' : 'diverged', aheadBy, behindBy: 0 };
      },
      async forceBranchToSha(owner, repo, branch, sha) {
        await world.record('github.forceBranch', { repo: `${owner}/${repo}`, branch, sha });
        await pool.query('UPDATE crash_world_branches SET sha = $3 WHERE repo = $1 AND branch = $2', [`${owner}/${repo}`, branch, sha]);
        return { sha };
      },
    },
  });

  // ── The coding worker ─────────────────────────────────────────────────
  const turnLifecycle = require(path.join(SRC, 'services/turn-lifecycle'));
  const realWorker = require(path.join(SRC, 'services/worker'));
  const registry = new Map();
  const reg = (sid) => registry.get(Number(sid)) || null;
  const upsert = (sid, patch) => { registry.set(Number(sid), { ...(registry.get(Number(sid)) || {}), ...patch }); };
  const runtimeName = (sid) => `usernode-worker-${Number(sid)}`;
  const db = () => world.appPool();

  // Which of a build's turns this is: the step a durable turn is kept under.
  function stepOf(opts, where = {}) {
    // A bench trial's triage runs on a session of its own (runner.js trialSession).
    if (opts.mode === 'scout' && /(^|\/)session:triage$/.test(String(where.workflowStep || ''))) return 'triage';
    if (opts.mode === 'scout') return 'spec';
    if (opts.telemetryComponent === 'homeroom_bot_build_nudge') return 'nudge';
    const fix = /review fixes, round (\d+)/.exec(String(opts.commitMsg || ''));
    if (fix) return `fix:${fix[1]}`;
    return opts.mode === 'build' ? 'build' : String(opts.mode || 'turn');
  }

  // worker.js _persistActiveTurn, as it is.
  async function persistActiveTurn(sessionId, turn) {
    try {
      const current = await turnLifecycle.loadActiveTurn(db(), sessionId);
      if (current) {
        const isRegisteredAttempt = !!(
          turn.backend === 'codex_openrouter'
          && current.backend === 'codex_openrouter'
          && turn.turnUuid
          && String(current.turnUuid || '') === String(turn.turnUuid)
          && String(turnLifecycle.turnIdentity(current) || '') === String(turn.turnId || '')
          && current.phase === turnLifecycle.PHASE_DISPATCH_PENDING
          && String(current.journal || '') === String(turn.journal || '')
        );
        if (isRegisteredAttempt) return { ok: true };
        throw Object.assign(new Error('turn-lifecycle: session already owns a different turn'), { code: 'session_busy' });
      }
      await turnLifecycle.persistNewTurn(db(), sessionId, turn);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: typeof err?.code === 'string' ? err.code : 'persist_error' };
    }
  }

  // worker.js markTurnTail / noteTailMilestone / finishTurn / clearActiveTurn /
  // releaseSkippedDispatch, as they are, minus the files in the container.
  async function markTurnTail(sessionId, milestones = {}, { turnId = null, journal = null } = {}) {
    const meta = reg(sessionId);
    const identity = turnId || meta?.finishedTurnId || null;
    const recoveryJournal = journal || meta?.finishedJournal || null;
    if (!identity && !recoveryJournal) throw Object.assign(new Error('markTurnTail: durable turn identity required'), { code: 'turn_identity_required' });
    await turnLifecycle.markTailPending(db(), { sessionId, turnId: identity, journal: recoveryJournal, patch: { tail: milestones || {} } });
    return true;
  }
  async function noteTailMilestone(sessionId, milestones, { turnId = null, journal = null } = {}) {
    if (!milestones || typeof milestones !== 'object') return false;
    const meta = reg(sessionId);
    const identity = turnId || meta?.finishedTurnId || null;
    const recoveryJournal = journal || meta?.finishedJournal || null;
    if (!identity && !recoveryJournal) throw Object.assign(new Error('noteTailMilestone: durable turn identity required'), { code: 'turn_identity_required' });
    const result = await turnLifecycle.mergeTailMilestones(db(), { sessionId, turnId: identity, journal: identity ? null : recoveryJournal, milestones });
    return result.updated;
  }
  async function finishTurn(sessionId, { journal = null, turnId = null } = {}) {
    const meta = reg(sessionId);
    const rememberedJournal = meta?.finishedJournal || null;
    const rememberedTurnId = meta?.finishedTurnId || null;
    let ownsCleanup = false;
    let cleanupTurnId = null;
    let cleanupJournal = null;
    try {
      const current = await turnLifecycle.loadActiveTurn(db(), sessionId);
      if (current) {
        if (turnId) cleanupTurnId = turnId;
        else if (journal) cleanupJournal = journal;
        else if (rememberedTurnId) cleanupTurnId = rememberedTurnId;
        else if (rememberedJournal) cleanupJournal = rememberedJournal;
        if (!cleanupTurnId && !cleanupJournal) throw Object.assign(new Error('finishTurn: durable turn identity required'), { code: 'turn_identity_required' });
        const cleanup = await turnLifecycle.markCleanupPending(db(), { sessionId, turnId: cleanupTurnId, journal: cleanupJournal });
        ownsCleanup = !cleanup.alreadyCleared;
      }
    } catch {
      return false;
    }
    if (ownsCleanup) {
      try {
        await turnLifecycle.clearCleanupPending(db(), { sessionId, turnId: cleanupTurnId, journal: cleanupJournal });
      } catch {
        return false;
      }
      await world.record('turn.release', { sessionId: Number(sessionId), turnId: cleanupTurnId, journal: cleanupJournal });
    }
    upsert(sessionId, { finishedJournal: null, finishedTurnId: null });
    return true;
  }
  async function clearActiveTurn(sessionId, { turnId = null, journal = null } = {}) {
    try {
      if (!turnId && !journal) throw new Error('clearActiveTurn: durable turn identity required');
      await turnLifecycle.markCleanupPending(db(), { sessionId, turnId, journal });
      await turnLifecycle.clearCleanupPending(db(), { sessionId, turnId, journal });
      return true;
    } catch {
      return false;
    }
  }
  async function releaseSkippedDispatch(sessionId, turnId, { holdTurnRecord = false } = {}) {
    if (!turnId) return false;
    try {
      const current = await turnLifecycle.loadActiveTurn(db(), sessionId);
      if (!current || String(turnLifecycle.turnIdentity(current) || '') !== String(turnId)
        || turnLifecycle.phaseOf(current) !== turnLifecycle.PHASE_DISPATCH_PENDING) return false;
      if (holdTurnRecord) await markTurnTail(sessionId, {}, { turnId });
      else if (!(await finishTurn(sessionId, { turnId }))) return false;
      return true;
    } catch {
      return false;
    }
  }

  // The turn, handed to the worker: from here it runs in the test process.
  async function dispatchTurn({ sid, where, step, mode, journal, turnId, turnUuid, branchName }) {
    const plan = ((await planOf(where.appId)).turns || {})[step] || {};
    const repo = where.repo;
    const branch = branchName || where.branch;
    const { rows: [b] } = repo && branch
      ? await pool.query('SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2', [repo, branch])
      : { rows: [] };
    const base = b?.sha || MAIN_SHA;
    const { rows: [c] } = await pool.query('SELECT ahead FROM crash_world_commits WHERE sha = $1', [base]);
    const { rows: [{ n }] } = await pool.query(
      'SELECT count(*)::int + 1 AS n FROM crash_world_turns WHERE session_id = $1 AND step = $2', [sid, step]);
    await pool.query(
      `INSERT INTO crash_world_turns (app_id, session_id, journal, turn_id, turn_uuid, step, mode, dispatch_n, repo, branch,
                                      base_sha, base_ahead, due_at, plan, pid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp() + make_interval(secs => $13::float8 / 1000), $14, $15)`,
      [where.appId, sid, journal, turnId, turnUuid || null, step, mode, n, repo, branch, base, c ? Number(c.ahead) : 0,
        Number(plan.ms) || 100, JSON.stringify(plan), process.pid]);
    await pool.query(
      `INSERT INTO crash_world_workspaces (session_id, container, branch) VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET branch = EXCLUDED.branch`, [sid, runtimeName(sid), branch]);
    await world.record('turn.dispatch', { step, n, sessionId: sid, journal }, where.appId);
  }

  // Follow a turn's journal to its end and replay it through the worker's
  // own parser. A journal the worker never wrote (the turn was never
  // dispatched) reads as a turn that never started.
  async function consume(sid, journal, { backend, harness, turnId, onProgress, dispatched }) {
    const state = realWorker.newWatchState();
    state.turnId = turnId || null;
    state.agentBackend = backend;
    state.agentHarness = harness;
    state.providerDispatched = dispatched === true;
    state.hostSessionId = sid;
    const deadline = Date.now() + 120000;
    for (;;) {
      const { rows: [t] } = await pool.query('SELECT status, lines FROM crash_world_turns WHERE journal = $1', [journal]);
      if (!t) {
        state.exitCode = -1;
        state.markerlessCause = 'container_gone';
        return { state, missing: true };
      }
      if (t.status === 'finished') {
        for (const line of t.lines || []) {
          state.rawStdout += `${line}\n`;
          realWorker.parseLine(line, typeof onProgress === 'function' ? onProgress : () => {}, state);
        }
        return { state, missing: false };
      }
      if (Date.now() > deadline) throw new Error(`the fake turn ${journal} never finished`);
      await sleep(25);
    }
  }

  const fake = {
    usesKubernetesWorkers: () => false,
    workerContainerName: runtimeName,
    workerRuntimeName: runtimeName,
    setAccountDeletionGuard() {},
    async ensureWorkerImage() {},
    async ensureWorker(sessionId, { branchName = null } = {}) {
      const sid = Number(sessionId);
      const { rows: [running] } = await pool.query(
        `SELECT count(*)::int AS n FROM crash_world_turns WHERE session_id = $1 AND status = 'running'`, [sid]);
      const where = await sessionWorld(sid);
      // A turn running in a worker this replaces would go with it.
      await world.record('worker.ensure', { sessionId: sid, turnRunning: running.n > 0 }, where.appId);
      await pool.query(
        `INSERT INTO crash_world_workspaces (session_id, container, branch) VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO UPDATE SET branch = COALESCE(EXCLUDED.branch, crash_world_workspaces.branch)`,
        [sid, runtimeName(sid), branchName]);
      upsert(sid, { containerName: runtimeName(sid), inFlight: reg(sid)?.inFlight || false });
      return runtimeName(sid);
    },
    async getWorkerStatus(name) {
      const { rows: [w] } = await pool.query('SELECT 1 FROM crash_world_workspaces WHERE container = $1', [name]);
      return w ? 'running' : null;
    },
    adoptWarmWorker(sessionId, containerName = null) {
      upsert(sessionId, { containerName: containerName || runtimeName(sessionId), adopted: true });
      world.record('worker.adopt', { sessionId: Number(sessionId) }).catch(() => {});
      return true;
    },
    isInFlight: (sessionId) => !!reg(sessionId)?.inFlight,
    getActiveTurnMode: (sessionId) => (reg(sessionId)?.inFlight ? reg(sessionId)?.activeTurnMode || null : null),
    isWorkerExecuting: async () => true,
    async execInWorker(sessionId, opts = {}) {
      const sid = Number(sessionId);
      const meta = reg(sid);
      if (!meta) throw new Error(`execInWorker: no warm worker registered for session ${sid}`);
      if (meta.inFlight) throw Object.assign(new Error(`execInWorker: a turn is already in flight for session ${sid}`), { code: 'TURN_IN_FLIGHT' });
      const mode = opts.mode || 'build';
      const where = await sessionWorld(sid);
      const step = stepOf(opts, where);
      await world.record('turn.exec', { step, mode, sessionId: sid }, where.appId);
      // The attempt is registered (agent-turn.js startCodexAttempt wrote its
      // dispatch_pending record); nothing of this call has happened yet.
      await world.kill(`exec:${step}`);
      const durableTurnId = opts.logicalTurnId || opts.turnUuid || turnLifecycle.newTurnId();
      const preRegistered = opts.logicalTurnId || opts.turnUuid || null;
      const { harness } = realWorker.resolveTurnBackend(opts.agentBackend || 'claude_code', opts.agentHarness || null);
      const backend = opts.agentBackend || 'claude_code';
      if (meta.stopRequestedAt) {
        const stopped = realWorker.newWatchState();
        stopped.turnId = preRegistered;
        stopped.agentBackend = backend;
        stopped.agentHarness = harness;
        stopped.execExitSeen = true;
        stopped.exitCode = 143;
        await releaseSkippedDispatch(sid, preRegistered, { holdTurnRecord: !!opts.holdTurnRecord });
        await world.record('turn.skipped', { step, sessionId: sid }, where.appId);
        return stopped;
      }
      const journal = opts.journalPath || turnLifecycle.journalPathForAttempt(opts.turnUuid || crypto.randomUUID());
      upsert(sid, { inFlight: true, activeTurnMode: mode, journal, activeTurnId: durableTurnId });
      const persisted = await persistActiveTurn(sid, {
        turnId: durableTurnId, phase: turnLifecycle.PHASE_DISPATCH_PENDING, mode, journal, backend,
        harness: harness || undefined, turnUuid: opts.turnUuid || undefined, logicalTurnId: opts.logicalTurnId || undefined,
        attemptNumber: opts.attemptNumber || undefined, telemetryComponent: opts.telemetryComponent || undefined,
        model: opts.agentModel || opts.model || '', startedAt: new Date().toISOString(), byok: false,
      });
      if (!persisted.ok) {
        upsert(sid, { inFlight: false, activeTurnMode: null, journal: null, activeTurnId: null });
        throw Object.assign(new Error(persisted.code === 'session_busy'
          ? 'execInWorker: another turn already owns this session'
          : 'execInWorker: durable active turn could not be persisted'), {
          code: 'durable_turn_persist_failed', persistCode: persisted.code, sessionBusy: persisted.code === 'session_busy',
        });
      }
      if (typeof opts.onTurnRecord === 'function') {
        try {
          await opts.onTurnRecord({ turnId: durableTurnId, journal, turnUuid: opts.turnUuid || null, mode });
        } catch (err) {
          upsert(sid, { inFlight: false, activeTurnMode: null, journal: null, activeTurnId: null });
          throw err;
        }
      }
      let state = null;
      try {
        await dispatchTurn({ sid, where, step, mode, journal, turnId: durableTurnId, turnUuid: opts.turnUuid, branchName: opts.branchName });
        await turnLifecycle.markExecuting(db(), { sessionId: sid, turnId: durableTurnId }).catch(() => {});
        // The turn runs in the worker; this process only watches it.
        await world.kill(`dispatched:${step}`);
        if (reg(sid)?.stopRequestedAt) await fake.stopTurn(sid).catch(() => {});
        ({ state } = await consume(sid, journal, { backend, harness, turnId: durableTurnId, onProgress: opts.onProgress, dispatched: true }));
        return realWorker.finalizeHarnessResult(state);
      } finally {
        upsert(sid, {
          inFlight: false, lastUsedMs: Date.now(), activeTurnMode: null, journal: null, activeTurnId: null,
          ...(opts.holdTurnRecord ? { finishedJournal: journal, finishedTurnId: durableTurnId } : {}),
        });
        if (opts.holdTurnRecord) {
          await markTurnTail(sid, state ? { sha: state.sha || null, pushOk: state.pushOk === true } : {}, { turnId: durableTurnId, journal });
        } else {
          await finishTurn(sid, { turnId: durableTurnId, journal });
        }
      }
    },
    async resumeTurnFromJournal(sessionId, {
      journal, turnId = null, onProgress, agentBackend = 'claude_code', agentHarness = null, providerWasDispatched = false,
    } = {}) {
      if (!journal) throw new Error('resumeTurnFromJournal: journal path required');
      const sid = Number(sessionId);
      upsert(sid, { inFlight: true, adopted: true, activeTurnId: turnId || null, containerName: reg(sid)?.containerName || runtimeName(sid) });
      try {
        const { harness } = realWorker.resolveTurnBackend(agentBackend, agentHarness);
        const { rows: [t] } = await pool.query('SELECT status, step FROM crash_world_turns WHERE journal = $1', [journal]);
        const where = await sessionWorld(sid);
        await world.record('turn.follow', { step: t?.step || null, at: t ? t.status : 'missing', sessionId: sid }, where.appId);
        const { state, missing } = await consume(sid, journal, { backend: agentBackend, harness, turnId, onProgress, dispatched: providerWasDispatched === true });
        if (!missing && (state.rawStdout || state.execExitSeen)) state.providerDispatched = true;
        // The follower has read the turn's end; nothing of it is kept yet.
        if (t) await world.kill(`followed:${t.step}`);
        return realWorker.finalizeHarnessResult(state);
      } finally {
        upsert(sid, { inFlight: false, lastUsedMs: Date.now() });
      }
    },
    markTurnTail,
    noteTailMilestone,
    finishTurn,
    clearActiveTurn,
    releaseSkippedDispatch,
    async stopTurn(sessionId) {
      const sid = Number(sessionId);
      upsert(sid, { stopRequestedAt: Date.now() });
      const { rowCount } = await pool.query(
        `UPDATE crash_world_turns SET stopped = TRUE WHERE session_id = $1 AND status = 'running'`, [sid]);
      await world.record('turn.stop', { sessionId: sid, running: rowCount });
    },
    clearPendingStop(sessionId) {
      if (!registry.has(Number(sessionId))) return;
      upsert(sessionId, { stopRequestedAt: null });
    },
    getPendingStop: (sessionId) => reg(sessionId)?.stopRequestedAt || null,
    // The commit a turn made but could not push, pushed from its worker.
    async execPushFromWorker(sessionId, branchName) {
      const sid = Number(sessionId);
      const { rows: [w] } = await pool.query('SELECT head_sha FROM crash_world_workspaces WHERE session_id = $1', [sid]);
      if (!w?.head_sha) throw Object.assign(new Error('nothing to push'), { code: 'nothing_to_push' });
      const where = await sessionWorld(sid);
      const { rows: [b] } = await pool.query('SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2', [where.repo, branchName]);
      await pool.query('UPDATE crash_world_branches SET sha = $3 WHERE repo = $1 AND branch = $2', [where.repo, branchName, w.head_sha]);
      await world.record('push', { sha: w.head_sha, from: b?.sha || null, by: 'execPushFromWorker', branch: branchName }, where.appId);
      return { sha: w.head_sha };
    },
    async keepPartialWork(sessionId) {
      await world.record('worker.keepPartialWork', { sessionId: Number(sessionId) });
      return { pushed: false, reason: 'nothing to keep' };
    },
    async readRepoSnapshot() { return null; },
    async writeAppCheck(sessionId) { await world.record('worker.writeAppCheck', { sessionId: Number(sessionId) }); },
    // The screenshot step, detached: done as soon as it starts.
    async startDetachedCapture(containerName, { id } = {}) {
      await pool.query(
        `INSERT INTO crash_world_captures (id, container, state, output) VALUES ($1, $2, 'done', $3)`,
        [id, containerName, captureStdout()]);
      await world.record('capture.start', { id, containerName });
    },
    async detachedCaptureStatus(containerName, id) {
      const { rows: [c] } = await pool.query('SELECT state FROM crash_world_captures WHERE id = $1 AND container = $2', [id, containerName]);
      return { state: c ? c.state : 'gone' };
    },
    async readDetachedCapture(containerName, id) {
      const { rows: [c] } = await pool.query('SELECT output FROM crash_world_captures WHERE id = $1', [id]);
      return c?.output || '';
    },
    async clearDetachedCapture(containerName, id) { await pool.query('DELETE FROM crash_world_captures WHERE id = $1', [id]); },
    async stopDetachedCapture(containerName, id) { await pool.query(`UPDATE crash_world_captures SET state = 'gone' WHERE id = $1`, [id]); },
    touchWorker() {},
    async syncUserAgentFiles() {},
    getTurnByokCents: () => 0,
    noteTurnByokSpend() {},
    markTurnByokSwitched() {},
    async listOrphanWorkers() { return []; },
    async listWorkerVolumes() { return []; },
    async evictWorker(sessionId) { await world.record('worker.evict', { sessionId: Number(sessionId) }); },
    async destroyWorker(name) { await world.record('worker.destroy', { name }); },
    async stopWorker(name) { await world.record('worker.stop', { name }); },
    async retireWorker(sessionId) { await world.record('worker.retire', { sessionId: Number(sessionId) }); },
    holdWorker() { return () => {}; },
    warmRegistrySnapshot: () => [...registry.entries()].map(([sessionId, m]) => ({ sessionId, ...m })),
  };
  outside(world, 'services/worker', {
    keep: ['describePushFailure', 'isBootstrapError', 'isRetryableBootstrapError', 'isTailPhase', 'newWatchState', 'parseLine',
      'finalizeHarnessResult', 'resolveTurnBackend', 'unpushedCommit', 'claudeTurnModel', 'parseClaudeResponse',
      'buildAppCheckCommand', 'newWatchdogCounters', 'recordWatchdogProbe', 'turnPromptPaths'],
    // Not offered by this worker, so the features that need them skip.
    drop: ['runBenchCapture', 'runLiveScript'],
    overrides: fake,
  });
  // ── The model: the bot's OpenRouter key, the catalog, the reviewer ─────
  const realCredentials = require(path.join(SRC, 'services/credential-store'));
  world.stub(path.join(SRC, 'services/credential-store'), {
    ...realCredentials,
    // The bot's included key is a real row (the test's); only its secret,
    // which would need the platform's data key, is not read.
    async readSecret() { return 'sk-or-v1-test'; },
  });
  const realModels = require(path.join(SRC, 'services/agent-models'));
  world.stub(path.join(SRC, 'services/agent-models'), {
    ...realModels,
    async resolveModelPricing({ modelId } = {}) {
      return {
        id: modelId, name: modelId, inputPricePerMillion: 1, outputPricePerMillion: 2,
        supportsImages: true, supportsReasoning: false, supportsTools: true, contextLength: 200000, maxOutputTokens: 32000,
      };
    },
  });
  const realLimits = require(path.join(SRC, 'services/limits'));
  world.stub(path.join(SRC, 'services/limits'), {
    ...realLimits,
    // The bot's allowance is never what stops these builds.
    async checkBudget() { return { weeklyRemaining: 1e9, limitCents: 1e9 }; },
    // Each debit, as the build that made it (the child's AsyncLocalStorage).
    async recordSpend(p, userId, cents, opts) {
      await world.record('debit', { userId, cents });
      return realLimits.recordSpend(p, userId, cents, opts);
    },
  });
  const realManaged = require(path.join(SRC, 'services/openrouter-managed-keys'));
  world.stub(path.join(SRC, 'services/openrouter-managed-keys'), {
    ...realManaged,
    async usesIncludedKey() { return true; },
    async ensureIncludedKey() { return { created: false }; },
    async syncAllowance() { return null; },
  });
  const realMayor = require(path.join(SRC, 'services/openrouter-mayor'));
  world.stub(path.join(SRC, 'services/openrouter-mayor'), {
    ...realMayor,
    // The reviewer: its verdict for round N is the scenario's (plan.reviewer).
    createClient() {
      return {
        async streamChat({ chatMessages = [], telemetryContext = {} } = {}) {
          const text = (chatMessages[0]?.content || []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
          const round = Number((/ROUND (\d+) of (\d+)\./.exec(text) || [])[1]) || 1;
          const plan = await planOf(telemetryContext.appId);
          const verdict = (plan.reviewer || [])[round - 1] || 'ship';
          await world.record('reviewer.call', { round, verdict, sessionId: telemetryContext.sessionId ?? null }, telemetryContext.appId);
          const issues = verdict === 'fix' ? [{
            id: `tap-target-${round}`, severity: 'major', screen: 'Phone, light look',
            problem: 'The add button is too small to tap.', fix: 'Make the add button at least 44px tall.',
          }] : [];
          return { text: JSON.stringify({ verdict, issues, previousFixed: round > 1 ? [`tap-target-${round - 1}`] : [] }), usage: { prompt_tokens: 1000, completion_tokens: 200 } };
        },
        estimateCostCents() { return 2; },
      };
    },
  });

  // ── The promote route ─────────────────────────────────────────────────
  const realVotes = require(path.join(SRC, 'routes/votes'));
  async function promote(sessionId) {
    const db = world.appPool();
    const { rows: [s] } = await db.query(
      `SELECT cs.status, cs.branch_name, cs.pr_number, cs.app_id, a.repo_url
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [sessionId]);
    if (!s || !['active', 'paused'].includes(s.status)) return { status: 409, body: { error: 'This change is not open to propose.' } };
    const repo = repoOf(s.repo_url);
    let number = s.pr_number || (await pool.query(
      `SELECT number FROM crash_world_prs WHERE repo = $1 AND branch = $2 AND state = 'open'`, [repo, s.branch_name])).rows[0]?.number;
    if (!number) {
      const { rows: [pr] } = await pool.query(
        `INSERT INTO crash_world_prs (repo, number, branch, session_id)
         VALUES ($1, (SELECT COALESCE(max(number), 0) + 1 FROM crash_world_prs WHERE repo = $1), $2, $3) RETURNING number`,
        [repo, s.branch_name, sessionId]);
      number = pr.number;
      await world.record('github.pr', { repo, number, branch: s.branch_name, sessionId }, s.app_id);
    }
    // GitHub opened it; the session's row is not written yet.
    await world.kill('promote:pr');
    await db.query(
      `UPDATE chat_sessions SET status = 'promoted', pr_number = $2,
              pr_title = COALESCE(NULLIF(proposed_pr_title, ''), session_title) WHERE id = $1`, [sessionId, number]);
    await world.record('promote', { sessionId, number }, s.app_id);
    return { status: 200, body: { ok: true, prNumber: number } };
  }
  world.stub(path.join(SRC, 'routes/votes'), {
    ...realVotes,
    voteRoutes: () => ({
      handle(req, res) {
        const id = Number((String(req.url).match(/sessions\/(\d+)\/promote/) || [])[1]);
        promote(id).then((r) => res.status(r.status).json(r.body), (err) => res.status(500).json({ error: err.message }));
      },
    }),
  });

};
