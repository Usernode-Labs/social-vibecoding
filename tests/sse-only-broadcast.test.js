'use strict';

// #394: the dev-chat turn's `send()` helper broadcasts an event on the global
// WebSocket only when its type is NOT in the SSE_ONLY set
// (`if (!SSE_ONLY.has(type)) broadcastGlobal(...)`). The Mayor's post-spec
// wrap-up summary is a `mayor_reasoning` event; it must be broadcast on the WS
// so it survives a dropped POST SSE (the global-WS `done` otherwise races
// ahead and tears down streaming before the resumable stream can replay it,
// and the summary only shows after a refresh).
//
// SSE_ONLY and send() are closures inside the route handler, so rather than
// spin up the whole streaming route we evaluate the EXACT SSE_ONLY literal out
// of the source and assert the broadcast guard is still wired the way this
// invariant assumes.
//
// Run with: node --test tests/sse-only-broadcast.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
  'utf8'
);

function extractSseOnly() {
  const m = SRC.match(/const\s+SSE_ONLY\s*=\s*new\s+Set\(\s*(\[[^\]]*\])\s*\)/);
  assert.ok(m, 'found the SSE_ONLY = new Set([...]) literal');
  // The array literal is a plain list of string literals — eval it in a
  // bare context so the test reflects the real source verbatim.
  // eslint-disable-next-line no-eval
  return new Set(eval(m[1]));
}

test('mayor_reasoning is NOT SSE-only, so send() broadcasts it on the global WS', () => {
  const sseOnly = extractSseOnly();
  assert.equal(sseOnly.has('mayor_reasoning'), false,
    'mayor_reasoning must be broadcast on the global WS (not SSE-only) — #394');
});

test('high-frequency token streaming stays SSE-only', () => {
  const sseOnly = extractSseOnly();
  assert.equal(sseOnly.has('token'), true,
    'token stays SSE-only — it is recovered by the full-text mayor_reasoning event');
});

test('suggestions / quick_replies / usage / error remain SSE-only', () => {
  const sseOnly = extractSseOnly();
  for (const t of ['suggestions', 'quick_replies', 'usage', 'error']) {
    assert.equal(sseOnly.has(t), true, `${t} stays SSE-only`);
  }
});

test('send() broadcasts on the global WS exactly when the type is not SSE-only', () => {
  // Guards that the routing mechanism this invariant depends on is intact:
  // the SSE_ONLY membership check is what gates broadcastGlobal.
  assert.match(
    SRC,
    /if\s*\(\s*!SSE_ONLY\.has\(type\)\s*\)\s*\{\s*\n\s*broadcastGlobal\(/,
    'send() still gates broadcastGlobal on !SSE_ONLY.has(type)'
  );
});
