'use strict';

// The crash suite is the slowest file in the unit suite, and `npm test` kills
// a file at --test-timeout=180000. A file cut off there reports "test timed
// out", reddens every change whose checks ran it, and tells nobody anything
// about the change. So the suite's own budget, the grace it gives a stuck
// build, and its teardown must together end well inside that limit.
//
// Run with: node --test tests/bot-build-crash-budget.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const budget = require('./lib/bot-build-crash-budget');

const root = path.join(__dirname, '..');

test('the crash suite ends with real room under the runner\'s per-file timeout', () => {
  const total = budget.BUDGET_MS + budget.GRACE_MS + budget.TEARDOWN_MS;
  assert.ok(
    total <= budget.RUNNER_LIMIT_MS - budget.MIN_MARGIN_MS,
    `budget ${budget.BUDGET_MS} + grace ${budget.GRACE_MS} + teardown ${budget.TEARDOWN_MS} = ${total} ms, `
      + `which must leave ${budget.MIN_MARGIN_MS} ms under the runner's ${budget.RUNNER_LIMIT_MS} ms`,
  );
  assert.ok(budget.BUDGET_MS > 0 && budget.GRACE_MS > 0 && budget.TEARDOWN_MS > 0);
});

test('the arithmetic is against the runner limit the test script really uses', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const script = String(pkg.scripts && pkg.scripts.test || '');
  assert.match(script, new RegExp(`--test-timeout=${budget.RUNNER_LIMIT_MS}\\b`),
    `package.json's test script must run with --test-timeout=${budget.RUNNER_LIMIT_MS}`);
});

test('the crash suite itself spends its budget and grace, never bigger numbers of its own', () => {
  const src = fs.readFileSync(path.join(root, 'tests', 'bot-build-crash-postgres.test.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/bot-build-crash-budget'\)/);
  assert.match(src, /Number\(process\.env\.BOT_BUILD_CRASH_BUDGET_MS\) \|\| BUDGET_MS_DEFAULT/);
  assert.match(src, /started \+ BUDGET_MS \+ GRACE_MS/);
});
