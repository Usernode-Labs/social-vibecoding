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

  assert.deepEqual(params, [42, 'abc123']);
  assert.match(sql, /check_state = 'pending'/);
});

test('setChecksPending: null commit sha still passes a typed parameter', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };

  await visuals.setChecksPending(pool, 42, null);
  assert.deepEqual(queries[0].params, [42, null]);
});
