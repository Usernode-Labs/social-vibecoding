'use strict';

// The connection budget in the chart (item 4): each role's pools reach its
// Pods as env, a replaced Pod's drain sizes too, and the chart refuses values
// whose most connections at once (serving Pods plus a surge, drainingMax
// replaced Pods per replica at the drain sizes, the migration Job) exceed
// postgresql.platformConnections, the share the server keeps for the
// platform's user.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;
const skip = !helmAvailable && 'helm is not installed';
const CHART = 'deploy/helm/social-vibecoding-platform';

function render(sets = [], showOnly = null) {
  const args = ['template', 'budget-test', CHART, '--set', 'enabled=true', '--set', 'secrets.create=false',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  for (const s of sets) args.push('--set', s);
  if (showOnly) args.push('--show-only', showOnly);
  const out = spawnSync('helm', args, { encoding: 'utf8' });
  return { ok: out.status === 0, stdout: out.stdout, stderr: out.stderr };
}

// Each Pod's env, by its process-role label, in the order rendered.
function podEnvs(stdout) {
  return stdout.split(/^---$/m).filter((doc) => /^kind: (Deployment|Job)$/m.test(doc)).map((doc) => ({
    role: (doc.match(/social\.usernode\.io\/process-role: "([a-z]+)"/) || [])[1] || (/^kind: Job$/m.test(doc) ? 'migration' : null),
    env: new Map([...doc.matchAll(/\{name: ([A-Z0-9_]+), value: "([^"]*)"\}/g)].map(([, k, v]) => [k, v])),
  }));
}

// The chart's sum, written out again here.
function budget({ web = [10, 2, 2], conductor = [30, 10, 4], replicas = 1, conductors = 1, draining = 2,
  drain = [4, 2, 1], migration = 4, split = true } = {}) {
  const outside = 5;
  // [main pool, workflow pool, database operations]; an operation can hold
  // two connections at once.
  const size = ([db, wf, ops]) => db + wf + 2 * ops;
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const drainEach = size(drain) + outside;
  const role = (n, pools) => (n + 1) * (size(pools) + outside) + n * draining * drainEach;
  const parts = split
    ? [['web', role(replicas, web)], ['conductor', role(conductors, conductor)]]
    : [['platform', role(replicas, [web[0], conductor[1], conductor[2]])]];
  parts.push(['migration', migration + 2]);
  return { total: sum(parts.map(([, n]) => n)), parts };
}

test('each role\'s pools reach its Pods, the conductor\'s work sizes where the Pod does it', { skip }, () => {
  const { ok, stdout, stderr } = render(['config.dbPoolMax=24', 'platform.conductor.dbPoolMax=16',
    'platform.conductor.wfPoolMax=8', 'platform.conductor.databaseOperations=3', 'platform.drainPools.dbPoolMax=5']);
  assert.ok(ok, stderr);
  const pods = podEnvs(stdout);
  const get = (role) => pods.find((p) => p.role === role).env;
  const pick = (env) => Object.fromEntries(['DB_POOL_MAX', 'WF_POOL_MAX', 'DB_ADMIN_CONNECTIONS_MAX', 'DRAIN_DB_POOL_MAX',
    'DRAIN_WF_POOL_MAX', 'DB_ADMIN_CONNECTIONS_DRAINING'].map((k) => [k, env.get(k)]));
  assert.deepEqual(pick(get('web')), { DB_POOL_MAX: '24', WF_POOL_MAX: '2', DB_ADMIN_CONNECTIONS_MAX: '2',
    DRAIN_DB_POOL_MAX: '5', DRAIN_WF_POOL_MAX: '2', DB_ADMIN_CONNECTIONS_DRAINING: '1' });
  assert.deepEqual(pick(get('conductor')), { DB_POOL_MAX: '16', WF_POOL_MAX: '8', DB_ADMIN_CONNECTIONS_MAX: '3',
    DRAIN_DB_POOL_MAX: '5', DRAIN_WF_POOL_MAX: '2', DB_ADMIN_CONNECTIONS_DRAINING: '1' });
  assert.equal(get('migration').get('DB_POOL_MAX'), '4', 'the migration Job\'s own pool');

  // The conductor off: the platform Pods do its work, at its sizes.
  const single = render(['platform.conductor.enabled=false', 'platform.conductor.wfPoolMax=8',
    'platform.conductor.databaseOperations=3'], 'templates/platform.yaml');
  assert.ok(single.ok, single.stderr);
  const [only] = podEnvs(single.stdout);
  assert.equal(only.role, 'all');
  assert.deepEqual([only.env.get('DB_POOL_MAX'), only.env.get('WF_POOL_MAX'), only.env.get('DB_ADMIN_CONNECTIONS_MAX')], ['10', '8', '3']);
});

test('the chart refuses pools that could hold more than the platform\'s share, and says by how much per role', { skip }, () => {
  const cases = [
    [[], budget()],
    [['config.dbPoolMax=24', 'platform.conductor.replicas=2', 'platform.conductor.dbPoolMax=16',
      'platform.conductor.wfPoolMax=8', 'platform.conductor.databaseOperations=3'],
    budget({ web: [24, 2, 2], conductor: [16, 8, 3], conductors: 2 })],
    [['platform.drainingMax=0', 'platform.replicas=2'], budget({ draining: 0, replicas: 2 })],
    [['platform.drainPools.dbPoolMax=8', 'migration.dbPoolMax=6'], budget({ drain: [8, 2, 1], migration: 6 })],
    [['platform.conductor.enabled=false'], budget({ split: false })],
  ];
  for (const [sets, { total, parts }] of cases) {
    const fits = render([...sets, `postgresql.platformConnections=${total}`], 'templates/platform.yaml');
    assert.ok(fits.ok, `${sets.join(' ')} fits in exactly ${total}: ${fits.stderr}`);
    const over = render([...sets, `postgresql.platformConnections=${total - 1}`], 'templates/platform.yaml');
    assert.equal(over.ok, false, `${sets.join(' ')} refused at ${total - 1}`);
    const named = parts.map(([name, n]) => `${name} ${n}`).join(', ');
    assert.match(over.stderr, new RegExp(`could hold ${total} connections at once on its database server \\(${named}\\)`));
  }
  // 0 checks nothing (the bundled server).
  assert.ok(render(['config.dbPoolMax=500'], 'templates/platform.yaml').ok);
});

test('a replaced Pod keeps its workflow listener and one more', { skip }, () => {
  const out = render(['platform.drainPools.wfPoolMax=1'], 'templates/platform.yaml');
  assert.equal(out.ok, false);
  assert.match(out.stderr, /platform\.drainPools needs/);
});
