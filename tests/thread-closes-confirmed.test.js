'use strict';

// #6225: a change's Votes card lists every request a yes would close, and
// marks the ones whose requester has not agreed. This pins the rule that
// decides "confirmed", without a database (the SQL that resolves each number
// to its request runs against PostgreSQL in thread-one-page-postgres.test.js):
//
//   - the request the change was built for is confirmed, whoever filed it;
//   - a request filed by the change's author is confirmed;
//   - any other request is not;
//   - for a change Homeroom bot built, the person it was built for counts as
//     its author;
//   - a number with no request row is unconfirmed unless it is the built-for
//     one, and shows no title or filer;
//   - the list is ascending and deduplicated.
//
// Run with: node --test tests/thread-closes-confirmed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { closesRequests } = require('../src/services/threads');

const row = (number, extra = {}) => ({ number, title: `Request ${number}`, by: 'someone', filerId: 7, builtFor: false, ...extra });

test('#6225: the request a change was built for is confirmed, whoever filed it', () => {
  assert.deepEqual(closesRequests([row(10, { builtFor: true, filerId: 99 })], 7), [
    { number: 10, title: 'Request 10', by: 'someone', confirmed: true },
  ]);
});

test('#6225: a request filed by the change\'s author is confirmed; anyone else\'s is not', () => {
  const out = closesRequests([row(10, { filerId: 7 }), row(11, { filerId: 8 })], 7);
  assert.equal(out.find((r) => r.number === 10).confirmed, true);
  assert.equal(out.find((r) => r.number === 11).confirmed, false);
});

test('#6225: a change Homeroom bot built is its requester\'s, so that person\'s requests are confirmed', () => {
  // built_for_user_id is the filer of the request it was built from (99).
  const out = closesRequests([row(10, { builtFor: true, filerId: 99 }), row(11, { filerId: 99 }), row(12, { filerId: 8 })], 99);
  assert.equal(out.find((r) => r.number === 10).confirmed, true, 'the built-for request');
  assert.equal(out.find((r) => r.number === 11).confirmed, true, 'another request by the person it was built for');
  assert.equal(out.find((r) => r.number === 12).confirmed, false, 'a third person\'s');
});

test('#6225: a number with no request row shows no title or filer, and is unconfirmed', () => {
  const out = closesRequests([row(10, { title: null, by: null, filerId: null })], 7);
  assert.deepEqual(out, [{ number: 10, title: null, by: null, confirmed: false }]);
  assert.equal(closesRequests([row(10, { title: null, by: null, filerId: null, builtFor: true })], 7)[0].confirmed, true,
    'unless it is the request the change was built for');
});

test('#6225: the list is ascending and without duplicates, and tolerates a null column', () => {
  const out = closesRequests([row(12), row(10), row(11), row(10)], 7);
  assert.deepEqual(out.map((r) => r.number), [10, 11, 12]);
  assert.deepEqual(closesRequests(null, 7), []);
  assert.deepEqual(closesRequests(undefined, 7), []);
  assert.deepEqual(closesRequests([], 7), []);
});

test('#6225: with no author to compare against, only the built-for request is confirmed', () => {
  const out = closesRequests([row(10, { builtFor: true }), row(11, { filerId: 7 })], null);
  assert.equal(out.find((r) => r.number === 10).confirmed, true);
  assert.equal(out.find((r) => r.number === 11).confirmed, false);
});
