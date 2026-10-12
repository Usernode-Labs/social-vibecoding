'use strict';

// A second Postgres server for preview databases (STAGING_DB_ADMIN_URL,
// src/services/db-manager.js), with pg and child_process stubbed at the same
// seam as tests/staging-db-template.test.js. Every statement is recorded
// with the server it was sent to. Pinned here:
//   - without the setting, nothing is ever sent to another server and no
//     statement differs from before;
//   - with it, a preview's template, clone, role and both redaction passes
//     are on the preview server, the dump is read from the main server and
//     restored on the preview server, and an old database of the same name
//     is dropped on both;
//   - PostgreSQL 18 on the preview server is asked for a shared-block copy,
//     in the same session as its SET; an older one, a refusal, the off
//     switch and the main server (whatever its version) get the plain copy,
//     and a refusal is said once;
//   - draining makes new previews on the main server and still cleans the
//     preview server;
//   - a preview server that fails does not fall back to the main server and
//     marks the failure as the platform's;
//   - the setting's password is in no log line and no error;
//   - a preview whose database is gone needs a rebuild, and only on positive
//     evidence.
// tests/preview-db-server-postgres.test.js runs the same paths on two real
// servers.
//
// Run with: node --test tests/preview-db-server.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const MAIN_HOST = 'main-db.example.test';
const PREVIEW_HOST = 'preview-db.example.test';
const PREVIEW_PASSWORD = 'pv-secret-4f1c';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function load({
  preview = `postgres://previewadmin:${PREVIEW_PASSWORD}@${PREVIEW_HOST}:5432/postgres`,
  drain = false, fileClone = null,
  versions = { [MAIN_HOST]: 170007, [PREVIEW_HOST]: 180006 },
  identifiers = { [MAIN_HOST]: '7001', [PREVIEW_HOST]: '7002' },
  templates = {},            // host → shobj_description comment
  databases = {},            // host → [datname] for pg_database listings
  failures = [],             // [{ host, match, times, error(sql) }]
  privateTables = ['public.vault'],
} = {}) {
  const env = {
    DB_ADMIN_URL: `postgres://usernode:main-secret@${MAIN_HOST}:5432/usernode`,
    STAGING_DB_ADMIN_URL: preview,
    STAGING_DB_SERVER_DRAIN: drain ? '1' : null,
    STAGING_DB_FILE_CLONE: fileClone,
    STAGING_DB_TEMPLATE_MAX_AGE_MS: null,
  };
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  const ids = {
    childProcess: require.resolve('child_process'),
    pg: require.resolve('pg'),
    logger: require.resolve('../src/services/logger'),
    dbRetry: require.resolve('../src/services/db-retry'),
    subject: require.resolve('../src/services/db-manager'),
  };
  const orig = {};
  for (const [key, id] of Object.entries(ids)) orig[key] = require.cache[id];

  const calls = [];
  const logs = [];
  const answer = (host, db, sql, via) => {
    calls.push({ via, host, db, sql });
    const failure = failures.find((f) => (!f.host || f.host === host) && f.match.test(sql) && (f.times ?? Infinity) > 0);
    if (failure) {
      failure.times = (failure.times ?? Infinity) - 1;
      throw failure.error(sql);
    }
    if (/^SHOW server_version_num/.test(sql)) return String(versions[host] || '');
    if (/system_identifier/.test(sql)) return String(identifiers[host] || '');
    if (/shobj_description/.test(sql)) return templates[host] || '';
    if (/FROM pg_database/.test(sql)) return (databases[host] || []).join('\n');
    if (/SELECT EXISTS/.test(sql)) return 'f';
    if (/col_description/.test(sql)) return '';
    if (/obj_description/.test(sql)) return privateTables.join('\n');
    return '';
  };
  const fakeExecFile = async (cmd, args, opts = {}) => {
    const host = (opts.env || {}).PGHOST;
    const db = (opts.env || {}).PGDATABASE;
    const statements = args.flatMap((arg, i) => (args[i - 1] === '-c' ? [arg] : []));
    let stdout = '';
    for (const sql of statements) stdout = answer(host, db, sql, 'psql');
    return { stdout: stdout ? `${stdout}\n` : '', stderr: '' };
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;
  const fakeSpawn = (cmd, args, opts = {}) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    calls.push({ via: cmd, host: (opts.env || {}).PGHOST, db: (opts.env || {}).PGDATABASE, sql: '', args });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  class FakeClient extends EventEmitter {
    constructor(config) {
      super();
      const url = new URL(config.connectionString);
      this.host = url.hostname;
      this.db = url.pathname.slice(1);
      this.session = Symbol('session');
    }
    async connect() {
      const failure = failures.find((f) => f.connect && (!f.host || f.host === this.host));
      if (failure) throw failure.error('connect');
    }
    async query(config) {
      const text = typeof config === 'string' ? config : config.text;
      const out = answer(this.host, this.db, text, 'pg');
      calls[calls.length - 1].session = this.session;
      return { rows: out ? out.split('\n').map((line) => (config.rowMode === 'array' ? line.split('|') : { datname: line })) : [] };
    }
    async end() {}
  }
  const record = (level) => (scope, message, meta) => logs.push({ level, scope, message, meta });
  stub(ids.pg, { Client: FakeClient });
  stub(ids.childProcess, { execFile: fakeExecFile, spawn: fakeSpawn });
  stub(ids.logger, { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') });
  delete require.cache[ids.dbRetry];
  const realRetry = require(ids.dbRetry);
  stub(ids.dbRetry, {
    ...realRetry,
    withDbRetry: (fn, options = {}) => realRetry.withDbRetry(fn, { ...options, wait: async () => {} }),
  });
  delete require.cache[ids.subject];
  const dbManager = require(ids.subject);
  const restore = () => {
    for (const [key, id] of Object.entries(ids)) { if (orig[key]) require.cache[id] = orig[key]; else delete require.cache[id]; }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  const on = (host) => calls.filter((c) => c.host === host);
  const sqlOn = (host) => on(host).filter((c) => c.sql).map((c) => c.sql);
  return { dbManager, calls, logs, restore, on, sqlOn };
}

const SOURCE = 'app_demo';
const TARGET = 'app_demo_staging_s9_abc123';
const fresh = () => `staging-template source=${SOURCE} refreshed_at=${new Date().toISOString()}`;
const copyStatements = (sqls) => sqls.filter((sql) => /^CREATE DATABASE \S+ TEMPLATE \S+_(stgtmpl|evsrc_[0-9a-f]{12}) /.test(sql));

test('without the setting there is one server and no statement changes', async () => {
  const h = load({ preview: null, versions: { [MAIN_HOST]: 180006 } });
  try {
    assert.equal(h.dbManager.previewServerConfigured(), false);
    const cloned = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(cloned.server, 'primary');
    assert.ok(h.calls.length > 10);
    assert.ok(h.calls.every((c) => c.host === MAIN_HOST), 'every statement goes to the main server');
    const sqls = h.sqlOn(MAIN_HOST);
    assert.equal(sqls.filter((sql) => /FILE_COPY|file_copy_method|server_version_num|system_identifier/.test(sql)).length, 0,
      'the main server is never asked for a file copy, even on PostgreSQL 18, and nothing new is asked of it');
    assert.deepEqual(copyStatements(sqls), [`CREATE DATABASE ${TARGET} TEMPLATE ${SOURCE}_stgtmpl OWNER ${TARGET}_owner`]);
    assert.equal(sqls.filter((sql) => sql.startsWith(`DROP DATABASE IF EXISTS ${TARGET}`)).length, 1, 'one drop of the old target, as before');
    assert.equal(new URL(h.dbManager.connectionUrl(TARGET, cloned.password, { server: cloned.server })).hostname, MAIN_HOST);
    assert.equal(await h.dbManager.previewDatabaseVerdict(labelsFor(TARGET, 'preview')), null, 'with one server the question is not asked');
    assert.deepEqual(await h.dbManager.retireStrayTemplates(), { examined: 0, dropped: 0, failed: 0 });
  } finally { h.restore(); }
});

test('with the setting, a preview is built on the preview server from a dump read on the main server', async () => {
  const h = load();
  try {
    assert.equal(h.dbManager.previewCreateServer(), 'preview');
    const cloned = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(cloned.server, 'preview');
    assert.equal(cloned.via, 'template');
    assert.equal(cloned.templateRefreshed, true);
    const url = new URL(h.dbManager.connectionUrl(TARGET, cloned.password, { server: cloned.server }));
    assert.equal(url.hostname, PREVIEW_HOST);
    assert.equal(url.username, `${TARGET}_owner`);
    assert.notEqual(url.password, PREVIEW_PASSWORD, 'a preview gets its own role, never the server\'s admin credential');

    const main = h.sqlOn(MAIN_HOST);
    const preview = h.sqlOn(PREVIEW_HOST);
    // The main server: read, and cleared of an old database of this name.
    assert.equal(h.on(MAIN_HOST).filter((c) => c.via === 'pg_dump' && c.db === SOURCE).length, 1, 'the dump reads the live source');
    assert.equal(h.on(MAIN_HOST).filter((c) => c.via === 'pg_restore').length, 0);
    assert.ok(main.some((sql) => /WITH RECURSIVE priv/.test(sql)), 'what to leave out of the dump is read from the source');
    assert.equal(main.filter((sql) => /^(CREATE|ALTER|COMMENT|REVOKE|GRANT|TRUNCATE|UPDATE)\b/.test(sql)).length, 0,
      'nothing is created or changed on the main server');
    assert.ok(main.includes(`DROP DATABASE IF EXISTS ${TARGET}`), 'an earlier build of this preview on the main server is dropped');
    // The preview server: everything else.
    const restores = h.on(PREVIEW_HOST).filter((c) => c.via === 'pg_restore');
    assert.equal(restores.length, 1);
    assert.equal(restores[0].db, `${SOURCE}_stgtmpl_next`);
    assert.deepEqual(restores[0].args, ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', `${SOURCE}_stgtmpl_next`]);
    for (const expected of [
      `CREATE DATABASE ${SOURCE}_stgtmpl_next TEMPLATE template0 OWNER ${SOURCE}_stgtmpl_owner`,
      `ALTER DATABASE ${SOURCE}_stgtmpl_next WITH ALLOW_CONNECTIONS false`,
      `ALTER DATABASE ${SOURCE}_stgtmpl_next RENAME TO ${SOURCE}_stgtmpl`,
      `REVOKE CONNECT ON DATABASE ${TARGET} FROM PUBLIC`,
      `ALTER DATABASE ${TARGET} CONNECTION LIMIT 12`,
    ]) assert.ok(preview.includes(expected), expected);
    assert.ok(preview.some((sql) => sql.startsWith(`CREATE ROLE ${TARGET}_owner LOGIN PASSWORD`)));
    // Both redaction passes, on the template and again on the clone.
    for (const db of [`${SOURCE}_stgtmpl_next`, TARGET]) {
      const there = h.on(PREVIEW_HOST).filter((c) => c.db === db).map((c) => c.sql);
      assert.ok(there.includes('TRUNCATE public.vault RESTART IDENTITY CASCADE'), `${db}: private tables are emptied`);
      assert.ok(there.some((sql) => /col_description/.test(sql)), `${db}: private columns are looked for`);
    }
    // The shared-block copy: asked of the preview server, in one session.
    const copy = h.calls.find((c) => /STRATEGY = FILE_COPY$/.test(c.sql));
    assert.equal(copy.sql, `CREATE DATABASE ${TARGET} TEMPLATE ${SOURCE}_stgtmpl OWNER ${TARGET}_owner STRATEGY = FILE_COPY`);
    assert.equal(copy.host, PREVIEW_HOST);
    const before = h.calls[h.calls.indexOf(copy) - 1];
    assert.equal(before.sql, 'SET file_copy_method = clone');
    assert.equal(before.session, copy.session, 'the SET and the copy share one connection');
    assert.equal(copyStatements(preview).length, 1, 'no second, plain copy');
  } finally { h.restore(); }
});

test('through psql too, the SET and the copy are separate statements of one session', async () => {
  const h = load();
  try {
    await h.dbManager.createFromTemplate(`${SOURCE}_stgtmpl`, 'app_demo_shots_0123456789ab_b', 'app_demo_shots_0123456789ab_b_owner', {
      server: 'preview', timeoutMs: 90_000,
    });
    const copy = h.calls.find((c) => /STRATEGY = FILE_COPY$/.test(c.sql));
    assert.equal(copy.via, 'psql');
    assert.equal(h.calls[h.calls.indexOf(copy) - 1].sql, 'SET file_copy_method = clone');
    assert.doesNotMatch(copy.sql, /;/, 'a CREATE DATABASE sharing one -c with a SET would be inside a transaction block');
  } finally { h.restore(); }
});

for (const [name, options, note] of [
  ['an older preview server', { versions: { [MAIN_HOST]: 170007, [PREVIEW_HOST]: 170007 } }, /older than PostgreSQL 18/],
  ['the off switch', { fileClone: '0' }, null],
  ['one server under two addresses', { identifiers: { [MAIN_HOST]: '7001', [PREVIEW_HOST]: '7001' } }, /under another address/],
]) {
  test(`${name} gets the plain copy`, async () => {
    const h = load({ ...options, templates: { [PREVIEW_HOST]: fresh() } });
    try {
      await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
      await h.dbManager.cloneDatabase(SOURCE, 'app_demo_staging_s10_def456', { viaTemplate: true });
      const copies = copyStatements(h.sqlOn(PREVIEW_HOST));
      assert.equal(copies.length, 2);
      assert.ok(copies.every((sql) => !/STRATEGY/.test(sql)));
      assert.equal(h.calls.filter((c) => /file_copy_method/.test(c.sql)).length, 0);
      if (note) assert.equal(h.logs.filter((l) => note.test(l.message)).length, 1, 'said once');
    } finally { h.restore(); }
  });
}

test('a refused shared-block copy falls back to the plain copy and says so once', async () => {
  const refusal = () => new Error('ERROR:  could not clone file "base/5/1259" to "base/16400/1259": Operation not supported');
  const h = load({
    templates: { [PREVIEW_HOST]: fresh() },
    failures: [{ host: PREVIEW_HOST, match: /STRATEGY = FILE_COPY/, times: 1, error: refusal }],
  });
  try {
    const first = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(first.via, 'template', 'the build is not sent down the slow direct path for this');
    await h.dbManager.cloneDatabase(SOURCE, 'app_demo_staging_s10_def456', { viaTemplate: true });
    const copies = copyStatements(h.sqlOn(PREVIEW_HOST));
    assert.deepEqual(copies.map((sql) => /STRATEGY/.test(sql)), [true, false, false],
      'tried once, then the plain copy for this build and the next');
    const said = h.logs.filter((l) => /refused a shared-block copy/.test(l.message));
    assert.equal(said.length, 1);
    assert.match(said[0].meta.err, /could not clone file/);
  } finally { h.restore(); }
});

test('a copy that fails for another reason is not retried as a plain copy', async () => {
  const h = load({
    templates: { [PREVIEW_HOST]: fresh() },
    failures: [{ host: PREVIEW_HOST, match: /STRATEGY = FILE_COPY/, times: 1, error: () => new Error('Query read timeout') }],
  });
  try {
    // The statement may still be running on the server. The existing
    // fallback (drop the target, build directly) owns this.
    const cloned = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(cloned.via, 'direct');
    assert.equal(cloned.server, 'preview', 'the direct copy is made on the preview server too');
    assert.equal(copyStatements(h.sqlOn(PREVIEW_HOST)).length, 1);
    assert.equal(h.on(MAIN_HOST).filter((c) => c.via === 'pg_restore').length, 0);
    assert.equal(h.on(PREVIEW_HOST).filter((c) => c.via === 'pg_restore' && c.db === TARGET).length, 1);
  } finally { h.restore(); }
});

test('draining makes new previews on the main server and still cleans the preview server', async () => {
  const h = load({ drain: true, templates: { [MAIN_HOST]: fresh() } });
  try {
    assert.equal(h.dbManager.previewCreateServer(), 'primary');
    assert.deepEqual(h.dbManager.previewSideServers(), ['preview', 'primary']);
    const cloned = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(cloned.server, 'primary');
    assert.deepEqual(copyStatements(h.sqlOn(MAIN_HOST)), [`CREATE DATABASE ${TARGET} TEMPLATE ${SOURCE}_stgtmpl OWNER ${TARGET}_owner`]);
    assert.deepEqual(h.sqlOn(PREVIEW_HOST), [
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET}' AND pid <> pg_backend_pid()`,
      `DROP DATABASE IF EXISTS ${TARGET}`,
      `DROP OWNED BY ${TARGET}_owner CASCADE`,
      `DROP ROLE IF EXISTS ${TARGET}_owner`,
    ], 'the preview server only loses an old database of this name');
    h.calls.length = 0;
    await h.dbManager.dropDatabase(TARGET);
    assert.ok(h.sqlOn(PREVIEW_HOST).includes(`DROP DATABASE IF EXISTS ${TARGET}`));
    assert.ok(h.sqlOn(MAIN_HOST).includes(`DROP DATABASE IF EXISTS ${TARGET}`));
  } finally { h.restore(); }
});

test('templates left on the server that no longer makes previews are retired, and only those', async () => {
  const listing = ['app_demo_stgtmpl', 'app_other_stgtmpl', 'app_other_stgtmpl_next', 'app_demo_staging_s9_abc123', 'app_demo'];
  const h = load({ databases: { [MAIN_HOST]: listing, [PREVIEW_HOST]: ['app_demo_stgtmpl'] } });
  try {
    const summary = await h.dbManager.retireStrayTemplates();
    assert.deepEqual(summary, { examined: 2, dropped: 2, failed: 0 });
    const drops = h.sqlOn(MAIN_HOST).filter((sql) => /^DROP (DATABASE|ROLE)/.test(sql));
    assert.ok(drops.length > 0);
    assert.ok(drops.every((sql) => /^DROP DATABASE IF EXISTS app_(demo|other)_stgtmpl(_next)? WITH \(FORCE\)$|^DROP ROLE IF EXISTS app_(demo|other)_stgtmpl_owner$/.test(sql)),
      `only templates and their roles: ${drops.join(' | ')}`);
    assert.equal(h.sqlOn(PREVIEW_HOST).filter((sql) => /^DROP /.test(sql)).length, 0, 'the server that makes previews keeps its templates');
  } finally { h.restore(); }

  // Draining turns it round: the preview server's templates go.
  const draining = load({ drain: true, databases: { [MAIN_HOST]: ['app_demo_stgtmpl'], [PREVIEW_HOST]: ['app_demo_stgtmpl'] } });
  try {
    await draining.dbManager.retireStrayTemplates();
    assert.ok(draining.sqlOn(PREVIEW_HOST).includes('DROP DATABASE IF EXISTS app_demo_stgtmpl WITH (FORCE)'));
    assert.equal(draining.sqlOn(MAIN_HOST).filter((sql) => /^DROP /.test(sql)).length, 0);
  } finally { draining.restore(); }

  // One server under two addresses: nothing is "the other server's".
  const same = load({ identifiers: { [MAIN_HOST]: '7001', [PREVIEW_HOST]: '7001' }, databases: { [MAIN_HOST]: ['app_demo_stgtmpl'], [PREVIEW_HOST]: ['app_demo_stgtmpl'] } });
  try {
    assert.deepEqual(await same.dbManager.retireStrayTemplates(), { examined: 0, dropped: 0, failed: 0 });
    assert.equal(same.calls.filter((c) => /^DROP /.test(c.sql)).length, 0);
  } finally { same.restore(); }
});

test('a drop looks on both servers for preview databases and only on the main one for an app', async () => {
  const h = load();
  try {
    for (const name of [TARGET, 'app_demo_shots_0123456789ab_h', 'app_demo_evsrc_0123456789ab', 'app_demo_stgtmpl']) {
      assert.equal(h.dbManager.isPreviewSideDb(name), true, name);
      h.calls.length = 0;
      await h.dbManager.dropDatabase(name);
      assert.ok(h.sqlOn(PREVIEW_HOST).some((sql) => sql.startsWith(`DROP DATABASE IF EXISTS ${name}`)), `${name} on the preview server`);
      assert.ok(h.sqlOn(MAIN_HOST).some((sql) => sql.startsWith(`DROP DATABASE IF EXISTS ${name}`)), `${name} on the main server`);
    }
    for (const name of ['app_demo', 'app_usernode_2d5619', 'usernode']) {
      assert.equal(h.dbManager.isPreviewSideDb(name), false, name);
      h.calls.length = 0;
      await h.dbManager.dropDatabase(name);
      assert.equal(h.on(PREVIEW_HOST).length, 0, `${name} is never looked for on the preview server`);
      assert.ok(h.sqlOn(MAIN_HOST).includes(`DROP DATABASE IF EXISTS ${name}`));
    }
    // The orphan sweep decided per server and drops on that one only.
    h.calls.length = 0;
    await h.dbManager.dropDatabase(TARGET, { server: 'preview' });
    assert.equal(h.on(MAIN_HOST).length, 0);
    // A fork's production database is created on the main server.
    h.calls.length = 0;
    const fork = await h.dbManager.cloneDatabase(SOURCE, 'app_fork_1a2b3c');
    assert.equal(fork.server, 'primary');
    assert.equal(h.on(PREVIEW_HOST).length, 0);
    await h.dbManager.createDatabase('app_new_1a2b3c');
    assert.equal(h.on(PREVIEW_HOST).length, 0);
    assert.equal(new URL(h.dbManager.connectionUrl('app_new_1a2b3c', 'pw')).hostname, MAIN_HOST);
  } finally { h.restore(); }
});

test('a preview server that fails does not fall back to the main server, and its password is nowhere', async () => {
  const refused = () => new Error(`connection to server at "${PREVIEW_HOST}", port 5432 failed: Connection refused`);
  const h = load({ failures: [{ host: PREVIEW_HOST, match: /./, connect: true, error: refused }] });
  try {
    await assert.rejects(h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), (err) => {
      assert.equal(err.infrastructure, true, 'a platform fault, which the checks retry');
      assert.match(err.message, /Connection refused/);
      return true;
    });
    assert.equal(h.sqlOn(MAIN_HOST).filter((sql) => /^CREATE /.test(sql)).length, 0, 'nothing is created on the main server');
    assert.equal(h.on(MAIN_HOST).filter((c) => c.via === 'pg_restore').length, 0);
    assert.equal(await h.dbManager.previewDatabaseVerdict(labelsFor(TARGET, 'preview')), null, 'a server that cannot be read is "cannot tell"');
    assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(PREVIEW_PASSWORD));
  } finally { h.restore(); }
});

test('the preview URL is one connection for every client: routing and credentials only in its address', async () => {
  const base = `postgres://previewadmin:${PREVIEW_PASSWORD}@${PREVIEW_HOST}:5432/postgres`;
  for (const [query, name] of [
    ['?port=5999', 'port'], ['?host=main-db.example.test', 'host'], ['?user=postgres', 'user'],
    [`?password=${PREVIEW_PASSWORD}x`, 'password'], ['?dbname=usernode', 'dbname'], ['?options=-c%20x%3D1', 'options'],
    ['?sslmode=require&port=5999', 'port'], ['?application_name=x', 'application_name'],
  ]) {
    const h = load({ preview: `${base}${query}` });
    try {
      await assert.rejects(h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), (err) => {
        assert.match(err.message, new RegExp(`STAGING_DB_ADMIN_URL has an unsupported parameter "${name}"`), query);
        assert.doesNotMatch(`${err.message}${err.stack}`, new RegExp(PREVIEW_PASSWORD));
        assert.equal(err.previewDatabaseServerFault, true);
        return true;
      });
      assert.equal(h.calls.filter((c) => /FILE_COPY|file_copy_method|^CREATE /.test(c.sql)).length, 0,
        `${query}: nothing is created anywhere, and no server is asked for a file copy`);
      assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(PREVIEW_PASSWORD));
    } finally { h.restore(); }
  }
  for (const bad of [`${base}?sslmode=whatever`, `${base}?sslmode=require&sslmode=disable`, `postgres://:${PREVIEW_PASSWORD}@${PREVIEW_HOST}/postgres`]) {
    const h = load({ preview: bad });
    try {
      await assert.rejects(h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), /STAGING_DB_ADMIN_URL/);
    } finally { h.restore(); }
  }
  // sslmode is the one parameter both clients read alike. It is kept, for
  // the platform and in the URL a preview is handed.
  const ssl = load({ preview: `${base}?sslmode=require` });
  try {
    const cloned = await ssl.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    const url = new URL(ssl.dbManager.connectionUrl(TARGET, cloned.password, { server: cloned.server }));
    assert.equal(url.search, '?sslmode=require');
    assert.equal(url.hostname, PREVIEW_HOST);
  } finally { ssl.restore(); }
});

test('a clone URL never carries administrative credentials in its query', () => {
  const saved = process.env.DB_ADMIN_URL;
  process.env.DB_ADMIN_URL = `postgres://usernode:main-secret@${MAIN_HOST}:5432/usernode?sslmode=require&user=postgres&password=admin-secret-77`;
  try {
    delete require.cache[require.resolve('../src/services/db-manager')];
    const dbManager = require('../src/services/db-manager');
    const url = new URL(dbManager.connectionUrl('app_demo', 'role-password'));
    assert.equal(url.username, 'app_demo_owner');
    assert.equal(url.password, 'role-password');
    assert.equal(url.search, '?sslmode=require', 'node-postgres would have let ?user and ?password override the role');
    assert.doesNotMatch(String(url), /admin-secret-77|main-secret/);
  } finally {
    delete require.cache[require.resolve('../src/services/db-manager')];
    if (saved === undefined) delete process.env.DB_ADMIN_URL; else process.env.DB_ADMIN_URL = saved;
  }
});

test('the server asked for its version and identity is the one the copy is sent to', async () => {
  const h = load({ templates: { [PREVIEW_HOST]: fresh() } });
  try {
    await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    const copy = h.calls.find((c) => /STRATEGY = FILE_COPY$/.test(c.sql));
    const version = h.calls.find((c) => /^SHOW server_version_num/.test(c.sql));
    const identity = h.calls.filter((c) => /system_identifier/.test(c.sql));
    assert.equal(version.session, copy.session, 'the version is read on the copy\'s own connection');
    assert.ok(identity.some((c) => c.session === copy.session), 'and so is the identity');
    assert.ok(identity.some((c) => c.host === MAIN_HOST), 'compared with the main server\'s');
  } finally { h.restore(); }
});

test('a clone that fails for want of room is not a refusal and does not switch shared-block copies off', async () => {
  const full = () => new Error('ERROR:  could not clone file "base/5/1259" to "base/16400/1259": No space left on device');
  const h = load({
    templates: { [PREVIEW_HOST]: fresh() },
    failures: [{ host: PREVIEW_HOST, match: /STRATEGY = FILE_COPY/, times: 1, error: full }],
  });
  try {
    const first = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(first.via, 'direct', 'the copy\'s own failure, handled as any other');
    await h.dbManager.cloneDatabase(SOURCE, 'app_demo_staging_s10_def456', { viaTemplate: true });
    assert.equal(copyStatements(h.sqlOn(PREVIEW_HOST)).filter((sql) => /STRATEGY/.test(sql)).length, 2, 'asked again next time');
    assert.equal(h.logs.filter((l) => /refused a shared-block copy/.test(l.message)).length, 0);
  } finally { h.restore(); }
});

test('while draining, a preview server that is down does not stop a build on the main server', async () => {
  const refused = () => new Error(`connection to server at "${PREVIEW_HOST}", port 5432 failed: Connection refused`);
  const h = load({ drain: true, templates: { [MAIN_HOST]: fresh() }, failures: [{ host: PREVIEW_HOST, match: /./, connect: true, error: refused }] });
  try {
    const cloned = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(cloned.server, 'primary');
    assert.equal(cloned.via, 'template');
    assert.equal(h.logs.filter((l) => /Could not drop an old database of this name on the other server/.test(l.message)).length, 1);
    // The direct path too.
    const direct = await h.dbManager.cloneDatabase(SOURCE, 'app_demo_staging_s10_def456');
    assert.equal(direct.server, 'primary');
  } finally { h.restore(); }
});

test('a failed clone on the preview server is stored as a platform fault, so its retries apply', async () => {
  const ids = {
    visuals: require.resolve('../src/services/visuals'),
    lifecycle: require.resolve('../src/services/preview-lifecycle'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/staging-recovery'),
  };
  const orig = {};
  for (const [key, id] of Object.entries(ids)) orig[key] = require.cache[id];
  const stored = [];
  stub(ids.visuals, {
    summarizeBootFailure: (err) => err.message,
    // Stop after the write: the rest of the function is unchanged.
    storeChecks: async (pool, sessionId, commit, result, detail) => { stored.push({ result, detail }); return false; },
  });
  stub(ids.lifecycle, { isCancelled: () => false });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  try {
    const recovery = require(ids.subject);
    const record = (err) => recovery.recordStagingBootFailure({ config: {}, pool: {}, session: { id: 5 }, commitHash: 'abc123', err });
    await record(Object.assign(new Error('preview server refused'), { infrastructure: true, previewDatabaseServerFault: true }));
    await record(Object.assign(new Error('sorry, too many clients already'), { infrastructure: true }));
    await record(new Error('app crashed on boot'));
    assert.deepEqual(stored.map((s) => s.result), [
      { state: 'error', results: [], platformFault: true },
      { state: 'error', results: [] },
      { state: 'error', results: [] },
    ], 'only the preview-server fault is stored differently');
    // What the stored flag buys: the error lane keeps retrying past the cap.
    const row = (platform) => ({ consecutive_check_failures: 6, check_error_platform: platform, first_check_failure_at: new Date().toISOString() });
    assert.equal(recovery.errorWithinAutoRetries(row(true), { maxAutoRetries: 5 }), true);
    assert.equal(recovery.errorWithinAutoRetries(row(false), { maxAutoRetries: 5 }), false);
  } finally {
    for (const [key, id] of Object.entries(ids)) { if (orig[key]) require.cache[id] = orig[key]; else delete require.cache[id]; }
  }
});

test('a bad or self-referring setting is said without its value', async () => {
  const bad = load({ preview: `not a url ${PREVIEW_PASSWORD}` });
  try {
    await assert.rejects(bad.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), (err) => {
      assert.match(err.message, /STAGING_DB_ADMIN_URL is not a valid URL/);
      assert.doesNotMatch(`${err.message}${err.stack}`, new RegExp(PREVIEW_PASSWORD));
      assert.equal(err.infrastructure, true);
      return true;
    });
    assert.equal(bad.sqlOn(MAIN_HOST).filter((sql) => /^CREATE /.test(sql)).length, 0, 'a typo does not quietly put previews on production');
    assert.doesNotMatch(JSON.stringify(bad.logs), new RegExp(PREVIEW_PASSWORD));
  } finally { bad.restore(); }

  const same = load({ preview: `postgres://other:${PREVIEW_PASSWORD}@${MAIN_HOST.toUpperCase()}/postgres` });
  try {
    assert.equal(same.dbManager.previewServerConfigured(), false);
    assert.equal(same.dbManager.previewServerConfigured(), false);
    assert.equal(same.logs.filter((l) => /names the main database server/.test(l.message)).length, 1, 'said once');
    assert.doesNotMatch(JSON.stringify(same.logs), new RegExp(PREVIEW_PASSWORD));
    const cloned = await same.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(cloned.server, 'primary');
  } finally { same.restore(); }
});

const labelsFor = (name, server) => ({ 'usernode.db.name': name, 'usernode.db.server': server });

test('a preview is judged by the database its runtime was given, on the server it was made on', async () => {
  const current = 'app_demo_staging_s7_abc123';
  // An older clone of the SAME session is still on the main server. It must
  // not vouch for the current one.
  const h = load({ databases: { [MAIN_HOST]: ['app_demo_staging_s7_000000'], [PREVIEW_HOST]: ['app_other_staging_s8_latest'] } });
  try {
    assert.deepEqual(h.dbManager.previewDatabaseLabels(current, 'preview'), labelsFor(current, 'preview'));
    assert.equal(await h.dbManager.previewDatabaseVerdict(labelsFor(current, 'preview')), 'gone',
      'wiped from the preview server, whatever else the session has elsewhere');
    assert.equal(await h.dbManager.previewDatabaseVerdict(labelsFor('app_other_staging_s8_latest', 'preview')), null);
    assert.equal(await h.dbManager.previewDatabaseVerdict(labelsFor('app_demo_staging_s7_000000', 'primary')), null);
    assert.equal(await h.dbManager.previewDatabaseVerdict(labelsFor('app_demo_staging_s7_000000', 'preview')), 'gone',
      'the right name on the wrong server is not this runtime\'s database');
    // No labels (a preview from before the setting), or labels this module
    // did not write: nothing is asked.
    h.calls.length = 0;
    for (const labels of [null, {}, { 'usernode.db.name': current }, labelsFor('app_demo', 'preview'), labelsFor(current, 'elsewhere')]) {
      assert.equal(await h.dbManager.previewDatabaseVerdict(labels), null);
    }
    assert.equal(h.calls.length, 0);
  } finally { h.restore(); }

  // Draining: the current clone on the preview server is moved by a rebuild,
  // even though the session has an old clone on the main server.
  const draining = load({ drain: true, databases: {
    [MAIN_HOST]: ['app_demo_staging_s7_000000'], [PREVIEW_HOST]: [current],
  } });
  try {
    assert.equal(await draining.dbManager.previewDatabaseVerdict(labelsFor(current, 'preview')), 'draining');
    assert.equal(await draining.dbManager.previewDatabaseVerdict(labelsFor('app_demo_staging_s7_000000', 'primary')), null,
      'already on the main server');
    assert.equal(await draining.dbManager.previewDatabaseVerdict(labelsFor('app_demo_staging_s7_ffffff', 'preview')), 'gone',
      'gone outranks draining');
  } finally { draining.restore(); }

  // One server: no labels are written, and nothing is asked.
  const one = load({ preview: null });
  try {
    assert.deepEqual(one.dbManager.previewDatabaseLabels(current, 'primary'), {});
    assert.equal(await one.dbManager.previewDatabaseVerdict(labelsFor(current, 'preview')), null);
    assert.equal(one.calls.length, 0);
  } finally { one.restore(); }
});

test('a session id is read from the end of a clone name, never from inside a project slug', async () => {
  const tricky = 'app_review8016_demo_staging_s7_6cb80a_staging_s98017_abcdef';
  const h = load({ databases: { [PREVIEW_HOST]: [
    tricky,
    'app_demo_staging_s12_latest',
    'app_demo_staging_s13_Main-1',          // not a name this module builds
    'app_prod_staging_s55_abcdef',          // a production database that ends like a clone
    'app_demo_stgtmpl',
  ] } });
  try {
    assert.equal(h.dbManager.stagingCloneSessionId(tricky), 98017);
    assert.equal(h.dbManager.stagingCloneSessionId('app_demo_staging_s7_6cb80a_extra'), null);
    assert.equal(h.dbManager.stagingCloneSessionId('app_demo'), null);
    const ids = await h.dbManager.stagingCloneSessionIds('preview', { exclude: new Set(['app_prod_staging_s55_abcdef']) });
    assert.deepEqual([...ids].sort((x, y) => x - y), [12, 98017]);
  } finally { h.restore(); }
});

test('stagingNeedsRebuild rebuilds a running preview whose database is gone or on a draining server', async () => {
  const ids = {
    dbManager: require.resolve('../src/services/db-manager'),
    docker: require.resolve('../src/services/docker'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/staging-recovery'),
  };
  const orig = {};
  for (const [key, id] of Object.entries(ids)) orig[key] = require.cache[id];
  let verdict = null;
  let asked = 0;
  stub(ids.dbManager, { previewDatabaseVerdict: async (labels) => { asked += 1; assert.deepEqual(labels, { 'usernode.db.name': 'x' }); return verdict; } });
  stub(ids.docker, { inspectContainer: async () => ({ status: 'running', labels: { 'usernode.db.name': 'x' } }) });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  try {
    const recovery = require(ids.subject);
    const session = { id: 41, staging_url: 'https://x.example', staging_container_id: 'c1' };
    assert.equal(await recovery.stagingNeedsRebuild(session), false);
    verdict = 'gone';
    assert.equal(await recovery.stagingNeedsRebuild(session), true);
    verdict = 'draining';
    assert.equal(await recovery.stagingNeedsRebuild(session), true);
    assert.equal(asked, 3);
    // A preview that is not running, or has none, is decided before the look.
    assert.equal(await recovery.stagingNeedsRebuild({ id: 41, staging_url: null }), true);
    assert.equal(asked, 3);
    // A look that throws is "cannot tell".
    stub(ids.dbManager, { previewDatabaseVerdict: async () => { throw new Error('boom'); } });
    assert.equal(await recovery.stagingNeedsRebuild(session), false);
  } finally {
    for (const [key, id] of Object.entries(ids)) { if (orig[key]) require.cache[id] = orig[key]; else delete require.cache[id]; }
  }
});

// ─── The connection-pressure pass, per server ───────────────────────────

function loadReapForPressure(fx) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    docker: require.resolve('../src/services/docker'),
    staging: require.resolve('../src/services/staging'),
    dbManager: require.resolve('../src/services/db-manager'),
    events: require.resolve('../src/services/events'),
    ws: require.resolve('../src/services/ws'),
    stagingEnv: require.resolve('../src/services/staging-env'),
    pool: require.resolve('../src/db/pool'),
    census: require.resolve('../src/db/connection-census'),
    activeWorkers: require.resolve('../src/services/active-workers'),
    sessionLifecycle: require.resolve('../src/services/session-lifecycle'),
    reap: require.resolve('../src/services/staging-reap'),
  };
  const orig = {};
  for (const [key, id] of Object.entries(ids)) { orig[key] = require.cache[id]; delete require.cache[id]; }
  const mainPool = { name: 'main', query: async (sql) => ({ rows: /FROM apps/.test(sql) ? [{ slug: 'prod-staging-s3-abcdef' }] : fx.rows }) };
  const previewReader = { name: 'preview' };
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.docker, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.ws, { broadcastToAdmins() {} });
  stub(ids.stagingEnv, { expectedStagingFingerprint: () => 'fp' });
  stub(ids.staging, { hasInFlightBuild: () => false });
  stub(ids.pool, { getPool: () => mainPool });
  stub(ids.activeWorkers, { isSessionBusy: () => false });
  stub(ids.census, {
    connectionCensus: async (reader) => {
      fx.read.push(reader.name);
      const saturated = fx.saturated[reader.name] > 0;
      return { max: 100, used: saturated ? 95 : 10, free: saturated ? 5 : 90, saturated, topDatabases: [] };
    },
  });
  stub(ids.sessionLifecycle, {
    teardownStagingForSession: async ({ sessionId, reason }) => {
      assert.equal(reason, 'connection-pressure');
      fx.tornDown.push(sessionId);
      for (const name of Object.keys(fx.holds)) {
        if (fx.holds[name].has(sessionId)) fx.saturated[name] -= 1;
      }
      return { torn: true };
    },
  });
  stub(ids.dbManager, fx.twoServers ? {
    PRIMARY_SERVER: 'primary',
    PREVIEW_SERVER: 'preview',
    previewServerConfigured: () => true,
    previewServerQueryable: () => previewReader,
    appDbName: (slug) => `app_${slug.replace(/[^a-z0-9_]/g, '_')}`,
    stagingCloneSessionIds: async (server, { exclude }) => {
      assert.ok(exclude.has('app_prod_staging_s3_abcdef'), 'production database names are excluded from the reading');
      return fx.holds[server === 'preview' ? 'preview' : 'main'];
    },
  } : { dropDatabase: async () => {} });
  const reap = require(ids.reap);
  const restore = () => {
    for (const [key, id] of Object.entries(ids)) { if (orig[key]) require.cache[id] = orig[key]; else delete require.cache[id]; }
  };
  return { reap, restore };
}

const pressureFixture = (overrides = {}) => ({
  twoServers: true,
  rows: [
    { id: 1, status: 'active', last_activity_at: '2026-09-01T00:00:00Z' },
    { id: 2, status: 'active', last_activity_at: '2026-09-02T00:00:00Z' },
    { id: 3, status: 'active', last_activity_at: '2026-09-03T00:00:00Z' },
  ],
  // How many teardowns of a preview held there it takes to clear each server.
  saturated: { main: 0, preview: 0 },
  holds: { main: new Set([1]), preview: new Set([2, 3]) },
  read: [],
  tornDown: [],
  ...overrides,
});

test('connection pressure on the preview server reclaims only previews whose database is there', async () => {
  const fx = pressureFixture({ saturated: { main: 0, preview: 1 } });
  const { reap, restore } = loadReapForPressure(fx);
  try {
    const main = await reap.sweepConnectionPressure({});
    assert.equal(main.saturated, false);
    const preview = await reap.sweepConnectionPressure({}, { server: 'preview' });
    assert.equal(preview.saturated, true);
    assert.equal(preview.candidates, 2);
    assert.deepEqual(fx.tornDown, [2], 'idle longest of the previews on that server, and it stops when the pressure is off');
    assert.deepEqual(fx.read, ['main', 'preview', 'preview']);
  } finally { restore(); }
});

test('connection pressure on the main server leaves previews on the preview server alone', async () => {
  const fx = pressureFixture({ saturated: { main: 5, preview: 0 } });
  const { reap, restore } = loadReapForPressure(fx);
  try {
    const main = await reap.sweepConnectionPressure({});
    assert.equal(main.candidates, 1);
    assert.deepEqual(fx.tornDown, [1], 'tearing down a preview on the other server would free nothing here');
  } finally { restore(); }
});

test('with one server the pressure pass is what it was, and the preview pass does nothing', async () => {
  const fx = pressureFixture({ twoServers: false, saturated: { main: 1, preview: 0 }, holds: { main: new Set([1, 2, 3]), preview: new Set() } });
  const { reap, restore } = loadReapForPressure(fx);
  try {
    const preview = await reap.sweepConnectionPressure({}, { server: 'preview' });
    assert.deepEqual(preview, { saturated: false, candidates: 0, tornDown: 0, failed: 0, freed: 0 });
    assert.deepEqual(fx.read, []);
    const main = await reap.sweepConnectionPressure({});
    assert.equal(main.candidates, 3);
    assert.deepEqual(fx.tornDown, [1]);
  } finally { restore(); }
});

// ─── Is a draining preview server still in use? ─────────────────────────

test('drain status counts what depends on the preview server, not connections', async () => {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    docker: require.resolve('../src/services/docker'),
    staging: require.resolve('../src/services/staging'),
    recovery: require.resolve('../src/services/staging-recovery'),
    dbManager: require.resolve('../src/services/db-manager'),
    events: require.resolve('../src/services/events'),
    ws: require.resolve('../src/services/ws'),
    stagingEnv: require.resolve('../src/services/staging-env'),
    pool: require.resolve('../src/db/pool'),
    reap: require.resolve('../src/services/staging-reap'),
  };
  const orig = {};
  for (const [key, id] of Object.entries(ids)) { orig[key] = require.cache[id]; delete require.cache[id]; }
  const fx = {
    draining: true,
    shots: ['app_demo_shots_0123456789ab_b', 'app_demo_evsrc_0123456789ab'],
    // session id → the runtime's state, or null when it could not be read
    runtimes: {
      1: { status: 'running', labels: { 'usernode.db.server': 'preview' } },   // idle, zero connections, still depends on it
      2: { status: 'running', labels: { 'usernode.db.server': 'primary' } },
      3: { status: 'running', labels: {} },                                    // from before the setting
      4: { status: 'exited', labels: { 'usernode.db.server': 'preview' } },
      5: null,
    },
    inFlight: new Set([2]),
  };
  const logs = [];
  stub(ids.logger, { info: (scope, message, meta) => logs.push({ message, meta }), warn() {}, error() {}, debug() {} });
  stub(ids.docker, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.ws, { broadcastToAdmins() {} });
  stub(ids.stagingEnv, { expectedStagingFingerprint: () => 'fp' });
  stub(ids.staging, { hasInFlightBuild: (id) => fx.inFlight.has(id) });
  stub(ids.recovery, { inspectPreviewRuntime: async (session) => fx.runtimes[session.id] });
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: Object.keys(fx.runtimes).map((id) => ({ id: Number(id), staging_url: 'https://x' })) }) }) });
  stub(ids.dbManager, {
    PREVIEW_SERVER: 'preview',
    LABEL_PREVIEW_DB_SERVER: 'usernode.db.server',
    previewServerConfigured: () => true,
    previewServerDraining: () => fx.draining,
    previewServerShotsDatabases: async () => fx.shots,
  });
  try {
    const reap = require(ids.reap);
    const busy = await reap.previewServerDrainStatus({}, { force: true });
    assert.deepEqual(busy, { previews: [1], unread: 1, buildsInFlight: 1, shotsDatabases: 2, clear: false });
    assert.equal(logs.at(-1).message, 'Preview database server drain: still in use');
    assert.equal(await reap.previewServerDrainStatus({}), null, 'at most once every ten minutes');

    fx.runtimes = { 2: fx.runtimes[2], 3: fx.runtimes[3], 4: fx.runtimes[4] };
    fx.inFlight = new Set();
    fx.shots = [];
    const clear = await reap.previewServerDrainStatus({}, { force: true });
    assert.equal(clear.clear, true);
    assert.equal(logs.at(-1).message, 'Preview database server drain: nothing depends on it any more');

    fx.draining = false;
    assert.equal(await reap.previewServerDrainStatus({}, { force: true }), null, 'only while draining');
  } finally {
    for (const [key, id] of Object.entries(ids)) { if (orig[key]) require.cache[id] = orig[key]; else delete require.cache[id]; }
  }
});

test('a preview runtime is labelled with its database and server where it is deployed', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/services/staging.js'), 'utf8');
  assert.match(source, /\.\.\.\(dbManager\.previewDatabaseLabels\?\.\(stagingDbNameStr, cloned\.server\) \|\| \{\}\)/,
    'the labels are what the heal pass judges a preview\'s database by');
});
