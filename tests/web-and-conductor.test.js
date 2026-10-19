'use strict';

// What a process that never leads needs from the one that does, and what
// each process does for itself (docs/plans/web-and-conductor.md): statuses
// the leader keeps in memory, published for the others; the leader's loops
// woken over the bus from wherever a request landed; the open-issues copy
// kept in step across processes; DM answers asked again exactly once;
// workers warm in one process left alone by the others; and a web process
// that never stands for election. The other process is played by the
// registry's copy of its holds (a fake database answers the mirror's read)
// and the bus by a stub of its publish.
//
// Run with: node --test tests/web-and-conductor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const processes = require('../src/services/processes');
const wsBus = require('../src/services/ws-bus');
const leaderStatus = require('../src/services/leader-status');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The registry, over a database whose only other live process ('pod-web')
// holds `held` ([kind, ref] pairs). `holders` is answered exactly too.
async function elsewhere(held, other = 'pod-web') {
  processes._reset();
  const pool = {
    query: async (sql, params = []) => {
      if (/FROM process_holds h\s+JOIN platform_processes p ON p\.id = h\.process_id\s+WHERE h\.process_id <> \$1/.test(sql)) {
        return { rows: held.map(([kind, ref]) => ({ kind, ref: String(ref), process_id: other })) };
      }
      if (/SELECT DISTINCT h\.process_id/.test(sql)) {
        const kinds = [].concat(params[0]);
        const hit = held.some(([kind, ref]) => kinds.includes(kind) && String(ref) === String(params[1]));
        return { rows: hit ? [{ process_id: other }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await processes.start({ pool, role: 'web' });
  return pool;
}

function capturePublishes(t) {
  const sent = [];
  const real = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { sent.push({ kind, routing, data }); };
  t.after(() => { wsBus.publish = real; });
  return sent;
}

// ── Leader status ─────────────────────────────────────────────────────

test('a status is read from memory where its work runs, and from the leader\'s copy elsewhere', async (t) => {
  leaderStatus._reset();
  t.after(() => leaderStatus._reset());
  const rows = new Map();
  const pool = {
    query: async (sql, params) => {
      if (sql.startsWith('INSERT INTO leader_status')) {
        rows.set(params[0], { value: JSON.parse(params[1]), at: Date.now() });
        return { rows: [] };
      }
      if (sql.includes('FROM leader_status')) {
        const row = rows.get(params[0]);
        const fresh = row && Date.now() - row.at < params[1] * 1000;
        return { rows: fresh ? [{ value: row.value }] : [] };
      }
      return { rows: [] };
    },
  };
  let lastSweepAt = new Date('2026-10-14T12:00:00Z');
  leaderStatus.provide('app-domains.sweep', () => ({ lastSweepAt, lastError: null, sweepInFlight: false }));
  await leaderStatus.start({ pool });
  // Where the work runs: its memory, as it is now.
  lastSweepAt = new Date('2026-10-14T12:05:00Z');
  assert.equal((await leaderStatus.read('app-domains.sweep', pool)).lastSweepAt.toISOString(), '2026-10-14T12:05:00.000Z');
  // Elsewhere (no provider): the copy, as res.json would have sent it.
  assert.deepEqual(rows.get('app-domains.sweep').value,
    { lastSweepAt: '2026-10-14T12:00:00.000Z', lastError: null, sweepInFlight: false });
  leaderStatus.stop();
  const published = rows.get('app-domains.sweep').value;
  leaderStatus._reset();
  rows.set('app-domains.sweep', { value: published, at: Date.now() });
  assert.deepEqual(await leaderStatus.read('app-domains.sweep', pool), published);
  // A copy its leader stopped writing is nobody's.
  rows.set('app-domains.sweep', { value: published, at: Date.now() - leaderStatus.STALE_MS - 1000 });
  assert.equal(await leaderStatus.read('app-domains.sweep', pool), null);
  assert.deepEqual(await leaderStatus.readOr('app-domains.sweep', pool, () => ({ own: true })), { own: true });
  // A database that will not answer is no copy, never a failed route.
  assert.equal(await leaderStatus.read('app-domains.sweep', { query: async () => { throw new Error('down'); } }), null);
});

test('the leader publishes the admin statuses it keeps in memory, and stops as it hands over', () => {
  const body = serverJs.slice(serverJs.indexOf('async function becomeLeader()'), serverJs.indexOf('async function start()'));
  for (const key of [
    "'bench-lane'",
    "'staging-reap.automatic'",
  ]) {
    assert.ok(body.includes(`leaderStatus.provide(${key}`), `becomeLeader publishes ${key}`);
  }
  assert.match(body, /leaderStatus\.start\(\{ pool: getPool\(config\) \}\)/);
  // The Homeroom bot's loop keeps nothing in memory to publish: its lane is
  // a workflow instance every process reads (homeroom-bot.js loopMemory).
  assert.ok(!body.includes("require('./src/services/homeroom-bot').MEMORY_STATUS_KEY"));
  const cleanupBody = serverJs.slice(serverJs.indexOf('async function cleanup()'));
  assert.match(cleanupBody, /require\('\.\/src\/services\/leader-status'\)\.stop\(\)/);
  // And the routes read them wherever they are served.
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.js'), 'utf8');
  assert.match(admin, /automatic: await leaderStatus\.readOr\('staging-reap\.automatic', pool, stagingReap\.readAutomatic\)/);
  // The custom-domain sweep and the storage cap's are scheduled jobs of the
  // workflow: their status is the clock's last run, read wherever they ran.
  assert.match(admin, /sweep: await clocks\.status\(pool, 'app-domains'\)/);
  assert.match(admin, /await clocks\.status\(pool, 'app-storage-cap'\)/);
  assert.ok(!body.includes("'app-domains.sweep'") && !body.includes('LAST_SWEEP_STATUS_KEY'), 'no leader publishes them');
  const bench = fs.readFileSync(path.join(__dirname, '..', 'src/routes/homeroom-bench.js'), 'utf8');
  assert.equal(bench.match(/lane: await leaderStatus\.readOr\('bench-lane', pool, lane\.laneStatus\)/g).length, 2);
});

test('the Homeroom bot\'s queue shows why a row waits from its lane, the same in every process', async () => {
  const bot = require('../src/services/homeroom-bot');
  const now = Date.now();
  const waiting = {
    id: 1, app_id: 5, issue_number: 9, priority: 1, reason: 'new', started_at: null, waiting_total: 1, running_total: 0,
  };
  const pool = { query: async () => ({ rows: [waiting] }) };
  // What the lane says (loopMemory's shape): a platform fault pausing grants.
  const memory = { loop: null, inFlight: [], backoff: [], fault: { attempts: 1, until: now + 60_000, error: null, at: null }, budgetUntil: 0 };
  const snap = await bot.queueSnapshot(pool, {}, { now, memory });
  assert.equal(snap.items[0].waiting.reason, 'platform_fault');
  // Read from the lane's instance and the slots its requests hold, in any
  // process: nothing is copied from a leader's memory.
  const lanePool = {
    query: async (sql) => (/FROM wf_instances WHERE machine = \$1 AND key = \$2/.test(sql)
      ? { rows: [{ data: { fault: { until: new Date(now + 60_000).toISOString(), attempts: 2 }, refresh: { n: 3, due: null }, grants: 7 }, updated_at: new Date(now).toISOString() }] }
      : { rows: [] }),
  };
  const fromLane = await bot.loopMemory(lanePool, now);
  assert.equal(fromLane.fault.attempts, 2);
  assert.equal(fromLane.loop.grants, 7);
  assert.deepEqual((await bot.loopMemory({ query: async () => ({ rows: [] }) }, now)).inFlight, []);
});

// ── Wakes over the bus ────────────────────────────────────────────────

test('a launch on a process not running the bench lane or the eval runner wakes the one that does', (t) => {
  const sent = capturePublishes(t);
  const lane = require('../src/services/bench/lane');
  const runner = require('../src/services/shots-eval-runner');
  assert.equal(lane.wake(), false, 'the lane does not run here');
  assert.equal(runner.wake(), false, 'nor the runner');
  assert.deepEqual(sent.map((m) => m.kind), ['bench_wake', 'shots_eval_wake']);
  // Where they do not run either, the bus half does nothing and publishes nothing.
  sent.length = 0;
  const ws = require('../src/services/ws');
  ws._onBusMessage({ kind: 'bench_wake', data: {} });
  ws._onBusMessage({ kind: 'shots_eval_wake', data: {} });
  assert.deepEqual(sent, [], 'a wake is never passed on again');
  assert.equal(lane.wakeHere(), false);
  assert.equal(runner.wakeHere(), false);
});

// ── The open-issues copy ──────────────────────────────────────────────

test('issues one process closes leave every process\'s open-issues copy, and are never passed on again', (t) => {
  const sent = capturePublishes(t);
  const github = require('../src/services/github');
  github.noteIssuesClosed('Acme', 'board', [4, 'x', 5]);
  github.invalidateIssuesCache('Acme', 'board');
  github.unsuppressIssues('Acme', 'board', [5]);
  assert.deepEqual(sent, [
    { kind: 'issues_cache', routing: { owner: 'Acme', repo: 'board' }, data: { closed: [4, 5] } },
    { kind: 'issues_cache', routing: { owner: 'Acme', repo: 'board' }, data: { invalidate: true } },
    { kind: 'issues_cache', routing: { owner: 'Acme', repo: 'board' }, data: { open: [5] } },
  ]);
  sent.length = 0;
  const ws = require('../src/services/ws');
  ws._onBusMessage({ kind: 'issues_cache', routing: { owner: 'Acme', repo: 'other' }, data: { closed: [7] } });
  ws._onBusMessage({ kind: 'issues_closed', routing: { owner: 'Acme', repo: 'other' }, data: { numbers: [8] }, fromWorkflow: true });
  assert.deepEqual(sent, [], 'what another process shared is applied here only');
  // Applied: the closed numbers are suppressed here, as noteIssuesClosed does.
  assert.equal(github.unsuppressIssues('Acme', 'other', [7, 8]), 2);
});

// ── DM answers asked again ────────────────────────────────────────────

// 17 Oct 2026: a later try at a DM answer is the person's DM machine's own
// timer (src/workflow/bot-dm/), so no process marks or holds one, and the
// leader sweeps for none a process that died left.
test('a DM answer asked again later is the DM machine\'s, never a process\'s mark or the leader\'s sweep', () => {
  const kinds = fs.readFileSync(path.join(__dirname, '..', 'src/services/processes.js'), 'utf8');
  assert.doesNotMatch(kinds, /'dm_defer'|'dm_answer'/);
  const bot = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.doesNotMatch(bot, /resumeDeferred|deferResumeTimer/);
  const mayor = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-mayor.js'), 'utf8');
  assert.doesNotMatch(mayor, /scheduleDeferred|setTimeout\(work, ms\)/);
  assert.match(mayor, /if \(typeof deps\.onLater === 'function'\) deps\.onLater\(next\);/, 'the answer\'s work hears it and the machine sets its timer');
  const machine = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/bot-dm/machine.ts'), 'utf8');
  assert.match(machine, /timer: \{ at: new Date\(ctx\.now\.getTime\(\) \+ DEFER_DELAYS_MS\[later - 1\]!\), event: \{ type: 'TryAgain' \} \}/);
});

// ── Warm workers ──────────────────────────────────────────────────────

test('a worker warm here is a marker other processes read, never work a drain waits for', (t) => {
  processes._reset();
  t.after(() => processes._reset());
  const worker = require('../src/services/worker');
  worker._registryUpsertForTests(9201, { lastUsedMs: Date.now(), inFlight: false });
  assert.equal(processes.heldHere('warm', 9201), true);
  assert.equal(processes.localCount(), 0, 'warm is had, not done');
  assert.deepEqual(processes.localSnapshot(), []);
  worker._registryUpsertForTests(9201, { inFlight: true });
  assert.equal(processes.localCount(), 1, 'a turn in it is');
  worker.forgetWorker(9201);
  assert.equal(processes.heldHere('warm', 9201), false);
  assert.equal(processes.heldHere('session', 9201), false);
});

test('the idle sweep leaves a worker another process keeps warm, and adoption leaves it too', () => {
  const sweeper = serverJs.slice(serverJs.indexOf('function startIdleEvictionSweeper()'));
  assert.match(sweeper.slice(0, 3000), /if \(processes\.heldElsewhere\('warm', meta\.sessionId\)\) \{\n\s+worker\.forgetWorker\(meta\.sessionId\);/,
    'the last one keeping it warm evicts it');
  // A draining process lets go of its idle ones, so the next leader adopts them.
  const cleanupBody = serverJs.slice(serverJs.indexOf('async function cleanup()'));
  assert.match(cleanupBody.slice(0, 4000), /if \(!meta\.inFlight && !meta\.bootstrapping\) worker\.forgetWorker\(meta\.sessionId\);/);
  const adopt = serverJs.slice(serverJs.indexOf('async function adoptOrphanWorker('));
  assert.match(adopt, /processes\.holders\('warm', sessionId, pool\)/);
});

test('a heal under way elsewhere is not started twice', async (t) => {
  await elsewhere([['app_heal', 'ear-trainer']]);
  t.after(() => processes._reset());
  const heal = require('../src/services/app-heal');
  const out = await heal.checkAndHealOne({}, null, { slug: 'ear-trainer', runtime_kind: 'docker' });
  assert.deepEqual(out, { status: 'in_flight', slug: 'ear-trainer' });
});

// ── Roles at boot ─────────────────────────────────────────────────────

test('a web process never stands for leader, and only a serving one says its merges are live', () => {
  const startBody = serverJs.slice(serverJs.indexOf('async function start()'), serverJs.indexOf('// Boot only when run as the entry point'));
  assert.match(startBody, /const ownRole = processRole\.processRole\(\);/);
  assert.match(startBody, /await processes\.start\(\{ pool: getPool\(config\), role: ownRole \}\);/);
  const web = startBody.indexOf('} else if (!processRole.standsForLeader(ownRole)) {');
  const elect = startBody.indexOf('leadership.start(becomeLeader)');
  assert.ok(web !== -1 && elect > web, 'the election is the last branch, after the web one');
  assert.match(startBody, /if \(processRole\.servesRequests\(ownRole\)\) platformRelease\.recordRunning\(getPool\(config\)\);/);
  // The merge-followups machine hears it from the same place, never from a
  // conductor's boot (src/workflow/platform.ts releaseServing).
  assert.match(startBody, /if \(processRole\.servesRequests\(ownRole\)\) require\('\.\/src\/workflow\/platform\.ts'\)\.releaseServing\(getPool\(config\)\);/);
  // The sweeps that read busy before acting read it for every process.
  assert.equal((serverJs.match(/worker\.isInFlight\(session\.id\) \|\| activeWorkersSvc\.isSessionBusy\(session\.id\)/g) || []).length, 2);
});

// ── The chart ─────────────────────────────────────────────────────────

const { spawnSync } = require('node:child_process');
const helmAvailable = spawnSync('helm', ['version', '--short']).status === 0;

function render(extra = []) {
  const args = ['template', 'test', 'deploy/helm/social-vibecoding-platform',
    '--set', 'enabled=true', '--set', 'networkPolicy.appNamespace=social-apps',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)}`, ...extra];
  for (const field of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${field}.digest=sha256:${'b'.repeat(64)}`);
  }
  const out = spawnSync('helm', args, { encoding: 'utf8', cwd: path.join(__dirname, '..') });
  assert.equal(out.status, 0, out.stderr);
  const { parseAllDocuments } = require('yaml');
  return parseAllDocuments(out.stdout).map((d) => d.toJSON()).filter(Boolean);
}

test('the chart runs a conductor beside the web Pods by default, and the Service follows the Deployments', { skip: !helmAvailable }, () => {
  const objects = render();
  const deployments = objects.filter((o) => o.kind === 'Deployment');
  const role = (d) => d.spec.template.spec.containers[0].env.find((e) => e.name === 'PROCESS_ROLE')?.value;
  assert.deepEqual(deployments.map((d) => [d.metadata.name, role(d)]),
    [['social-vibecoding', 'web'], ['social-vibecoding-conductor', 'conductor']]);
  const [web, conductor] = deployments;
  assert.equal(web.spec.template.metadata.labels['social.usernode.io/serves-requests'], 'true');
  assert.equal(conductor.spec.template.metadata.labels['social.usernode.io/serves-requests'], undefined, 'no requests for the conductor');
  assert.equal(conductor.spec.template.metadata.labels['app.kubernetes.io/component'], 'platform', 'the platform\'s network identity');
  const service = objects.find((o) => o.kind === 'Service' && o.metadata.name === 'social-vibecoding');
  assert.equal(service.spec.selector['social.usernode.io/serves-requests'], 'true');
  assert.equal(service.metadata.annotations['argocd.argoproj.io/sync-wave'], '1',
    'after the Deployments are healthy, so a selector requiring the label never finds none Ready');
  const pdb = objects.find((o) => o.kind === 'PodDisruptionBudget' && o.metadata.name.endsWith('-platform'));
  assert.equal(pdb.spec.selector.matchLabels['social.usernode.io/serves-requests'], 'true');

  // Off: one Deployment that serves and leads, and a selector without the label.
  const off = render(['--set', 'platform.conductor.enabled=false']);
  const only = off.filter((o) => o.kind === 'Deployment');
  assert.deepEqual(only.map((d) => [d.metadata.name, role(d)]), [['social-vibecoding', undefined]]);
  assert.equal(off.find((o) => o.kind === 'Service' && o.metadata.name === 'social-vibecoding')
    .spec.selector['social.usernode.io/serves-requests'], undefined);
  assert.equal(off.filter((o) => o.metadata?.name?.endsWith('-conductor')).length, 0, 'no conductor budget either');
});

test('the conductor runs the workflow in replicas: its budget, its spread, its pool and its metrics', { skip: !helmAvailable }, () => {
  const objects = render(['--api-versions', 'monitoring.coreos.com/v1', '--set', 'platform.conductor.replicas=2']);
  const env = (d) => new Map(d.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
  const web = objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'social-vibecoding');
  const conductor = objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'social-vibecoding-conductor');
  assert.equal(conductor.spec.replicas, 2);
  assert.equal(env(conductor).get('DB_POOL_MAX'), '30', 'its own request pool: it serves nobody');
  assert.equal(env(conductor).get('WF_METRICS_PORT'), '9464');
  assert.equal(env(web).get('WF_METRICS_PORT'), undefined, 'a web Pod runs no workflow, and serves no metrics');
  assert.ok(conductor.spec.template.spec.containers[0].ports.some((p) => p.name === 'metrics' && p.containerPort === 9464));
  const spread = conductor.spec.template.spec.topologySpreadConstraints;
  assert.equal(spread[0].topologyKey, 'kubernetes.io/hostname');
  assert.equal(spread[0].labelSelector.matchLabels['social.usernode.io/process-role'], 'conductor');
  assert.equal(web.spec.template.spec.topologySpreadConstraints, undefined);
  // A node drain evicts one at a time, and never blocks at one replica.
  const budget = objects.find((o) => o.kind === 'PodDisruptionBudget' && o.metadata.name === 'social-vibecoding-conductor');
  assert.equal(budget.spec.maxUnavailable, 1);
  assert.equal(budget.spec.selector.matchLabels['social.usernode.io/process-role'], 'conductor');
  // Prometheus scrapes the metrics port, admitted from its namespace only.
  const monitor = objects.find((o) => o.kind === 'PodMonitor');
  assert.equal(monitor.spec.podMetricsEndpoints[0].port, 'metrics');
  assert.equal(monitor.metadata.labels.release, 'kube-prometheus-stack');
  const rules = objects.find((o) => o.kind === 'PrometheusRule').spec.groups[0].rules.map((r) => r.alert);
  assert.ok(rules.includes('SocialWorkflowNoConductor') && rules.includes('SocialWorkflowWorkNobodyTakes'));
  const policy = objects.find((o) => o.kind === 'NetworkPolicy' && o.metadata.name.endsWith('-platform'));
  assert.ok(policy.spec.ingress.some((r) => r.ports?.[0]?.port === 9464
    && r.from?.[0]?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'monitoring'));
  // A cluster without the Prometheus Operator's kinds gets no monitors.
  assert.equal(render().filter((o) => o.kind === 'PodMonitor' || o.kind === 'PrometheusRule').length, 0);
});
