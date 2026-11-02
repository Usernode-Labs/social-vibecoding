'use strict';
// Two branches that each add a schema migration: the one that merges second
// regenerates the manifest with `--onto <main>`, in a real git repository,
// after a merge of main and after a rebase onto it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { record, onto } = require('../scripts/record-schema-migration');
const { loadPlan } = require('../src/db/schema-source');

const hash = sql => crypto.createHash('sha256').update(sql).digest('hex');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };

// main: the baseline. branch: its own migration. main again: another
// branch's migration, merged first.
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-onto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'migrations');
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: ENV, encoding: 'utf8', stdio: 'pipe' });
  const tryGit = (...args) => spawnSync('git', args, { cwd: root, env: ENV, encoding: 'utf8' });
  const sql = new Map([['0001-baseline', 'CREATE TABLE a (id int);'],
    ['admin-text', 'ALTER TABLE a ADD admin text;'], ['web-withdraws', 'ALTER TABLE a ADD web int;']]);
  const add = id => { fs.writeFileSync(path.join(dir, `${id}.sql`), sql.get(id)); record(id, root); git('add', '-A'); git('commit', '-qm', id); };
  fs.writeFileSync(path.join(root, '.gitignore'), 'schema.sql\n');
  fs.writeFileSync(path.join(dir, '0001-baseline.sql'), sql.get('0001-baseline'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, migrations: [{
    id: '0001-baseline', sha256: hash(sql.get('0001-baseline')), schemaSha256: hash(sql.get('0001-baseline')) }] }, null, 2) + '\n');
  git('init', '-qb', 'main'); git('add', '-A'); git('commit', '-qm', 'baseline');
  git('switch', '-qc', 'branch'); add('web-withdraws');
  git('switch', '-q', 'main'); add('admin-text');
  git('switch', '-q', 'branch');
  const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).migrations;
  return { root, dir, git, tryGit, sql, manifest };
}

function assertOnTopOfMain(r) {
  const [, admin, web] = r.manifest();
  assert.deepEqual(r.manifest().map(m => m.id), ['0001-baseline', 'admin-text', 'web-withdraws']);
  // Main's entries are main's, byte for byte; the branch's file is untouched
  // and its history checksum now covers main's migration.
  assert.deepEqual(admin, JSON.parse(r.git('show', 'main:migrations/manifest.json')).migrations[1]);
  assert.equal(web.sha256, hash(r.sql.get('web-withdraws')));
  assert.equal(web.schemaSha256, hash(['0001-baseline', 'admin-text', 'web-withdraws'].map(id => r.sql.get(id)).join('\n')));
  assert.equal(loadPlan(r.dir).length, 3);
}

test('a merge of main: the manifest conflict is regenerated, main first', t => {
  const r = repository(t);
  const merge = r.tryGit('merge', '-q', 'main');
  assert.notEqual(merge.status, 0, 'both branches appended to the manifest');
  assert.deepEqual(r.git('diff', '--name-only', '--diff-filter=U').trim().split('\n'), ['migrations/manifest.json']);
  assert.deepEqual(onto('main', r.root), ['web-withdraws']);
  assertOnTopOfMain(r);
  r.git('add', 'migrations/manifest.json'); r.git('commit', '-qm', 'merge main');
  // Already on top: running it again changes nothing.
  const settled = fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8');
  assert.deepEqual(onto('main', r.root), ['web-withdraws']);
  assert.equal(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'), settled);
});

test('a rebase onto main: the sides are swapped, the result is the same', t => {
  const r = repository(t);
  assert.notEqual(r.tryGit('rebase', 'main').status, 0);
  assert.deepEqual(onto('main', r.root), ['web-withdraws']);
  assertOnTopOfMain(r);
});

test('a branch with several migrations keeps their order after main\'s', t => {
  const r = repository(t);
  r.sql.set('web-backfill', 'UPDATE a SET web = 0;');
  fs.writeFileSync(path.join(r.dir, 'web-backfill.sql'), r.sql.get('web-backfill'));
  record('web-backfill', r.root); r.git('add', '-A'); r.git('commit', '-qm', 'backfill');
  r.tryGit('merge', '-q', 'main');
  assert.deepEqual(onto('main', r.root), ['web-withdraws', 'web-backfill']);
  assert.deepEqual(r.manifest().map(m => m.id), ['0001-baseline', 'admin-text', 'web-withdraws', 'web-backfill']);
  assert.equal(loadPlan(r.dir).length, 4);
});

test('a branch that edited one of main\'s migrations is refused, and nothing is written', t => {
  const r = repository(t);
  fs.appendFileSync(path.join(r.dir, '0001-baseline.sql'), '\nALTER TABLE a ADD sneaky int;');
  r.git('commit', '-qam', 'edit history');
  r.tryGit('merge', '-q', 'main');
  const conflicted = fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8');
  assert.throws(() => onto('main', r.root), /checksum mismatch: 0001-baseline/);
  assert.equal(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'), conflicted);
});

test('mid-merge, MERGE_HEAD names main as the sync passes it; the CLI says its usage', t => {
  const r = repository(t);
  r.tryGit('merge', '-q', 'main');
  const script = path.join(__dirname, '..', 'scripts', 'record-schema-migration.js');
  // The CLI works on the repository's own src/db; the module call is what
  // tests can point elsewhere. Its usage errors are the CLI's own.
  const usage = spawnSync(process.execPath, [script, '--onto'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: record-schema-migration\.js --onto <ref>/);
  assert.deepEqual(onto('MERGE_HEAD', r.root), ['web-withdraws']);
  assertOnTopOfMain(r);
});
