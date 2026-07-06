'use strict';

// Delivery guarantees for dev-chat suggestion chips and quick-reply pills
// (the "Build it" button) — the client-side halves of the invariant that
// tests/sse-only-broadcast.test.js asserts server-side.
//
// Background: the turn's events ride three channels (POST SSE, resumable
// GET /events, global WS) sharing one monotonic `_seq` stream with
// client-side dedup. Four gaps let chips/pills/messages get persisted to the
// DB but never reach the open UI until a manual refresh:
//   1. 'suggestions'/'quick_replies' were SSE-only (never on the WS) — fixed
//      server-side, asserted in sse-only-broadcast.test.js.
//   2. _handleResumedEvent had NO 'quick_replies' case, so the resumable
//      channel silently dropped replayed pills.
//   3. handleSessionEvent advanced DevChat._lastSeenSeq from WS deliveries,
//      over-advancing the resumable `?since=` cursor past SSE-only events
//      that were never delivered.
//   4. A 'done' arriving on a fallback channel (WS / resumable) tore down
//      streaming without reconciling the timeline against the DB.
//
// These are source-invariant tests (repo convention for closure-internal
// logic): they extract the relevant function bodies out of the client source
// and assert the wiring, rather than booting a browser.
//
// Run with: node --test tests/quick-replies-delivery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);
const DEVCHAT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);
const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
  'utf8'
);

// Slice a method body out of an object-literal source by its header and the
// header of the next member. Cruder than parsing, but stable: both markers
// are unique definition sites (`name(args) {`), not call sites.
function sliceBetween(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `found ${label} start marker: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `found ${label} end marker: ${endMarker}`);
  return src.slice(start, end);
}

const handleSessionEventBody = sliceBetween(
  APP_SRC, 'handleSessionEvent(data) {', 'handleAppUpdate(data)', 'App.handleSessionEvent'
);
const handleResumedEventBody = sliceBetween(
  DEVCHAT_SRC, '_handleResumedEvent(data, sessionId) {', '_handleSpecUpdated(data) {', 'DevChat._handleResumedEvent'
);

test('resumable channel handles quick_replies (was silently dropped)', () => {
  assert.match(handleResumedEventBody, /case 'quick_replies':/,
    "_handleResumedEvent must have a case 'quick_replies' — without it a Build-it pill replayed over GET /events is dropped until refresh");
  assert.match(handleResumedEventBody, /case 'suggestions':/,
    "_handleResumedEvent keeps its case 'suggestions'");
});

test('WS handler covers suggestions and quick_replies (#437 rule)', () => {
  assert.match(handleSessionEventBody, /case 'suggestions':/,
    "handleSessionEvent must handle 'suggestions' — it is broadcast on the WS now, and an unhandled broadcast type marks its seq seen and swallows the SSE copy");
  assert.match(handleSessionEventBody, /case 'quick_replies':/,
    "handleSessionEvent must handle 'quick_replies' for the same reason");
});

test('every WS-broadcast type emitted by send() has a handleSessionEvent case (#437, set-difference)', () => {
  // The interactive turn's send() broadcasts every type NOT in SSE_ONLY;
  // the headless send() broadcasts everything it emits. Any broadcast type
  // without a client case gets its _seq marked seen and the matching
  // SSE/bus delivery deduped-and-swallowed — the "persisted but invisible
  // until refresh" failure mode. Assert the difference is empty so the next
  // added event type can't regress silently.
  const sseOnlyMatch = SESSIONS_SRC.match(/const\s+SSE_ONLY\s*=\s*new\s+Set\(\s*(\[[^\]]*\])\s*\)/);
  assert.ok(sseOnlyMatch, 'found the SSE_ONLY literal in sessions.js');
  // eslint-disable-next-line no-eval
  const sseOnly = new Set(eval(sseOnlyMatch[1]));

  const emitted = new Set();
  for (const m of SESSIONS_SRC.matchAll(/send\('([a-z_]+)'/g)) emitted.add(m[1]);

  // headless_update is headless-only and deliberately has no dev-chat
  // handler on ANY channel (nothing else delivers it, so the seq-swallow
  // hazard doesn't apply); checks_ready is handled before the switch.
  const exceptions = new Set(['headless_update']);

  const unhandled = [...emitted].filter((t) =>
    !sseOnly.has(t)
    && !exceptions.has(t)
    && !handleSessionEventBody.includes(`case '${t}':`));
  assert.deepEqual(unhandled, [],
    `WS-broadcast event types missing a handleSessionEvent case: ${unhandled.join(', ')}`);
});

test('handleSessionEvent no longer advances the resumable cursor from WS deliveries', () => {
  // _lastSeenSeq seeds GET /events `?since=`. WS and SSE-only events share
  // one seq stream, so a WS delivery moving the cursor makes the replay skip
  // SSE-only events (chips, pills, tokens) that never arrived. Dedup still
  // uses _seenSeqs; only the SSE channels may move the cursor.
  assert.doesNotMatch(handleSessionEventBody, /DevChat\._lastSeenSeq\s*=/,
    'handleSessionEvent must not assign DevChat._lastSeenSeq');
  assert.match(handleSessionEventBody, /_seenSeqs\.add\(data\._seq\)/,
    'the _seenSeqs dedup itself must stay');
});

test("fallback-channel 'done' reconciles the timeline from the server", () => {
  // A done arriving on the WS or resumable channel means the primary POST
  // SSE never finished — reload the session so anything that rode only the
  // dead stream shows without a manual refresh (#446).
  assert.match(handleSessionEventBody, /case 'done':[\s\S]*?_reconcileAfterFallbackDone\(/,
    "WS 'done' case calls _reconcileAfterFallbackDone");
  assert.match(handleResumedEventBody, /case 'done':[\s\S]*?_reconcileAfterFallbackDone\(/,
    "resumable 'done' case calls _reconcileAfterFallbackDone");
  const helper = sliceBetween(
    DEVCHAT_SRC,
    'async _reconcileAfterFallbackDone(sessionId) {',
    '_openResumableStream(sessionId) {',
    'DevChat._reconcileAfterFallbackDone'
  );
  assert.match(helper, /openSession\(/,
    'the reconcile helper reloads the session from the server');
  assert.match(helper, /isStreaming/,
    'the reconcile helper must bail when a newer turn is already streaming');
});
