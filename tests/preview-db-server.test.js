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
  leftovers = {},            // host → [database or role names] the other-server check finds
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
  const clients = [];
  const logs = [];
  const answer = (host, db, sql, via) => {
    calls.push({ via, host, db, sql });
    const failure = failures.find((f) => f.match && (!f.host || f.host === host) && f.match.test(sql) && (f.times ?? Infinity) > 0);
    if (failure) {
      failure.times = (failure.times ?? Infinity) - 1;
      throw failure.error(sql);
    }
    const asked = sql.match(/^SELECT EXISTS \(SELECT 1 FROM pg_database WHERE datname = '(\w+)'\) OR EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = '(\w+)'\)$/);
    if (asked) return (leftovers[host] || []).some((name) => name === asked[1] || name === asked[2]) ? 't' : 'f';
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
    for (const sql of statements) { stdout = answer(host, db, sql, 'psql'); calls[calls.length - 1].env = opts.env; }
    return { stdout: stdout ? `${stdout}\n` : '', stderr: '' };
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;
  const fakeSpawn = (cmd, args, opts = {}) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    calls.push({ via: cmd, host: (opts.env || {}).PGHOST, db: (opts.env || {}).PGDATABASE, sql: '', args, env: opts.env });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  class FakeClient extends EventEmitter {
    constructor(config) {
      super();
      const url = new URL(config.connectionString);
      clients.push({ host: url.hostname, search: url.search, ssl: config.ssl });
      this.host = url.hostname;
      this.db = url.pathname.slice(1);
      this.session = Symbol('session');
    }
    async connect() {
      const failure = failures.find((f) => (f.connect || f.connectOnly) && (!f.host || f.host === this.host));
      if (failure) throw failure.error('connect');
    }
    async query(config) {
      const text = typeof config === 'string' ? config : config.text;
      let out;
      try { out = answer(this.host, this.db, text, 'pg'); } finally { calls[calls.length - 1].session = this.session; }
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
  return { dbManager, calls, clients, logs, restore, on, sqlOn };
}

const SOURCE = 'app_demo';
const TARGET = 'app_demo_staging_s9_abc123';
const fresh = () => `staging-template source=${SOURCE} refreshed_at=${new Date().toISOString()}`;
const oldTargetCheck = (name) => `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${name}') `
  + `OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}_owner')`;
const dropSequence = (name) => [
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  `DROP DATABASE IF EXISTS ${name}`,
  `DROP OWNED BY ${name}_owner CASCADE`,
  `DROP ROLE IF EXISTS ${name}_owner`,
];
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
    assert.deepEqual(main.filter((sql) => sql.includes(TARGET)), [oldTargetCheck(TARGET)],
      'the main server is asked once whether it holds an earlier build of this preview; it holds none, so nothing is dropped there');
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

test('a copy with no runner of its own holds one connection for the probes, the SET and the copy', async () => {
  // The frozen shots source is copied this way.
  const h = load();
  try {
    await h.dbManager.createFromTemplate(`${SOURCE}_stgtmpl`, 'app_demo_evsrc_0123456789ab', 'app_demo_evsrc_0123456789ab_owner', {
      server: 'preview', timeoutMs: 90_000, attempts: 3,
    });
    const copy = h.calls.find((c) => /STRATEGY = FILE_COPY$/.test(c.sql));
    assert.equal(copy.via, 'pg');
    assert.equal(copy.host, PREVIEW_HOST);
    const onIt = h.calls.filter((c) => c.session === copy.session).map((c) => c.sql);
    assert.deepEqual(onIt, [
      'SHOW server_version_num',
      'SELECT system_identifier FROM pg_control_system()',
      'SET file_copy_method = clone',
      copy.sql,
    ], 'who the server is, and the copy, are one session');
    assert.equal(h.calls.filter((c) => c.via === 'psql' && c.host === PREVIEW_HOST).length, 0,
      'no psql process, each of which would be a connection of its own, takes part');
  } finally { h.restore(); }
});

test('a runner that is a connection per statement never gets a shared-block copy', async () => {
  const h = load();
  try {
    // What psql is: every call a new process. Who it reached last time says
    // nothing about where the next statement goes.
    const perStatement = (sql, opts) => h.dbManager.terminateDisposableSessions && Promise.resolve(h.calls.push({ via: 'own', host: PREVIEW_HOST, sql })).then(() => (/server_version_num/.test(sql) ? '180006' : '7002'));
    await h.dbManager.createFromTemplate(`${SOURCE}_stgtmpl`, 'app_demo_evsrc_0123456789ab', 'app_demo_evsrc_0123456789ab_owner', {
      server: 'preview', execute: perStatement,
    });
    const own = h.calls.filter((c) => c.via === 'own').map((c) => c.sql);
    assert.deepEqual(own, [`CREATE DATABASE app_demo_evsrc_0123456789ab TEMPLATE ${SOURCE}_stgtmpl OWNER app_demo_evsrc_0123456789ab_owner`],
      'not asked who it is, and sent the plain copy');
  } finally { h.restore(); }
});

test('with a retry, the copy stays on the connection that proved the server', async () => {
  const inUse = () => Object.assign(new Error('source database "app_demo_stgtmpl" is being accessed by other users'), { code: '55006' });
  const h = load({ failures: [{ host: PREVIEW_HOST, match: /STRATEGY = FILE_COPY/, times: 1, error: inUse }] });
  try {
    await h.dbManager.createFromTemplate(`${SOURCE}_stgtmpl`, 'app_demo_evsrc_0123456789ab', 'app_demo_evsrc_0123456789ab_owner', {
      server: 'preview', attempts: 3,
    });
    const copies = h.calls.filter((c) => /STRATEGY = FILE_COPY$/.test(c.sql));
    assert.equal(copies.length, 2);
    assert.equal(copies[0].session, copies[1].session);
    assert.ok(h.on(PREVIEW_HOST).every((c) => c.via === 'pg' && c.session === copies[0].session),
      'the probes, both attempts and the clean-up between them');
    assert.deepEqual(h.sqlOn(MAIN_HOST), ['SELECT system_identifier FROM pg_control_system()'],
      'the main server is only asked who it is, for the comparison');
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
    assert.deepEqual(h.sqlOn(PREVIEW_HOST), [oldTargetCheck(TARGET)],
      'the preview server holds nothing of this name, so it is only asked');
    // Teardown drops on both servers without asking first.
    h.calls.length = 0;
    await h.dbManager.dropDatabase(TARGET);
    assert.deepEqual(h.sqlOn(PREVIEW_HOST), dropSequence(TARGET));
    assert.deepEqual(h.sqlOn(MAIN_HOST), dropSequence(TARGET));
  } finally { h.restore(); }
  // An old database of this name IS on the draining server: it goes, as before.
  const held = load({ drain: true, templates: { [MAIN_HOST]: fresh() }, leftovers: { [PREVIEW_HOST]: [TARGET] } });
  try {
    await held.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.deepEqual(held.sqlOn(PREVIEW_HOST), [oldTargetCheck(TARGET), ...dropSequence(TARGET)],
      'the preview server only loses an old database of this name');
  } finally { held.restore(); }
});

test('the other server is asked first: what it holds of the name is dropped as before, and nothing is claimed otherwise', async () => {
  const OTHER = 'app_demo_staging_s10_def456';
  // An earlier build of the preview on the main server, or only its role
  // (a drop that stopped half way): dropped there, database and role, on
  // both copy paths.
  for (const leftover of [TARGET, `${TARGET}_owner`]) {
    const h = load({ leftovers: { [MAIN_HOST]: [leftover, OTHER] } });
    try {
      assert.equal((await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true })).server, 'preview');
      assert.equal((await h.dbManager.cloneDatabase(SOURCE, OTHER)).server, 'preview');
      for (const name of [TARGET, OTHER]) {
        assert.deepEqual(h.sqlOn(MAIN_HOST).filter((sql) => sql.includes(name)), [oldTargetCheck(name), ...dropSequence(name)], `${leftover}: ${name}`);
        // The question takes the drop's own way to the server: psql, with
        // the same libpq environment (address, user, TLS, connect deadline).
        const there = h.on(MAIN_HOST).filter((c) => c.sql.includes(name));
        const reach = (c) => JSON.stringify(Object.entries(c.env || {}).filter(([key]) => /^PG/.test(key)).sort());
        assert.ok(there.every((c) => c.via === 'psql' && reach(c) === reach(there[1])), `${leftover}: ${name}: asked as the drop is sent`);
      }
      const dropped = h.logs.filter((l) => l.message === 'Database and role dropped' && l.meta.server === 'primary').map((l) => l.meta.dbName);
      assert.deepEqual(dropped.filter((name) => name === TARGET || name === OTHER), [TARGET, OTHER], leftover);
    } finally { h.restore(); }
  }
  // Nothing there: one question, no drop, no line saying there was one. The
  // copy's own server keeps its drop.
  // libpq settings the main server's psql processes inherit (a CA file, a
  // connect deadline) reach the question as they reach the drop.
  const libpq = { PGSSLROOTCERT: '/etc/ssl/main-ca.pem', PGCONNECT_TIMEOUT: '1' };
  const savedLibpq = Object.fromEntries(Object.keys(libpq).map((key) => [key, process.env[key]]));
  Object.assign(process.env, libpq);
  const h = load();
  try {
    await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    await h.dbManager.cloneDatabase(SOURCE, OTHER);
    for (const name of [TARGET, OTHER]) {
      assert.deepEqual(h.sqlOn(MAIN_HOST).filter((sql) => sql.includes(name)), [oldTargetCheck(name)], name);
      const [asked] = h.on(MAIN_HOST).filter((c) => c.sql.includes(name));
      assert.equal(asked.via, 'psql', `${name}: asked through psql, as the drop was`);
      assert.deepEqual([asked.env.PGHOST, asked.env.PGUSER, asked.env.PGDATABASE, asked.env.PGSSLROOTCERT, asked.env.PGCONNECT_TIMEOUT],
        [MAIN_HOST, 'usernode', 'usernode', libpq.PGSSLROOTCERT, libpq.PGCONNECT_TIMEOUT], `${name}: with the main server's own libpq settings`);
      assert.ok(h.sqlOn(PREVIEW_HOST).includes(`DROP DATABASE IF EXISTS ${name}`), `${name}: its own server keeps its drop`);
      assert.ok(h.logs.some((l) => l.message === 'Database and role dropped' && l.meta.dbName === name && l.meta.server === 'preview'),
        `${name}: the drop on its own server is said to be there`);
    }
    assert.equal(h.logs.filter((l) => l.message === 'Database and role dropped' && l.meta.server === 'primary'
      && (l.meta.dbName === TARGET || l.meta.dbName === OTHER)).length, 0, 'no drop is claimed on the main server');
    assert.deepEqual(h.logs.filter((l) => l.message === 'No old database or role of this name on the other server')
      .map((l) => [l.meta.dbName, l.meta.server]).filter(([name]) => name === TARGET || name === OTHER), [[TARGET, 'primary'], [OTHER, 'primary']]);
  } finally {
    h.restore();
    for (const [key, value] of Object.entries(savedLibpq)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('an other server that cannot be asked is left for the sweep, and the build goes on', async () => {
  const refused = () => new Error('connection refused');
  const h = load({ failures: [{ host: MAIN_HOST, match: /^SELECT EXISTS \(SELECT 1 FROM pg_database/, error: refused }] });
  try {
    const cloned = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    assert.equal(cloned.server, 'preview');
    assert.equal(h.sqlOn(MAIN_HOST).filter((sql) => /^DROP /.test(sql) && sql.includes(TARGET)).length, 0);
    assert.equal(h.logs.filter((l) => /Could not drop an old database of this name on the other server/.test(l.message)).length, 1);
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
    ['?sslmode=disable&port=5999', 'port'], ['?application_name=x', 'application_name'],
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
  for (const bad of [
    `${base}?sslmode=whatever`,
    `${base}?sslmode=disable&sslmode=disable`,
    `postgres://:${PREVIEW_PASSWORD}@${PREVIEW_HOST}/postgres`,
    // Two hosts to libpq, one unresolvable name to node-postgres.
    `postgres://previewadmin:${PREVIEW_PASSWORD}@10.0.0.1,10.0.0.2:5432/postgres`,
    `postgres://previewadmin:${PREVIEW_PASSWORD}@[::1]:5432/postgres`,
    `postgres://previewadmin:${PREVIEW_PASSWORD}@%2Fvar%2Frun%2Fpostgresql/postgres`,
    // A user this module could not write into SQL unquoted: restored objects
    // could not be handed to the preview's role.
    `postgres://preview-admin:${PREVIEW_PASSWORD}@${PREVIEW_HOST}:5432/postgres`,
    `postgres://preview%20admin:${PREVIEW_PASSWORD}@${PREVIEW_HOST}:5432/postgres`,
  ]) {
    const h = load({ preview: bad });
    try {
      await assert.rejects(h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), (err) => {
        assert.match(err.message, /STAGING_DB_ADMIN_URL/, bad.replace(PREVIEW_PASSWORD, '…'));
        assert.doesNotMatch(`${err.message}${err.stack}`, new RegExp(PREVIEW_PASSWORD));
        return true;
      });
      assert.equal(h.calls.filter((c) => /^CREATE /.test(c.sql)).length, 0, 'refused before anything is created');
    } finally { h.restore(); }
  }
});

test('the preview server is reached without TLS by every client, and any other sslmode is refused by name', async () => {
  const base = `postgres://previewadmin:${PREVIEW_PASSWORD}@${PREVIEW_HOST}:5432/postgres`;
  for (const mode of ['allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']) {
    const h = load({ preview: `${base}?sslmode=${mode}` });
    try {
      await assert.rejects(h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), (err) => {
        assert.match(err.message, new RegExp(`STAGING_DB_ADMIN_URL: sslmode=${mode} is not supported`));
        assert.match(err.message, /leave sslmode out or set sslmode=disable/);
        assert.equal(err.previewDatabaseServerFault, true);
        return true;
      });
      assert.equal(h.calls.filter((c) => c.via === 'pg_dump' || /^CREATE /.test(c.sql)).length, 0,
        `${mode}: nothing is read from production and nothing is created`);
    } finally { h.restore(); }
  }
  const odd = load({ preview: `${base}?sslmode=${PREVIEW_PASSWORD}` });
  try {
    await assert.rejects(odd.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), (err) => {
      assert.match(err.message, /this sslmode is not supported/);
      assert.doesNotMatch(err.message, new RegExp(PREVIEW_PASSWORD), 'an unknown value is not echoed');
      return true;
    });
  } finally { odd.restore(); }

  // Absent or `disable`: one contract for the three clients, whatever TLS
  // settings are in the platform's own environment.
  const saved = { PGSSLMODE: process.env.PGSSLMODE, PGSSLROOTCERT: process.env.PGSSLROOTCERT };
  process.env.PGSSLMODE = 'verify-full';
  process.env.PGSSLROOTCERT = '/etc/ca.crt';
  try {
    for (const query of ['', '?sslmode=disable']) {
      const h = load({ preview: `${base}${query}` });
      try {
        const cloned = await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
        const there = h.clients.filter((c) => c.host === PREVIEW_HOST);
        assert.ok(there.length >= 2);
        for (const client of there) {
          assert.equal(client.ssl, false, 'node-postgres is told outright: no TLS');
          assert.equal(client.search, '', 'and is given no sslmode to read its own way');
        }
        for (const call of h.on(PREVIEW_HOST).filter((c) => c.env)) {
          assert.equal(call.env.PGSSLMODE, 'disable', `${call.via}: libpq is told outright`);
          assert.equal(call.env.PGSSLROOTCERT, undefined);
        }
        const url = new URL(h.dbManager.connectionUrl(TARGET, cloned.password, { server: cloned.server }));
        assert.equal(url.search, '?sslmode=disable', 'every reader of the handed-out URL is told outright, whichever form the admin URL took');
        assert.equal(url.hostname, PREVIEW_HOST);
        // The main server's clients are configured as they always were.
        for (const client of h.clients.filter((c) => c.host === MAIN_HOST)) assert.equal(client.ssl, undefined);
        for (const call of h.on(MAIN_HOST).filter((c) => c.env)) assert.equal(call.env.PGSSLMODE, 'verify-full', 'inherited, as before');
      } finally { h.restore(); }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('a preview server node-postgres cannot connect to costs no production dump and returns no clone', async () => {
  // psql reaches it, node-postgres does not: what a TLS setting the two
  // read differently looked like.
  const refused = () => new Error('self-signed certificate');
  for (const templates of [{}, { [PREVIEW_HOST]: fresh() }]) {
    const h = load({ templates, failures: [{ host: PREVIEW_HOST, connectOnly: true, error: refused }] });
    try {
      await assert.rejects(h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), (err) => {
        assert.match(err.message, /self-signed certificate/);
        assert.equal(err.previewDatabaseServerFault, true);
        return true;
      });
      assert.equal(h.calls.filter((c) => c.via === 'pg_dump').length, 0, 'production is not dumped');
      assert.equal(h.calls.filter((c) => /^CREATE /.test(c.sql)).length, 0, 'nothing is created');
      await assert.rejects(h.dbManager.prepareStagingCloneSource(SOURCE, { sourceId: 'run-1' }), /self-signed certificate/);
      assert.equal(h.calls.filter((c) => c.via === 'pg_dump').length, 0, 'nor for a shots run');
    } finally { h.restore(); }
  }
});

test('a preview-side child process takes its connection from the URL alone, whatever libpq variables are around', async () => {
  // Each of these outranks or replaces what PGHOST and PGPORT say.
  const ambient = {
    PGSERVICE: 'primary', PGSERVICEFILE: '/etc/pg_service.conf', PGHOSTADDR: '10.9.9.9',
    PGOPTIONS: '-c search_path=x', PGSSLMODE: 'verify-full', PGTARGETSESSIONATTRS: 'read-write', PGPASSFILE: '/x',
  };
  const saved = {};
  for (const [key, value] of Object.entries(ambient)) { saved[key] = process.env[key]; process.env[key] = value; }
  const h = load();
  try {
    await h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true });
    const preview = h.on(PREVIEW_HOST).filter((c) => c.env);
    const main = h.on(MAIN_HOST).filter((c) => c.env);
    assert.ok(preview.some((c) => c.via === 'pg_restore') && preview.some((c) => c.via === 'psql'));
    for (const call of preview) {
      const pg = Object.keys(call.env).filter((key) => /^PG/i.test(key)).sort();
      // A psql child the platform runs inside an app database also carries
      // the search_path pin (see execInTarget); the ambient PGOPTIONS —
      // which libpq would obey — must never leak through either way.
      const unpinned = pg.filter((key) => key !== 'PGOPTIONS');
      assert.deepEqual(unpinned, ['PGDATABASE', 'PGHOST', 'PGPASSWORD', 'PGPORT', 'PGSSLMODE', 'PGUSER'], `${call.via}: only what the URL says`);
      if (pg.includes('PGOPTIONS')) {
        assert.equal(call.env.PGOPTIONS, '-c search_path=pg_catalog', `${call.via}: the search_path is pinned to the built-ins, not the ambient one`);
      }
      assert.equal(call.env.PGSSLMODE, 'disable');
      assert.equal(call.env.PGHOST, PREVIEW_HOST);
      // Administrative work connects as the preview admin; the redaction
      // passes connect as the copy's own unprivileged owner role (see
      // redactPrivateData), never the admin.
      assert.ok(call.env.PGUSER === 'previewadmin' || /_owner$/.test(call.env.PGUSER),
        `${call.via}: unexpected PGUSER ${call.env.PGUSER}`);
      assert.equal(call.env.PATH, process.env.PATH, 'the rest of the environment is kept');
    }
    // The main server's processes inherit the environment as they always did.
    assert.ok(main.some((c) => c.via === 'pg_dump'));
    for (const call of main) assert.equal(call.env.PGSERVICE, 'primary', call.via);
  } finally {
    h.restore();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('a clone whose ownership could not be handed over on the preview server is not returned', async () => {
  const h = load({ failures: [{ host: PREVIEW_HOST, match: /ALTER %s %I\.%I OWNER TO %I/, error: () => new Error('must be owner of table notes') }] });
  try {
    await assert.rejects(h.dbManager.cloneDatabase(SOURCE, TARGET, { viaTemplate: true }), /must be owner of table notes/);
  } finally { h.restore(); }
  // On the main server the same failure is the warning it always was.
  const one = load({ preview: null, failures: [{ host: MAIN_HOST, match: /ALTER %s %I\.%I OWNER TO %I/, times: 2, error: () => new Error('must be owner of table notes') }] });
  try {
    const cloned = await one.dbManager.cloneDatabase(SOURCE, TARGET);
    assert.equal(cloned.via, 'direct');
  } finally { one.restore(); }
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
  // The preview machine's prepare work (src/workflow/preview/services.ts)
  // reads the fault off the error, and its prepareFailed domain write
  // (src/workflow/preview/machine.ts) stores it with the verdict.
  const ids = {
    staging: require.resolve('../src/services/staging'),
    visuals: require.resolve('../src/services/visuals'),
    sync: require.resolve('../src/services/boot-failure-sync'),
    logger: require.resolve('../src/services/logger'),
    recovery: require.resolve('../src/services/staging-recovery'),
  };
  const orig = {};
  for (const [key, id] of Object.entries(ids)) orig[key] = require.cache[id];
  const build = { err: null };
  stub(ids.staging, { prepareAttempt: async () => { throw build.err; } });
  stub(ids.visuals, { summarizeBootFailure: (err) => err.message });
  stub(ids.sync, { afterBootFailure: async () => null, explain: () => '' });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.recovery];
  try {
    const { previewServices } = require('../src/workflow/preview/services.ts');
    const { preview, WORK } = require('../src/workflow/preview/machine.ts');
    const pool = { async query(sql) {
      if (/FROM chat_sessions cs JOIN apps/.test(String(sql))) return { rows: [{ id: 5, app_id: 2, app_slug: 'demo' }] };
      if (/FROM apps WHERE id/.test(String(sql))) return { rows: [{ id: 2, slug: 'demo' }] };
      return { rows: [] };
    } };
    const prepare = previewServices({ config: {}, pool })[WORK.prepare];
    const prepareFailed = preview({ maxRetries: 5, retireAfterMs: 60000 }).writes.get('prepareFailed');
    const stored = [];
    const tx = { async query(sql, params) {
      if (/SET check_state = \$1/.test(String(sql))) stored.push({ state: params[0], platformFault: params[5] });
      return { rows: [], rowCount: 0 };
    } };
    const record = async (err) => {
      build.err = err;
      const r = await prepare.run({
        input: { sessionId: 5, appId: 2, n: 1, head: 'abc123', db: TARGET }, key: 'prepare:1', attempt: 1,
        resumeFrom: null, signal: new AbortController().signal, checkpoint: async () => {},
      });
      await prepareFailed(tx, { type: 'prepareFailed', sessionId: 5, appId: 2, userId: 1, head: 'abc123',
        detail: r.detail, infrastructure: r.infrastructure, platformFault: r.platformFault, source: null }, { push() {} });
    };
    await record(Object.assign(new Error('preview server refused'), { infrastructure: true, previewDatabaseServerFault: true }));
    await record(Object.assign(new Error('sorry, too many clients already'), { infrastructure: true }));
    await record(new Error('app crashed on boot'));
    assert.deepEqual(stored, [
      { state: 'error', platformFault: true },
      { state: 'error', platformFault: false },
      { state: 'error', platformFault: false },
    ], 'only the preview-server fault is stored differently');
    // What the stored flag buys: the error lane keeps retrying past the cap.
    const recovery = require(ids.recovery);
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

const idOf = (name) => require('node:crypto').createHash('sha256').update(name.slice(0, 63)).digest('hex').slice(0, 32);
const labelsFor = (name, server) => ({ 'usernode.db.id': idOf(name), 'usernode.db.server': server });

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
    for (const labels of [null, {}, { 'usernode.db.id': idOf(current) }, { 'usernode.db.id': current, 'usernode.db.server': 'preview' }, labelsFor(current, 'elsewhere')]) {
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

test('the label is a bounded identity of the name as Postgres stores it, at the longest legal names', async () => {
  // A 50-character slug and a seven-digit session id ask for a 78-character
  // database name. Postgres keeps the first 63 bytes, at CREATE, at connect
  // and at DROP.
  const long = `app_${'a'.repeat(50)}_staging_s8016000_abcdef`;
  assert.equal(long.length, 78);
  const stored = long.slice(0, 63);
  const h = load({ databases: { [PREVIEW_HOST]: [stored, 'app_demo_staging_s7_abc123'] } });
  try {
    const labels = h.dbManager.previewDatabaseLabels(long, 'preview');
    assert.deepEqual(Object.keys(labels), ['usernode.db.id', 'usernode.db.server']);
    for (const value of Object.values(labels)) {
      // A Kubernetes label value: 63 characters at most, alphanumeric at
      // both ends. A Docker label takes anything.
      assert.match(value, /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/, value);
    }
    assert.equal(labels['usernode.db.id'], h.dbManager.databaseIdentity(stored), 'the stored name and the requested name are one identity');
    assert.equal(await h.dbManager.previewDatabaseVerdict(labels), null, 'a healthy preview with a long name is not "gone"');
    assert.equal(h.dbManager.previewDatabaseServerOf(labels), 'preview');
    assert.equal(h.dbManager.previewDatabaseServerOf({ 'usernode.db.server': 'preview' }), null);
    assert.equal(h.dbManager.previewDatabaseServerOf({}), null);
  } finally { h.restore(); }
  const wiped = load({ databases: { [PREVIEW_HOST]: [] } });
  try {
    assert.equal(await wiped.dbManager.previewDatabaseVerdict(wiped.dbManager.previewDatabaseLabels(long, 'preview')), 'gone');
  } finally { wiped.restore(); }
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
  stub(ids.dbManager, { previewDatabaseVerdict: async (labels) => { asked += 1; assert.deepEqual(labels, { 'usernode.db.id': 'x' }); return verdict; } });
  stub(ids.docker, { inspectContainer: async () => ({ status: 'running', labels: { 'usernode.db.id': 'x' } }) });
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
    recovery: require.resolve('../src/services/staging-recovery'),
    reap: require.resolve('../src/services/staging-reap'),
  };
  const orig = {};
  for (const [key, id] of Object.entries(ids)) { orig[key] = require.cache[id]; delete require.cache[id]; }
  const mainPool = {
    name: 'main',
    query: async (sql, params) => ({ rows: /WHERE id = \$1/.test(sql) ? [{ id: params[0], staging_container_id: `c${params[0]}` }] : fx.rows }),
  };
  const previewReader = { name: 'preview' };
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.docker, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.ws, { broadcastToAdmins() {} });
  stub(ids.stagingEnv, { expectedStagingFingerprint: () => 'fp' });
  stub(ids.staging, {});
  stub(ids.pool, { getPool: () => mainPool });
  stub(ids.activeWorkers, { isSessionBusy: () => false });
  stub(ids.recovery, {
    inspectPreviewRuntime: async (session) => {
      fx.inspected.push(Number(session.id));
      const id = Number(session.id);
      if (fx.unreadable?.has(id)) return null;
      const server = fx.holds.preview.has(id) ? 'preview' : fx.unlabelled?.has(id) ? null : 'primary';
      return { status: 'running', labels: server ? { server } : {} };
    },
  });
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
    // What the runtime's labels say; null for a runtime built before the setting.
    previewDatabaseServerOf: (labels) => labels?.server || null,
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
  inspected: [],
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
  // Session 2's runtime is on the preview server. That the session also has
  // an old clone on the main server is not something this pass looks at.
  // Session 4 was built before the setting: no labels, so it is on main.
  // Session 5 cannot be read and is left alone.
  const fx = pressureFixture({
    saturated: { main: 5, preview: 0 },
    rows: [1, 2, 3, 4, 5].map((id) => ({ id, status: 'active', last_activity_at: `2026-09-0${id}T00:00:00Z` })),
    holds: { main: new Set([1, 4]), preview: new Set([2, 3]) },
    unlabelled: new Set([4]),
    unreadable: new Set([5]),
  });
  const { reap, restore } = loadReapForPressure(fx);
  try {
    const main = await reap.sweepConnectionPressure({});
    assert.equal(main.candidates, 2);
    assert.deepEqual(fx.tornDown, [1, 4], 'tearing down a preview on the other server would free nothing here');
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
    assert.deepEqual(fx.inspected, [], 'with one server no runtime is inspected: the pass is what it was');
  } finally { restore(); }
});

// ─── Is a draining preview server still in use? ─────────────────────────

test('drain status counts what depends on the preview server, in every state and across replicas', async () => {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    docker: require.resolve('../src/services/docker'),
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
  const there = { server: 'preview' };
  const runtime = (status, labels = there) => ({ status, labels });
  const fx = {
    draining: true,
    shots: [],
    shotsRuns: 0,
    // session id → the row and the runtime's state (null: could not be read)
    sessions: {},
  };
  const logs = [];
  const sqls = [];
  stub(ids.logger, { info: (scope, message, meta) => logs.push({ message, meta }), warn() {}, error() {}, debug() {} });
  stub(ids.docker, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.ws, { broadcastToAdmins() {} });
  stub(ids.stagingEnv, { expectedStagingFingerprint: () => 'fp' });
  stub(ids.recovery, { inspectPreviewRuntime: async (session) => fx.sessions[session.id].state });
  stub(ids.pool, { getPool: () => ({ query: async (sql) => {
    sqls.push(sql);
    if (/FROM shot_runs/.test(sql)) return { rows: [{ n: fx.shotsRuns }] };
    return { rows: Object.entries(fx.sessions).map(([id, v]) => ({ id: Number(id), ...v.row })) };
  } }) });
  stub(ids.dbManager, {
    PREVIEW_SERVER: 'preview',
    previewServerConfigured: () => true,
    previewServerDraining: () => fx.draining,
    previewServerShotsDatabases: async () => fx.shots,
    previewDatabaseServerOf: (labels) => labels?.server || null,
  });
  const named = { staging_url: 'https://x', staging_container_id: 'c' };
  try {
    const reap = require(ids.reap);
    const one = async (sessions, extra = {}) => {
      Object.assign(fx, { sessions, shots: [], shotsRuns: 0 }, extra);
      return reap.previewServerDrainStatus({}, { force: true });
    };
    // A dependent runtime counts in EVERY state it can exist in: one that is
    // restarting or stopped today serves again tomorrow.
    for (const status of ['running', 'restarting', 'created', 'paused', 'exited', 'dead', 'unknown']) {
      const result = await one({ 1: { row: named, state: runtime(status) } });
      assert.equal(result.clear, false, status);
      assert.deepEqual(result.previews, [1], status);
    }
    // Gone, on the main server, or from before the setting: not dependent.
    for (const state of [runtime('not_found'), runtime('running', { server: 'primary' }), runtime('running', {})]) {
      assert.equal((await one({ 1: { row: named, state } })).clear, true);
    }
    assert.equal(logs.at(-1).message, 'Preview database server drain: no dependent preview, build or shots run found');
    // A runtime that could not be read is not "none".
    assert.deepEqual(await one({ 1: { row: named, state: null } }),
      { previews: [], unread: 1, buildsInFlight: 0, shotsRuns: 0, shotsDatabases: 0, clear: false });
    // A first build has no runtime and no staging_url yet. It is counted
    // from its row (the phase the preview machine writes), so a build any
    // platform replica is running counts.
    const firstBuild = await one({ 9: { row: { staging_url: null, building: true }, state: null } });
    assert.deepEqual(firstBuild, { previews: [], unread: 0, buildsInFlight: 1, shotsRuns: 0, shotsDatabases: 0, clear: false });
    assert.match(sqls.find((sql) => /FROM chat_sessions/.test(sql)), /check_state = 'pending' AND check_phase = 'building'/);
    // Shots runs anywhere, shots databases there.
    assert.equal((await one({}, { shotsRuns: 1 })).clear, false);
    assert.equal((await one({}, { shots: ['app_demo_evsrc_0123456789ab'] })).clear, false);
    assert.equal(logs.at(-1).message, 'Preview database server drain: still in use');

    assert.equal(await reap.previewServerDrainStatus({}), null, 'at most once every ten minutes');
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

test('with the setting absent a returned URL is the base\'s, byte for byte, unless it carried ?user or ?password', () => {
  const saved = { admin: process.env.DB_ADMIN_URL, preview: process.env.STAGING_DB_ADMIN_URL };
  delete process.env.STAGING_DB_ADMIN_URL;
  delete require.cache[require.resolve('../src/services/db-manager')];
  const dbManager = require('../src/services/db-manager');
  // What the base did: swap the role, the password and the database into
  // the admin URL and print it. Nothing else.
  const asBase = (adminUrl, dbName, password) => {
    const url = new URL(adminUrl);
    url.username = `${dbName}_owner`; url.password = password; url.pathname = `/${dbName}`;
    return url.toString();
  };
  try {
    for (const adminUrl of [
      'postgres://usernode:pw@db.internal:5432/usernode',
      'postgres://usernode:pw@db.internal/usernode',
      'postgresql://usernode:p%40w@db.internal:6432/usernode?sslmode=require',
      'postgres://usernode:pw@db.internal:5432/usernode?sslmode=verify-full&application_name=x',
      'postgres://usernode:pw@[::1]:5432/usernode?options=-c%20x%3D1',
    ]) {
      process.env.DB_ADMIN_URL = adminUrl;
      for (const dbName of ['app_demo', 'app_demo_staging_s9_abc123', 'app_demo_shots_0123456789ab_b']) {
        assert.equal(dbManager.connectionUrl(dbName, 'rolepw'), asBase(adminUrl, dbName, 'rolepw'), `${adminUrl.replace(/:[^:@/]+@/, ':…@')} ${dbName}`);
      }
    }
  } finally {
    delete require.cache[require.resolve('../src/services/db-manager')];
    for (const [key, env] of [['admin', 'DB_ADMIN_URL'], ['preview', 'STAGING_DB_ADMIN_URL']]) {
      if (saved[key] === undefined) delete process.env[env]; else process.env[env] = saved[key];
    }
  }
});
