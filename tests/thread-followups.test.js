'use strict';

// #6264: what the bot promises and what it says when the promise comes due,
// as pure text. The full flow (stored, fired once, called off) is pinned
// against a real database in thread-followups-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EVENTS, promiseFor, lineFor, closedLine, nameOf } = require('../src/services/thread-followups');

test('a promise exists for every moment, and says it will tell them here', () => {
  assert.deepEqual([...EVENTS], ['update', 'checks', 'vote', 'merged', 'live']);
  for (const event of EVENTS) {
    const promise = promiseFor(event);
    assert.ok(promise, `${event} has a promise`);
    assert.match(promise, /^I'll tell you here when /, `${event}: ${promise}`);
  }
  assert.equal(promiseFor('update'), "I'll tell you here when it's in.");
  assert.equal(promiseFor('vote'), "I'll tell you here when it's ready to vote.");
  assert.equal(promiseFor('nonsense'), null);
});

test('the line names the person and the change', () => {
  const base = { changeName: 'PR 6249', username: 'evan' };
  assert.equal(lineFor({ ...base, event: 'update' }), '@evan, the update to PR 6249 is in, and its checks are running.');
  assert.equal(lineFor({ ...base, event: 'vote' }), '@evan, PR 6249 is ready to vote on.');
  assert.equal(lineFor({ ...base, event: 'merged' }), '@evan, PR 6249 was approved and merged. It goes live next.');
  assert.equal(lineFor({ ...base, event: 'live' }), '@evan, PR 6249 is live.');
  assert.equal(lineFor({ ...base, event: 'checks', verdict: 'passing' }),
    '@evan, the checks on PR 6249 have finished: they all passed.');
  assert.equal(lineFor({ ...base, event: 'checks', verdict: 'skipped' }),
    '@evan, the checks on PR 6249 have finished: they all passed.');
  assert.equal(lineFor({ ...base, event: 'checks', verdict: 'failing' }),
    '@evan, the checks on PR 6249 have finished: some failed.');
  assert.equal(closedLine(base), "@evan, PR 6249 was closed, so there's nothing more to tell you about it.");
});

test('a GitHub repository says PR, any other says change, and no line has an em dash', () => {
  const row = { id: 6249, pr_number: 6249 };
  assert.equal(nameOf(row, 'https://github.com/acme/clubs'), 'PR 6249');
  assert.equal(nameOf(row, 'https://git.usernode.dev/acme/clubs'), 'change 6249');
  const texts = [
    ...EVENTS.map((event) => lineFor({ event, verdict: 'failing', changeName: 'PR 6249', username: 'evan' })),
    closedLine({ changeName: 'change 6249', username: 'evan' }),
    ...EVENTS.map((event) => promiseFor(event)),
  ];
  for (const text of texts) {
    assert.ok(!text.includes('—') && !text.includes('–'), `no em dash in: ${text}`);
  }
});
