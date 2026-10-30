'use strict';
// test:changed: when src/db/migrations/ (canonical SQL history)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { loadPlan, renderSchema, schemaSql, ensureSchema } = require('../src/db/schema-source');
const { REFERENCE_STATEMENTS } = require('../src/db/reference-data');
const root = path.resolve(__dirname, '..');
const hash = sql => crypto.createHash('sha256').update(sql).digest('hex');
function fixture(t, statements = ['CREATE TABLE a(id int) -- final comment']) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-source-'));
  const dir = path.join(base, 'migrations'); fs.mkdirSync(dir);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const migrations = statements.map((sql, i) => ({ id: `${String(i + 1).padStart(4, '0')}-step`,
    sha256: hash(sql), schemaSha256: hash(statements.slice(0, i + 1).join('\n')) }));
  migrations.forEach((m,i) => fs.writeFileSync(path.join(dir, `${m.id}.sql`), statements[i]));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, migrations }));
  return { base, dir, target: path.join(base, 'schema.sql') };
}

test('the generated input is exactly the ordered migration history and the shared reference inserts', () => {
  const plan = loadPlan(); const sql = schemaSql();
  assert.equal(sql, renderSchema(plan));
  assert.ok(sql.startsWith('-- Generated from migrations and reference-data.js. Do not edit.'));
  for (const ref of REFERENCE_STATEMENTS) assert.ok(sql.includes(ref));
  assert.equal(fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8'), sql);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^src\/db\/schema\.sql$/m);
  assert.match(fs.readFileSync(path.join(root, '.dockerignore'), 'utf8'), /^src\/db\/schema\.sql$/m);
  assert.equal(plan[0].sql.includes("VALUES ('channel', 'general', 'general')"), false, 'reference inserts are not duplicated in the baseline');
});

test('rendering preserves optional query terminators and trailing line comments', t => {
  const f = fixture(t, ['CREATE TABLE a(id int) -- trailing comment', 'CREATE TABLE b(id int)']);
  const sql = renderSchema(loadPlan(f.dir), []);
  assert.match(sql, /trailing comment\n;\n/);
  assert.match(sql, /CREATE TABLE b\(id int\)\n;\n/);
  const reference = renderSchema([], ['SELECT 1 -- trailing comment', 'SELECT 2']);
  assert.match(reference, /trailing comment\n;\n\s*SELECT 2\n;\n/);
});

test('reference changes alter rendered input without invalidating immutable migration receipts', t => {
  const f = fixture(t); const plan = loadPlan(f.dir);
  const before = renderSchema(plan, ['SELECT 1;']);
  const after = renderSchema(plan, ['SELECT 2;']);
  assert.notEqual(before, after);
  assert.deepEqual(loadPlan(f.dir), plan);
});

test('missing or poisoned generated files are rebuilt from validated sources', t => {
  const f = fixture(t); const sql = schemaSql(f.dir);
  assert.equal(ensureSchema(f.dir), f.target);
  assert.equal(fs.readFileSync(f.target, 'utf8'), sql);
  fs.writeFileSync(f.target, 'untrusted or stale SQL');
  ensureSchema(f.dir);
  assert.equal(fs.readFileSync(f.target, 'utf8'), sql);
  fs.appendFileSync(path.join(f.dir, '0001-step.sql'), '\nSELECT 5;');
  assert.throws(() => ensureSchema(f.dir), /checksum mismatch/);
  assert.equal(fs.readFileSync(f.target, 'utf8'), sql, 'invalid sources never replace a good artifact');
});

test('an up-to-date artifact is usable without writing to it', t => {
  const f = fixture(t); ensureSchema(f.dir);
  fs.utimesSync(f.target, 100, 100); fs.chmodSync(f.target, 0o444);
  const before = fs.statSync(f.target).mtimeMs;
  assert.equal(ensureSchema(f.dir), f.target);
  assert.equal(fs.statSync(f.target).mtimeMs, before);
});

test('concurrent preloads atomically materialize a complete artifact', async t => {
  const f = fixture(t);
  const code = 'require(process.argv[1]).ensureSchema(process.argv[2])';
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
    ['-e', code, require.resolve('../src/db/schema-source'), f.dir])));
  assert.equal(fs.readFileSync(f.target, 'utf8'), schemaSql(f.dir));
  assert.deepEqual(fs.readdirSync(f.base).sort(), ['migrations', 'schema.sql']);
});

test('npm, direct test preloads and both images generate the ignored input', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const script of ['prestart','predev','pretest','pretest:changed']) assert.ok(pkg.scripts[script].startsWith('node scripts/build-schema.js && '));
  assert.equal(pkg.scripts['build:schema'], 'node scripts/build-schema.js');
  assert.match(fs.readFileSync(path.join(root, 'tests/lib/test-net.js'), 'utf8'), /schema-source'\)\.ensureSchema\(\)/);
  for (const docker of ['Dockerfile', 'Dockerfile.kubernetes']) assert.match(fs.readFileSync(path.join(root, docker), 'utf8'), /^RUN node scripts\/build-schema\.js$/m);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-kubernetes-images.yml'), 'utf8');
  const previewJob = workflow.slice(workflow.indexOf('  preview-schema-compatibility:'), workflow.indexOf('  security-images:'));
  const generated = previewJob.indexOf('run: node scripts/build-schema.js');
  assert.ok(generated >= 0 && generated < previewJob.indexOf('node --test'),
    'fresh CI checkouts generate SQL before direct node --test invocations');
});

test('history-prefix checksums are validated independently of generated output', t => {
  const f = fixture(t, ['SELECT 1;', 'SELECT 2;']);
  const file = path.join(f.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.migrations[0].schemaSha256 = 'a'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => ensureSchema(f.dir), /history checksum mismatch/);
  assert.equal(fs.existsSync(f.target), false);
});
