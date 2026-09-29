'use strict';

// #2513: the LLM spend cap was defeatable by concurrency, and removed
// entirely by a database error.
//
// Both defects lived in a block that was COPIED into
// routes/app-llm-proxy.js and routes/anthropic-proxy.js — which is why one
// could be fixed and the other left behind. services/spend-cache.js is now
// the single copy, and this file tests it directly.
//
// THIS CHANGE FIXES ONE OF THE TWO, and is explicit about which.
//
// FIXED — the fail-open. Every refresher installed
// `totalAtCheckpointCents: 0` in its catch block, "no spend today", and
// cached it for the full TTL. A Postgres blip removed the cap rather than the
// traffic. It now fails CLOSED.
//
// NOT FIXED — the race. `liveDeltaCents` is incremented at SETTLEMENT, so
// concurrent requests in one cache window still read the same pre-spend
// snapshot. A reservation scheme was built for it and withdrawn before
// shipping; the first test below pins that the source says so, and what
// closing it properly requires.
//
// Run with: node --test tests/spend-cache.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const spendCache = require('../src/services/spend-cache');
const {
  readSpend, unavailable, spendTotal, isUnavailable, settle,
  CACHE_TTL_MS, RETRY_AFTER_ERROR_MS,
} = spendCache;

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── The concurrency race is NOT fixed here, and says so ────────────────
//
// A reservation scheme was built for it and withdrawn before shipping:
// review showed it was not sound admission control — not atomic with the
// gate, not surviving a cache refresh, released before the settlement writes,
// and sized at a flat cent that does not bound a real call. Half an admission
// control on a money path is worse than none, because it reads like a guard.
//
// This test pins the module's honesty rather than a behaviour: the race is
// named in the source as unfixed, with what closing it requires.
test('the module states the race is unfixed and what closing it needs', () => {
  const src = read('src/services/spend-cache.js');
  assert.match(src, /NOT FIXED HERE: the concurrency race/);
  for (const requirement of [/ATOMICALLY with the gate/, /SIZED to bound a real call/,
    /SURVIVE a refresh/, /anthropic-proxy\.js/]) {
    assert.match(src, requirement, `the follow-up needs ${requirement} recorded`);
  }
});

test('spendTotal is checkpoint + settled, with no phantom reservation', () => {
  assert.equal(spendTotal({ totalAtCheckpointCents: 10, liveDeltaCents: 2.5 }), 12.5);
  settleCheck();
});

function settleCheck() {
  const entry = { totalAtCheckpointCents: 10, liveDeltaCents: 0 };
  settle(entry, 0.4);
  settle(entry, 0);        // a zero-cost call changes nothing
  settle(entry, -1);       // and a nonsense one cannot credit headroom back
  assert.equal(entry.liveDeltaCents, 0.4);
}

// ── DEFECT 2: the database error ───────────────────────────────────────

test('a read that throws with NOTHING known refuses', async () => {
  const entry = await readSpend({
    previous: undefined,
    load: async () => { throw new Error('db down'); },
  });
  assert.equal(isUnavailable(entry), true);
  assert.equal(spendTotal(entry), Number.POSITIVE_INFINITY,
    'every `spend >= cap` comparison must refuse');
  assert.ok(spendTotal(entry) >= 1, 'and refuse at any cap, however large');
});

test('a read that throws KEEPS the last real figure rather than inventing zero', async () => {
  const previous = {
    totalAtCheckpointCents: 80, fetchedAt: Date.now() - CACHE_TTL_MS - 1,
    liveDeltaCents: 5,
  };
  const entry = await readSpend({
    previous,
    load: async () => { throw new Error('db down'); },
  });
  assert.equal(entry.totalAtCheckpointCents, 80, 'not 0 — that was the bug');
  assert.equal(entry.liveDeltaCents, 5, 'and what settled against it survives');
  assert.equal(spendTotal(entry), 85);
});

test('after an error the next call retries soon, not a full TTL later', async () => {
  const now = Date.now();
  const entry = await readSpend({
    previous: undefined, now,
    load: async () => { throw new Error('db down'); },
  });
  const heldFor = CACHE_TTL_MS - (now - entry.fetchedAt);
  assert.ok(heldFor <= RETRY_AFTER_ERROR_MS,
    `a failed read must not be cached for a full window (held ${heldFor}ms)`);
  assert.ok(heldFor > 0, 'but it must not spin on every request either');
});

test('a healthy read is cached for the full TTL and reports real numbers', async () => {
  const now = Date.now();
  let loads = 0;
  const first = await readSpend({ previous: undefined, now, load: async () => { loads++; return 42; } });
  assert.equal(first.totalAtCheckpointCents, 42);
  assert.equal(isUnavailable(first), false);
  const second = await readSpend({ previous: first, now: now + 1000, load: async () => { loads++; return 99; } });
  assert.equal(second, first, 'still fresh, so no second query');
  assert.equal(loads, 1);
  const third = await readSpend({
    previous: first, now: now + CACHE_TTL_MS + 1, load: async () => { loads++; return 99; },
  });
  assert.equal(third.totalAtCheckpointCents, 99, 'and it does re-read once stale');
  assert.equal(loads, 2);
});

test('unavailable() is the same posture for the hand-written catch blocks', () => {
  // routes/anthropic-proxy.js has four refreshers with different queries and
  // log context, so they keep their own try/catch and call this instead.
  assert.equal(spendTotal(unavailable(undefined)), Number.POSITIVE_INFINITY);
  const kept = unavailable({
    totalAtCheckpointCents: 12, liveDeltaCents: 3, fetchedAt: 0,
  });
  assert.equal(kept.totalAtCheckpointCents, 12, 'a real previous figure is kept');
  assert.equal(kept.liveDeltaCents, 3);
  // An unavailable previous must not be laundered into a real reading.
  const stillUnknown = unavailable({
    totalAtCheckpointCents: Number.POSITIVE_INFINITY, liveDeltaCents: 0, fetchedAt: 0,
  });
  assert.equal(spendTotal(stillUnknown), Number.POSITIVE_INFINITY);
});

test('spendTotal on a missing entry refuses rather than reading as zero', () => {
  assert.equal(spendTotal(undefined), Number.POSITIVE_INFINITY);
  assert.equal(spendTotal(null), Number.POSITIVE_INFINITY);
});

// ── Both proxies actually use it ───────────────────────────────────────

test('neither proxy still installs zero on a failed read', () => {
  for (const file of ['src/routes/app-llm-proxy.js', 'src/routes/anthropic-proxy.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /failing open/,
      `${file} still describes itself as failing open`);
    assert.doesNotMatch(src, /totalAtCheckpointCents: 0, fetchedAt: now/,
      `${file} still installs "no spend today" on a database error`);
    assert.match(src, /require\('\.\.\/services\/spend-cache'\)/,
      `${file} must use the shared cache`);
  }
});



// The regression I nearly shipped with the pre-forward refusal: `null` means
// "this cap does not apply" (BYOK has no user budget; no weekly cap means no
// weekly snapshot), and refusing those would have broken every BYOK call.
test('a null snapshot means the cap does not apply, not that it is unreadable', () => {
  const src = read('src/routes/app-llm-proxy.js');
  assert.match(src, /const snapshotMissing = \(e\) => e != null && spendCache\.isUnavailable\(e\)/,
    'null must be distinguished from unavailable at the refusal');
});

test('an unavailable snapshot refuses BEFORE forwarding', () => {
  const src = read('src/routes/app-llm-proxy.js');
  const refusal = src.indexOf("code: 'budget_unavailable'");
  const forward = src.indexOf('anthropicStream.forwardCall');
  assert.ok(refusal > 0 && refusal < forward,
    'an unwatched call must not be sent upstream and killed mid-stream — it '
    + 'has already been paid for by the time that shows');
});

// Review's last two findings. The fail-closed sentinel means "we cannot
// tell", and arithmetic alone reads it as "at cap" — which is a DIFFERENT
// thing with worse consequences on each path.
test('an unreadable ledger refuses before the BYOK switch, not after', () => {
  const src = read('src/routes/anthropic-proxy.js');
  const refusal = src.indexOf("code: 'budget_unavailable',");
  const byok = src.indexOf('limits.loadUserApiKey');
  assert.ok(refusal > 0 && refusal < byok,
    'read as "over cap", an outage would switch a user onto their OWN key and '
    + 'bill them for a Postgres blip');
});

test('an unreadable GLOBAL ledger refuses rather than resolving to "not over"', () => {
  const src = read('src/routes/anthropic-proxy.js');
  assert.match(src, /isUnavailable\(globalSpend\)/,
    'otherwise a keyless caller spends the platform key during an outage');
});

test('an unreadable app ledger is not dressed up as an exhausted cap', () => {
  const src = read('src/routes/app-llm-proxy.js');
  // The trailing comma picks the real object literals, not the prose in the
  // file header that names both codes.
  const refusal = src.indexOf("code: 'budget_unavailable',");
  const capGate = src.indexOf("code: 'app_cap_exceeded',");
  // The setHeader CALL, not the comment above it that names the header.
  const header = src.indexOf("res.setHeader('x-usernode-llm-spent-cents'");
  assert.ok(refusal > 0 && refusal < capGate,
    'a transient outage must not tell the user to wait until midnight');
  assert.ok(refusal < header,
    'and must not reach the spend header, where Infinity serialises as 0');
});

test('every refusal on an unreadable ledger uses one retryable code', () => {
  for (const file of ['src/routes/app-llm-proxy.js', 'src/routes/anthropic-proxy.js']) {
    const src = read(file);
    assert.match(src, /code: 'budget_unavailable'/, `${file} needs the retryable code`);
    assert.match(src, /briefly unavailable\. Try again in a moment\./,
      `${file} should tell the caller it is transient`);
  }
});
