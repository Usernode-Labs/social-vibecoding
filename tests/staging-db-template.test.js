'use strict';

// Staging templates (db-manager.js): a preview clones from a redacted copy
// of its app's database that is kept warm on the server, refreshed at most
// every STAGING_DB_TEMPLATE_MAX_AGE_MS, instead of paying pg_dump |
// pg_restore of the live database on every build.
//
// Pinned here, with pg and child_process stubbed (the latter at the same seam as
// tests/db-clone-exclude-data.test.js):
//   - a missing or stale template is rebuilt into `_next` with the direct
//     path's own steps, stamped, locked against connections, and swapped in
//     by rename — never built in place;
//   - a fresh template means NO pg_dump at all: the clone is CREATE DATABASE
//     … TEMPLATE, ownership moves to the clone role, and the two redaction
//     passes still run;
//   - templates disabled (MAX_AGE 0) or any template failure falls back to
//     the direct copy, so a build is never blocked on the optimisation;
//   - the template's name never parses as a preview clone (the reap sweep).
//
// Run with: node --test tests/staging-db-template.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// `failures`: [{ match, times, error(sql) }], each statement matching
// `match` fails with `error(sql)` its first `times` times, then succeeds.
function loadDbManager({ templateComment = null, failOn = null, maxAge = null, privateTables = [], privateColumns = [], failConnect = false, loseConnection = false, timeoutOn = null, failures = [] } = {}) {
  const savedEnv = { url: process.env.DB_ADMIN_URL, age: process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS };
  process.env.DB_ADMIN_URL = 'postgres://usernode:test@db.example.test:5432/usernode';
  if (maxAge === null) delete process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS;
  else process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS = String(maxAge);
  const ids = {
    childProcess: require.resolve('child_process'),
    pg: require.resolve('pg'),
    logger: require.resolve('../src/services/logger'),
    dbRetry: require.resolve('../src/services/db-retry'),
    subject: require.resolve('../src/services/db-manager'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const calls = [];
  const fakeExecFile = (cmd, args, opts = {}) => {
    const dashC = args.indexOf('-c');
    const sql = dashC >= 0 ? args[dashC + 1] : '';
    calls.push({ cmd, args, sql, db: (opts.env || {}).PGDATABASE, timeout: opts.timeout });
    if (timeoutOn && timeoutOn.test(sql)) return Promise.reject(new Error('Query read timeout'));
    if (failOn && failOn.test(sql)) return Promise.reject(new Error(`boom: ${sql.slice(0, 40)}`));
    const failure = failures.find((f) => f.match.test(sql) && (f.times ?? Infinity) > 0);
    if (failure) {
      failure.times = (failure.times ?? Infinity) - 1;
      return Promise.reject(failure.error(sql));
    }
    if (/shobj_description/.test(sql)) {
      // A function form is read afresh per query, so one test can see the
      // template fresh and then gone.
      const comment = typeof templateComment === 'function' ? templateComment() : templateComment;
      return Promise.resolve({ stdout: comment ? `${comment}\n` : '\n', stderr: '' });
    }
    if (/SELECT EXISTS/.test(sql)) return Promise.resolve({ stdout: 'f\n', stderr: '' });
    if (/col_description/.test(sql)) return Promise.resolve({ stdout: privateColumns.join('\n'), stderr: '' });
    if (/obj_description/.test(sql)) return Promise.resolve({ stdout: privateTables.join('\n'), stderr: '' });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;
  const fakeSpawn = (cmd, args, opts = {}) => {
    assert.ok(connections.every((c) => c.ended), 'close clone connections before refresh or fallback');
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    calls.push({ cmd, args, db: (opts.env || {}).PGDATABASE });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  const connections = [];
  class FakeClient extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.db = new URL(config.connectionString).pathname.slice(1);
      this.ended = false;
      connections.push(this);
    }
    async connect() {
      if (failConnect && this.db !== 'usernode') throw new Error('connection refused');
    }
    async query({ text, rowMode }) {
      assert.equal(rowMode, 'array');
      assert.equal(this.ended, false, 'queries cannot use a closed clone connection');
      const result = await fakeExecFile('pg', ['-c', text], { env: { PGDATABASE: this.db } });
      if (loseConnection && this.db !== 'usernode') this.emit('error', new Error('connection lost'));
      return { rows: result.stdout.trim() ? result.stdout.trim().split('\n').map((row) => row.split('|')
        .map((value) => value === 't' ? true : value === 'f' ? false : value || null)) : [] };
    }
    async end() { this.ended = true; }
  }
  stub(ids.pg, { Client: FakeClient });
  stub(ids.childProcess, { execFile: fakeExecFile, spawn: fakeSpawn });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  // The real retry, without its pauses: they are recorded instead.
  const waits = [];
  delete require.cache[ids.dbRetry];
  const realRetry = require(ids.dbRetry);
  stub(ids.dbRetry, {
    ...realRetry,
    withDbRetry: (fn, options = {}) => realRetry.withDbRetry(fn, {
      ...options, wait: async (ms) => { waits.push(ms); },
    }),
  });
  delete require.cache[ids.subject];
  const dbManager = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) { if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id]; }
    if (savedEnv.url === undefined) delete process.env.DB_ADMIN_URL; else process.env.DB_ADMIN_URL = savedEnv.url;
    if (savedEnv.age === undefined) delete process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS; else process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS = savedEnv.age;
  };
  return { dbManager, calls, connections, waits, restore };
}

const sqls = (calls) => calls.filter((c) => ['psql', 'pg'].includes(c.cmd)).map((c) => c.sql);
const dumps = (calls) => calls.filter((c) => c.cmd === 'pg_dump');
const restores = (calls) => calls.filter((c) => c.cmd === 'pg_restore');
const fresh = () => `staging-template source=app_demo refreshed_at=${new Date().toISOString()}`;
const stale = () => `staging-template source=app_demo refreshed_at=${new Date(Date.now() - 3600 * 1000).toISOString()}`;

for (const stage of ['database', 'role']) {
  const failOn = stage === 'database' ? /^DROP DATABASE IF EXISTS app_demo_staging_/ : /^DROP ROLE IF EXISTS app_demo_staging_/;
  for (const viaTemplate of [false, true]) {
    test(`${viaTemplate ? 'template' : 'direct'} clone stops before creation when old ${stage} cleanup fails`, async () => {
      const { dbManager, calls, restore } = loadDbManager({ failOn, templateComment: fresh() });
      try {
        await assert.rejects(
          dbManager.cloneDatabase('app_demo', 'app_demo_staging_s9_abc123', { viaTemplate }),
          /boom: DROP/,
        );
        assert.ok(!sqls(calls).some((sql) => /^CREATE (ROLE|DATABASE) app_demo_staging_/.test(sql)),
          'failed cleanup must not be masked by a duplicate role or database error');
        assert.equal(dumps(calls).length, 0);
        if (stage === 'database') {
          assert.ok(!sqls(calls).some((sql) => /^DROP ROLE/.test(sql)), 'keep the role that still owns the database');
        }
      } finally { restore(); }
    });
  }

  test(`ordinary teardown stays best-effort when ${stage} cleanup fails`, async () => {
    const { dbManager, restore } = loadDbManager({ failOn });
    try {
      await assert.doesNotReject(dbManager.dropDatabase('app_demo_staging_s9_abc123'));
    } finally { restore(); }
  });
}

test('no template yet: it is built into _next with the direct steps, stamped, locked, and swapped in by rename', async () => {
  const { dbManager, calls, restore } = loadDbManager();
  try {
    const out = await dbManager.cloneDatabase('app_demo', 'app_demo_staging_s1_abc123', { viaTemplate: true });
    assert.equal(out.via, 'template');
    assert.equal(out.templateRefreshed, true);
    assert.match(out.password, /^[0-9a-f]{48}$/);
    const s = sqls(calls);
    const at = (re) => s.findIndex((x) => re.test(x));
    assert.ok(at(/CREATE ROLE app_demo_stgtmpl_owner NOLOGIN/) >= 0, 'a NOLOGIN template role');
    const create = at(/CREATE DATABASE app_demo_stgtmpl_next TEMPLATE template0 OWNER app_demo_stgtmpl_owner/);
    assert.ok(create >= 0);
    // The one dump/restore of the run goes INTO _next, not into the clone.
    assert.equal(dumps(calls).length, 1);
    assert.equal(restores(calls).length, 1);
    assert.ok(restores(calls)[0].args.includes('app_demo_stgtmpl_next'), 'restored into the build database');
    const comment = at(/COMMENT ON DATABASE app_demo_stgtmpl_next IS 'staging-template source=app_demo refreshed_at=/);
    const lock = at(/ALTER DATABASE app_demo_stgtmpl_next WITH ALLOW_CONNECTIONS false/);
    const drop = at(/DROP DATABASE IF EXISTS app_demo_stgtmpl WITH \(FORCE\)$/);
    const rename = at(/ALTER DATABASE app_demo_stgtmpl_next RENAME TO app_demo_stgtmpl/);
    assert.ok(create < comment && comment < lock && lock < drop && drop < rename, 'build, stamp, lock, drop old, rename');
    // Then the clone itself: a file copy handed to a fresh role.
    const cloneCreate = at(/CREATE DATABASE app_demo_staging_s1_abc123 TEMPLATE app_demo_stgtmpl OWNER app_demo_staging_s1_abc123_owner/);
    assert.ok(cloneCreate > rename, 'the clone follows the swap');
    assert.ok(s.slice(cloneCreate).some((x) => /GRANT ALL PRIVILEGES ON DATABASE app_demo_staging_s1_abc123 TO app_demo_staging_s1_abc123_owner/.test(x)));
    // Ownership walk template role → clone role, then the redaction passes on the clone.
    const walk = calls.filter((c) => ['psql', 'pg'].includes(c.cmd) && c.db === 'app_demo_staging_s1_abc123' && /DO \$\$/.test(c.sql));
    assert.ok(walk.length >= 1, 'reassignUserObjectsTo ran inside the clone');
    assert.ok(walk.some((c) => /app_demo_stgtmpl_owner/.test(c.sql) && /app_demo_staging_s1_abc123_owner/.test(c.sql)));
    const onClone = calls.filter((c) => ['psql', 'pg'].includes(c.cmd) && c.db === 'app_demo_staging_s1_abc123').map((c) => c.sql);
    assert.ok(onClone.some((x) => /obj_description/.test(x) && /relkind/.test(x)), 'truncatePrivateTables still runs on the clone');
    assert.ok(onClone.some((x) => /col_description/.test(x)), 'scrubPrivateColumns still runs on the clone');
  } finally { restore(); }
});

test('a fresh template means no dump at all', async () => {
  const { dbManager, calls, restore } = loadDbManager({ templateComment: fresh() });
  try {
    const out = await dbManager.cloneDatabase('app_demo', 'app_demo_staging_s2_abc123', { viaTemplate: true });
    assert.equal(out.via, 'template');
    assert.equal(out.templateRefreshed, false);
    assert.equal(dumps(calls).length, 0);
    assert.ok(sqls(calls).some((x) => /CREATE DATABASE app_demo_staging_s2_abc123 TEMPLATE app_demo_stgtmpl OWNER/.test(x)));
    assert.ok(!sqls(calls).some((x) => /_stgtmpl_next/.test(x)), 'nothing rebuilt');
  } finally { restore(); }
});

test('a template past its soft age serves the build as it is, and is rebuilt behind it', async () => {
  const { dbManager, calls, restore } = loadDbManager({ templateComment: stale() });
  try {
    const out = await dbManager.cloneDatabase('app_demo', 'app_demo_staging_s3_abc123', { viaTemplate: true });
    assert.equal(out.via, 'template');
    assert.equal(out.templateRefreshed, false, 'not on the build\'s critical path');
    assert.equal(out.templateStale, true);
    const s = sqls(calls);
    const cloneAt = s.findIndex((x) => /CREATE DATABASE app_demo_staging_s3_abc123 TEMPLATE app_demo_stgtmpl OWNER/.test(x));
    assert.ok(cloneAt >= 0);
    assert.equal(dumps(calls).length, 0, 'no dump before the clone returned');
    await dbManager._templateIdleForTest('app_demo');
    assert.equal(dumps(calls).length, 1, 'the refresh ran afterwards');
    const renameAt = sqls(calls).findIndex((x) => /ALTER DATABASE app_demo_stgtmpl_next RENAME TO app_demo_stgtmpl/.test(x));
    assert.ok(renameAt > cloneAt, 'and swapped in after the clone was done');
  } finally { restore(); }
});

test('a template past its hard age is rebuilt before the build uses it', async () => {
  const ancient = `staging-template source=app_demo refreshed_at=${new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()}`;
  const { dbManager, calls, restore } = loadDbManager({ templateComment: ancient });
  try {
    const out = await dbManager.cloneDatabase('app_demo', 'app_demo_staging_s7_abc123', { viaTemplate: true });
    assert.equal(out.templateRefreshed, true);
    assert.equal(out.templateStale, false);
    const s = sqls(calls);
    const renameAt = s.findIndex((x) => /RENAME TO app_demo_stgtmpl/.test(x));
    const cloneAt = s.findIndex((x) => /CREATE DATABASE app_demo_staging_s7_abc123 TEMPLATE app_demo_stgtmpl OWNER/.test(x));
    assert.ok(renameAt >= 0 && renameAt < cloneAt, 'refresh first, then the clone');
    assert.equal(dbManager.STAGING_TEMPLATE_HARD_MAX_AGE_MS, 6 * 60 * 60 * 1000, 'default: six hours');
  } finally { restore(); }
});

test('templates off (MAX_AGE 0), or not asked for: the direct copy, exactly as before', async () => {
  const off = loadDbManager({ maxAge: 0 });
  try {
    const out = await off.dbManager.cloneDatabase('app_demo', 'app_demo_staging_s4_abc123', { viaTemplate: true });
    assert.equal(out.via, 'direct');
    assert.equal(off.dbManager.stagingTemplatesEnabled(), false);
    assert.equal(dumps(off.calls).length, 1);
    assert.ok(restores(off.calls)[0].args.includes('app_demo_staging_s4_abc123'));
    assert.ok(!sqls(off.calls).some((x) => /stgtmpl/.test(x)));
  } finally { off.restore(); }
  const fork = loadDbManager({ templateComment: fresh() });
  try {
    const out = await fork.dbManager.cloneDatabase('app_demo', 'app_demo_fork_copy');
    assert.equal(out.via, 'direct', 'app forks keep the direct copy');
    assert.equal(dumps(fork.calls).length, 1);
  } finally { fork.restore(); }
});

test('a template failure falls back to the direct copy and never throws', async () => {
  const { dbManager, calls, restore } = loadDbManager({ failOn: /RENAME TO app_demo_stgtmpl/ });
  try {
    const out = await dbManager.cloneDatabase('app_demo', 'app_demo_staging_s5_abc123', { viaTemplate: true });
    assert.equal(out.via, 'direct');
    assert.ok(restores(calls).some((c) => c.args.includes('app_demo_staging_s5_abc123')), 'the clone was still made, directly');
  } finally { restore(); }
  const cloneFails = loadDbManager({ templateComment: fresh(), failOn: /TEMPLATE app_demo_stgtmpl OWNER/ });
  try {
    const out = await cloneFails.dbManager.cloneDatabase('app_demo', 'app_demo_staging_s6_abc123', { viaTemplate: true });
    assert.equal(out.via, 'direct');
    assert.ok(sqls(cloneFails.calls).filter((x) => /DROP DATABASE IF EXISTS app_demo_staging_s6_abc123/.test(x)).length >= 2,
      'the half-made clone is dropped before the direct path makes it again');
  } finally { cloneFails.restore(); }
});

test('the template name is not a preview clone, and the freshness stamp parses', async () => {
  const { dbManager, restore } = loadDbManager({ templateComment: 'staging-template source=app_demo refreshed_at=2026-09-07T09:00:00.000Z' });
  try {
    assert.equal(dbManager.stagingTemplateDbName('app_demo'), 'app_demo_stgtmpl');
    const STAGING_DB_NAME_RE = /^app_[a-z0-9_]+_staging_s(\d+)_([0-9a-f]{6}|latest)$/; // staging-reap.js
    assert.equal(STAGING_DB_NAME_RE.test('app_demo_stgtmpl'), false);
    assert.equal(STAGING_DB_NAME_RE.test('app_demo_stgtmpl_next'), false);
    assert.equal(await dbManager.readTemplateRefreshedAt('app_demo_stgtmpl'), Date.parse('2026-09-07T09:00:00.000Z'));
    assert.equal(dbManager.STAGING_TEMPLATE_MAX_AGE_MS, 15 * 60 * 1000, 'default: fifteen minutes');
    await assert.rejects(dbManager.ensureStagingTemplate('bad name'), /unsafe/);
  } finally { restore(); }
});

test('shots clone names are bounded, side-specific, and connection-limited without joining preview reaping', () => {
  const { dbManager, restore } = loadDbManager();
  try {
    const runId = 'a'.repeat(32);
    const base = dbManager.shotsDbName('x'.repeat(80), runId, 'base');
    const head = dbManager.shotsDbName('x'.repeat(80), runId, 'head');
    assert.notEqual(base, head);
    assert.ok(base.length <= 57, 'database plus _owner fits PostgreSQL identifier limit');
    assert.equal(dbManager.isShotsCloneDb(base), true);
    assert.equal(dbManager.isShotsCloneDb(head), true);
    assert.equal(dbManager.isStagingCloneDb(base), false, 'the ordinary preview sweeper does not own shots clones');
    assert.throws(() => dbManager.shotsDbName('demo', runId, 'other'), /side/);
  } finally { restore(); }
});

test('one immutable prepared source feeds both evidence sides before cleanup', async () => {
  const { dbManager, calls, connections, restore } = loadDbManager({ templateComment: fresh() });
  try {
    const prepared = await dbManager.prepareStagingCloneSource('app_demo', {
      sourceId: 'shots-run-0123456789abcdef',
    });
    assert.equal(dbManager.isPreparedCloneSource(prepared.templateDb), true);
    assert.match(prepared.fingerprint, /^[0-9a-f]{64}$/);
    // The copy gets the paired clones' ceiling, not psql's 30-second default.
    const copy = calls.find((call) => call.sql.startsWith(`CREATE DATABASE ${prepared.templateDb} TEMPLATE`));
    assert.equal(copy.timeout, 90_000);
    assert.ok(calls.filter((call) => call.cmd === 'psql' && call !== copy).every((call) => call.timeout === 30000),
      'every other statement keeps the default');
    assert.ok(connections.some((connection) => connection.db === prepared.templateDb
      && connection.config.query_timeout === 90_000));
    assert.equal(prepared.refreshedAt.length > 0, true);
    const phases = [];
    await dbManager.cloneFromPreparedSource(prepared, 'app_demo_staging_s91_aaaaaa', {
      onProgress: (phase) => phases.push(phase),
    });
    assert.deepEqual(phases, [
      'drop_target', 'create_role', 'copy_template', 'reassign_ownership',
      'truncate_private', 'scrub_private', 'redaction_complete', 'connection_limit',
    ]);
    await dbManager.cloneFromPreparedSource(prepared, 'app_demo_staging_s92_bbbbbb');
    const evidenceConnections = connections.filter((connection) =>
      connection.db.startsWith('app_demo_staging_s9'));
    assert.equal(evidenceConnections.length, 2);
    assert.ok(evidenceConnections.every((connection) =>
      connection.config.query_timeout === 90_000
        && connection.config.statement_timeout === 90_000));
    await dbManager.releasePreparedCloneSource(prepared);

    const creates = sqls(calls).filter((sql) => /CREATE DATABASE app_demo_staging_s9[12]_/.test(sql));
    assert.equal(creates.length, 2);
    assert.ok(creates.every((sql) => sql.includes(`TEMPLATE ${prepared.templateDb}`)),
      'both sides clone the exact prepared database, not the moving shared template');
    assert.ok(sqls(calls).some((sql) => new RegExp(`ALTER DATABASE ${prepared.templateDb} WITH ALLOW_CONNECTIONS false`).test(sql)));
    assert.ok(sqls(calls).some((sql) => new RegExp(`DROP DATABASE IF EXISTS ${prepared.templateDb} WITH \\(FORCE\\)$`).test(sql)),
      'cleanup drops the run-scoped prepared source');
  } finally { restore(); }
});

test('prepared evidence sources require a run identity and cannot adopt arbitrary databases', async () => {
  const { dbManager, restore } = loadDbManager({ templateComment: fresh() });
  try {
    await assert.rejects(dbManager.prepareStagingCloneSource('app_demo'), /sourceId is required/);
    await assert.rejects(dbManager.cloneFromPreparedSource('app_demo_stgtmpl', 'app_demo_staging_s1_aaaaaa'), /invalid prepared source/);
    await assert.rejects(dbManager.releasePreparedCloneSource('app_demo'), /invalid prepared source/);
  } finally { restore(); }
});

test('the preview build asks for the template and records how the clone went', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const staging = fs.readFileSync(path.join(__dirname, '..', 'src/services/staging.js'), 'utf8');
  assert.match(staging, /dbManager\.cloneDatabase\(prodDbName, stagingDbNameStr, \{ viaTemplate: true \}\)/);
  assert.match(staging, /timings\.cloneVia = cloned\.via \|\| 'direct';/);
  assert.match(staging, /if \(cloned\.templateStale\) timings\.templateRefreshQueued = true;/);
  const visuals = fs.readFileSync(path.join(__dirname, '..', 'src/services/visuals.js'), 'utf8');
  assert.match(visuals, /via: buildTimings\.cloneVia \|\| undefined,/, 'the checks trace tells the two apart');
});


test('template clone uses two bounded connections for 101 redactions and closes both', async () => {
  const fixture = loadDbManager({ templateComment: fresh(),
    privateTables: Array.from({ length: 82 }, (_, i) => `public.private_${i}`),
    privateColumns: Array.from({ length: 19 }, (_, i) => `public.users|secret_${i}|f|`),
  });
  try {
    const result = await fixture.dbManager.cloneDatabase('app_demo', 'app_demo_staging_s8_abc123', { viaTemplate: true });
    assert.equal(result.via, 'template');
    assert.deepEqual(fixture.connections.map((c) => c.db), ['usernode', 'app_demo_staging_s8_abc123']);
    for (const c of fixture.connections) {
      assert.equal(c.ended, true);
      assert.equal(c.config.connectionTimeoutMillis, 30000);
      assert.equal(c.config.statement_timeout, 30000);
      assert.equal(c.config.query_timeout, 30000);
    }
    assert.equal(fixture.calls.filter((c) => c.cmd === 'pg' && /^TRUNCATE/.test(c.sql)).length, 82);
    assert.equal(fixture.calls.filter((c) => c.cmd === 'pg' && /^UPDATE/.test(c.sql)).length, 19);
    assert.ok(!fixture.calls.some((c) => c.cmd === 'psql' && /TRUNCATE|UPDATE/.test(c.sql)));
    assert.ok(!fixture.calls.some((c) => /^(BEGIN|COMMIT)/.test(c.sql || '')), 'CREATE DATABASE stays outside transactions');
  } finally { fixture.restore(); }
});

test('reused connection preserves bool/null discovery and unique private-column redaction', async () => {
  const fixture = loadDbManager({ templateComment: fresh(), privateColumns: [
    'public.users|token|t|64', 'public.users|password|f|',
  ] });
  try {
    await fixture.dbManager.cloneDatabase('app_demo', 'app_demo_staging_s8_abc123', { viaTemplate: true });
    const updates = fixture.calls.filter((c) => c.cmd === 'pg' && /^UPDATE/.test(c.sql)).map((c) => c.sql);
    assert.equal(updates.length, 2);
    assert.match(updates[0], /^UPDATE public\.users SET token = '__staging_redacted__[0-9a-f]{16}:' \|\| ctid::text$/);
    assert.equal(updates[1], 'UPDATE public.users SET password = NULL');
  } finally { fixture.restore(); }
});

for (const failure of ['redaction', 'connect', 'disconnect']) {
  test(`template clone closes its connections after ${failure} failure before fallback`, async () => {
    const fixture = loadDbManager({ templateComment: fresh(),
      privateTables: ['public.private_one', 'public.private_two'],
      failOn: failure === 'redaction' ? /^TRUNCATE public.private_one/ : null,
      failConnect: failure === 'connect', loseConnection: failure === 'disconnect',
    });
    try {
      const promise = fixture.dbManager.cloneDatabase('app_demo', 'app_demo_staging_s8_abc123', { viaTemplate: true });
      if (failure === 'redaction') {
        await assert.rejects(promise, /Failed to truncate/);
        assert.ok(fixture.calls.some((c) => c.cmd === 'pg' && /^TRUNCATE public.private_two/.test(c.sql)),
          'autocommit allows collecting later failures without skipping redaction');
      } else {
        assert.equal((await promise).via, 'direct');
      }
      assert.equal(fixture.connections.length, 2);
      assert.ok(fixture.connections.every((c) => c.ended));
      assert.equal(dumps(fixture.calls).length, 1, 'existing direct fallback remains available');
    } finally { fixture.restore(); }
  });
}


test('concurrent clones never share target connections', async () => {
  const fixture = loadDbManager({ templateComment: fresh(), privateTables: ['public.private_data'] });
  try {
    const results = await Promise.all(['app_demo', 'app_other'].map((source) =>
      fixture.dbManager.cloneDatabase(source, `${source}_staging_s8_abc123`, { viaTemplate: true })));
    assert.ok(results.every((r) => r.via === 'template'));
    assert.equal(fixture.connections.length, 4);
    assert.deepEqual(fixture.connections.filter((c) => c.db !== 'usernode').map((c) => c.db).sort(),
      ['app_demo_staging_s8_abc123', 'app_other_staging_s8_abc123']);
    assert.ok(fixture.connections.every((c) => c.ended));
  } finally { fixture.restore(); }
});


test('client query timeout stops submissions on the uncertain connection before fallback', async () => {
  const fixture = loadDbManager({ templateComment: fresh(),
    privateTables: ['public.private_one', 'public.private_two'], timeoutOn: /^TRUNCATE public.private_one/,
  });
  try {
    await assert.rejects(fixture.dbManager.cloneDatabase('app_demo', 'app_demo_staging_s8_abc123', { viaTemplate: true }), /Failed to truncate/);
    assert.ok(!fixture.calls.some((c) => c.cmd === 'pg' && /^TRUNCATE public.private_two/.test(c.sql)));
    assert.ok(fixture.connections.every((c) => c.ended));
    assert.equal(dumps(fixture.calls).length, 1);
  } finally { fixture.restore(); }
});

test('strict database existence lookup propagates failure rather than authorizing a parallel clone', async () => {
  const fixture = loadDbManager({ failOn: /SELECT 1 FROM pg_database/ });
  try {
    assert.equal(await fixture.dbManager.databaseExists('app_demo'), false, 'legacy best-effort callers remain compatible');
    await assert.rejects(fixture.dbManager.databaseExists('app_demo', { strict: true }), /boom/);
    await assert.rejects(fixture.dbManager.databaseExists('unsafe-name', { strict: true }), /unsafe/);
  } finally { fixture.restore(); }
});

// ── Brief conflicts on the shots path (db-retry.js) ─────────────────────
//
// Three shots runs ended on a database error that said nothing about the
// proposal. Two were Postgres refusing to copy or drop a database a session
// was still on; those databases are the disposable shots and template ones,
// and only those may have sessions cut off or be dropped WITH (FORCE).

// What execFile rejects with when psql exits 1, and what pg rejects with.
const psqlError = (sql, serverMessage) => Object.assign(
  new Error(`Command failed: psql -X -v ON_ERROR_STOP=1 -c ${sql}\nERROR:  ${serverMessage}\n`),
  { code: 1, stderr: `ERROR:  ${serverMessage}\n` }
);
const pgError = (code, message) => Object.assign(new Error(message), { code });
const terminates = (calls, db) => sqls(calls).filter((sql) =>
  sql.startsWith('SELECT pg_terminate_backend') && sql.includes(`datname = '${db}'`));
const RUN_TOKEN = 'b'.repeat(12);

test('a session left on the shared template no longer stops the shots copy: it is cut off and the copy runs again', async () => {
  const failures = [{
    match: /^CREATE DATABASE app_demo_evsrc_[0-9a-f]{12} TEMPLATE app_demo_stgtmpl OWNER/,
    times: 1,
    error: (sql) => psqlError(sql, 'source database "app_demo_stgtmpl" is being accessed by other users'),
  }];
  const { dbManager, calls, waits, restore } = loadDbManager({ templateComment: fresh(), failures });
  try {
    const prepared = await dbManager.prepareStagingCloneSource('app_demo', { sourceId: 'shots-run-in-use' });
    const s = sqls(calls);
    const copies = s.map((sql, i) => [sql, i]).filter(([sql]) => sql.startsWith(`CREATE DATABASE ${prepared.templateDb} TEMPLATE`));
    assert.equal(copies.length, 2, 'refused once, then copied');
    const cutOff = s.findIndex((sql) => sql.startsWith('SELECT pg_terminate_backend') && sql.includes("datname = 'app_demo_stgtmpl'"));
    assert.ok(copies[0][1] < cutOff && cutOff < copies[1][1], 'the template\'s stray session is cut off between the attempts');
    assert.deepEqual(waits, [1_000], 'after a short pause');
    assert.ok(calls.filter((c) => c.sql.startsWith(`CREATE DATABASE ${prepared.templateDb} TEMPLATE`)).every((c) => c.timeout === 90_000),
      'the retry keeps the copy\'s own ceiling');
    assert.ok(s.some((sql) => sql === `ALTER DATABASE ${prepared.templateDb} WITH ALLOW_CONNECTIONS false`), 'and the source is finished');
  } finally { restore(); }
});

test('a copy that is refused every time fails with Postgres\'s own message, and leaves nothing behind', async () => {
  const failures = [{
    match: /^CREATE DATABASE app_demo_evsrc_[0-9a-f]{12} TEMPLATE app_demo_stgtmpl OWNER/,
    times: Infinity,
    error: (sql) => psqlError(sql, 'source database "app_demo_stgtmpl" is being accessed by other users'),
  }];
  const { dbManager, calls, restore } = loadDbManager({ templateComment: fresh(), failures });
  try {
    await assert.rejects(dbManager.prepareStagingCloneSource('app_demo', { sourceId: 'shots-run-held' }),
      /^Error: Command failed: psql -X -v ON_ERROR_STOP=1 -c CREATE DATABASE app_demo_evsrc_[0-9a-f]{12} TEMPLATE app_demo_stgtmpl[^]*source database "app_demo_stgtmpl" is being accessed by other users/);
    const prepared = dbManager.preparedCloneSourceName('app_demo', 'shots-run-held');
    assert.equal(sqls(calls).filter((sql) => sql.startsWith(`CREATE DATABASE ${prepared} TEMPLATE`)).length, 3,
      'three attempts, no more');
    const after = sqls(calls).slice(sqls(calls).findLastIndex((sql) => sql.startsWith('CREATE DATABASE')));
    assert.ok(after.includes(`DROP ROLE IF EXISTS ${prepared}_owner`), 'the half-made source and its role are cleaned up');
  } finally { restore(); }
});

test('the shared template vanishes before the shots copy: it is rebuilt and the copy runs again', async () => {
  // Reads: ensure → fresh; provenance → fresh; the copy then fails with
  // Postgres's missing-template error; the re-ensure reads no template
  // (empty), rebuilds it; the provenance read is fresh again.
  let read = 0;
  const templateComment = () => (++read === 3 ? '' : fresh());
  const failures = [{
    match: /^CREATE DATABASE app_demo_evsrc_[0-9a-f]{12} TEMPLATE app_demo_stgtmpl OWNER/,
    times: 1,
    error: (sql) => psqlError(sql, 'template database "app_demo_stgtmpl" does not exist'),
  }];
  const { dbManager, calls, restore } = loadDbManager({ templateComment, failures });
  try {
    const prepared = await dbManager.prepareStagingCloneSource('app_demo', { sourceId: 'shots-run-vanished' });
    assert.match(prepared.fingerprint, /^[0-9a-f]{64}$/);
    const s = sqls(calls);
    const built = s.findIndex((sql) => sql === 'CREATE DATABASE app_demo_stgtmpl_next TEMPLATE template0 OWNER app_demo_stgtmpl_owner');
    const swapped = s.findIndex((sql) => sql === 'ALTER DATABASE app_demo_stgtmpl_next RENAME TO app_demo_stgtmpl');
    const copies = s.map((sql, i) => [sql, i]).filter(([sql]) => sql.startsWith(`CREATE DATABASE ${prepared.templateDb} TEMPLATE`));
    assert.equal(copies.length, 2, 'the copy ran again after the rebuild');
    assert.ok(copies[0][1] < built && built < swapped && swapped < copies[1][1],
      'the template is rebuilt into _next, swapped in by rename, and only then copied');
    assert.ok(dumps(calls).length >= 1 && restores(calls).some((c) => c.args.includes('app_demo_stgtmpl_next')),
      'the rebuild goes through the direct path\'s own dump/restore');
    assert.ok(s.some((sql) => sql.startsWith(`COMMENT ON DATABASE ${prepared.templateDb} IS 'shots-clone-source source=app_demo refreshed_at=`)),
      'the prepared source is stamped');
    assert.ok(s.some((sql) => sql === `ALTER DATABASE ${prepared.templateDb} WITH ALLOW_CONNECTIONS false`), 'and locked');
  } finally { restore(); }
});

test('the rebuilt template keeps missing: the shots source is built directly from the live source', async () => {
  let read = 0;
  const templateComment = () => (++read === 3 ? '' : fresh());
  const failures = [{
    match: /^CREATE DATABASE app_demo_evsrc_[0-9a-f]{12} TEMPLATE app_demo_stgtmpl OWNER/,
    times: Infinity,
    error: (sql) => psqlError(sql, 'template database "app_demo_stgtmpl" does not exist'),
  }];
  const { dbManager, calls, connections, restore } = loadDbManager({
    templateComment, failures, privateTables: ['public.private_data'],
  });
  try {
    const prepared = await dbManager.prepareStagingCloneSource('app_demo', { sourceId: 'shots-run-direct' });
    assert.match(prepared.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(Math.abs(Date.parse(prepared.refreshedAt) - Date.now()) < 60_000,
      'a direct build is as fresh as the moment it was made');
    const s = sqls(calls);
    const copies = s.filter((sql) => sql.startsWith(`CREATE DATABASE ${prepared.templateDb} TEMPLATE app_demo_stgtmpl`));
    assert.equal(copies.length, 2, 'the shared template was tried once more after the rebuild, then given up on');
    // Order over the raw call stream: a TRUNCATE also ran on the rebuild's
    // _next, so the prepared source's own steps are told apart by its db.
    const stepAt = (pred) => calls.findIndex((c) => ['psql', 'pg'].includes(c.cmd) && pred(c.sql, c.db));
    const direct = stepAt((sql) => sql === `CREATE DATABASE ${prepared.templateDb} TEMPLATE template0 OWNER ${prepared.templateDb}_owner`);
    assert.ok(direct > -1, 'the prepared source is created from template0 instead');
    assert.ok(restores(calls).some((c) => c.args.includes(prepared.templateDb)), 'and restored from the live source');
    const truncateAt = stepAt((sql, db) => db === prepared.templateDb && /^TRUNCATE public\.private_data/.test(sql));
    const locked = stepAt((sql) => sql === `ALTER DATABASE ${prepared.templateDb} WITH ALLOW_CONNECTIONS false`);
    assert.ok(direct < truncateAt && truncateAt < locked, 'the redaction passes run on it before it is locked');
    assert.ok(connections.every((c) => c.db !== prepared.templateDb),
      'no shared-role ownership pass runs on a direct build');
  } finally { restore(); }
});

test('a rebuild that itself fails falls back to the direct build too', async () => {
  let read = 0;
  const templateComment = () => (++read === 3 ? '' : fresh());
  const failures = [{
    match: /^CREATE DATABASE app_demo_evsrc_[0-9a-f]{12} TEMPLATE app_demo_stgtmpl OWNER/,
    times: 1,
    error: (sql) => psqlError(sql, 'template database "app_demo_stgtmpl" does not exist'),
  }, {
    match: /^CREATE DATABASE app_demo_stgtmpl_next TEMPLATE template0/,
    times: Infinity,
    error: (sql) => psqlError(sql, 'source database "app_demo" is being accessed by other users'),
  }];
  const { dbManager, calls, restore } = loadDbManager({ templateComment, failures });
  try {
    const prepared = await dbManager.prepareStagingCloneSource('app_demo', { sourceId: 'shots-run-rebuild-fails' });
    const s = sqls(calls);
    assert.ok(s.some((sql) => sql === `CREATE DATABASE ${prepared.templateDb} TEMPLATE template0 OWNER ${prepared.templateDb}_owner`),
      'the prepared source is built directly when the template cannot be rebuilt either');
    assert.ok(restores(calls).some((c) => c.args.includes(prepared.templateDb)));
    assert.ok(s.some((sql) => sql === `ALTER DATABASE ${prepared.templateDb} WITH ALLOW_CONNECTIONS false`), 'and it is still finished and locked');
  } finally { restore(); }
});

test('both sides\' clones from the prepared source get the same retry over their pg connection', async () => {
  const target = `app_demo_shots_${RUN_TOKEN}_b`;
  for (const [kind, error, cutsOff] of [
    ['in use', pgError('55006', 'source database "x" is being accessed by other users'), true],
    ['deadlock', pgError('40P01', 'deadlock detected'), false],
  ]) {
    const failures = [{ match: new RegExp(`^CREATE DATABASE ${target} TEMPLATE`), times: 1, error: () => error }];
    const { dbManager, calls, waits, restore } = loadDbManager({ templateComment: fresh(), failures });
    try {
      const source = dbManager.preparedCloneSourceName('app_demo', 'shots-run-clone');
      const out = await dbManager.cloneFromPreparedSource(source, target);
      assert.match(out.password, /^[0-9a-f]{48}$/, kind);
      const onAdmin = calls.filter((c) => c.cmd === 'pg' && c.db === 'usernode').map((c) => c.sql);
      assert.equal(onAdmin.filter((sql) => sql.startsWith(`CREATE DATABASE ${target} TEMPLATE ${source}`)).length, 2, kind);
      assert.equal(terminates(calls, source).length > 0, cutsOff,
        `${kind}: the source's sessions are cut off only when one was in the way`);
      const secondCopy = onAdmin.findLastIndex((sql) => sql.startsWith(`CREATE DATABASE ${target}`));
      assert.equal(onAdmin[secondCopy - 1], `DROP DATABASE IF EXISTS ${target} WITH (FORCE)`,
        `${kind}: whatever the failed attempt left of the target is dropped first`);
      assert.deepEqual(waits, [1_000], kind);
    } finally { restore(); }
  }
});

test('a refused DROP of the template\'s _next build is forced and tried again (Plant Pal PR 6)', async () => {
  const failures = [{
    match: /^DROP DATABASE IF EXISTS app_demo_stgtmpl_next WITH \(FORCE\)$/,
    times: 1,
    error: (sql) => psqlError(sql, 'database "app_demo_stgtmpl_next" is being accessed by other users'),
  }];
  const { dbManager, calls, waits, restore } = loadDbManager({ failures });
  try {
    const out = await dbManager.cloneDatabase('app_demo', 'app_demo_staging_s1_abc123', { viaTemplate: true });
    assert.equal(out.via, 'template', 'the template was rebuilt rather than given up on');
    assert.equal(out.templateRefreshed, true);
    assert.equal(sqls(calls).filter((sql) => sql === 'DROP DATABASE IF EXISTS app_demo_stgtmpl_next WITH (FORCE)').length, 2);
    assert.ok(terminates(calls, 'app_demo_stgtmpl_next').length >= 2, 'sessions are cut off before each attempt');
    assert.deepEqual(waits, [1_000]);
  } finally { restore(); }
});

test('the rename that swaps the template in waits out a session still leaving _next', async () => {
  const failures = [{
    match: /^ALTER DATABASE app_demo_stgtmpl_next RENAME TO app_demo_stgtmpl$/,
    times: 1,
    error: (sql) => psqlError(sql, 'database "app_demo_stgtmpl_next" is being accessed by other users'),
  }];
  const { dbManager, calls, restore } = loadDbManager({ failures });
  try {
    const out = await dbManager.cloneDatabase('app_demo', 'app_demo_staging_s1_abc123', { viaTemplate: true });
    assert.equal(out.via, 'template');
    const s = sqls(calls);
    const renames = s.map((sql, i) => [sql, i]).filter(([sql]) => /RENAME TO app_demo_stgtmpl$/.test(sql));
    assert.equal(renames.length, 2);
    assert.ok(s.slice(renames[0][1], renames[1][1]).some((sql) => sql.startsWith('SELECT pg_terminate_backend')
      && sql.includes("datname = 'app_demo_stgtmpl_next'")));
  } finally { restore(); }
});

test('an older server without DROP … WITH (FORCE) gets the plain statement', async () => {
  const failures = [{
    match: / WITH \(FORCE\)$/,
    error: (sql) => psqlError(sql, 'syntax error at or near "WITH"'),
  }];
  const { dbManager, calls, restore } = loadDbManager({ failures });
  try {
    const shots = `app_demo_shots_${RUN_TOKEN}_h`;
    await dbManager.dropDatabase(shots, { strict: true });
    const s = sqls(calls);
    const forced = s.indexOf(`DROP DATABASE IF EXISTS ${shots} WITH (FORCE)`);
    assert.ok(forced >= 0);
    assert.equal(s[forced + 1], `DROP DATABASE IF EXISTS ${shots}`);
    assert.ok(s.includes(`DROP ROLE IF EXISTS ${shots}_owner`), 'and the clone\'s role goes with it');
  } finally { restore(); }
});

test('only the disposable shots and template databases can be forced, cut off or retried', async () => {
  const { dbManager, calls, waits, restore } = loadDbManager({
    failures: [{
      match: /^DROP DATABASE IF EXISTS app_plant_pal_1ad9b5$/,
      error: (sql) => psqlError(sql, 'database "app_plant_pal_1ad9b5" is being accessed by other users'),
    }],
  });
  try {
    const runId = 'c'.repeat(32);
    for (const name of [
      dbManager.shotsDbName('usernode-2d5619', runId, 'base'),
      dbManager.shotsDbName('plant-pal-1ad9b5', runId, 'head'),
      dbManager.legacyShotsDbName('usernode-2d5619', runId, 'head'),
      dbManager.preparedCloneSourceName('app_usernode_2d5619', runId),
      'app_usernode_2d5619_evsrc_3507b567ed7f',
      'app_usernode_2d5619_stgtmpl',
      'app_plant_pal_1ad9b5_stgtmpl_next',
    ]) assert.equal(dbManager.isDisposableDb(name), true, name);
    for (const name of [
      'app_usernode_2d5619', 'app_plant_pal_1ad9b5',            // an app's own database
      'app_plant_pal_1ad9b5_staging_s42_abc123',                 // a preview's clone
      'usernode', 'postgres', 'template1',
      'app_demo_stgtmpl_old', 'app_demo_evsrc_123', `app_demo_shots_${RUN_TOKEN}_x`,
      'APP_DEMO_STGTMPL', "app_demo_stgtmpl'; DROP DATABASE app_demo; --", '', null,
    ]) {
      assert.equal(dbManager.isDisposableDb(name), false, String(name));
      await assert.rejects(dbManager.terminateDisposableSessions(name), /not a disposable shots or staging-template database/);
      await assert.rejects(dbManager.dropDisposableDatabase(name), /not a disposable shots or staging-template database/);
    }
    assert.deepEqual(sqls(calls), [], 'a refused name reaches no statement');

    // An app's own database keeps the plain drop: no FORCE, and a refusal is
    // not retried.
    await assert.rejects(dbManager.dropDatabase('app_plant_pal_1ad9b5', { strict: true }), /being accessed by other users/);
    assert.ok(!sqls(calls).some((sql) => /WITH \(FORCE\)/.test(sql)));
    assert.equal(sqls(calls).filter((sql) => sql === 'DROP DATABASE IF EXISTS app_plant_pal_1ad9b5').length, 1);
    assert.deepEqual(waits, []);
  } finally { restore(); }
});

test('a preview\'s template clone is not retried: it falls back to the direct copy as before', async () => {
  const failures = [{
    match: /^CREATE DATABASE app_demo_staging_s8_abc123 TEMPLATE app_demo_stgtmpl OWNER/,
    error: () => pgError('55006', 'source database "app_demo_stgtmpl" is being accessed by other users'),
  }];
  const { dbManager, calls, waits, restore } = loadDbManager({ templateComment: fresh(), failures });
  try {
    const out = await dbManager.cloneDatabase('app_demo', 'app_demo_staging_s8_abc123', { viaTemplate: true });
    assert.equal(out.via, 'direct');
    assert.equal(sqls(calls).filter((sql) => /^CREATE DATABASE app_demo_staging_s8_abc123 TEMPLATE app_demo_stgtmpl/.test(sql)).length, 1);
    assert.equal(terminates(calls, 'app_demo_stgtmpl').length, 0, 'nothing is cut off on a preview\'s behalf');
    assert.deepEqual(waits, []);
  } finally { restore(); }
});
