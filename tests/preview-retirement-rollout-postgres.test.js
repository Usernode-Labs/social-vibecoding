'use strict';

// The platform's own previews across a release (28 Oct 2026). Each carries
// the data policy of the build that made it, and the newest build retires
// every other one (services/platform-preview-retirement.js, run by the
// preview-data-policy clock and at a conductor's boot). While a release
// rolled out, the old conductors went on starting previews for changes, and
// the new ones retired each within a minute, under its checks run: every
// page then answered 403, and "Run checks again" ran all 743 checks against
// the runtime that was gone.
//
//   1. The rollout window. An old build serves and a newer one boots (in
//      platform_processes from its start, before its own boot retirement):
//      the old build's security clock looks at nothing, so the newer build's
//      previews are spared, and a preview's build (newestOnly) is left to
//      the newer build, which claims it once it runs.
//   2. What a retirement took, the preview machine is told about, on every
//      run of the clock whichever process makes it: the platform's previews
//      being checked whose runtime is gone are reported lost (the machine
//      stops the run and rebuilds). Not one that is restarting or running,
//      another app's, one being built, or a vote-backed one at rest (the
//      preview-runtimes clock's).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

// What the cluster says of a runtime, and what the machine is told.
const cluster = new Map();
stub('../src/services/application-runtime', {
  ...require('../src/services/application-runtime'),
  mode: () => 'kubernetes',
  async inspect(config, { runtimeName }) { return { status: cluster.get(runtimeName) ?? 'running', labels: {} }; },
});
const told = [];
stub('../src/services/preview-workflow', {
  ...require('../src/services/preview-workflow'),
  async lost({ session, detail }) { told.push([session.id, detail]); return true; },
});
const db = { pool: null };
stub('../src/db/pool', { ...require('../src/db/pool'), getPool: () => db.pool });

const startup = require('../src/services/platform-preview-startup');
const retirement = require('../src/services/platform-preview-retirement');
const { PLATFORM_SLUG } = require('../src/services/platform-preview-data-policy');
const { createRuntime, defineMachine, NONE, ok } = require('../src/workflow/kernel/index.ts');
const { JOBS, clockServices, newestBuild } = require('../src/workflow/clock/services.ts');
const { previewServices } = require('../src/workflow/preview/services.ts');
const { WORK } = require('../src/workflow/preview/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const config = { appRuntime: 'kubernetes', edgeJwtSecret: 'fake-rollout-receipt-key', kubernetes: { appNamespace: 'fake-apps' } };
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40), HEAD = 'c'.repeat(40);

// A machine that asks for one build, of a kind only the newest build claims.
const BUILD = 'rollout.build';
const asker = defineMachine({
  name: 'rollout-asker',
  version: 1,
  events: { Ask: (p) => p || {} },
  create: ['Ask'],
  terminal: ['built'],
  decode: (row) => ({ name: row.state, data: row.data }),
  async facts() { return {}; },
  authorize: { Ask: () => ok() },
  transitions: {
    [NONE]: { Ask: { to: () => ({ next: { name: 'waiting', data: {} }, work: [{ kind: BUILD, key: 'b1', input: {} }] }) } },
    waiting: {
      Ask: { ignore: 'asked' },
      WorkSucceeded: { to: (s, e) => ({ next: { name: 'built', data: { by: e.payload.result.by } } }) },
    },
    built: { Ask: { ignore: 'built' } },
  },
});

test('across a release the old build leaves the platform\'s previews to the new one, and what retirement took is rebuilt', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (error) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw error;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `preview_rollout_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = db.pool = new Pool({ connectionString: String(url) });
  pool.on('error', () => {});
  const runtimes = [];
  const saved = { role: process.env.PROCESS_ROLE, sha: process.env.GIT_SHA, staging: process.env.USERNODE_ENV, retire: retirement.retire };
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    retirement.retire = saved.retire;
    for (const [key, value] of [['PROCESS_ROLE', saved.role], ['GIT_SHA', saved.sha], ['USERNODE_ENV', saved.staging]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  process.env.PROCESS_ROLE = 'conductor';
  delete process.env.USERNODE_ENV;

  // ── Fixture ─────────────────────────────────────────────────────────
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('rollout-owner', 'x') RETURNING id`);
  const app = async (slug, selfHosted) => (await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url, self_hosted)
     VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text, $3) RETURNING *`,
    [slug, owner.id, selfHosted])).rows[0];
  const platform = await app(PLATFORM_SLUG, true);
  const other = await app('rollout-other-app', false);
  // A proposal and the preview machine's instance of it, written as the
  // machine's transition would (the writer marker).
  async function proposal(a, status, state, data = {}) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, $3, 'feature') RETURNING id`,
      [a.id, owner.id, status]);
    const runtime = `sv-preview-${a.id}-s${s.id}`;
    await pool.query(
      `UPDATE chat_sessions SET staging_url = $2, staging_runtime_kind = 'kubernetes', staging_runtime_name = $3 WHERE id = $1`,
      [s.id, `https://p--s${s.id}.apps.test`, runtime]);
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(
        `INSERT INTO wf_instances (machine, key, app_id, state, data, machine_version) VALUES ('preview', $1, $2, $3, $4, 1)`,
        [`session:${s.id}`, a.id, state, { sessionId: s.id, head: HEAD, verdict: null, ...data,
          serving: { n: 1, head: HEAD, runtimeKind: 'kubernetes', runtimeName: runtime } }]);
      await c.query('COMMIT');
    } finally { c.release(); }
    return { id: s.id, runtime };
  }
  // The roster as services/processes.js writes it: a process is 'serving'
  // from its start, before its boot's own retirement (server.js).
  const started = (id, release, role, ago = '0 seconds') => pool.query(
    `INSERT INTO platform_processes (id, release, role, host, state, started_at, heartbeat_at)
     VALUES ($1, $2, $3, $1, 'serving', now() - $4::interval, now())`, [id, release, role, ago]);

  // The security clock's run, as this process (its GIT_SHA).
  let scans = 0, retiredNow = 0;
  retirement.retire = async () => { scans++; return { examined: 3, retired: retiredNow }; };
  const job = JOBS.find((j) => j.name === startup.JOB);
  const clock = clockServices([job], { config, pool, previewRetirement: null })[`clock.${job.name}`];
  const tick = () => clock.run({ input: {}, signal: new AbortController().signal });
  // A process's runtime with a build to claim, asking the roster whether it
  // runs the newest build (platform.ts passes the same `newest`).
  const builds = [];
  const runtimeOf = (sha) => {
    const r = createRuntime({ pool, machines: [asker], newest: () => newestBuild(pool), services: {
      [BUILD]: { newestOnly: true, async run() { builds.push(sha); return { by: sha }; } },
    } });
    runtimes.push(r);
    return r;
  };
  const asked = async (key) => (await pool.query(`SELECT state, data FROM wf_instances WHERE machine = 'rollout-asker' AND key = $1`, [key])).rows[0];

  // A preview's build is the kind only the newest build claims.
  assert.equal(previewServices({ config, pool })[WORK.prepare].newestOnly, true);

  // ── 1. The rollout window ───────────────────────────────────────────
  process.env.GIT_SHA = OLD;
  await started('old-conductor', OLD, 'conductor', '10 minutes');
  // Alone, the old build is the newest: it retires.
  assert.equal((await tick()).release, OLD);
  assert.equal(scans, 1);
  // A newer build's web process decides nothing: it neither builds nor retires.
  await started('new-web', NEW, 'web');
  assert.equal(await newestBuild(pool), true);
  assert.equal((await tick()).release, OLD);
  assert.equal(scans, 2);

  // A newer conductor is booting. The old build's clock looks at nothing, so
  // nothing the newer build made (or will make) is retired by the old policy...
  await started('new-conductor', NEW, 'conductor');
  assert.deepEqual(await tick(), { skipped: 'older_build' });
  assert.equal(scans, 2, 'the old build retires nothing once a newer one has started');
  // ...and a build asked for now is not the old build's to make.
  const old = runtimeOf(OLD);
  await old.append(asker, 'p1', { type: 'Ask', payload: {} }, { requestKey: 'ask:p1', source: { kind: 'system', name: 'test' } });
  await old.drain();
  assert.equal(await old.runServices(), 0, 'the old build claims nothing a newer build should make');
  assert.equal((await asked('p1')).state, 'waiting');
  const { rows: [queued] } = await pool.query(`SELECT status, attempt_count FROM wf_work WHERE kind = $1`, [BUILD]);
  assert.deepEqual(queued, { status: 'queued', attempt_count: 0 }, 'left queued, no attempt spent');

  // The newer build claims and makes it.
  process.env.GIT_SHA = NEW;
  const fresh = runtimeOf(NEW);
  assert.equal(await fresh.runServices(), 1);
  await fresh.drain();
  assert.deepEqual(builds, [NEW]);
  assert.deepEqual((await asked('p1')).data, { by: NEW });
  // And it retires.
  assert.equal((await tick()).release, NEW);
  assert.equal(scans, 3);

  // A newer build that claims nothing (stuck in its boot) holds a build
  // back no longer than two minutes: then the old build takes it again.
  process.env.GIT_SHA = OLD;
  const stuck = runtimeOf(OLD);
  await stuck.append(asker, 'p2', { type: 'Ask', payload: {} }, { requestKey: 'ask:p2', source: { kind: 'system', name: 'test' } });
  await stuck.drain();
  assert.equal(await stuck.runServices(), 0);
  await pool.query(`UPDATE wf_work SET due_at = now() - interval '3 minutes' WHERE key = 'p2' AND kind = $1`, [BUILD]);
  assert.equal(await runtimeOf(OLD).runServices(), 1, 'a build left waiting is taken by the old build');
  // Once the newer build has gone (its row no longer beats), the old build
  // is the newest again and builds at once.
  await pool.query(`DELETE FROM platform_processes WHERE id = 'new-conductor'`);
  const resumed = runtimeOf(OLD);
  await resumed.append(asker, 'p3', { type: 'Ask', payload: {} }, { requestKey: 'ask:p3', source: { kind: 'system', name: 'test' } });
  await resumed.drain();
  assert.equal(await resumed.runServices(), 1);
  await started('new-conductor', NEW, 'conductor');
  // A roster that cannot be read keeps the last answer (at first: claim).
  const blind = createRuntime({ pool, machines: [asker], newest: async () => { throw new Error('roster unreadable'); },
    services: { [BUILD]: { newestOnly: true, async run() { builds.push('blind'); return { by: 'blind' }; } } } });
  runtimes.push(blind);
  await blind.append(asker, 'p4', { type: 'Ask', payload: {} }, { requestKey: 'ask:p4', source: { kind: 'system', name: 'test' } });
  await blind.drain();
  assert.equal(await blind.runServices(), 1);
  process.env.GIT_SHA = NEW;

  // The platform's runtime asks the same roster, on its own pool.
  assert.match(fs.readFileSync(require.resolve('../src/workflow/platform.ts'), 'utf8'),
    /createPlatformRuntime\(\{[\s\S]{0,400}newest: \(\) => newestBuild\(workflowPool\),/);

  // ── 2. What the retirement took ─────────────────────────────────────
  const checking = await proposal(platform, 'active', 'checking');
  const restarting = await proposal(platform, 'active', 'checking');
  const alive = await proposal(platform, 'active', 'checking');
  const building = await proposal(platform, 'promoted', 'preparing');
  const resting = await proposal(platform, 'promoted', 'settled', { verdict: 'passing' });
  const elsewhere = await proposal(other, 'active', 'checking');
  for (const s of [checking, building, resting, elsewhere]) cluster.set(s.runtime, 'not_found');
  cluster.set(restarting.runtime, 'restarting');

  // A run that retired nothing still looks: a conductor's boot retirement
  // (another process's, or this one's before the clock's last result) took
  // the runtime, and this run is the first to see it.
  told.length = 0;
  retiredNow = 0;
  const result = await tick();
  assert.equal(result.retired, 0);
  assert.equal(result.lost, 1);
  assert.deepEqual(told, [[checking.id, 'runtime gone']],
    'not one restarting or running, one being built, one at rest under a vote, nor another app\'s');
  // The readiness proof the web waits on is still the run's result.
  assert.equal(typeof result.scope, 'string');
  assert.equal(typeof result.checkedAt, 'string');
  // Nothing gone: the result says nothing more.
  cluster.set(checking.runtime, 'running');
  told.length = 0;
  assert.equal((await tick()).lost, undefined);
  assert.deepEqual(told, []);
  // The old build's skipped run looks at nothing.
  process.env.GIT_SHA = OLD;
  cluster.set(checking.runtime, 'not_found');
  assert.deepEqual(await tick(), { skipped: 'older_build' });
  assert.deepEqual(told, []);
  process.env.GIT_SHA = NEW;

  // The preview-runtimes clock's own look is unchanged: vote-backed ones at
  // rest, never a run going.
  const { lookForLostPreviews } = require('../src/services/staging-recovery');
  assert.deepEqual(await lookForLostPreviews(config), { examined: 1, lost: 1 });
  assert.deepEqual(told, [[resting.id, 'runtime gone']]);

  // A look that fails never fails the run: its result opens the web.
  db.pool = { query: async () => { throw new Error('database blinked'); } };
  try {
    assert.deepEqual(await startup.tellRetired(config, { retired: 1, scope: 's' }), { retired: 1, scope: 's' });
  } finally { db.pool = pool; }
});
