'use strict';
// test:changed: when src/db/migrations/ (migration history and schema checksum)
// test:changed: when src/db/schema.sql (snapshot requires a tracked migration)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { applySchemaWithLockRetry, loadPlan, pendingMigrations, BLOCKERS_SQL } = require('../src/db/schema-migrations');
const digest = sql => crypto.createHash('sha256').update(sql).digest('hex');
const { schemaSql, renderSchema } = require('../src/db/schema-source');
const snapshot = schemaSql();
const error = code => Object.assign(new Error(`PostgreSQL ${code}`), { code });

function fixture(t, statements = ['CREATE TABLE baseline (id int);']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = statements.map((sql, i) => ({ id: `${String(i + 1).padStart(4, '0')}-step`,
    sha256: digest(sql), schemaSha256: digest(statements.slice(0, i + 1).join('\n')) }));
  const save = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, migrations: entries }));
  entries.forEach((m, i) => fs.writeFileSync(path.join(dir, `${m.id}.sql`), statements[i]));
  save();
  return { dir, entries, save, schema: statements.join('\n') };
}

test('the generated schema comes from the validated immutable migration history', () => {
  const plan = loadPlan();
  assert.equal(plan[0].id, '0001-baseline');
  assert.equal(plan.at(-1).schemaSha256, digest(plan.map(m => m.sql).join('\n')));
  assert.equal(snapshot, renderSchema(plan));
});

test('missing files, untracked files and edited SQL fail before DB access', t => {
  const f = fixture(t);
  const filename = path.join(f.dir, `${f.entries[0].id}.sql`);
  fs.appendFileSync(filename, '\nSELECT 1;');
  assert.throws(() => loadPlan(f.dir), /checksum mismatch/);
  fs.writeFileSync(filename, f.schema);
  fs.writeFileSync(path.join(f.dir, '0002-unlisted.sql'), 'SELECT 1;');
  assert.throws(() => loadPlan(f.dir), /Every schema migration/);
  fs.unlinkSync(filename);
  assert.throws(() => loadPlan(f.dir), /ENOENT/);
});

test('migration IDs cannot be reordered, duplicated, skipped or escape the directory', t => {
  const f = fixture(t, ['SELECT 1;', 'SELECT 2;']);
  for (const id of ['0001-step', '0003-step', '../escape']) {
    f.entries[1].id = id; f.save();
    assert.throws(() => loadPlan(f.dir), /ordered IDs/);
  }
});

for (const sql of ['BEGIN; SELECT 1; COMMIT;', 'COMMIT;', 'ROLLBACK;', 'SELECT 1; /* nested /* comment */ */ COMMIT;', 'SELECT 1; END;', 'CREATE INDEX CONCURRENTLY x ON t(id);']) {
  test(`nontransactional migration is refused: ${sql}`, t => {
    const f = fixture(t, [sql]);
    assert.throws(() => loadPlan(f.dir), /must be transactional/);
  });
}

test('receipts must be an exact prefix, with immutable SQL and schema checksums', t => {
  const f = fixture(t, ['SELECT 1;', 'SELECT 2;']);
  const plan = loadPlan(f.dir);
  const rows = plan.map(m => ({ id: m.id, checksum: m.sha256, schema_sha256: m.schemaSha256 }));
  assert.deepEqual(pendingMigrations(plan, [rows[0]]).map(m => m.id), [rows[1].id]);
  assert.deepEqual(pendingMigrations(plan, rows), []);
  for (const invalid of [[rows[1]], [{ ...rows[0], checksum: 'a'.repeat(64) }],
    [{ ...rows[0], schema_sha256: 'b'.repeat(64) }]]) {
    assert.throws(() => pendingMigrations(plan, invalid), /history differs/);
  }
  assert.throws(() => pendingMigrations(plan, [...rows, rows[1]]), /newer than/);
});

function harness(f, { failures = [], applied = [], setupError } = {}) {
  const queries = [];
  const released = [];
  let stopped = 0;
  let attempts = 0;
  const sql = fs.readFileSync(path.join(f.dir, `${f.entries.at(-1).id}.sql`), 'utf8');
  const pool = { async connect() { return { async query(text, values) {
    queries.push({ text, values });
    if (text.includes('set_config') && setupError) throw setupError;
    if (text === sql && failures[attempts++]) throw failures[attempts - 1];
    if (text.includes('pg_backend_pid')) return { rows: [{ pid: 120 }] };
    if (text.includes('to_regclass')) return { rows: [{ journal: applied.length ? 'schema_migrations' : null }] };
    if (text.startsWith('SELECT id,')) return { rows: applied };
    return { rows: [] };
  }, release(destroy) { released.push(destroy); } }; } };
  return { queries, released, stopped: () => stopped, run: () => applySchemaWithLockRetry(pool, {
    dir: f.dir, retries: 25, retryDelayMs: 0, observe: () => async () => { stopped++; },
  }) };
}

test('DDL and its receipt commit together and the dedicated session is destroyed', async t => {
  const f = fixture(t); const h = harness(f);
  await h.run();
  const q = h.queries.map(q => q.text);
  assert.ok(q.indexOf('BEGIN') < q.indexOf(f.schema));
  assert.ok(q.indexOf(f.schema) < q.findIndex(sql => sql.startsWith('INSERT INTO public.schema_migrations')));
  assert.ok(q.findIndex(sql => sql.startsWith('INSERT INTO public.schema_migrations')) < q.indexOf('COMMIT'));
  assert.equal(h.stopped(), 1);
  assert.deepEqual(h.released, [true]);
});

for (const code of ['55P03', '40P01']) {
  test(`${code} rolls back before retrying only the failed migration`, async t => {
    const f = fixture(t, ['CREATE TABLE a(id int);', 'ALTER TABLE a ADD value int;']);
    const h = harness(f, { failures: [error(code)] });
    await h.run();
    const q = h.queries.map(q => q.text);
    assert.equal(q.filter(s => s === 'ROLLBACK').length, 1);
    assert.equal(q.filter(s => s === 'COMMIT').length, 2);
    assert.equal(q.filter(s => s === 'CREATE TABLE a(id int);').length, 1);
    assert.equal(q.filter(s => s === 'ALTER TABLE a ADD value int;').length, 2);
    assert.ok(q.indexOf('ROLLBACK') < q.lastIndexOf('ALTER TABLE a ADD value int;'));
  });
  test(`${code} stops at the attempt budget and cleans up`, async t => {
    const f = fixture(t); const failure = error(code);
    const h = harness(f, { failures: Array(25).fill(failure) });
    await assert.rejects(h.run(), e => e === failure);
    assert.equal(h.queries.filter(q => q.text === 'ROLLBACK').length, 25);
    assert.equal(h.queries.filter(q => q.text === 'COMMIT').length, 0);
    assert.equal(h.stopped(), 1);
    assert.deepEqual(h.released, [true]);
  });
}

test('a current database executes no schema SQL, receipt writes or DDL', async t => {
  const f = fixture(t);
  const applied = f.entries.map(m => ({ id: m.id, checksum: m.sha256, schema_sha256: m.schemaSha256 }));
  const h = harness(f, { applied }); await h.run();
  assert.equal(h.queries.some(q => q.text === f.schema || /^(CREATE|ALTER|INSERT|BEGIN)/.test(q.text)), false);
});

test('syntax, data and connection errors escape unchanged without retrying', async t => {
  for (const code of ['42601', '23505', '08006']) {
    const f = fixture(t); const failure = error(code);
    const h = harness(f, { failures: [failure] });
    await assert.rejects(h.run(), e => e === failure);
    assert.equal(h.queries.filter(q => q.text === 'ROLLBACK').length, 1);
    assert.deepEqual(h.released, [true]);
  }
  const f = fixture(t); const failure = error('08006');
  const h = harness(f, { setupError: failure });
  await assert.rejects(h.run(), e => e === failure);
  assert.equal(h.stopped(), 0); assert.deepEqual(h.released, [true]);
});

test('blocker diagnostics select actual blocker IDs and relation locks without SQL text', () => {
  assert.match(BLOCKERS_SQL, /pg_blocking_pids\(\$1::int\)/);
  assert.match(BLOCKERS_SQL, /w\.pid = \$1::int AND NOT w\.granted/);
  assert.match(BLOCKERS_SQL, /application_name/);
  assert.doesNotMatch(BLOCKERS_SQL, /\bquery\b|pg_cancel_backend|pg_terminate_backend/);
  assert.doesNotMatch(BLOCKERS_SQL, /state IS DISTINCT/);
});

test('the authoring command appends checksums and refuses to bless historical edits', t => {
  const { record } = require('../scripts/record-schema-migration');
  const f = fixture(t);
  // The command accepts an explicit DB source root in tests; never edits
  // the repository's manifest while constructing a fixture.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-author-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.mkdirSync(path.join(work, 'migrations'));
  for (const file of fs.readdirSync(f.dir)) fs.copyFileSync(path.join(f.dir, file), path.join(work, 'migrations', file));
  fs.writeFileSync(path.join(work, 'schema.sql'), f.schema + '\nALTER TABLE baseline ADD value int;');
  const next = path.join(work, 'migrations', '0002-example.sql');
  fs.writeFileSync(next, 'ALTER TABLE baseline ADD value int;');
  record('0002-example', work);
  assert.equal(loadPlan(path.join(work, 'migrations')).length, 2);
  assert.throws(() => record('0002-again', work), /must start with 0003/);
  fs.appendFileSync(path.join(work, 'migrations', '0001-step.sql'), '\nSELECT 1;');
  fs.writeFileSync(path.join(work, 'migrations', '0003-next.sql'), 'SELECT 3;');
  const before = fs.readFileSync(path.join(work, 'migrations', 'manifest.json'), 'utf8');
  assert.throws(() => record('0003-next', work), /checksum mismatch/);
  assert.equal(fs.readFileSync(path.join(work, 'migrations', 'manifest.json'), 'utf8'), before);
});

test('transaction guards allow quoted keywords, escaped strings, function bodies and nested comments', t => {
  const f = fixture(t, ["DO $body$ BEGIN PERFORM 'COMMIT;'; END $body$; SELECT 'it''s; BEGIN;'; /* nested /* COMMIT; */ */ SELECT 1;"]);
  assert.equal(loadPlan(f.dir).length, 1);
});

for (const [first, second] of [
  ['first$hide$', 'second$hide$'], ['café$hide$', 'autre$hide$'], ['first$1$hide$', 'second$1$hide$'],
]) {
  test(`identifier ${first} cannot conceal a transaction boundary`, async t => {
    const sql = `CREATE TABLE ${first} (id int); COMMIT; CREATE TABLE ${second} (id int); SELECT 1/0;`;
    const f = fixture(t, [sql]);
    let connections = 0;
    await assert.rejects(applySchemaWithLockRetry({ async connect() { connections++; } }, f), /must be transactional/);
    assert.equal(connections, 0, 'reject the file before any DDL or even connecting');
  });
}

test('dollars remain valid in identifiers and non-ASCII dollar quote tags', t => {
  for (const sql of ['CREATE TABLE valid$identifier$ (id int);',
    "DO $café$ BEGIN PERFORM 'COMMIT;'; END $café$; CREATE TABLE café$dollars$ (id int);"]) {
    const f = fixture(t, [sql]);
    assert.equal(loadPlan(f.dir).length, 1);
  }
});
