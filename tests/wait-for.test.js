'use strict';

// The shared wait helper the Postgres suites use instead of fixed sleeps
// (tests/lib/wait-for.js). No database: it is about what the helper returns,
// and what it says when the event never comes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitFor, within, deferred } = require('./lib/wait-for');

test('waitFor returns the truthy value a sync check produces', async () => {
  let reads = 0;
  const value = await waitFor(() => { reads++; return reads >= 3 && 'the row'; }, { label: 'the row', everyMs: 1 });
  assert.equal(value, 'the row');
  assert.ok(reads >= 3);
});

test('waitFor awaits an async check', async () => {
  let reads = 0;
  const value = await waitFor(async () => { reads++; return reads >= 2; }, { label: 'the notice', everyMs: 1 });
  assert.equal(value, true);
});

test('waitFor fails with its label and detail once the deadline passes', async () => {
  await assert.rejects(
    waitFor(() => false, { label: 'the invite notice', timeoutMs: 50, everyMs: 5, detail: async () => 'left 0 notices' }),
    (err) => err instanceof assert.AssertionError
      && /timed out after 50 ms waiting for the invite notice/.test(err.message)
      && /left 0 notices/.test(err.message),
  );
});

test('waitFor rejects without a label', async () => {
  await assert.rejects(waitFor(() => true), /waitFor needs a label/);
});

test('waitFor does not retry a check that throws', async () => {
  let reads = 0;
  await assert.rejects(
    waitFor(() => { reads++; throw new Error('syntax error at or near'); }, { label: 'the row', everyMs: 1 }),
    /syntax error/,
  );
  assert.equal(reads, 1);
});

test('within resolves in time and rejects late', async () => {
  assert.equal(await within(Promise.resolve('done'), 100, 'the drain'), 'done');
  await assert.rejects(
    within(new Promise(() => {}), 20, 'the drain'),
    (err) => err instanceof assert.AssertionError && /the drain did not settle within 20 ms/.test(err.message),
  );
});

test('deferred resolves to its value', async () => {
  const gate = deferred();
  gate.resolve('entered');
  assert.equal(await gate.promise, 'entered');
});
