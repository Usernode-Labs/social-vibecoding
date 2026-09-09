'use strict';

// Staging templates (db-manager.js): a preview clones from a redacted copy
// of its app's database that is kept warm on the server, refreshed at most
// every STAGING_DB_TEMPLATE_MAX_AGE_MS, instead of paying pg_dump |
// pg_restore of the live database on every build.
//
// Pinned here, with child_process stubbed at the same seam as
// tests/db-clone-exclude-data.test.js:
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

function loadDbManager({ templateComment = null, failOn = null, maxAge = null } = {}) {
  const savedEnv = { url: process.env.DB_ADMIN_URL, age: process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS };
  process.env.DB_ADMIN_URL = 'postgres://usernode:test@db.example.test:5432/usernode';
  if (maxAge === null) delete process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS;
  else process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS = String(maxAge);
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/db-manager'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const calls = [];
  const fakeExecFile = (cmd, args, opts = {}) => {
    const dashC = args.indexOf('-c');
    const sql = dashC >= 0 ? args[dashC + 1] : '';
    calls.push({ cmd, args, sql, db: (opts.env || {}).PGDATABASE });
    if (failOn && failOn.test(sql)) return Promise.reject(new Error(`boom: ${sql.slice(0, 40)}`));
    if (/shobj_description/.test(sql)) {
      return Promise.resolve({ stdout: templateComment ? `${templateComment}\n` : '\n', stderr: '' });
    }
    if (/obj_description|col_description/.test(sql)) return Promise.resolve({ stdout: '\n', stderr: '' });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;
  const fakeSpawn = (cmd, args, opts = {}) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    calls.push({ cmd, args, db: (opts.env || {}).PGDATABASE });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  stub(ids.childProcess, { execFile: fakeExecFile, spawn: fakeSpawn });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  const dbManager = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) { if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id]; }
    if (savedEnv.url === undefined) delete process.env.DB_ADMIN_URL; else process.env.DB_ADMIN_URL = savedEnv.url;
    if (savedEnv.age === undefined) delete process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS; else process.env.STAGING_DB_TEMPLATE_MAX_AGE_MS = savedEnv.age;
  };
  return { dbManager, calls, restore };
}

const sqls = (calls) => calls.filter((c) => c.cmd === 'psql').map((c) => c.sql);
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
    const drop = at(/DROP DATABASE IF EXISTS app_demo_stgtmpl$/);
    const rename = at(/ALTER DATABASE app_demo_stgtmpl_next RENAME TO app_demo_stgtmpl/);
    assert.ok(create < comment && comment < lock && lock < drop && drop < rename, 'build, stamp, lock, drop old, rename');
    // Then the clone itself: a file copy handed to a fresh role.
    const cloneCreate = at(/CREATE DATABASE app_demo_staging_s1_abc123 TEMPLATE app_demo_stgtmpl OWNER app_demo_staging_s1_abc123_owner/);
    assert.ok(cloneCreate > rename, 'the clone follows the swap');
    assert.ok(s.slice(cloneCreate).some((x) => /GRANT ALL PRIVILEGES ON DATABASE app_demo_staging_s1_abc123 TO app_demo_staging_s1_abc123_owner/.test(x)));
    // Ownership walk template role → clone role, then the redaction passes on the clone.
    const walk = calls.filter((c) => c.cmd === 'psql' && c.db === 'app_demo_staging_s1_abc123' && /DO \$\$/.test(c.sql));
    assert.ok(walk.length >= 1, 'reassignUserObjectsTo ran inside the clone');
    assert.ok(walk.some((c) => /app_demo_stgtmpl_owner/.test(c.sql) && /app_demo_staging_s1_abc123_owner/.test(c.sql)));
    const onClone = calls.filter((c) => c.cmd === 'psql' && c.db === 'app_demo_staging_s1_abc123').map((c) => c.sql);
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
