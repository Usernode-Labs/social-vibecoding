'use strict';

// Additive changes only on an original that versions get their updates from
// (src/services/schema-safety.js, docs/plans/versions.md).
//
// Pinned here:
//   1. the rule: which ADDED lines of code and SQL files drop, rename,
//      retype or truncate data, and which look alike and do not;
//   2. the refusal: only when some version follows, in the words people
//      read, failing open when the diff cannot be read;
//   3. that the proposal machine's merge gate asks it first, unless forced,
//      and says it once in the proposal's thread.
//
// Run with: node --test tests/schema-safety.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const safety = require('../src/services/schema-safety');

function diffOf(file, lines, removed = []) {
  return [
    `diff --git a/${file} b/${file}`,
    '@@ -1,3 +1,4 @@',
    ...removed.map((l) => `-${l}`),
    ...lines.map((l) => `+${l}`),
    ' unchanged();',
  ].join('\n');
}

test('drops, renames, type changes and truncates in added code are destructive', () => {
  const cases = [
    "await pool.query('DROP TABLE IF EXISTS items');",
    'DROP SCHEMA old CASCADE;',
    'ALTER TABLE items DROP COLUMN price;',
    'ALTER TABLE items DROP price;',
    'ALTER TABLE items DROP IF EXISTS price;',
    'ALTER TABLE items RENAME TO things;',
    'ALTER TABLE items RENAME COLUMN price TO cost;',
    'ALTER TABLE "items" RENAME "price" TO cost;',
    'ALTER TABLE items ALTER COLUMN price TYPE numeric;',
    'ALTER TABLE items ALTER price SET DATA TYPE text;',
    "await db.query('TRUNCATE items');",
    'TRUNCATE TABLE items RESTART IDENTITY;',
    'truncate only public.items cascade;',
  ];
  for (const line of cases) {
    const found = safety.destructiveStatements(diffOf('server.js', [line]));
    assert.equal(found.length, 1, line);
    assert.equal(found[0], line.trim());
  }
  assert.deepEqual(safety.destructiveStatements(diffOf('migrations/002.sql', ['DROP TABLE votes;'])),
    ['DROP TABLE votes;'], 'a .sql migration counts');
});

test('what only looks alike is not destructive', () => {
  const lines = [
    'CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY);',
    'ALTER TABLE items ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ;',
    'ALTER TABLE items DROP CONSTRAINT items_price_check;',
    'ALTER TABLE items ALTER COLUMN price DROP NOT NULL;',
    'ALTER TABLE items ALTER COLUMN price DROP DEFAULT;',
    'ALTER TABLE items RENAME CONSTRAINT a TO b;',
    'DROP INDEX IF EXISTS idx_items_price;',
    'DROP VIEW IF EXISTS item_totals;',
    'ALTER TYPE mood ADD VALUE \'calm\';',
    'const short = truncate(text, 80);',
    "label.textContent = 'We truncate the text to fit';",
    '// DROP TABLE items once nobody reads it',
    "fetch('https://example.com/a'); -- DROP TABLE x",
    'fs.renameSync(a, b);',
  ];
  assert.deepEqual(safety.destructiveStatements(diffOf('server.js', lines)), []);
});

test('only added lines of code and SQL files count', () => {
  assert.deepEqual(safety.destructiveStatements(diffOf('server.js', ['ok();'], ['DROP TABLE items;'])), [],
    'taking a DROP out removes nothing');
  assert.deepEqual(safety.destructiveStatements(diffOf('README.md', ['Run DROP TABLE items; to reset.'])), [],
    'words in a README are not a migration');
  assert.deepEqual(safety.destructiveStatements(diffOf('public/app.css', ['DROP TABLE x;'])), []);
  const both = `${diffOf('README.md', ['DROP TABLE a;'])}\n${diffOf('api.js', ['ALTER TABLE b DROP COLUMN c;'])}`;
  assert.deepEqual(safety.destructiveStatements(both), ['ALTER TABLE b DROP COLUMN c;']);
});

test('a statement written over several added lines is found, and repeats are listed once', () => {
  const found = safety.destructiveStatements(diffOf('api.js', [
    'await pool.query(`',
    '  ALTER TABLE items',
    '    RENAME COLUMN price TO cost',
    '`);',
  ]));
  assert.equal(found.length, 1);
  assert.match(found[0], /ALTER TABLE items RENAME COLUMN price TO cost/);
  assert.deepEqual(safety.destructiveStatements(diffOf('a.js', ['DROP TABLE x;', 'DROP TABLE x;'])), ['DROP TABLE x;']);
});

test('the GitHub-shaped diff (with ---/+++ lines) reads the same', () => {
  const diff = [
    'diff --git a/db.sql b/db.sql',
    '--- a/db.sql',
    '+++ b/db.sql',
    '@@ -1 +1,2 @@',
    ' CREATE TABLE a (id int);',
    '+ALTER TABLE a ALTER COLUMN id TYPE bigint;',
  ].join('\n');
  assert.deepEqual(safety.destructiveStatements(diff), ['ALTER TABLE a ALTER COLUMN id TYPE bigint;']);
});

test('the refusal says how many versions get the updates, in plain words', () => {
  assert.equal(safety.refusalMessage(3),
    "This change removes or renames data, and 3 versions get this project's updates. Changes here have to add, not remove.");
  assert.match(safety.refusalMessage(1), /and 1 version gets this project's updates\./);
  assert.doesNotMatch(safety.refusalMessage(2), /—|upstream|fork|remix/i);
});

function fakePool({ following = 0 } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/FROM apps/.test(sql) && /upstream->>'following' = 'true'/.test(sql)) return { rows: [{ n: following }] };
      return { rows: [] };
    },
  };
}

const SESSION = {
  id: 9, app_id: 3, source: null, reviewed_head_sha: 'a'.repeat(40), branch_name: 'b',
  repo_url: 'https://git.example.test/apps/tier-list',
};
const repoRef = { ownerRepo: () => ({ owner: 'apps', repo: 'tier-list' }) };

test('an original nobody follows merges what it likes, without its diff being read', async () => {
  let read = 0;
  const github = { getProposalDiff: async () => { read += 1; return { diff: diffOf('a.js', ['DROP TABLE x;']) }; } };
  assert.equal(await safety.mergeRefusal(fakePool({ following: 0 }), SESSION, { github, repoRef }), null);
  assert.equal(read, 0);
});

test('an original with following versions is refused a destructive change, at the reviewed head', async () => {
  const asked = [];
  const github = {
    getProposalDiff: async (owner, repo, basehead) => {
      asked.push([owner, repo, basehead]);
      return { diff: diffOf('api.js', ['ALTER TABLE items DROP COLUMN price;']) };
    },
  };
  const pool = fakePool({ following: 2 });
  const out = await safety.mergeRefusal(pool, SESSION, { github, repoRef });
  assert.equal(out.following, 2);
  assert.deepEqual(out.statements, ['ALTER TABLE items DROP COLUMN price;']);
  assert.match(out.message, /2 versions get this project's updates/);
  assert.deepEqual(asked, [['apps', 'tier-list', `main...${'a'.repeat(40)}`]]);
  const count = pool.queries[0];
  assert.match(count.sql, /\(upstream->>'appId'\)::int = \$1/, 'the expression index the schema keeps');
  assert.deepEqual(count.params, [3]);

  const additive = { getProposalDiff: async () => ({ diff: diffOf('api.js', ['CREATE TABLE IF NOT EXISTS x (id int);']) }) };
  assert.equal(await safety.mergeRefusal(pool, SESSION, { github: additive, repoRef }), null);
});

test('a diff that cannot be read does not hold the merge', async () => {
  const github = { getProposalDiff: async () => { throw new Error('host down'); } };
  assert.equal(await safety.mergeRefusal(fakePool({ following: 4 }), SESSION, { github, repoRef }), null);
});

test('the refusal is said once in the proposal\'s own thread', async () => {
  const sent = [];
  const ws = { sendSystemMessage: async (...args) => { sent.push(args); } };
  let last = null;
  const pool = { async query() { return { rows: last ? [{ content: last }] : [] }; } };
  const message = safety.refusalMessage(2);
  assert.equal(await safety.sayOnce(pool, SESSION, message, { ws }), true);
  assert.deepEqual(sent[0].slice(1), [3, message, 'system', null, { type: 'session', ref: 9 }]);
  last = message;
  assert.equal(await safety.sayOnce(pool, SESSION, message, { ws }), false, 'not again while it is the last line');
  assert.equal(sent.length, 1);
});

test('the merge gate asks first, unless an admin forces the merge', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/proposal/services.ts'), 'utf8');
  const gate = src.slice(src.indexOf('[WORK.gate]: {'), src.indexOf('[WORK.attempt]: {'));
  const asked = gate.indexOf("legacy('services/schema-safety')");
  assert.ok(asked > 0, 'the gate reads the rule');
  assert.ok(asked < gate.indexOf('evaluateMergeGate'), 'before the rest of the gate');
  assert.match(gate, /if \(!input\.force\) \{/);
  assert.match(gate, /await schemaSafety\.sayOnce\(pool, row, refusal\.message\);\s+return \{ ready: false, blockReason: schemaSafety\.BLOCK_REASON \};/);
  assert.equal(safety.BLOCK_REASON, 'destructive_schema');
});
