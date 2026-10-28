'use strict';

// waitlistOptions() (frontend/src/features/auth/waitlist-shared.tsx) is one
// fetch shared by the page: the landing's sign-in providers and terms link,
// the waiting room's countries and "How did you find us?" choices. It used
// to keep a failure for the document's whole life, so one failed read
// emptied every later reader until a reload. 28 Oct 2026: someone signed up
// from an invite link and reached a waiting room with no country to pick,
// because the read had been cut off by a session boundary at boot (#5931).
//
// Run with: node --test tests/waitlist-options-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/features/auth/waitlist-shared.tsx';
const OPTIONS = { countries: { NL: 'Netherlands' }, discovery_sources: { friend: 'A friend' } };
const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const fenced = () => Promise.reject(new DOMException('Session changed', 'AbortError'));

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

/** The page's fetch, answering in turn; every read after the list succeeds. */
function answering(answers) {
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(url);
    const next = answers.shift();
    return next ? next() : ok(OPTIONS);
  };
  return calls;
}

test('a read that failed is not kept: the next reader asks again', async () => {
  for (const failure of [
    () => Promise.reject(new TypeError('Failed to fetch')),
    () => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Too many requests' }) }),
    () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('Unexpected token')) }),
  ]) {
    const { waitlistOptions } = loadTsx(ENTRY);
    const calls = answering([failure]);
    assert.equal(await waitlistOptions(), null, 'the failed read still answers null');
    assert.deepEqual(await waitlistOptions(), OPTIONS, 'a later reader gets the options');
    assert.equal(calls.length, 2);
  }
});

test('a read cut off by a session boundary is read once more', async () => {
  const { waitlistOptions } = loadTsx(ENTRY);
  const calls = answering([fenced]);
  assert.deepEqual(await waitlistOptions(), OPTIONS);
  assert.equal(calls.length, 2);

  const again = loadTsx(ENTRY);
  const twice = answering([fenced, fenced]);
  assert.equal(await again.waitlistOptions(), null, 'only once more, then it gives up');
  assert.equal(twice.length, 2);
});

test('a read that worked is made once and shared by every reader', async () => {
  const { waitlistOptions } = loadTsx(ENTRY);
  const calls = answering([]);
  const [first, second] = await Promise.all([waitlistOptions(), waitlistOptions()]);
  assert.deepEqual(first, OPTIONS);
  assert.equal(first, second);
  assert.equal(await waitlistOptions(), first);
  assert.deepEqual(calls, ['/api/public/waitlist/options']);
});
