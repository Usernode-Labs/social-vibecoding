// Regression guard for the setChecksPending "inconsistent types deduced
// for parameter $2" bug (session 2258 investigation, 2026-07-14).
//
// The UPDATE splices $2 into both an assignment to checks_commit_sha
// (varchar) and IS DISTINCT FROM comparisons (where postgres infers
// text). Without an explicit cast on EVERY occurrence, postgres refuses
// to prepare the statement — "inconsistent types deduced for parameter
// $2: text versus character varying" — and because every call site
// .catch'es this as non-fatal, the pending stamp silently never landed:
// stale 'passing'/'error' verdicts survived into the merge gate while a
// rebuild was in flight, and the failure-streak bookkeeping never reset
// on new commits.
//
// We can't run a real postgres PREPARE in the unit suite, so this pins
// the property that triggers the planner error: every `$2` reference in
// the emitted SQL must carry the same explicit ::text cast.
//
// Run with: node --test tests/set-checks-pending.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const visuals = require('../src/services/visuals');

test('setChecksPending: every $2 occurrence is explicitly cast (uniform type for the planner)', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.setChecksPending(pool, 42, 'abc123');

  assert.equal(queries.length, 1);
  const { sql, params } = queries[0];

  const occurrences = sql.match(/\$2(::\w+)?/g) || [];
  assert.ok(occurrences.length >= 5, `expected $2 in assignment + 4 CASE clauses, saw ${occurrences.length}`);
  const uncast = occurrences.filter((o) => o === '$2');
  assert.deepEqual(uncast, [],
    'every $2 must carry an explicit cast — a bare $2 next to checks_commit_sha (varchar) ' +
    'plus a text-inferred comparison makes postgres refuse to prepare the statement');
  assert.ok(occurrences.every((o) => o === occurrences[0]),
    `all $2 casts must agree, saw: ${[...new Set(occurrences)].join(', ')}`);

  // $3 (check_phase) is subject to the same planner hazard and carries the
  // same explicit cast; assert it too so a future edit can't reintroduce the
  // bug through the newer parameter.
  const p3 = sql.match(/\$3(::\w+)?/g) || [];
  assert.ok(p3.length >= 1, 'check_phase parameter is present');
  assert.deepEqual(p3.filter((o) => o === '$3'), [],
    'every $3 must carry an explicit cast, for the same reason as $2');

  assert.deepEqual(params, [42, 'abc123', null]);
  assert.match(sql, /check_state = 'pending'/);
});

test('setChecksPending: null commit sha still passes a typed parameter', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.setChecksPending(pool, 42, null);
  assert.deepEqual(queries[0].params, [42, null, null]);
});

// ── check_phase: which half of the run the card should name ─────────────

test('setChecksPending records the run phase, and the streak CASE arms are untouched by it', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.setChecksPending(pool, 42, 'abc123', 'building');
  assert.deepEqual(queries[0].params, [42, 'abc123', 'building']);

  await visuals.setChecksPending(pool, 42, 'abc123', 'testing');
  assert.deepEqual(queries[1].params, [42, 'abc123', 'testing']);

  // The phase is a PLAIN assignment, not another commit-conditional CASE
  // arm: it describes the run happening right now, so a backoff retry of the
  // same commit must still move it from 'building' to 'testing'. The four
  // streak-resetting CASE arms must remain exactly four.
  const { sql } = queries[0];
  assert.match(sql, /check_phase = \$3::text/);
  assert.equal((sql.match(/CASE WHEN checks_commit_sha IS DISTINCT FROM/g) || []).length, 4,
    'the commit-changed CASE arms are unchanged — the phase is not one of them');
});

test('setChecksPending stores an unrecognised or absent phase as NULL', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  // A typo or a value from a newer writer must not reach the card, which
  // would render an unknown caption; NULL is the legacy-wording fallback.
  for (const bad of [undefined, null, '', 'BUILDING', 'cloning', 42, {}]) {
    queries.length = 0;
    await visuals.setChecksPending(pool, 42, 'abc123', bad);
    assert.equal(queries[0].params[2], null, `phase ${JSON.stringify(bad)} → NULL`);
  }
});

test('a terminal verdict clears the phase so a settled card never shows a stage', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.storeChecks(pool, 42, 'abc123', { state: 'passing', results: [] });
  assert.match(queries[0].sql, /check_phase = NULL/);

  queries.length = 0;
  await visuals.storeChecks(pool, 42, 'abc123', { state: 'error', results: [] }, 'boom');
  assert.match(queries[0].sql, /check_phase = NULL/);

  queries.length = 0;
  await visuals.storeChecksSkipped(pool, 42, 'abc123', 'nothing to test');
  assert.match(queries[0].sql, /check_phase = NULL/);
});
