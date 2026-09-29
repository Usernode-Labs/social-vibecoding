'use strict';

// scripts/shots-dry-run-pair.js stands up the before/after pair a shots dry
// run takes its shots on. The run itself needs Docker and the local stack;
// these pin its argument contract and the names it gives what it creates.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs, pairNames, ORIGINS } = require('../scripts/shots-dry-run-pair');
const dbManager = require('../src/services/db-manager');

const BEFORE = 'a'.repeat(40);
const AFTER = 'b'.repeat(40);

test('a pair is two exact, different commits, named after the after commit unless told otherwise', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs([]), { help: true });
  assert.throws(() => parseArgs(['start']), /Unknown command/);
  assert.throws(() => parseArgs(['up', '--before', BEFORE]), /needs --before and --after/);
  assert.throws(() => parseArgs(['up', '--before', 'abc123', '--after', AFTER]), /40-character/);
  assert.throws(() => parseArgs(['up', '--before', BEFORE, '--after', BEFORE]), /different commits/);
  assert.throws(() => parseArgs(['up', '--before', BEFORE, '--after', AFTER, '--label', 'Bad Label']), /--label/);
  assert.throws(() => parseArgs(['up', '--before', BEFORE, '--before', BEFORE]), /repeated/);

  const up = parseArgs(['up', '--before', BEFORE, '--after', AFTER]);
  assert.equal(up.label, 'bbbbbbbbbbbb');
  assert.equal(up.build, true);
  assert.equal(up.lab, path.resolve(__dirname, '..', '.shots-dry-run'), 'everything stays in the ignored lab directory');
  assert.equal(parseArgs(['up', '--before', BEFORE, '--after', AFTER, '--no-build', '--label', 'p4832']).build, false);
  assert.equal(parseArgs(['down']).label, null, 'down without a label stops every pair');
});

test('a pair\'s databases are the shots databases a hosted run would name, and its hosts differ', () => {
  const names = pairNames('p4832');
  assert.equal(names.runId.length, 32);
  assert.deepEqual(names.dbs, {
    base: dbManager.shotsDbName('usernode-2d5619', names.runId, 'base'),
    head: dbManager.shotsDbName('usernode-2d5619', names.runId, 'head'),
  });
  assert.deepEqual(names.containers, { base: 'shots-p4832-before', head: 'shots-p4832-after' });
  assert.equal(pairNames('p4832').runId, names.runId, 'the same label always names the same pair');
  // Cookies are scoped by host, not port: the two sides must not share one.
  assert.notEqual(new URL(ORIGINS.base).hostname, new URL(ORIGINS.head).hostname);
});
