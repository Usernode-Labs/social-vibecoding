'use strict';

// Earned gating, at a bar worth clearing.
//
// A declared check used to graduate from ADVISORY to permanently BLOCKING
// the first time it was observed passing, and there is no demotion. So a
// check that is flaky from birth graduated on its first lucky run and
// gated every proposal afterwards — which is how several checks that fail
// intermittently came to redden this app's own merges.
//
// Ten consecutive passes is not proof a check is deterministic: ten clean
// observations put the 95% upper bound on its failure rate near 3/10, not
// at zero. What it buys is (a) a 1-in-20 flake clears it about 60% of the
// time per window instead of 95%, and (b) the ten come from ten different
// builds, which is the decorrelation ten repeats in one container cannot
// give. The flake chip covers what the bar still lets through.
//
// Run with: node --test tests/check-graduation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const checkHistory = require('../src/services/check-history');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** A pool that records statements and answers the graduated-set read. */
function fakePool(rows = []) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (/SELECT check_key FROM app_check_history/.test(sql)) return { rows };
      if (/SELECT check_key, pass_count, fail_count/.test(sql)) return { rows };
      if (/SELECT 1 FROM app_check_history/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('graduation reads a run of passes, not a single lucky one', async () => {
  const pool = fakePool([{ check_key: 'aa' }]);
  const out = await checkHistory.loadGraduated(pool, 7);
  assert.deepEqual([...out], ['aa']);
  const q = pool.seen.find((s) => /SELECT check_key FROM/.test(s.sql));
  assert.match(q.sql, /consecutive_passes/, 'the predicate is the run, not first_passed_at');
  assert.doesNotMatch(q.sql, /first_passed_at IS NOT NULL/,
    'one observed pass is no longer the bar');
  assert.deepEqual(q.params, [7, checkHistory.GRADUATION_PASSES]);
  assert.equal(checkHistory.GRADUATION_PASSES, 10);
});

test('a failure resets the run, and nothing else about the row', async () => {
  const pool = fakePool();
  await checkHistory.recordRun(pool, 7, [{ checkKey: 'aa', name: 'n', path: '/', passed: true }]);
  const ins = pool.seen.find((s) => /INSERT INTO app_check_history AS h/.test(s.sql));
  assert.match(ins.sql, /consecutive_passes = CASE WHEN EXCLUDED\.consecutive_passes > 0/,
    'extend the run on a pass');
  assert.match(ins.sql, /ELSE 0 END/, 'and start it again from nothing on a failure');
  // The no-demotion rule is untouched: first_passed_at still only ever
  // records the first pass, and a failure never clears it.
  assert.match(ins.sql, /first_passed_at = COALESCE\(h\.first_passed_at, EXCLUDED\.first_passed_at\)/);
});

test('the legacy-head bootstrap grandfathers straight to the threshold', async () => {
  const pool = fakePool();
  await checkHistory.bootstrapIfEmpty(pool, 7, [{ name: 'a', path: '/' }, { name: 'b', path: '/x' }]);
  const ins = pool.seen.find((s) => /INSERT INTO app_check_history\s*$|INSERT INTO app_check_history\n/.test(s.sql));
  assert.ok(ins, 'the bootstrap wrote');
  assert.match(ins.sql, /consecutive_passes/);
  assert.match(ins.sql, new RegExp(`, ${checkHistory.GRADUATION_PASSES}\\)`),
    'it reproduces build zero\'s gating set, so it must gate immediately');
});

test('raising the bar demotes nothing that is gating today', () => {
  // The backfill is a one-time migration living in an idempotently applied
  // schema, which is the trap: a DEFAULT would re-run every boot and
  // re-graduate any check whose counter a failure had just reset.
  const sql = read('src/db/schema.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS consecutive_passes INTEGER;/,
    'nullable, and with no default, so "unset" is distinguishable');
  assert.match(sql, /SET consecutive_passes = 10\s*\n\s*WHERE consecutive_passes IS NULL AND first_passed_at IS NOT NULL;/,
    'anything already graduated keeps gating');
  assert.match(sql, /SET consecutive_passes = 0 WHERE consecutive_passes IS NULL;/,
    'and everything else starts its run at zero, so the second boot is a no-op');
});

test('a flake rate is withheld until there is enough of it to mean anything', async () => {
  const pool = {
    async query(sql) {
      if (/SELECT check_key, pass_count, fail_count/.test(sql)) {
        return {
          rows: [
            { check_key: 'thin', pass_count: 2, fail_count: 1 },
            { check_key: 'flaky', pass_count: 40, fail_count: 8 },
            { check_key: 'bad', pass_count: 1, fail_count: 9 },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const m = await checkHistory.loadFlakeRates(pool, 7);
  assert.equal(m.get('thin').rate, null, '3 observations cannot tell 33% from bad luck');
  assert.equal(m.get('flaky').rate, 8 / 48);
  assert.equal(m.get('bad').rate, 0.9);
  assert.equal(checkHistory.MIN_OBSERVATIONS, 5);
});

test('the chip prints a rate worth printing, and nothing else', () => {
  const sandbox = {
    console, relTime: () => 'just now', App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach() {} }), addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} }, hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n`
    + `${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  assert.equal(AppView._flakePercent(null), null, 'never failed');
  assert.equal(AppView._flakePercent(0.02), null, 'below the floor is not worth a chip on every row');
  assert.equal(AppView._flakePercent(8 / 48), 17);
  assert.equal(AppView._flakePercent(0.9), 90);

  // It rides on PASSING rows too: a check that passes today and failed four
  // times last week is exactly the one worth knowing about, and a chip that
  // only ever appeared beside a red row could never say so.
  const v = AppView._checksVerdictView({
    check_state: 'passing',
    test_results: [{ name: 'Feed renders', path: '/feed', status: 'pass', flakeRate: 0.2 }],
  });
  assert.equal(v.passes[0].flaky, 20);
  assert.equal(v.passes[0].pass, true);
});
