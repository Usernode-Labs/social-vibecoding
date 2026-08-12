// Unit tests for the PR-import boot audit (auditDuplicatePrSessions).
//
// The audit must enforce the SAME invariant the import guard enforces
// (importedPrNumbers in routes/votes.js): at most one LIVE
// ('active'/'paused'/'promoted'/'merging'/'merged') imported session per
// (app_id, pr_number). #1162 added the first two: an import now lands In
// progress, so that is where a live claim on a PR normally sits, and the two
// filters have to keep matching in both directions.
// Archived imports are deliberately excluded — withdrawing an import and
// re-importing the reopened PR is a documented flow, and it leaves the
// withdrawn session behind with its pr_number intact.
//
// Regression: PR #1075 was withdrawn (session 3193 → archived) and
// re-imported (session 3195). The audit at the time counted ALL imported
// rows, so the next deploy's fresh container refused to boot on
// "duplicate (app_id, pr_number) sessions [3193, 3195]" — with the audit
// fix itself stuck behind the very deploy the audit was blocking. Prod
// needed manual DB surgery to roll again.
//
// Run with: node --test tests/pr-import-audit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { auditDuplicatePrSessions } = require('../src/db/migrate');

// A pool whose duplicate-group answer we control. The audit runs three
// queries: table existence, source-column existence, then the group scan.
function makePool(dupRows) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (/to_regclass/.test(sql)) return { rows: [{ reg: 'chat_sessions' }] };
      if (/information_schema\.columns/.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: dupRows };
    },
  };
}

test('the audit scopes to live statuses, mirroring the import guard', async () => {
  const pool = makePool([]);
  await auditDuplicatePrSessions(pool);
  const scan = pool.queries.find((q) => /GROUP BY app_id, pr_number/.test(q));
  assert.ok(scan, 'the duplicate-group scan ran');
  assert.match(scan, /source = 'imported'/, 'imported rows only');
  assert.match(
    scan, /status IN \('active', 'paused', 'promoted', 'merging', 'merged'\)/,
    'withdraw → re-import (an archived row beside a live one) must not brick the boot'
  );
  assert.doesNotMatch(
    scan, /'archived'/,
    'archived imports stay excluded — re-importing a withdrawn PR is supported'
  );
});

// #1162 in one assertion: the audit's status list and the import guard's must
// be the same set, or an In-progress import is either double-importable (guard
// too narrow) or a boot abort (audit too wide).
test('the audit status scope matches importedPrNumbers in routes/votes.js', () => {
  const fs = require('node:fs');
  const scopeOf = (src) => {
    const m = src.match(/status IN \(([^)]*)\)/g) || [];
    return m.map((s) => s.match(/'[a-z_]+'/g).sort().join(','));
  };
  const wanted = "'active','merged','merging','paused','promoted'";
  const migrate = fs.readFileSync(require.resolve('../src/db/migrate'), 'utf8');
  const votes = fs.readFileSync(require.resolve('../src/routes/votes'), 'utf8');
  assert.ok(scopeOf(migrate).includes(wanted), 'migrate.js audit scopes to the live set');
  assert.ok(scopeOf(votes).includes(wanted), 'votes.js import guard scopes to the same set');
});

test('a live duplicate still aborts the boot loudly', async () => {
  const pool = makePool([
    { app_id: 10, pr_number: 1075, session_ids: [3193, 3195], count: 2 },
  ]);
  await assert.rejects(
    () => auditDuplicatePrSessions(pool),
    /duplicate \(app_id, pr_number\)/,
    'two LIVE claims on one PR is real corruption and must not boot'
  );
});
