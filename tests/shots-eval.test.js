'use strict';

// Before & after shots evals (services/shots-eval.js, its runner in
// services/shots-eval-runner.js): the pure parts. A recipe is what it
// changes from the live shots agent, the live agent is every eval's control,
// a pair is left out when the platform failed a side, and an eval trial's
// shots turn is billed to the platform, never to the proposal's author.
// tests/shots-eval-postgres.test.js runs the rest against the real schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const evals = require('../src/services/shots-eval');
const runner = require('../src/services/shots-eval-runner');
const shotsAgent = require('../src/services/shots-agent');

const CONFIG = { shots: { agentModel: 'claude-sonnet-5-5', maxAgentMs: 480_000 } };

test('a recipe names only what it changes, within its limits', () => {
  assert.deepEqual(evals.validateRecipe({ model: 'claude-opus-5-5', guidance: '  Shoot the phone first.  ' }),
    { ok: true, recipe: { model: 'claude-opus-5-5', guidance: 'Shoot the phone first.' } });
  assert.deepEqual(evals.validateRecipe({ agentMinutes: 12, taskPrompt: '', systemPrompt: null }),
    { ok: true, recipe: { agentMinutes: 12 } });
  assert.equal(evals.validateRecipe({}).ok, false, 'a recipe that changes nothing is refused');
  assert.match(evals.validateRecipe({}).error, /at least one thing/);
  assert.equal(evals.validateRecipe({ model: 'gpt-5' }).ok, false, 'only a Claude model runs the shots agent');
  assert.equal(evals.validateRecipe({ agentMinutes: 1 }).ok, false);
  assert.equal(evals.validateRecipe({ agentMinutes: 21 }).ok, false);
  assert.equal(evals.validateRecipe({ agentMinutes: 2.5 }).ok, false);
  assert.match(evals.validateRecipe({ guidance: 'x'.repeat(8_001) }).error, /guidance is at most 8000/);
  assert.equal(evals.validateRecipe(['model']).ok, false);
});

test('the control runs the live shots agent; a recipe changes only what it names', () => {
  const live = evals.resolveRecipe(CONFIG, null);
  assert.equal(live.model, 'claude-sonnet-5-5');
  assert.equal(live.systemPrompt, shotsAgent.SYSTEM_PROMPT);
  assert.equal(live.taskPrompt, shotsAgent.TASK_PROMPT);
  assert.equal(live.budgetMs, 480_000);
  assert.equal(live.summary.live, true);
  assert.equal(live.summary.systemPrompt.live, true);

  const tried = evals.resolveRecipe(CONFIG, { guidance: 'Wait for the toast to fade.', agentMinutes: 10 });
  assert.equal(tried.model, 'claude-sonnet-5-5', 'the model it did not name is the live one');
  assert.equal(tried.systemPrompt, `${shotsAgent.SYSTEM_PROMPT}\n\nWait for the toast to fade.`, 'guidance goes after the system prompt');
  assert.equal(tried.budgetMs, 600_000);
  assert.equal(tried.summary.live, false);
  assert.equal(tried.summary.systemPrompt.live, true, 'the base prompt is still the live one');
  assert.equal(tried.summary.guidanceChars, 'Wait for the toast to fade.'.length);
  assert.equal(tried.summary.agentMinutes, 10);

  const whole = evals.resolveRecipe(CONFIG, { systemPrompt: 'Shoot every change.', model: 'claude-opus-5-5' });
  assert.equal(whole.systemPrompt, 'Shoot every change.');
  assert.equal(whole.summary.systemPrompt.live, false);
  assert.notEqual(whole.summary.systemPrompt.sha, live.summary.systemPrompt.sha);
  assert.equal(whole.summary.model, 'claude-opus-5-5');
});

test('the live recipe shows its prompts only when asked', () => {
  const hashed = evals.liveRecipe(CONFIG);
  assert.equal(typeof hashed.systemPrompt, 'object');
  assert.match(hashed.systemPrompt.sha, /^[0-9a-f]{12}$/);
  assert.equal(hashed.systemPrompt.chars, shotsAgent.SYSTEM_PROMPT.length);
  assert.equal(evals.liveRecipe(CONFIG, { prompts: true }).systemPrompt, shotsAgent.SYSTEM_PROMPT);
});

const verdict = (status) => ({ passed: status === 'ready', mode: 'shots', runs: 1, stories: [{ id: 'one', status }] });
const trial = (fields) => ({ intent: { stories: [{ id: 'one' }] }, ...fields });

test('a pair is left out when the platform failed a side or neither side shot anything', () => {
  const ready = trial({ state: 'verified', hard_verdict: verdict('ready') });
  const skipped = trial({ state: 'failed', failure_code: 'shots_capture_incomplete', hard_verdict: verdict('skipped') });
  const broken = trial({ state: 'failed', failure_code: 'shots_agent_failed' });
  const outOfTime = trial({ state: 'failed', failure_code: 'shots_agent_timeout' });
  assert.equal(evals.exclusionOf(ready, skipped), null, 'a skip is the arm\'s own result, and is judged');
  assert.equal(evals.exclusionOf(skipped, ready), null);
  assert.equal(evals.exclusionOf(ready, broken), 'platform_failed_arm');
  assert.equal(evals.exclusionOf(broken, ready), 'platform_failed_control');
  assert.equal(evals.exclusionOf(broken, broken), 'platform_failed_both');
  assert.equal(evals.exclusionOf(skipped, outOfTime), 'neither_ready');
});

test('a trial that ended without a verdict reads as every change skipped', () => {
  assert.deepEqual(evals.changeResults(trial({ state: 'failed', failure_code: 'shots_agent_timeout' })),
    [{ id: 'one', status: 'skipped', reason: null, note: null }]);
  assert.deepEqual(evals.changeResults(trial({ state: 'planned' })),
    [{ id: 'one', status: null, reason: null, note: null }]);
  const unchanged = trial({ state: 'verified', hard_verdict: { passed: true, stories: [{ id: 'one', status: 'ready', unchanged: true }] } });
  assert.equal(evals.changeResults(unchanged)[0].status, 'unchanged');
});

test('an arm\'s numbers count its own trials, and the platform\'s failures apart', () => {
  const rows = [
    { ...trial({ state: 'verified', hard_verdict: verdict('ready') }), config_id: null, cost_cents: 200, timings: { agentExploration: 240_000, total: 600_000 }, tool_counts: { save_shot: 2, get_brief: 1 } },
    { ...trial({ state: 'failed', failure_code: 'shots_agent_failed' }), config_id: null, cost_cents: 50 },
    { ...trial({ state: 'verified', hard_verdict: verdict('ready') }), config_id: 7, cost_cents: 100, timings: { agentExploration: 120_000, total: 480_000 } },
    { ...trial({ state: 'failed', failure_code: 'shots_capture_incomplete', hard_verdict: verdict('skipped') }), config_id: 7, cost_cents: 100 },
  ];
  const pairs = [
    { status: 'picked', pick: 'arm', armTrialArm: 'config-7', marks: { control: { one: { shows: 'partly', misleading: false } }, arm: { one: { shows: 'yes', misleading: false } } } },
    { status: 'excluded', excluded_reason: 'platform_failed_control', armTrialArm: 'config-7' },
  ];
  const control = evals.armStats(rows, pairs, 'control');
  assert.equal(control.trials.counted, 1);
  assert.equal(control.trials.platformFailed, 1);
  assert.deepEqual(control.changes, { declared: 1, ready: 1, unchanged: 0, skipped: 0, failed: 0 });
  assert.equal(control.avgCostUsd, 2, 'the platform\'s failure is not in its cost');
  assert.equal(control.medianAgentMinutes, 4);
  assert.equal(control.avgToolCalls, 3);
  assert.equal(control.vsControl, undefined);
  assert.equal(control.marks.partly, 1);

  const arm = evals.armStats(rows, pairs, 'config-7');
  assert.equal(arm.trials.counted, 2);
  assert.deepEqual(arm.changes, { declared: 2, ready: 1, unchanged: 0, skipped: 1, failed: 0 });
  assert.equal(arm.readyRate.rate, 0.5);
  assert.equal(arm.vsControl.wins, 1);
  assert.equal(arm.vsControl.n, 1);
  assert.deepEqual(arm.vsControl.excluded, { platform_failed_control: 1 });
  assert.equal(arm.marks.yes, 1);
  assert.equal(arm.marks.showsRate.rate, 1);
});

test('an eval trial\'s shots turn bills the platform, within its eval\'s cap, and only while it runs', () => {
  runner._resetForTests();
  assert.equal(runner.billsSession(42), false);
  assert.equal(runner.overCap(42, 1e9), false, 'a session no trial runs on has no eval cap');
  runner.start({ query: async () => ({ rows: [] }) }, CONFIG, {
    id: 1, attempt_id: 'a'.repeat(32), session_id: 42, eval_run_id: 3,
  }, { executeTrial: () => new Promise(() => {}) }, { capCents: 500, spentCents: 400 });
  assert.equal(runner.billsSession(42), true);
  assert.equal(runner.billsSession('42'), true);
  assert.equal(runner.billsSession(43), false);
  runner.noteSpend(42, 12.5);
  runner.noteSpend(42, -3);
  runner.noteSpend(43, 99);
  assert.equal(runner._inFlight.get(1).proxyCents, 12.5);
  assert.equal(runner.overCap(42, 87.5), false, 'exactly at the cap is within it');
  assert.equal(runner.overCap(42, 88), true, 'the call that would pass it is refused or cut off');
  runner._resetForTests();
  assert.equal(runner.billsSession(42), false);
});

test('the proxy sends an eval trial\'s calls on the platform key, gated by the eval, and adds them to the trial', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'anthropic-proxy.js'), 'utf8');
  const branch = src.slice(src.indexOf('let shotsEval = null;'), src.indexOf('const isSyncTurn = '));
  assert.match(branch, /turnMode = workerMod \? await workerMod\.turnModeFor\(sessionId\)/, 'the turn\'s mode, whichever process runs it');
  assert.match(branch, /if \(turnMode === 'shots'\)/, 'an eval turn is a shots turn');
  assert.match(branch, /evalRunner\.billsSession\(sessionId\)/, 'the runner here bills the trial');
  assert.match(branch, /evalRunner\.remoteTrialFor\(pool, sessionId\)[\s\S]*evalRunner\.remoteOverCap\(remote, extra\)[\s\S]*evalRunner\.noteRemoteSpend\(pool, remote\.trialId, cents\)/,
    'a trial another process runs is billed on its row (docs/plans/draining-releases.md)');
  assert.match(branch, /shotsEval\.overCap\(0\)[\s\S]*budget_exceeded/, 'an eval at its cap is refused before the call');
  assert.match(branch, /apiKey: config\.anthropicApiKey/, 'the platform key pays');
  assert.match(branch, /shouldKill: \(currentCallCents\) => \(shotsEval\.overCap\(currentCallCents\)/, 'a call that would pass the cap is cut off');
  assert.match(branch, /shotsEval\.noteSpend\(result\.costCents\);\s*return;/, 'each priced call is added to the trial, and nothing else');
  assert.doesNotMatch(branch, /noteAgentSpend|userBudgetCache|systemBudgetCache|loadUserApiKey/,
    'never the author\'s allowance or key, the system bucket, or the change\'s ledger');
  assert.ok(src.indexOf('let shotsEval = null;') < src.indexOf('limits.resolveCaps('), 'it is decided before any allowance is read');
});

test('the arm\'s prompts reach the shots agent, and what Claude Code reports is kept', async () => {
  const seen = [];
  const agent = {
    dispatch: async (_cfg, options) => { seen.push(options); return { backend: 'claude_code', result: { costUsd: 0.42 } }; },
  };
  const entry = { proxyCents: 0, reportedCents: 0 };
  const resolved = evals.resolveRecipe(CONFIG, { guidance: 'Close the toast first.', taskPrompt: 'Shoot it.' });
  const prompted = runner.promptedAgent(resolved, entry, agent);
  await prompted.dispatch(CONFIG, { runId: 'r', timeoutMs: 1 }, {});
  assert.equal(seen[0].systemPrompt, resolved.systemPrompt);
  assert.equal(seen[0].taskPrompt, 'Shoot it.');
  assert.equal(seen[0].runId, 'r', 'everything else the pipeline passes goes through');
  assert.equal(Math.round(entry.reportedCents * 100) / 100, 42);
});

test('the shots agent takes an eval\'s prompts and every proposal\'s own run takes the live ones', async () => {
  const calls = [];
  const workerService = {
    ensureWorker: async () => {},
    execInWorker: async (_id, options) => { calls.push(options); return { exitCode: 0 }; },
  };
  const options = {
    pool: {}, runId: 'b'.repeat(32), origins: {}, authTokens: {},
    session: { id: 5, repo_url: 'https://github.com/acme/demo', branch_name: 'x', status: 'merged' },
  };
  await shotsAgent.dispatch(CONFIG, options, { workerService, agentTurn: {} });
  await shotsAgent.dispatch(CONFIG, { ...options, systemPrompt: 'S', taskPrompt: 'T' }, { workerService, agentTurn: {} });
  assert.equal(calls[0].systemPrompt, shotsAgent.SYSTEM_PROMPT);
  assert.equal(calls[0].prompt, shotsAgent.TASK_PROMPT);
  assert.equal(calls[1].systemPrompt, 'S');
  assert.equal(calls[1].prompt, 'T');
});
