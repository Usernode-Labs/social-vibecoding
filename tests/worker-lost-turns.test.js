// A coding turn whose worker went from under it (17 Oct 2026).
//
// Homeroom bot builds on the platform's own repository ended "It made no
// change" and told their requester "I ended up with no changes to show you".
// They had not ended at all: 33 of the 40 such builds in two weeks had their
// worker OOM-killed partway through (exit 137) at its 2g limit, after the
// agent had edited a median of 20 files. Three things are pinned here:
//
//   - a worker on the platform's own repository gets more memory
//     (WORKER_MEMORY_PLATFORM_REPO, 4g by default), chosen when it is made;
//   - a turn the worker lost is said as failed, with why, everywhere the bot
//     reads a turn (homeroom-bot-live.js workerLostReason), and recorded as
//     the worker's failure (error_code worker_lost, markerless_cause) rather
//     than a provider's;
//   - every turn reports its container's memory (worker/memory-fields.sh),
//     so how close a build that survived came to its limit can be read.
//
// Run with: node --test tests/worker-lost-turns.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const track = require('../src/services/homeroom-bot-track');
const worker = require('../src/services/worker');
const llmTelemetry = require('../src/services/llm-telemetry');
const sessionLifecycle = require('../src/services/session-lifecycle');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const MIN = 60 * 1000;

// What the worker returned for run 2428's build turn (#5391, session 9091):
// the container was OOM-killed at 14:29:02 and the watchdog found no exit
// marker. The agent had edited 26 files.
const OOM = Object.freeze({
  agentHarness: 'claude', ccExit: null, exitCode: -1, markerlessCause: 'oom_killed',
  pushOk: false, ahead: 0, sha: null, lastResultText: '',
  routedProvider: 'Together', routedProviders: ['Together'], toolCallCount: 85, fileChangeCount: 26,
});

// ── Saying it ───────────────────────────────────────────────────────────

test('workerLostReason: each cause the worker records, in words that read as no other cause', () => {
  const cases = [
    ['oom_killed', 'its worker ran out of memory'],
    ['container_gone', 'its worker stopped partway through'],
    ['turn_process_gone', 'the agent stopped partway through without a result'],
    ['probe_unobservable', 'the platform lost sight of its worker'],
    ['something_new', 'the agent ended without a result'],
  ];
  for (const [cause, words] of cases) {
    assert.equal(live.workerLostReason({ exitCode: -1, markerlessCause: cause }), words, cause);
    // The requester's words read the run's record for its cause; none of
    // these may read as a restart, a start, a time-out or no change.
    const reason = `the build turn failed (${words})`;
    assert.equal(dm.buildFailedCause(reason).cause, 'other', reason);
    assert.equal(track.buildStopWhy(reason), 'build_failed', reason);
    assert.equal(bot.isInfraBuildError(reason), false, `${reason} is the build's, not the lane's`);
  }
  // An exit code below zero is one the worker could not read.
  assert.equal(live.workerLostReason({ exitCode: -1 }), 'the agent ended without a result');
  assert.equal(live.workerLostReason({ exitCode: 0 }), null);
  assert.equal(live.workerLostReason({ exitCode: 1 }), null, 'a real exit code is failedClaudeTurn\'s to say');
  assert.equal(live.workerLostReason(null), null);
});

test('failedClaudeTurn says a lost worker under either CLI, and is unchanged otherwise', () => {
  assert.equal(live.failedClaudeTurn(OOM), 'its worker ran out of memory');
  assert.equal(live.failedClaudeTurn({ ...OOM, agentHarness: 'codex' }), 'its worker ran out of memory',
    'neither runner reached its end, so nothing was committed under Codex either');
  assert.equal(live.failedClaudeTurn({ agentHarness: 'claude', ccExit: 0, exitCode: 0, lastResultText: 'Done.' }), null);
  assert.equal(live.failedClaudeTurn({ agentHarness: 'claude', exitCode: 1, lastResultText: 'Edited app.js.' }), 'the agent exited with code 1');
  assert.equal(live.failedClaudeTurn({ agentHarness: 'codex', ccExit: 1, exitCode: 1, ccIsError: true }), null);
});

test('turnFault and turnFailureReason agree: a turn called failed always has a reason', () => {
  const results = [
    OOM,
    { ...OOM, agentHarness: 'codex' },
    { agentHarness: 'claude', ccExit: 1, exitCode: 1 },
    { agentHarness: 'codex', ccExit: null, exitCode: 1, agentExit: 1 },
    { agentHarness: 'codex', agentExit: 2 },
    { agentHarness: 'codex', fatalError: 'worker bootstrap is not ready' },
    { agentHarness: 'codex', ccIsError: true },
    { agentHarness: 'claude', exitCode: -1 },
    { agentHarness: 'claude', ccExit: 0, exitCode: 0, pushOk: true, ahead: 0 },
    { agentHarness: 'claude', ccExit: 0, exitCode: 0, pushOk: true, ahead: 2 },
    {},
  ];
  for (const r of results) {
    const fault = live.turnFault({ routed: { result: r }, stopped: false });
    const why = live.turnFailureReason(r);
    assert.equal(fault === 'failed', !!why, JSON.stringify(r));
  }
  assert.equal(live.turnFailureReason({ agentHarness: 'codex', agentExit: 2 }), 'the agent exited with code 2');
  assert.equal(live.turnFailureReason({ agentHarness: 'codex', fatalError: 'worker bootstrap is not ready' }),
    'the worker reported an error: worker bootstrap is not ready');
});

function harness(turns) {
  const calls = { builds: [], events: [], closed: [] };
  sessionLifecycle.closeOwnSession = async ({ sessionId, reason }) => { calls.closed.push({ sessionId, reason }); return true; };
  const script = [...turns];
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 5001, app_id: 10, user_id: 77 }] };
      if (/INSERT INTO events/.test(sql)) calls.events.push({ type: params[3] });
      return { rows: [] };
    },
  };
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
      async execInWorker(_id, opts) {
        if (opts.mode === 'scout') return { lastResultText: '' };
        calls.builds.push(opts);
        return { ...script.shift() };
      },
      stopTurn() { return Promise.resolve(); },
      getPendingStop() { return null; },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        if (args.mode === 'scout') return { result: await args.dispatchOnce({}), error: null, estimatedCostUsd: 0.01 };
        return { result: await args.dispatchOnce({}), error: null, estimatedCostUsd: 0.05 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `homeroom_bot/s${sessionId}` }; } },
    activeWorkers: new Set(),
    seesImages: false,
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: {}, bot: { id: 77, username: 'homeroom_bot' },
  app: { id: 10, slug: 'usernode-2d5619', name: 'Homeroom', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' },
  repo: { owner: 'Usernode-Labs', repo: 'social-vibecoding' }, issueNumber: 5391,
  issue: { title: 'Workshop: remove the chips' }, seed: 'Please build issue #5391.',
  buildNote: 'Remove the chips.', turnBudgetMs: 40 * MIN, model: 'z-ai/glm-5.3-flash',
  origin: { lane: 'live', runId: 2428 },
};

test('a build whose worker ran out of memory fails as that, never as one that changed nothing', async () => {
  const h = harness([OOM]);
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(out.ok, false);
  assert.match(out.error, /^the build turn failed \(its worker ran out of memory\)/);
  assert.doesNotMatch(out.error, /no change/);
  assert.equal(h.calls.builds.length, 1, 'a failed turn is not nudged');
  assert.equal(out.noChange, undefined, 'nor kept as an early quit');
  assert.deepEqual(h.calls.events.filter((e) => /no_change|nudged/.test(e.type)), []);
  // The requester reads that it did not finish, not that it found nothing to do.
  assert.equal(dm.buildFailedWords(out.error),
    'I couldn\'t finish building this: something went wrong while I was working on it.');
  assert.equal(live.buildFailedText(out.error),
    'Homeroom bot couldn\'t finish building this: something went wrong during the build. '
      + 'Reply here (or on the GitHub issue) and it will try again.');
  assert.equal(track.buildStopWhy(out.error), 'build_failed');
});

// ── Recording it ────────────────────────────────────────────────────────

test('the worker says why a turn left no exit marker in the log, on the Kubernetes path too', () => {
  const src = read('src/services/worker.js');
  const abandon = src.slice(src.indexOf('if (verdict.abandon) {'), src.indexOf("state.markerlessCause = 'probe_unobservable';") + 200);
  assert.match(abandon, /state\.markerlessCause = termination\?\.oomKilled \? 'oom_killed'/);
  assert.match(abandon, /log\.warn\('worker', 'Turn ended without an exit marker', \{[\s\S]*?cause: state\.markerlessCause/);
  assert.equal((abandon.match(/'Turn ended without an exit marker'/g) || []).length, 2, 'the abandon and the deadline');
});

test('a lost worker is the worker\'s failure on the ledger, with its cause, not the provider\'s', () => {
  const sessions = read('src/routes/sessions.js');
  const code = sessions.slice(sessions.indexOf('function codexLedgerErrorCode('), sessions.indexOf('function codexLedgerErrorCode(') + 600);
  assert.match(code, /if \(result\?\.markerlessCause\) return 'worker_lost';/);
  const turns = read('src/services/agent-turn.js');
  assert.match(turns, /worker_lost: 'worker',/);
  assert.match(turns, /: result\?\.markerlessCause \? 'worker_lost' : null,/, 'a turn a restart recovered too');
  const metrics = llmTelemetry.normalizeDiagnostics({ markerlessCause: 'oom_killed', errorClass: 'worker' });
  assert.equal(metrics.markerless_cause, 'oom_killed');
  assert.equal(metrics.error_class, 'worker');
  assert.equal(llmTelemetry.normalizeDiagnostics({ markerlessCause: 'anything else' }).markerless_cause, undefined,
    'a strict enum: nothing free-form reaches the ledger');
});

// ── Memory ──────────────────────────────────────────────────────────────

test('a worker on the platform\'s own repository gets its own memory limit', () => {
  const env = {};
  assert.equal(worker.workerMemoryFor('Usernode-Labs', 'social-vibecoding', env), '4g');
  assert.equal(worker.workerMemoryFor('usernode-labs', 'SOCIAL-VIBECODING', env), '4g', 'GitHub names ignore case');
  assert.equal(worker.workerMemoryFor('usernode-bot', 'hiking', env), '2g');
  assert.equal(worker.workerMemoryFor(null, null, env), '2g');
  assert.equal(worker.workerMemoryFor('Usernode-Labs', 'social-vibecoding', { WORKER_MEMORY_PLATFORM_REPO: '6g' }), '6g');
  assert.equal(worker.workerMemoryFor('usernode-bot', 'hiking', { WORKER_MEMORY: '1280m' }), '1280m');
  // A fork that hosts itself names its own repository.
  const fork = { USERNODE_PLATFORM_REPO: 'https://github.com/acme/homeroom.git' };
  assert.equal(worker.workerMemoryFor('acme', 'homeroom', fork), '4g');
  assert.equal(worker.workerMemoryFor('Usernode-Labs', 'social-vibecoding', fork), '2g');
});

test('the limit is chosen when the worker is made, for both runtimes, and can be set in the chart', () => {
  const src = read('src/services/worker.js');
  const boot = src.slice(src.indexOf('async function _bootstrapWarmContainer('), src.indexOf('// Public API: ensureWorker, execInWorker, evictWorker'));
  assert.match(boot, /const memory = workerMemoryFor\(repoOwner, repoName\);/);
  assert.match(boot, /kubernetes\.ensureWorker\(kubernetesWorkerConfig\(\), \{\n\s+sessionId, env: safeEnv, onProgress, temporary, memory,/);
  assert.match(boot, /'--memory', memory,/);
  assert.match(read('deploy/helm/social-vibecoding-platform/templates/platform.yaml'),
    /- \{name: WORKER_MEMORY_PLATFORM_REPO, value: \{\{ \.Values\.config\.workerMemoryPlatformRepo \| quote \}\}\}/);
  assert.match(read('deploy/helm/social-vibecoding-platform/values.yaml'), /\n {2}workerMemoryPlatformRepo: 4g\n/);
  const declared = JSON.parse(read('dapp.json'));
  const all = JSON.stringify(declared);
  assert.match(all, /"key":"WORKER_MEMORY_PLATFORM_REPO"/);
});

test('every runner reports its container\'s memory on its result line, and the image carries the helper', () => {
  const dockerfile = read('worker/Dockerfile');
  assert.match(dockerfile, /\nCOPY memory-fields\.sh \/usr\/local\/bin\/memory-fields\.sh\n/);
  for (const runner of ['worker/run-cc.sh', 'worker/run-codex-agent.sh']) {
    const src = read(runner);
    assert.match(src, /\n\. "\$\(dirname "\$0"\)\/memory-fields\.sh"\n/, runner);
    const results = src.split('\n').filter((l) => l.includes('echo "__USERNODE_RESULT__') && /mode=(build|\$MODE)/.test(l) && !/mode=sync/.test(l));
    assert.ok(results.length >= 3, runner);
    for (const line of results) assert.match(line, /\$MEMORY_FIELDS"|\$\(usernode_memory_fields\)"/, `${runner}: ${line.trim()}`);
  }
});

test('memory-fields.sh reads the container\'s cgroup and leaves out what it cannot read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-'));
  const run = (cgroup) => execFileSync('sh', ['-c', `. "${path.join(root, 'worker/memory-fields.sh')}"; usernode_memory_fields`], {
    env: { ...process.env, USERNODE_CGROUP_DIR: cgroup }, encoding: 'utf8',
  });
  try {
    fs.writeFileSync(path.join(dir, 'memory.peak'), '1553989632\n');
    fs.writeFileSync(path.join(dir, 'memory.max'), '4294967296\n');
    fs.writeFileSync(path.join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n');
    assert.equal(run(dir), ' mem_peak_mib=1482 mem_limit_mib=4096 mem_oom_kills=1');
    fs.writeFileSync(path.join(dir, 'memory.max'), 'max\n');
    assert.equal(run(dir), ' mem_peak_mib=1482 mem_oom_kills=1', 'no limit, no field');
    assert.equal(run(path.join(dir, 'missing')), '', 'nothing to read, nothing said');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the host reads the memory fields into the turn, and the ledger keeps them', () => {
  const state = worker.newWatchState();
  worker.parseLine('__USERNODE_RESULT__ cc_exit=0 ahead=3 behind=0 sha=abc push_ok=1 mode=build stop_hook_blocks=0 mem_peak_mib=1482 mem_limit_mib=4096 mem_oom_kills=0', null, state);
  assert.equal(state.workerMemoryPeakMib, 1482);
  assert.equal(state.workerMemoryLimitMib, 4096);
  assert.equal(state.workerOomKillCount, 0);
  const metrics = llmTelemetry.normalizeDiagnostics(state);
  assert.equal(metrics.worker_memory_peak_mib, 1482);
  assert.equal(metrics.worker_memory_limit_mib, 4096);
  assert.equal(metrics.worker_oom_kill_count, 0);
  const none = worker.newWatchState();
  worker.parseLine('__USERNODE_RESULT__ cc_exit=0 ahead=0 behind=0 sha= push_ok=0 mode=scout', null, none);
  assert.equal(none.workerMemoryPeakMib, null, 'an older worker reports nothing, and nothing is made up');
  assert.equal(llmTelemetry.normalizeDiagnostics(none).worker_memory_peak_mib, undefined);
});
