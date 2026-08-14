'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
let inventoryCheck;
let inventory;

test.before(() => {
  inventoryCheck = spawnSync(process.execPath, ['scripts/check-sql.js', '--inventory-only'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(inventoryCheck.status, 0, inventoryCheck.stderr || inventoryCheck.stdout);
  const { collectQueryInventory } = require('../scripts/check-sql');
  inventory = collectQueryInventory();
});

test('SQL inventory covers static application queries and matches the reviewed dynamic baseline', () => {
  const summary = inventoryCheck.stdout.match(
    /SQL inventory: (\d+) static query variants from (\d+) \.query\(\) calls; (\d+) dynamic calls/
  );
  assert.ok(summary, `missing inventory summary: ${inventoryCheck.stdout}`);
  const [, staticCount, callCount, dynamicCount] = summary.map(Number);
  assert.ok(callCount > 2000, 'the inventory must cover the whole backend, not a hand-picked subset');
  assert.ok(staticCount / callCount > 0.9, 'at least 90% of query calls must reach PostgreSQL validation');
  assert.ok(dynamicCount > 0, 'runtime-built SQL must remain visible in the reviewed baseline');
});

test('the inventory carries the exact PostgreSQL parameter contexts from #1177', () => {
  const votes = inventory.queries.find(({ text }) => (
    text.includes("CASE WHEN $7::text = 'promoted' THEN NOW() END")
  ));
  assert.ok(votes, 'expected to inventory the proposal vote write query');
  assert.match(votes.text, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7::text,/);
  assert.match(votes.text, /CASE WHEN \$7::text = 'active' THEN NOW\(\) END/);
});

test('the checker uses PostgreSQL Parse + Describe without executing queries', () => {
  const checker = read('scripts/check-sql.js');
  assert.match(checker, /\.unsafe\(queryText, \[\], \{ prepare: true \}\)\.describe\(\)/);

  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(
    Object.keys(pkg.devDependencies).filter((name) => (
      name.includes('safeql') || name === 'eslint' || name === 'typescript-eslint' || name === 'libpg-query'
    )),
    []
  );
  assert.equal(pkg.devDependencies.postgres, '3.4.9');
  assert.equal(pkg.devDependencies.typescript, '6.0.3');
});

test('proposal unit suites run SQL validation against the worker PostgreSQL 17 planner', () => {
  const dockerfile = read('worker/Dockerfile');
  assert.match(dockerfile, /postgresql-17 postgresql-contrib-17/);
  assert.match(dockerfile, /PATH=\/usr\/lib\/postgresql\/17\/bin/);
  assert.doesNotMatch(dockerfile, /postgresql-15 postgresql-contrib-15/);

  const unitSuite = read('src/services/unit-suite.js');
  assert.match(unitSuite, /includes\('scripts\/check-sql\.js'\)/);
  assert.match(unitSuite, /SQL_CHECK_CONNECTION_URL=postgres:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres/);
  assert.match(unitSuite, /npm run lint:sql[\s\S]*npm test/);
});
