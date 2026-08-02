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

// ── #786: restart-recovery pills ride the `status` event, and the pill
// resolution reads them off a `system` breadcrumb ────────────────────────
//
// After a restart the coding work is recovered but the Mayor's phase-2
// wrap-up (the only thing that carries pills on a dispatch turn) never
// runs, so the recovery paths persist their pills on the recovery
// breadcrumb — a `system` row. Two wiring invariants follow: the three
// parallel status handlers must carry the field onto the pushed row, and
// _currentQuickReplies must be willing to read pills off a system row.

// Extract _currentQuickReplies and evaluate it for real against fake
// message timelines — the resolution rule is subtle enough (skip pill-less
// system rows, stop at the first user/assistant row) that regex assertions
// wouldn't catch a wrong stopping condition.
function loadCurrentQuickReplies() {
  const src = sliceBetween(
    DEVCHAT_SRC, '_currentQuickReplies() {', '_renderQuickReplies() {',
    'DevChat._currentQuickReplies'
  );
  const body = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}'));
  // eslint-disable-next-line no-new-func
  const compiled = new Function('DevChat', body);
  return (messages, opts = {}) => compiled({
    currentSession: opts.session === undefined ? { id: 1, status: 'active' } : opts.session,
    isStreaming: !!opts.isStreaming,
    messages,
    STARTER_QUICK_REPLIES: ['Change the colors', 'Add a new feature', "Fix something that's broken"],
  });
}

const currentQuickReplies = loadCurrentQuickReplies();

test('#786 pills resolve from a system recovery breadcrumb', () => {
  const pills = ['Try that again', "What's the current state?"];
  const out = currentQuickReplies([
    { role: 'user', content: 'Sort by score' },
    { role: 'assistant', content: "I'll have the agent do that." },
    { role: 'system', content: 'Claude Code is running...' },
    // A turn that couldn't be resumed has no Mayor reply to hang pills on,
    // so its breadcrumb is still the pill source (#786).
    { role: 'system', content: "That coding turn didn't finish — please send your request again.", quickReplies: pills },
  ]);
  assert.deepEqual(out, pills,
    'a recovery breadcrumb must be able to supply the pill bar — otherwise a restart leaves it empty forever');
});

// #896: a recovered BUILD turn now ends on a real Mayor wrap-up, so its
// pills ride an ordinary assistant row — the same source a live turn uses
// — with the ordinary card labels above it.
test('#896 a recovered build turn resolves its pills from the wrap-up assistant row', () => {
  const pills = ['Propose it to the group', 'Make a tweak', 'What did it change?'];
  const out = currentQuickReplies([
    { role: 'user', content: 'Sort by score' },
    { role: 'assistant', content: "I'll have the agent do that." },
    { role: 'system', content: 'Claude Code is running...' },
    { role: 'system', content: 'Claude Code finished' },
    { role: 'system', content: 'PR #12 created' },
    { role: 'system', content: 'Staging deployed!' },
    { role: 'assistant', content: 'Sorted the leaderboard by score.', quickReplies: pills },
  ]);
  assert.deepEqual(out, pills);
});

test('#786 pill-less system rows are skipped, not treated as a stop', () => {
  const pills = ['Build it', 'Revise the spec'];
  const out = currentQuickReplies([
    { role: 'user', content: 'Plan it' },
    { role: 'assistant', content: 'Scouting.' },
    { role: 'system', content: 'Scout drafted a 40-line spec from the codebase.', quickReplies: pills },
    // A later staging heal lands ABOVE the pill-carrying breadcrumb.
    { role: 'system', content: 'Staging preview rebuilt' },
  ]);
  assert.deepEqual(out, pills);
});

test('#786 a sent user row still clears the bar', () => {
  const out = currentQuickReplies([
    { role: 'assistant', content: 'Sorted the leaderboard by score.', quickReplies: ['Make a tweak'] },
    { role: 'user', content: 'Actually, change the header' },
  ]);
  assert.equal(out, null, 'pills must clear the moment the user sends');
});

test('#786 a user row plus its "Thinking..." status still clears the bar', () => {
  // The in-flight shape: the status row carries no pills, and the scan must
  // stop at the user row rather than walking back to an older turn's pills.
  const out = currentQuickReplies([
    { role: 'assistant', content: 'Done.', quickReplies: ['Make a tweak'] },
    { role: 'user', content: 'Now make it blue' },
    { role: 'system', content: 'Thinking about your request...' },
  ]);
  assert.equal(out, null);
});

test('#786 stale pills from an earlier turn are never resurrected', () => {
  const out = currentQuickReplies([
    { role: 'assistant', content: 'Built it.', quickReplies: ['Propose it to the group'] },
    { role: 'user', content: 'And a dark mode?' },
    { role: 'system', content: 'Thinking about your request...' },
    // Newest assistant reply carries no pills → empty bar, NOT the older set.
    { role: 'assistant', content: 'Here is what I found.' },
  ]);
  assert.equal(out, null);
});

test('#786 an assistant reply with pills still wins (unchanged behaviour)', () => {
  const out = currentQuickReplies([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello', quickReplies: ['Add a new feature'] },
  ]);
  assert.deepEqual(out, ['Add a new feature']);
});

test('#786 starters, streaming and non-interactive gates are unchanged', () => {
  // Fresh session (nothing but a status row, or nothing at all) → starters.
  assert.deepEqual(currentQuickReplies([]).length, 3);
  assert.deepEqual(currentQuickReplies([{ role: 'system', content: 'Thinking about your request...' }]).length, 3);
  // Streaming hides the bar even when a breadcrumb carries pills.
  assert.equal(currentQuickReplies(
    [{ role: 'system', content: 'recovered', quickReplies: ['Make a tweak'] }],
    { isStreaming: true }
  ), null);
  // Non-interactive statuses hide it too.
  assert.equal(currentQuickReplies(
    [{ role: 'system', content: 'recovered', quickReplies: ['Make a tweak'] }],
    { session: { id: 1, status: 'paused' } }
  ), null);
  assert.equal(currentQuickReplies(
    [{ role: 'system', content: 'recovered', quickReplies: ['Make a tweak'] }],
    { session: null }
  ), null);
  // 'promoted' stays interactive.
  assert.deepEqual(currentQuickReplies(
    [{ role: 'system', content: 'recovered', quickReplies: ['Make a tweak'] }],
    { session: { id: 1, status: 'promoted' } }
  ), ['Make a tweak']);
});

test('#786 all three status handlers carry quickReplies onto the pushed row', () => {
  // The recovery breadcrumb's pills ride the 'status' event (the
  // 'quick_replies' handlers attach to the last ASSISTANT row, which a
  // recovered turn doesn't have). Each channel pushes its own system row,
  // so all three must copy the field or the bar only fills after a reload.
  const postSse = sliceBetween(
    DEVCHAT_SRC, "case 'status':\n                DevChat._flushStreamingFinal();",
    "case 'platform_issue_draft':", 'POST-SSE status handler'
  );
  assert.match(postSse, /quickReplies: data\.quickReplies/,
    'POST-SSE status handler must carry quickReplies');

  const resumed = sliceBetween(
    handleResumedEventBody, "case 'status': {", "case 'platform_issue_draft':",
    'resumable status handler'
  );
  assert.match(resumed, /quickReplies: data\.quickReplies/,
    'resumable status handler must carry quickReplies');

  const wsStatus = sliceBetween(
    handleSessionEventBody, "case 'status': {", "case 'platform_issue_draft':",
    'WS status handler'
  );
  assert.match(wsStatus, /quickReplies: data\.quickReplies/,
    'WS status handler must carry quickReplies');
});

test('#786 loadMessages rehydrates metadata.quickReplies for any role', () => {
  // The role-agnostic rehydrate is what makes a breadcrumb's pills survive
  // a reload; a role gate here would silently break the whole feature.
  const mapper = sliceBetween(
    DEVCHAT_SRC, 'DevChat.messages = messages.map((m) => {', '// #252: sync state is keyed per session',
    'loadMessages metadata rehydrate'
  );
  assert.match(mapper, /if \(m\.metadata\.quickReplies\) m\.quickReplies = m\.metadata\.quickReplies;/);
  assert.doesNotMatch(mapper, /quickReplies[\s\S]{0,80}role === 'assistant'/,
    'the quickReplies rehydrate must not be gated on role');
});
