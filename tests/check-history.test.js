// #1019: services/check-history — the durable per-check record that decides
// which checks may block a merge.
//
// The rule: a check blocks iff it has been observed passing at least once
// (`first_passed_at IS NOT NULL`). Everything else is advisory. Three
// properties have to hold or the rule is unsafe in one direction or the
// other, and all three are easy to break with an innocent-looking SQL edit:
//
//   * NO DEMOTION. A graduated check that starts failing stays blocking.
//     That is the whole point — it is a guard rail, not a mood ring. In SQL
//     that is the COALESCE on first_passed_at; drop it and any failing run
//     silently un-gates the check it just caught.
//   * FAIL SAFE, NOT OPEN. If the history can't be read, nothing can be
//     PROVEN to have earned gating, so everything is advisory for that run.
//     The other choice — assume everything gates — turns a transient DB
//     hiccup into "no proposal can merge".
//   * BOOTSTRAP ONCE, ONLY WHEN EMPTY. The first build after deploy must not
//     start from zero gating: the old gate was "the first 12 declared checks
//     must pass", so an app with no history has exactly those pre-graduated.
//     Firing it twice, or on an app that already has history, would graduate
//     checks that never passed.
//
// Tested against a fake pool that records SQL — no database needed.
//
// Run with: node --test tests/check-history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const checkHistory = require('../src/services/check-history');
const appManifest = require('../src/services/app-manifest');

// Fake pg pool. `responder` maps a query to its result; anything unhandled
// returns no rows. Every call is recorded for inspection.
function makePool(responder) {
  const calls = [];
  return {
    calls,
    sql: (i) => calls[i].text.replace(/\s+/g, ' ').trim(),
    async query(text, params) {
      calls.push({ text, params });
      const out = responder ? responder(text, params) : null;
      if (out instanceof Error) throw out;
      return out || { rows: [] };
    },
  };
}

const tests = (n, from = 0) => Array.from({ length: n }, (_, i) => ({
  name: `check ${from + i}`, path: `/p${from + i}`,
}));

// ── loadGraduated ──────────────────────────────────────────────────────

test('loadGraduated returns the keys that have ever passed', async () => {
  const pool = makePool((text) => (
    /SELECT check_key/.test(text) ? { rows: [{ check_key: 'aaa' }, { check_key: 'bbb' }] } : null
  ));
  const set = await checkHistory.loadGraduated(pool, 7);
  assert.ok(set.has('aaa') && set.has('bbb'));
  assert.equal(set.size, 2);
  assert.match(pool.sql(0), /first_passed_at IS NOT NULL/,
    'graduation is derived from first_passed_at, never from a stored flag');
});

test('an unreadable history makes everything advisory, not everything blocking', async () => {
  const pool = makePool(() => new Error('connection terminated'));
  const set = await checkHistory.loadGraduated(pool, 7);
  assert.equal(set.size, 0, 'nothing can be proven graduated, so nothing gates');
});

test('loadGraduated tolerates a missing pool or app', async () => {
  assert.equal((await checkHistory.loadGraduated(null, 7)).size, 0);
  assert.equal((await checkHistory.loadGraduated(makePool(), null)).size, 0);
});

// ── bootstrap ──────────────────────────────────────────────────────────

test('an app with no history gets exactly the legacy gating head', async () => {
  const pool = makePool();
  const n = await checkHistory.bootstrapIfEmpty(pool, 3, tests(50));
  assert.equal(n, appManifest.LEGACY_GATING_HEAD,
    'the blocking set on build one matches the blocking set on build zero');
  assert.equal(n, 12, 'which was the old parse cap');
  const insert = pool.calls[1];
  assert.match(insert.text, /INSERT INTO app_check_history/);
  assert.match(insert.text.replace(/\s+/g, ' '), /ON CONFLICT \(app_id, check_key\) DO NOTHING/,
    'idempotent, so a racing second build cannot double-insert');
  // app_id + (key, name, path) per row.
  assert.equal(insert.params.length, 1 + 12 * 3);
  assert.equal(insert.params[1], appManifest.checkKey('check 0', '/p0'),
    'and the head is the first declared checks, in manifest order');
});

test('an app that already has history is never bootstrapped', async () => {
  // Re-running it would graduate checks on their declared position rather
  // than on having passed — inventing gating out of nothing.
  const pool = makePool((text) => (/LIMIT 1/.test(text) ? { rows: [{ '?column?': 1 }] } : null));
  const n = await checkHistory.bootstrapIfEmpty(pool, 3, tests(50));
  assert.equal(n, 0);
  assert.equal(pool.calls.length, 1, 'the probe, and no insert');
});

test('a failed history probe suppresses the bootstrap', async () => {
  // If the probe can't answer, assume history exists. Guessing "empty" would
  // re-graduate a head that was already graduated on some later build.
  const pool = makePool((text) => (/LIMIT 1/.test(text) ? new Error('nope') : null));
  assert.equal(await checkHistory.bootstrapIfEmpty(pool, 3, tests(50)), 0);
  assert.equal(pool.calls.length, 1);
});

test('a short manifest bootstraps only what it declares', async () => {
  const pool = makePool();
  assert.equal(await checkHistory.bootstrapIfEmpty(pool, 3, tests(4)), 4);
  assert.equal(await checkHistory.bootstrapIfEmpty(pool, 3, []), 0, 'nothing declared, nothing to do');
});

test('a bootstrap failure is non-fatal', async () => {
  // Continuity is worth having, but not worth failing a build over.
  const pool = makePool((text) => (/INSERT/.test(text) ? new Error('deadlock') : null));
  assert.equal(await checkHistory.bootstrapIfEmpty(pool, 3, tests(20)), 0);
});

// ── recordRun ──────────────────────────────────────────────────────────

test('recordRun upserts one row per check and prunes', async () => {
  const pool = makePool();
  const n = await checkHistory.recordRun(pool, 5, [
    { checkKey: 'k0', name: 'a', path: '/a', passed: true },
    { checkKey: 'k1', name: 'b', path: '/b', passed: false },
  ]);
  assert.equal(n, 2);
  const upsert = pool.sql(0);
  assert.match(upsert, /INSERT INTO app_check_history/);
  assert.match(upsert, /ON CONFLICT \(app_id, check_key\) DO UPDATE SET/);
  assert.deepEqual(pool.calls[0].params, [5, 'k0', 'a', '/a', true, 'k1', 'b', '/b', false]);
  assert.match(pool.sql(1), /DELETE FROM app_check_history/, 'stale rows age out');
  assert.equal(pool.calls[1].params[1], checkHistory.PRUNE_AFTER_DAYS);
});

test('the upsert cannot un-graduate a check', async () => {
  // The single most important line in the file. Without COALESCE, a failing
  // run writes NULL over first_passed_at and the check silently stops
  // gating — precisely when it has just proven it was worth having.
  const pool = makePool();
  await checkHistory.recordRun(pool, 5, [{ checkKey: 'k', name: 'a', path: '/a', passed: false }]);
  const sql = pool.sql(0);
  assert.match(sql, /first_passed_at = COALESCE\(h\.first_passed_at, EXCLUDED\.first_passed_at\)/);
  assert.doesNotMatch(sql, /first_passed_at = EXCLUDED\.first_passed_at\b/,
    'a plain assignment here is a demotion bug');
  assert.match(sql, /last_failed_at = COALESCE\(EXCLUDED\.last_failed_at, h\.last_failed_at\)/);
});

test('recordRun is bounded and skips keyless rows', async () => {
  const pool = makePool();
  const many = Array.from({ length: checkHistory.MAX_ROWS_PER_RUN + 25 }, (_, i) => ({
    checkKey: `k${i}`, name: `n${i}`, path: `/p${i}`, passed: true,
  }));
  assert.equal(await checkHistory.recordRun(pool, 5, many), checkHistory.MAX_ROWS_PER_RUN);
  assert.equal(checkHistory.MAX_ROWS_PER_RUN, appManifest.MAX_DECLARED_TESTS,
    'the write ceiling tracks the read ceiling, so a full manifest records in full');

  const pool2 = makePool();
  await checkHistory.recordRun(pool2, 5, [{ name: 'no key', passed: true }]);
  assert.equal(pool2.calls.length, 0, 'a row with no key is not an empty INSERT');
});

test('recordRun does nothing without rows, and survives a write error', async () => {
  const pool = makePool();
  assert.equal(await checkHistory.recordRun(pool, 5, []), 0);
  assert.equal(pool.calls.length, 0);

  const broken = makePool(() => new Error('read-only transaction'));
  assert.equal(
    await checkHistory.recordRun(broken, 5, [{ checkKey: 'k', name: 'a', path: '/a', passed: true }]),
    0,
    'history is bookkeeping; a failed write must not fail the build'
  );
});

test('a rename mints a new key, so the check re-earns its gating', async () => {
  // Deliberate: an edited assertion is a different assertion. Carrying the
  // old gating across a rename would let a rewritten check block a merge on
  // behaviour nobody has ever seen it verify.
  const before = appManifest.checkKey('Board renders', '/board');
  const after = appManifest.checkKey('Board renders rows', '/board');
  assert.notEqual(before, after);
  const graduated = new Set([before]);
  assert.equal(graduated.has(after), false);
});
