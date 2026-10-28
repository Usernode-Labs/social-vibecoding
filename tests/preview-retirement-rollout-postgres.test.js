'use strict';

// The platform's own previews across a release (28 Oct 2026). Each carries
// the data policy of the build that made it, and the newest build retires
// every other one (services/platform-preview-retirement.js, run by the
// preview-data-policy clock and at a conductor's boot). While a release
// rolled out, the old conductors went on building previews for three
// changes, and the new ones retired each within a minute, under its checks
// run: every page then answered 403, and "Run checks again" ran all 743
// checks against the runtime that was gone.
//
//   1. The rollout window. An old build serves and a newer one boots (in
//      platform_processes from its start, before its own boot retirement):
//      the old build's security clock looks at nothing, so the newer build's
//      previews are spared, and its build of a platform preview stands down,
//      at its claim or before what it creates, while a try is left. The
//      newer build builds and retires.
//   2. What a retirement took, the preview machine is told about: the
//      platform's previews it is checking or that back a vote, whose
//      runtime is gone, are reported lost (the machine rebuilds them). No
//      other app's, none it is building, none in its error lane.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

// What the build does, and what the cluster says of a runtime.
const built = [];
let duringBuild = null;
const realStaging = require('../src/services/staging');
stub('../src/services/staging', {
  ...realStaging,
  async prepareAttempt(config, row, app, head, attempt) {
    built.push(['clone', row.id, attempt.claim]);
    await attempt.checkpoint({ step: 'clone', db: attempt.dbName });
    if (duringBuild) await duringBuild();
    await attempt.checkpoint({ step: 'deploy', db: attempt.dbName });
    built.push(['deploy', row.id, attempt.claim]);
    return { stagingUrl: `https://p--s${row.id}.apps.test`, hostname: `p--s${row.id}.apps.test`,
      runtimeKind: 'kubernetes', runtimeName: `sv-preview-${app.id}-s${row.id}` };
  },
  async verifyStagingEdge() { return { ok: true }; },
});
const gone = new Set();
stub('../src/services/application-runtime', {
  ...require('../src/services/application-runtime'),
  mode: () => 'kubernetes',
  async inspect(config, { runtimeName }) { return gone.has(runtimeName) ? { status: 'not_found' } : { status: 'running', labels: {} }; },
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
const { JOBS, clockServices } = require('../src/workflow/clock/services.ts');
const { previewServices } = require('../src/workflow/preview/services.ts');
const { WORK, PREPARE_CLAIMS } = require('../src/workflow/preview/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const config = { appRuntime: 'kubernetes', edgeJwtSecret: 'fake-rollout-receipt-key', kubernetes: { appNamespace: 'fake-apps' } };
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40), HEAD = 'c'.repeat(40);

test('a release\'s old build stands down from the platform\'s previews, and what a retirement took is rebuilt', { timeout: 60000 }, async (t) => {
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
  const saved = { role: process.env.PROCESS_ROLE, sha: process.env.GIT_SHA, staging: process.env.USERNODE_ENV, retire: retirement.retire };
  t.after(async () => {
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
  const runtimeOf = (a, id) => `sv-preview-${a.id}-s${id}`;
  // A proposal and, when given, the preview machine's instance of it.
  async function proposal(a, status, state = null, data = {}) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, $3, 'feature') RETURNING id`,
      [a.id, owner.id, status]);
    await pool.query(
      `UPDATE chat_sessions SET staging_url = $2, staging_runtime_kind = 'kubernetes', staging_runtime_name = $3 WHERE id = $1`,
      [s.id, `https://p--s${s.id}.apps.test`, runtimeOf(a, s.id)]);
    if (state) {
      // Written as the machine's transition would (the writer marker).
      const c = await pool.connect();
      try {
        await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c.query(
          `INSERT INTO wf_instances (machine, key, app_id, state, data, machine_version) VALUES ('preview', $1, $2, $3, $4, 1)`,
          [`session:${s.id}`, a.id, state, { sessionId: s.id, head: HEAD, verdict: null, ...data,
            serving: { n: 1, head: HEAD, runtimeKind: 'kubernetes', runtimeName: runtimeOf(a, s.id) } }]);
        await c.query('COMMIT');
      } finally { c.release(); }
    }
    return { id: s.id, runtime: runtimeOf(a, s.id) };
  }
  // The roster as services/processes.js writes it: a process is 'serving'
  // from its start, before its boot's own retirement (server.js).
  const started = (id, release, role, ago = '0 seconds') => pool.query(
    `INSERT INTO platform_processes (id, release, role, host, state, started_at, heartbeat_at)
     VALUES ($1, $2, $3, $1, 'serving', now() - $4::interval, now())`, [id, release, role, ago]);
  const leaves = (id) => pool.query('DELETE FROM platform_processes WHERE id = $1', [id]);

  // The security clock's run, as this process (its GIT_SHA).
  let scans = 0, retiredNow = 0;
  retirement.retire = async () => { scans++; return { examined: 3, retired: retiredNow }; };
  const job = JOBS.find((j) => j.name === startup.JOB);
  const clock = clockServices([job], { config, pool, previewRetirement: null })[`clock.${job.name}`];
  const tick = () => clock.run({ input: {}, signal: new AbortController().signal });
  // A claim of a preview's build (preview.prepare), as this process.
  const prepare = previewServices({ config, pool })[WORK.prepare];
  const build = (s, a, claim = 1) => prepare.run({
    input: { sessionId: s.id, appId: a.id, n: 1, head: HEAD, db: `app_x_staging_s${s.id}_aaaaaa`,
      dbs: [1, 2, 3].map((k) => `app_x_staging_s${s.id}_${k}${k}${k}${k}${k}${k}`), serving: null },
    attempt: claim, lostAttempts: 0, workId: `w-${s.id}-${claim}`, key: 'prepare:1',
    checkpoint: async () => {}, signal: new AbortController().signal,
  });
  const olderBuild = { code: 'older_build' };

  const change = await proposal(platform, 'promoted');
  const otherChange = await proposal(other, 'promoted');

  // ── 1. The rollout window ───────────────────────────────────────────
  process.env.GIT_SHA = OLD;
  await started('old-conductor', OLD, 'conductor', '10 minutes');
  // Alone, the old build is the newest: it retires, and it builds.
  assert.equal((await tick()).release, OLD);
  assert.equal(scans, 1);
  built.length = 0;
  assert.equal((await build(change, platform)).ok, true);
  assert.deepEqual(built, [['clone', change.id, 1], ['deploy', change.id, 1]]);

  // A newer build's web process decides nothing: it neither builds nor retires.
  await started('new-web', NEW, 'web');
  assert.equal((await tick()).release, OLD);
  assert.equal(scans, 2);

  // A newer conductor is booting. The old build's clock looks at nothing, so
  // nothing the newer build made (or will make) is retired by the old policy.
  await started('new-conductor', NEW, 'conductor');
  assert.deepEqual(await tick(), { skipped: 'older_build' });
  assert.equal(scans, 2, 'the old build retires nothing once a newer one has started');

  // Its build of a platform preview is given back at the claim, before any
  // clone or deploy, while a try is left...
  built.length = 0;
  await assert.rejects(build(change, platform, 1), olderBuild);
  await assert.rejects(build(change, platform, PREPARE_CLAIMS - 1), olderBuild);
  assert.deepEqual(built, [], 'nothing the newer build would retire is made');
  // ...and claimed again after STAND_DOWN_MS, by when the old build drains.
  assert.equal(prepare.backoffMs(1), 30000);
  // On its last try it builds: the retirement that follows tells the machine (2).
  assert.equal((await build(change, platform, PREPARE_CLAIMS)).ok, true);
  // Another app's preview carries no data policy: the old build still builds it.
  built.length = 0;
  assert.equal((await build(otherChange, other, 1)).ok, true);
  assert.deepEqual(built, [['clone', otherChange.id, 1], ['deploy', otherChange.id, 1]]);

  // A build under way when the newer build starts stands down before its deploy.
  await leaves('new-conductor');
  built.length = 0;
  duringBuild = () => started('new-conductor', NEW, 'conductor');
  await assert.rejects(build(change, platform, 1), olderBuild);
  duringBuild = null;
  assert.deepEqual(built, [['clone', change.id, 1]], 'never deployed');

  // The newer build is the newest: it builds, and retires.
  process.env.GIT_SHA = NEW;
  built.length = 0;
  assert.equal((await build(change, platform, 1)).ok, true);
  assert.deepEqual(built, [['clone', change.id, 1], ['deploy', change.id, 1]]);
  assert.equal((await tick()).release, NEW);
  assert.equal(scans, 3);

  // ── 2. What the retirement took ─────────────────────────────────────
  const checking = await proposal(platform, 'active', 'checking');
  const voted = await proposal(platform, 'promoted', 'settled', { verdict: 'passing' });
  const resting = await proposal(platform, 'active', 'settled', { verdict: 'failing' });
  const building = await proposal(platform, 'promoted', 'preparing');
  const erroring = await proposal(platform, 'promoted', 'settled', { verdict: 'error' });
  const alive = await proposal(platform, 'active', 'checking');
  const elsewhere = await proposal(other, 'active', 'checking');
  for (const s of [checking, voted, resting, building, erroring, elsewhere]) gone.add(s.runtime);

  // Nothing retired: nothing is looked at.
  told.length = 0;
  assert.equal((await tick()).lost, undefined);
  assert.deepEqual(told, []);
  // Retired: the ones it is checking and the vote-backed ones are rebuilt.
  retiredNow = 6;
  const result = await tick();
  assert.equal(result.retired, 6);
  assert.equal(result.lost, 2);
  assert.deepEqual(told, [[checking.id, 'runtime gone'], [voted.id, 'runtime gone']],
    'not one resting outside a vote, one being built, one in its error lane, one still running, nor another app\'s');
  // The readiness proof the web waits on is still the run's result.
  assert.equal(typeof result.scope, 'string');
  assert.equal(typeof result.checkedAt, 'string');

  // The preview-runtimes clock's own look is unchanged: vote-backed only,
  // every app, never a run going.
  told.length = 0;
  const { lookForLostPreviews } = require('../src/services/staging-recovery');
  assert.deepEqual(await lookForLostPreviews(config), { examined: 1, lost: 1 });
  assert.deepEqual(told, [[voted.id, 'runtime gone']]);

  // A look that fails never fails the run: its result opens the web.
  const failing = { query: async () => { throw new Error('database blinked'); } };
  assert.deepEqual(await startup.tellRetired(config, failing, { retired: 1, scope: 's' }), { retired: 1, scope: 's' });
});
