// The template and its clones are scrubbed independently. A ctid-only
// placeholder can collide with an existing placeholder on a second scrub,
// so every pass reserves a new namespace before updating NOT NULL columns.
//
// The pass sends every column in ONE statement (a DO block): it checks each
// new namespace is free, runs one UPDATE per table, and checks every column
// now holds only NULL or its placeholder. When the database refuses that
// statement, today's column-by-column pass runs and names each column it
// cannot scrub. When the database does not answer, nothing more is sent.
//
// The first tests drive the psql executor with a fake psql; the last ones run
// against a real PostgreSQL server (skipped when none is reachable, required
// when TEST_DATABASE_URL is set).
//
// Run with: node --test tests/db-manager-scrub.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// What psql's failure looks like to execInTarget: the database answered with
// an ERROR (exit 1), or psql was stopped at its deadline (no answer).
function psqlError(message) {
  return Object.assign(new Error(`Command failed: psql\nERROR:  ${message}\n`),
    { code: 1, killed: false, signal: null, stdout: '', stderr: `ERROR:  ${message}\n` });
}
function psqlTimedOut() {
  return Object.assign(new Error('Command failed: psql'),
    { code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' });
}

// `discoveryRows` is the canned psql -At output (one line per column) for
// the discovery query. `batch(sql)` may throw to fail the one statement;
// `update(sql)` may throw to fail a column-by-column UPDATE; `unscrubbed`
// is what the check after the column-by-column pass reports.
function loadDbManager(discoveryRows, { occupiedAnswers = [], batch = null, update = null, unscrubbed = [] } = {}) {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://usernode:test@db.example.test:5432/usernode';
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/db-manager'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];
  const fakeExecFile = (cmd, args) => {
    const sql = args[args.indexOf('-c') + 1];
    calls.push(sql);
    try {
      if (/col_description/.test(sql)) return Promise.resolve({ stdout: discoveryRows.join('\n') + '\n', stderr: '' });
      if (/^DO /.test(sql)) { if (batch) batch(sql); return Promise.resolve({ stdout: 'DO\n', stderr: '' }); }
      if (/^SELECT EXISTS/.test(sql)) return Promise.resolve({ stdout: `${occupiedAnswers.shift() || 'f'}\n`, stderr: '' });
      if (/^UPDATE/.test(sql)) { if (update) update(sql); return Promise.resolve({ stdout: '', stderr: '' }); }
      if (/ WHERE EXISTS /.test(sql)) return Promise.resolve({ stdout: unscrubbed.map((t) => `${t}\n`).join(''), stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    } catch (err) {
      return Promise.reject(err);
    }
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;

  stub(ids.childProcess, { execFile: fakeExecFile, spawn: () => { throw new Error('unused'); } });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  const dbManager = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  };
  return {
    dbManager, calls, restore,
    blocks: () => calls.filter((sql) => /^DO /.test(sql)),
    probes: () => calls.filter((sql) => /^SELECT EXISTS/.test(sql)),
    updates: () => calls.filter((sql) => /^UPDATE/.test(sql)),
    checks: () => calls.filter((sql) => / WHERE EXISTS /.test(sql)),
  };
}

const DB = 'app_demo_staging_x_abc123';

test('every private column goes out in one statement: one UPDATE per table, between the two checks', async () => {
  const f = loadDbManager([
    'public.onchain_accounts|registration_code|t|64',
    'public.onchain_accounts|secret_key|t|64',
    'public.users|anthropic_key_enc|f|',
    'public.users|password|t|255',
    'public.users|wallet_link_token|f|64',
  ]);
  try {
    const result = await f.dbManager.scrubPrivateColumns(DB);
    assert.equal(f.calls.length, 2, 'discovery and the statement: two round trips');
    assert.deepEqual(f.probes(), []);
    assert.deepEqual(f.updates(), []);
    const block = f.blocks()[0];
    assert.match(block, /^DO \$staging_scrub\$\nBEGIN\n[\s\S]*\nEND\n\$staging_scrub\$$/);
    const lines = block.split('\n');
    const updates = lines.filter((l) => /^ {2}UPDATE /.test(l));
    assert.equal(updates.length, 2, 'one UPDATE per table');
    assert.match(updates[0], /^ {2}UPDATE public\.onchain_accounts SET registration_code = '__staging_redacted__[0-9a-f]{16}:' \|\| ctid::text, secret_key = '__staging_redacted__[0-9a-f]{16}:' \|\| ctid::text;$/);
    assert.match(updates[1], /^ {2}UPDATE public\.users SET anthropic_key_enc = NULL, password = '__staging_redacted__[0-9a-f]{16}:' \|\| ctid::text, wallet_link_token = NULL;$/);
    // Each NOT NULL column's namespace is checked free before any UPDATE,
    // and the same namespace is what the UPDATE writes.
    const firstUpdate = lines.findIndex((l) => /^ {2}UPDATE /.test(l));
    const reserved = lines.slice(0, firstUpdate).join('\n')
      .match(/WHERE left\((\w+)::text, (\d+)\) = '([^']+)'\) THEN/g);
    assert.equal(reserved.length, 3);
    for (const r of reserved) {
      const [, column, length, prefix] = /left\((\w+)::text, (\d+)\) = '([^']+)'/.exec(r);
      assert.equal(Number(length), prefix.length);
      assert.ok(block.includes(`${column} = '${prefix}' || ctid::text`));
    }
    // After the UPDATEs, each of the five columns is checked.
    const after = lines.slice(firstUpdate).join('\n');
    assert.equal((after.match(/still holds a value after its UPDATE/g) || []).length, 5);
    assert.match(after, /FROM public\.users WHERE anthropic_key_enc IS NOT NULL\) THEN/);
    assert.match(after, /FROM public\.users WHERE left\(password::text, 37\) IS DISTINCT FROM '__staging_redacted__[0-9a-f]{16}:'\) THEN/);
    assert.deepEqual(result.scrubbed, [
      'public.onchain_accounts.registration_code', 'public.onchain_accounts.secret_key',
      'public.users.anthropic_key_enc', 'public.users.password', 'public.users.wallet_link_token',
    ]);
  } finally {
    f.restore();
  }
});

test('each scrub picks fresh namespaces, so a second scrub never reuses the first one\'s values', async () => {
  const f = loadDbManager(['public.onchain_accounts|registration_code|t|64']);
  try {
    await f.dbManager.scrubPrivateColumns(DB);
    await f.dbManager.scrubPrivateColumns(DB);
    const prefixes = f.blocks().map((sql) => /registration_code = '([^']+)'/.exec(sql)[1]);
    assert.equal(prefixes.length, 2);
    assert.notEqual(prefixes[0], prefixes[1]);
  } finally {
    f.restore();
  }
});

test('an unbounded NOT NULL column gets the full marker, and the ctid suffix is never truncated', async () => {
  const f = loadDbManager(['public.some_table|some_col|t|']);
  try {
    await f.dbManager.scrubPrivateColumns(DB);
    assert.match(f.blocks()[0], /UPDATE public\.some_table SET some_col = '__staging_redacted__[0-9a-f]{16}:' \|\| ctid::text;/);
    assert.ok(!/left\(ctid|ctid::text, \d/.test(f.blocks()[0]));
  } finally {
    f.restore();
  }
});

test('a VARCHAR(32) private code uses a compact, still unique namespace', async () => {
  const f = loadDbManager(['public.short_codes|code|t|32']);
  try {
    await f.dbManager.scrubPrivateColumns(DB);
    const prefix = /SET code = '(~[0-9a-f]{8}:)' \|\| ctid::text;/.exec(f.blocks()[0])[1];
    assert.ok(prefix.length + 18 <= 32, 'the placeholder and the longest ctid fit the column');
  } finally {
    f.restore();
  }
});

test('a short NOT NULL column fails closed and stays out of the statement; the others are still scrubbed', async () => {
  const f = loadDbManager(['public.short_codes|code|t|20', 'public.users|secret|f|']);
  try {
    await assert.rejects(f.dbManager.scrubPrivateColumns(DB),
      (err) => /Failed to scrub 1 staging:private column\(s\)/.test(err.message)
        && /public\.short_codes\.code \(max length 20 cannot hold unique redaction values\)/.test(err.message));
    assert.equal(f.blocks().length, 1);
    assert.ok(!/short_codes/.test(f.blocks()[0]));
    assert.match(f.blocks()[0], /UPDATE public\.users SET secret = NULL;/);
  } finally {
    f.restore();
  }
});

test('an unsafe identifier is never put into SQL and still fails the pass', async () => {
  const f = loadDbManager([
    'public.users|bad"; DROP TABLE users; --|f|',
    'public.users|secret|f|',
  ]);
  try {
    await assert.rejects(f.dbManager.scrubPrivateColumns(DB),
      (err) => /Failed to scrub 1 staging:private column\(s\)/.test(err.message) && /unsafe identifier/.test(err.message));
    assert.ok(f.calls.every((sql) => !/DROP TABLE/.test(sql)));
    assert.match(f.blocks()[0], /UPDATE public\.users SET secret = NULL;/);
  } finally {
    f.restore();
  }
});

test('nullable columns are set to NULL, with no namespace to reserve', async () => {
  const f = loadDbManager(['public.users|email_confirmation_token|f|255']);
  try {
    await f.dbManager.scrubPrivateColumns(DB);
    const block = f.blocks()[0];
    assert.match(block, /UPDATE public\.users SET email_confirmation_token = NULL;/);
    assert.ok(!/placeholder namespace is taken/.test(block));
  } finally {
    f.restore();
  }
});

test('no private columns: no statement at all', async () => {
  const f = loadDbManager([]);
  try {
    assert.deepEqual((await f.dbManager.scrubPrivateColumns(DB)).scrubbed, []);
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test('a statement the database refuses falls back to column by column, which names the failing column', async () => {
  const f = loadDbManager([
    'public.onchain_accounts|registration_code|t|64',
    'public.users|password|t|255',
    'public.users|secret|f|',
  ], {
    batch: () => { throw psqlError('value too long for type character varying(64)'); },
    update: (sql) => { if (/^UPDATE public\.users SET password/.test(sql)) throw psqlError('refused by a trigger'); },
  });
  try {
    await assert.rejects(f.dbManager.scrubPrivateColumns(DB),
      (err) => /Failed to scrub 1 staging:private column\(s\)/.test(err.message)
        && /public\.users\.password \(.*refused by a trigger/s.test(err.message)
        && !/registration_code \(/.test(err.message) && !/secret \(/.test(err.message));
    // Today's pass: a namespace probe per NOT NULL column, then one UPDATE
    // per column, every column tried.
    assert.equal(f.probes().length, 2);
    assert.equal(f.updates().length, 3);
    assert.match(f.updates()[0], /^UPDATE public\.onchain_accounts SET registration_code = '__staging_redacted__[0-9a-f]{16}:' \|\| ctid::text$/);
    assert.equal(f.updates()[2], 'UPDATE public.users SET secret = NULL');
    assert.deepEqual(f.checks(), [], 'no check after a pass that already failed');
  } finally {
    f.restore();
  }
});

test('a refused statement whose columns all scrub one by one is not a failure, once the check confirms them', async () => {
  const f = loadDbManager(['public.onchain_accounts|registration_code|t|64', 'public.users|secret|f|'], {
    batch: () => { throw psqlError('staging:private scrub: public.users.secret still holds a value after its UPDATE'); },
  });
  try {
    const result = await f.dbManager.scrubPrivateColumns(DB);
    assert.deepEqual(result.scrubbed, ['public.onchain_accounts.registration_code', 'public.users.secret']);
    assert.equal(f.checks().length, 1);
    const prefix = /registration_code = '([^']+)'/.exec(f.updates()[0])[1];
    assert.equal(f.checks()[0],
      `SELECT 'public.onchain_accounts.registration_code' WHERE EXISTS (SELECT 1 FROM public.onchain_accounts WHERE left(registration_code::text, ${prefix.length}) IS DISTINCT FROM '${prefix}')`
      + " UNION ALL SELECT 'public.users.secret' WHERE EXISTS (SELECT 1 FROM public.users WHERE secret IS NOT NULL)");
  } finally {
    f.restore();
  }
});

test('a column still holding a value after the column-by-column pass fails it, by name', async () => {
  const f = loadDbManager(['public.users|secret|f|', 'public.users|token|f|'], {
    batch: () => { throw psqlError('staging:private scrub: public.users.token still holds a value after its UPDATE'); },
    unscrubbed: ['public.users.token'],
  });
  try {
    await assert.rejects(f.dbManager.scrubPrivateColumns(DB),
      (err) => /Failed to scrub 1 staging:private column\(s\)/.test(err.message)
        && /public\.users\.token \(still holds a value after its UPDATE\)/.test(err.message));
  } finally {
    f.restore();
  }
});

test('an occupied namespace in the column-by-column pass is rejected before updating the column', async () => {
  const f = loadDbManager(['public.onchain_accounts|registration_code|t|64'], {
    occupiedAnswers: ['t', 'f'],
    batch: () => { throw psqlError('staging:private scrub: placeholder namespace is taken in public.onchain_accounts.registration_code'); },
  });
  try {
    await f.dbManager.scrubPrivateColumns(DB);
    assert.equal(f.probes().length, 2);
    const firstPrefix = f.probes()[0].match(/= '([^']+)'/)[1];
    const secondPrefix = f.probes()[1].match(/= '([^']+)'/)[1];
    assert.notEqual(firstPrefix, secondPrefix);
    assert.equal(f.updates().length, 1);
    assert.ok(f.updates()[0].includes(`'${secondPrefix}'`));
  } finally {
    f.restore();
  }
});

test('no answer to the statement: nothing more is sent, and the pass fails', async () => {
  const f = loadDbManager(['public.users|secret|f|', 'public.users|token|t|64'], {
    batch: () => { throw psqlTimedOut(); },
  });
  try {
    await assert.rejects(f.dbManager.scrubPrivateColumns(DB),
      (err) => /^Failed to scrub staging:private columns in app_demo_staging_x_abc123: no answer to the one-statement scrub of 2 column\(s\)/.test(err.message)
        && /whether it changed anything is unknown/.test(err.message)
        && /psql's time limit/.test(err.message));
    assert.equal(f.calls.length, 2, 'discovery and the statement only');
  } finally {
    f.restore();
  }
});

test('the error a node-postgres connection gives decides the same way', async () => {
  // withDatabaseConnection's runner: a server ERROR carries severity and
  // SQLSTATE; a client-side timeout or a lost session does not.
  const { scrubPrivateColumns } = require('../src/services/db-manager');
  const run = (batchError) => {
    const sent = [];
    const execute = async (db, sql) => {
      sent.push(sql);
      if (/col_description/.test(sql)) return 'public.users|secret|f|';
      if (/^DO /.test(sql)) throw batchError;
      return '';
    };
    return { sent, done: scrubPrivateColumns(DB, execute).then(() => 'ok', (err) => err.message) };
  };
  const refused = run(Object.assign(new Error('deadlock detected'), { severity: 'ERROR', code: '40P01' }));
  assert.equal(await refused.done, 'ok');
  assert.deepEqual(refused.sent.slice(2), ['UPDATE public.users SET secret = NULL',
    "SELECT 'public.users.secret' WHERE EXISTS (SELECT 1 FROM public.users WHERE secret IS NOT NULL)"]);
  for (const err of [new Error('Query read timeout'), new Error('Connection terminated unexpectedly'),
    Object.assign(new Error('terminating connection due to administrator command'), { severity: 'FATAL', code: '57P01' })]) {
    const lost = run(err);
    assert.match(await lost.done, /no answer to the one-statement scrub of 1 column\(s\)/);
    assert.equal(lost.sent.length, 2, `${err.message}: no column-by-column pass`);
  }
});

test('discovery failure is fatal before any UPDATE', async () => {
  const { scrubPrivateColumns } = require('../src/services/db-manager');
  const sent = [];
  const execute = async (db, sql) => { sent.push(sql); throw new Error('down'); };
  await assert.rejects(scrubPrivateColumns(DB, execute), /Failed to discover staging:private columns/);
  assert.equal(sent.length, 1);
});

// ── against a real server ───────────────────────────────────────────────

const { Client } = require('pg');
const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// A scratch database and helpers. `open(db)` gives a connection and the
// runner withDatabaseConnection hands the pass (autocommit, '|'-joined tuples
// with booleans as t/f). `copy(db)` makes a copy the way previews are made,
// CREATE DATABASE … TEMPLATE, after closing this test's connections to it.
async function scratchDatabase(t, prefix) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.connect(); } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const fresh = () => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
  const created = [];
  const open = new Map();
  t.after(async () => {
    for (const client of open.values()) await client.end().catch(() => {});
    for (const db of created.reverse()) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });
  const connect = async (name) => {
    const url = new URL(DSN); url.pathname = `/${name}`;
    const client = new Client({ connectionString: String(url) });
    await client.connect();
    open.set(name, client);
    const statements = [];
    const execute = async (db, sql, opts = {}) => {
      assert.equal(db, name);
      statements.push(sql);
      const result = await client.query({ text: sql, rowMode: 'array' });
      if (!opts.tuplesOnly) return '';
      return result.rows.map((row) => row.map((v) => (v === true ? 't' : v === false ? 'f' : v == null ? '' : String(v))).join('|')).join('\n');
    };
    return { name, client, statements, execute };
  };
  const close = async (name) => {
    const client = open.get(name);
    open.delete(name);
    if (client) await client.end();
  };
  const copy = async (from) => {
    await close(from);
    const to = fresh();
    await admin.query(`CREATE DATABASE ${to} TEMPLATE ${from}`);
    created.push(to);
    return connect(to);
  };
  const name = fresh();
  await admin.query(`CREATE DATABASE ${name}`);
  created.push(name);
  return { ...(await connect(name)), copy, close };
}

test('real server: one statement scrubs every column, and repeated scrubs of copies keep placeholders unique', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'scrub_real');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE accounts (id serial PRIMARY KEY, code varchar(64) NOT NULL UNIQUE, short varchar(32) NOT NULL UNIQUE,
                           secret text, note text);
    INSERT INTO accounts (code, short, secret, note)
      SELECT 'code-' || g, 'short-' || g, 'secret-' || g, 'kept-' || g FROM generate_series(1, 300) g;
    COMMENT ON COLUMN accounts.code IS 'staging:private';
    COMMENT ON COLUMN accounts.short IS 'staging:private';
    COMMENT ON COLUMN accounts.secret IS 'staging:private';
    CREATE TABLE tokens (id serial PRIMARY KEY, token text NOT NULL);
    INSERT INTO tokens (token) SELECT 'tok-' || g FROM generate_series(1, 50) g;
    COMMENT ON COLUMN tokens.token IS 'staging:private';
  `);
  const { scrubPrivateColumns } = require('../src/services/db-manager');

  // The template, then a copy of it, then a copy of that copy: each scrubbed.
  let db = s;
  const seen = new Set();
  for (let generation = 0; generation < 3; generation += 1) {
    if (generation > 0) db = await s.copy(db.name);
    const result = await scrubPrivateColumns(db.name, db.execute);
    assert.equal(result.scrubbed.length, 4);
    assert.equal(db.statements.length, 2, 'no fallback: discovery and the one statement');
    assert.match(db.statements[1], /^DO /);
    const rows = (await db.client.query('SELECT code, short, secret, note FROM accounts ORDER BY id')).rows;
    assert.equal(new Set(rows.map((r) => r.code)).size, 300);
    assert.equal(new Set(rows.map((r) => r.short)).size, 300);
    assert.ok(rows.every((r) => /^__staging_redacted__[0-9a-f]{16}:\(\d+,\d+\)$/.test(r.code) && r.code.length <= 64));
    assert.ok(rows.every((r) => /^~[0-9a-f]{8}:\(\d+,\d+\)$/.test(r.short) && r.short.length <= 32));
    assert.ok(rows.every((r) => r.secret === null));
    assert.ok(rows.every((r, i) => r.note === `kept-${i + 1}`), 'columns that are not private are untouched');
    for (const r of rows) {
      assert.ok(!seen.has(r.code), 'a later scrub never repeats an earlier value');
      seen.add(r.code);
    }
    const tokens = (await db.client.query('SELECT token FROM tokens')).rows;
    assert.ok(tokens.every((r) => /^__staging_redacted__[0-9a-f]{16}:/.test(r.token)));
  }
});

test('real server: a trigger that keeps an old value through the combined UPDATE is caught; column by column clears it', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'scrub_trig');
  if (!s) return;
  // Keeps the previous key whenever the key changes. Column by column, the
  // later UPDATE of previous_key clears what the first one copied in; one
  // UPDATE for the table would leave the old key there.
  await s.client.query(`
    CREATE TABLE users (id serial PRIMARY KEY, api_key text, previous_key text);
    INSERT INTO users (api_key) VALUES ('key-a'), ('key-b');
    COMMENT ON COLUMN users.previous_key IS 'staging:private';
    COMMENT ON COLUMN users.api_key IS 'staging:private';
    CREATE FUNCTION keep_previous() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.api_key IS DISTINCT FROM OLD.api_key THEN NEW.previous_key := OLD.api_key; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER keep_previous BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION keep_previous();
  `);
  const { scrubPrivateColumns } = require('../src/services/db-manager');
  await scrubPrivateColumns(s.name, s.execute);
  assert.equal(s.statements.filter((sql) => /^DO /.test(sql)).length, 1);
  assert.equal(s.statements.filter((sql) => /^UPDATE /.test(sql)).length, 2, 'fell back to one UPDATE per column');
  const rows = (await s.client.query('SELECT api_key, previous_key FROM users')).rows;
  assert.ok(rows.every((r) => r.api_key === null && r.previous_key === null));
});

test('real server: a trigger that defeats even the column-by-column pass fails it, by name', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'scrub_trig2');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE users (id serial PRIMARY KEY, secret text);
    INSERT INTO users (secret) VALUES ('s-a');
    COMMENT ON COLUMN users.secret IS 'staging:private';
    CREATE FUNCTION keep_secret() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.secret := OLD.secret; RETURN NEW; END $$;
    CREATE TRIGGER keep_secret BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION keep_secret();
  `);
  const { scrubPrivateColumns } = require('../src/services/db-manager');
  await assert.rejects(scrubPrivateColumns(s.name, s.execute),
    (err) => /Failed to scrub 1 staging:private column\(s\)/.test(err.message)
      && /public\.users\.secret \(still holds a value after its UPDATE\)/.test(err.message));
});

test('real server: a column the database refuses to update is named, and the other columns are still scrubbed', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'scrub_refuse');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE users (id serial PRIMARY KEY, secret text, pin text NOT NULL CHECK (pin ~ '^[0-9]+$'), other text);
    INSERT INTO users (secret, pin, other) VALUES ('s-a', '1234', 'o-a');
    COMMENT ON COLUMN users.secret IS 'staging:private';
    COMMENT ON COLUMN users.pin IS 'staging:private';
    COMMENT ON COLUMN users.other IS 'staging:private';
  `);
  const { scrubPrivateColumns } = require('../src/services/db-manager');
  await assert.rejects(scrubPrivateColumns(s.name, s.execute),
    (err) => /Failed to scrub 1 staging:private column\(s\)/.test(err.message)
      && /public\.users\.pin \(.*check constraint/s.test(err.message));
  const row = (await s.client.query('SELECT secret, pin, other FROM users')).rows[0];
  assert.deepEqual(row, { secret: null, pin: '1234', other: null });
});

test('real server, through psql: a refused statement falls back; the platform schema scrubs in one statement', { timeout: 180000 }, async (t) => {
  try { execFileSync('psql', ['--version']); } catch { t.skip('psql not installed'); return; }
  const s = await scratchDatabase(t, 'scrub_psql');
  if (!s) return;
  await s.client.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await s.client.query(`
    INSERT INTO users (username, password, wallet_link_token) SELECT 'u' || g, 'pw-' || g, 'w-' || g FROM generate_series(1, 20) g;
    CREATE TABLE refuses (id serial PRIMARY KEY, code text NOT NULL CHECK (code ~ '^[0-9]+$'));
    INSERT INTO refuses (code) VALUES ('1');
    COMMENT ON COLUMN refuses.code IS 'staging:private';
  `);
  await s.close(s.name);
  // psql connects with the admin URL's credentials, to the named database.
  const saved = process.env.DB_ADMIN_URL;
  const adminUrl = new URL(DSN); adminUrl.pathname = '/usernode';
  process.env.DB_ADMIN_URL = String(adminUrl);
  t.after(() => { if (saved === undefined) delete process.env.DB_ADMIN_URL; else process.env.DB_ADMIN_URL = saved; });
  const { scrubPrivateColumns } = require('../src/services/db-manager');
  await assert.rejects(scrubPrivateColumns(s.name),
    (err) => /Failed to scrub 1 staging:private column\(s\)/.test(err.message) && /public\.refuses\.code \(/.test(err.message));
  const check = await s.copy(s.name);
  const rows = (await check.client.query('SELECT password, wallet_link_token FROM users')).rows;
  assert.equal(rows.length, 20);
  assert.ok(rows.every((r) => /^__staging_redacted__[0-9a-f]{16}:/.test(r.password) && r.wallet_link_token === null),
    'the column-by-column pass scrubbed the other columns');
  await check.client.query('DROP TABLE refuses');
  await check.client.query("UPDATE users SET wallet_link_token = 'w-again'");
  await s.close(check.name);
  const result = await scrubPrivateColumns(check.name);
  assert.ok(result.scrubbed.length >= 25, `scrubbed ${result.scrubbed.length} columns`);
  const again = await s.copy(check.name);
  const after = (await again.client.query('SELECT count(*)::int AS n FROM users WHERE wallet_link_token IS NOT NULL')).rows[0];
  assert.equal(after.n, 0, 'the one statement scrubbed the platform schema');
  // The same schema on the connection a preview copy uses: no fallback.
  const third = await s.copy(again.name);
  await scrubPrivateColumns(third.name, third.execute);
  assert.equal(third.statements.length, 2, 'discovery and the one statement');
});
