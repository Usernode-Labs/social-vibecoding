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

const wsBus = require('../src/services/ws-bus');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function capturePublishes(t) {
  const sent = [];
  const real = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { sent.push({ kind, routing, data }); };
  t.after(() => { wsBus.publish = real; });
  return sent;
}

// ── Leader status ─────────────────────────────────────────────────────

test('no admin status is kept in a leader\'s memory: each is read from Postgres wherever it is served', () => {
  const body = serverJs.slice(serverJs.indexOf('async function becomeLeader()'), serverJs.indexOf('async function start()'));
  // The last one the leader published, the bench lane's, is its machine's
  // instance now (workflow/bench-lane/): leader-status is gone.
  assert.ok(!serverJs.includes('leader-status') && !serverJs.includes('leaderStatus'));
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src/services/leader-status.js')), false);
  // The automatic stale-preview pass is the preview-gc clock now: nothing of
  // it is kept in the leader's memory.
  assert.ok(!body.includes("'staging-reap.automatic'"), 'no leader publishes the automatic reap');
  // The Homeroom bot's loop keeps nothing in memory to publish: its lane is
  // a workflow instance every process reads (homeroom-bot.js loopMemory).
  assert.ok(!body.includes("require('./src/services/homeroom-bot').MEMORY_STATUS_KEY"));
  // And the routes read them wherever they are served.
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.js'), 'utf8');
  // The custom-domain sweep, the storage cap's and the leftover-preview pass
  // are scheduled jobs of the workflow: their status is the clock's last
  // run, read wherever they ran.
  assert.match(admin, /automatic: await automaticReap\(pool\)/);
  assert.match(admin, /async function automaticReap\(pool\) \{[\s\S]*?await clocks\.status\(pool, 'preview-gc'\)/);
  assert.match(admin, /sweep: await clocks\.status\(pool, 'app-domains'\)/);
  assert.match(admin, /await clocks\.status\(pool, 'app-storage-cap'\)/);
  assert.ok(!body.includes("'app-domains.sweep'") && !body.includes('LAST_SWEEP_STATUS_KEY'), 'no leader publishes them');
  const bench = fs.readFileSync(path.join(__dirname, '..', 'src/routes/homeroom-bench.js'), 'utf8');
  assert.equal(bench.match(/lane: await lane\.laneStatus\(\)/g).length, 2);
  const lane = fs.readFileSync(path.join(__dirname, '..', 'src/services/bench/lane.js'), 'utf8');
  assert.match(lane, /return \(deps\.platform \|\| platform\(\)\)\.benchLaneStatus\(\);/);
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

test('neither the bench lane nor the shots evals need a wake: each is a machine a launch tells, in any process', () => {
  const lane = require('../src/services/bench/lane');
  const evals = require('../src/services/shots-eval');
  assert.equal(lane.wake, undefined);
  assert.equal(typeof lane.look, 'function');
  assert.equal(typeof evals.look, 'function');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src/services/shots-eval-runner.js')), false);
  const ws = fs.readFileSync(path.join(__dirname, '..', 'src/services/ws.js'), 'utf8');
  assert.doesNotMatch(ws, /bench_wake|shots_eval_wake/);
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

test('a worker used here is noted for every process, never held by this one', () => {
  // Which process last used a worker says nothing about who may evict it:
  // every process writes session_workers as it uses one, and the
  // worker-eviction clock evicts what nobody used for the window.
  const worker = fs.readFileSync(path.join(__dirname, '..', 'src/services/worker.js'), 'utf8');
  assert.doesNotMatch(worker, /hold\('warm'/);
  assert.match(worker, /INSERT INTO session_workers \(session_id, last_used_at\)/);
  const processesSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/processes.js'), 'utf8');
  assert.doesNotMatch(processesSrc.slice(processesSrc.indexOf('const KINDS'), processesSrc.indexOf('const KNOWN')), /'warm'/);
  // A draining process forgets nothing: its idle workers are noted already.
  const cleanupBody = serverJs.slice(serverJs.indexOf('async function cleanup()'));
  assert.doesNotMatch(cleanupBody.slice(0, 4000), /forgetWorker/);
});

// A heal is app delivery's work (src/workflow/app-delivery/): one at a time
// per app, never beside its deploy, under the workflow's lease rather than a
// hold another process reads through a mirror (tests/workflow-app-delivery-
// postgres.test.js H1-H3).

// ── Roles at boot ─────────────────────────────────────────────────────

test('no process stands for leader, and only a serving one says its merges are live', () => {
  const startBody = serverJs.slice(serverJs.indexOf('async function start()'), serverJs.indexOf('// Boot only when run as the entry point'));
  assert.match(startBody, /const ownRole = processRole\.processRole\(\);/);
  assert.match(startBody, /await processes\.start\(\{ pool: getPool\(config\), role: ownRole \}\);/);
  assert.ok(!/standsForLeader|becomeLeader|createLeadership/.test(serverJs), 'there is no election');
  assert.match(startBody, /if \(processRole\.servesRequests\(ownRole\)\) platformRelease\.recordRunning\(getPool\(config\)\);/);
  // The merge-followups machine hears it from the same place, never from a
  // conductor's boot (src/workflow/platform.ts releaseServing).
  assert.match(startBody, /if \(processRole\.servesRequests\(ownRole\)\) require\('\.\/src\/workflow\/platform\.ts'\)\.releaseServing\(getPool\(config\)\);/);
  // The scans that read busy before acting read it for every process: the
  // imported-PR look, the revision refresh and the measurement, clocks of
  // the workflow now (services/proposal-scans.js). What another process
  // works on is read from the workflow's own records (session-work.ts
  // workedOnSql), never from a mirror of its holds.
  const scans = fs.readFileSync(path.join(__dirname, '..', 'src/services/proposal-scans.js'), 'utf8');
  assert.match(scans, /function busy\(sessionId, pool\) \{\n\s+return require\('\.\/active-workers'\)\.isSessionBusyAnywhere\(Number\(sessionId\), \{ pool \}\);/);
  for (const fn of ['async function lookImported(', 'async function refreshRevision(']) {
    const body = scans.slice(scans.indexOf(fn), scans.indexOf('\n}\n', scans.indexOf(fn)));
    assert.match(body, /await busy\(session\.id, pool\)/, `${fn} skips a session busy anywhere`);
  }
  const measure = scans.slice(scans.indexOf('async function measurePromoted('), scans.indexOf('\n}\n', scans.indexOf('async function measurePromoted(')));
  assert.match(measure, /busySessionsAnywhere\(sessions\.map\(\(s\) => s\.id\), \{ pool \}\)/, 'the measurement skips sessions busy anywhere');
  const busy = fs.readFileSync(path.join(__dirname, '..', 'src/services/active-workers.js'), 'utf8');
  const anywhere = busy.slice(busy.indexOf('async function isSessionBusyAnywhere('), busy.indexOf('async function busySessionsAnywhere('));
  assert.match(anywhere, /if \(isSessionBusy\(sessionId\)\) return true;/, 'this process\'s own turn first');
  assert.match(anywhere, /workedOnSql\(/, 'then the workflow\'s records');
  assert.doesNotMatch(busy, /isSessionBusyElsewhere|heldElsewhere/, 'no mirror of another process\'s holds');
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
