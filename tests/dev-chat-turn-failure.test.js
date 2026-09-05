'use strict';

// A failed turn must not wear the pipeline's green tick.
//
// `turnError: true` has been on the wire since #894 — five paths in
// routes/sessions.js set it — and until this change NOTHING read it:
//
//   * both live status handlers built their pushed message from an explicit
//     property whitelist that did not include the flag, so a failure arriving
//     over SSE was indistinguishable from a step completing, and
//   * the reload hydration never mapped `metadata.turnError` onto the
//     message, so it was still indistinguishable after a refresh.
//
// It therefore fell through to the generic system row, whose icon is
// `msg._active ? 'spinner' : 'check'` — and `.dc-status-check` is #10b981.
// Every failed turn in the product's history has been reported in green.
//
// What this file pins is the whole chain: the server still writes the flag,
// both client channels carry it, the builder routes it to its own row, and
// that row renders as a failure. Break any link and a failure goes back to
// looking like a success, which is the one bug in a transcript that a user
// cannot work around.
//
// Run with: node --test tests/dev-chat-turn-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');
const TRANSCRIPT = read('frontend/src/features/dev-chat/transcript.tsx');
const STORE = read('frontend/src/features/dev-chat/transcript-store.ts');
const SESSIONS = read('src/routes/sessions.js');
const APP_CSS = read('public/css/app.css');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

test('the server still writes turnError — this change reads it, it does not add it', () => {
  const producers = SESSIONS.match(/turnError:\s*true/g) || [];
  assert.ok(producers.length >= 5,
    `expected the five turnError producers; found ${producers.length}`);
});

test('an agent RUN that fails is a failure too, not a green tick', () => {
  // #894 marked the five turn-level errors and stopped there, so the six
  // AGENT-run failures — the ones a reader actually meets, because they are
  // what a scout or a build does when it goes wrong — still fell through to
  // the generic system row. "Scout finished but produced no spec text" was
  // reported in #10b981.
  //
  // Each is now routed through turnFailure(), which SPREADS rather than
  // mutates: executionAgentMeta is one object shared by every status a run
  // emits, so marking it in place would have marked that run's successes.
  assert.match(SESSIONS, /function turnFailure\(meta\) \{\n  return \{ \.\.\.\(meta \|\| \{\}\), turnError: true \};/,
    'the helper must spread, never mutate the shared meta object');

  for (const failing of [
    'Scout error: ${result.fatalError',
    'Scout error: ${(ccText',
    "'Scout finished but produced no spec text.'",
    'Worker error: ${result.fatalError',
    '${executionAgentName} error: ${(ccText',
  ]) {
    const at = SESSIONS.indexOf(failing);
    assert.ok(at > 0, `${failing} must still be produced`);
    const after = SESSIONS.slice(at, at + 400);
    assert.match(after, /sendStatus\(msg, turnFailure\(/,
      `${failing} must be sent as a failure`);
  }
});

test('…but an OUTCOME that is merely not a success is left alone', () => {
  // Three neighbours of those six set the same `isError` flag and must NOT
  // become failure cards:
  //   * "No changes were made by X" is an outcome, and the no_changes card
  //     already says so without claiming the turn broke;
  //   * a stop is not a failure — the user asked for it;
  //   * a staging-build failure carries changesReady and keeps its
  //     Changes-ready card, because the commit exists and is proposable.
  for (const notAFailure of [
    'No changes were made by ${executionAgentName}',
    'Staging build failed.',
  ]) {
    const at = SESSIONS.indexOf(notAFailure);
    assert.ok(at > 0, `${notAFailure} must still be produced`);
    assert.doesNotMatch(SESSIONS.slice(at, at + 300), /turnFailure\(/,
      `${notAFailure} is an outcome, not a broken turn`);
  }
});

test('both live channels carry the flag onto the pushed message', () => {
  // The two status handlers (POST-SSE and the replay channel) build their
  // message from a literal, so an unlisted field is silently dropped. That
  // is exactly how the flag went missing for a live failure.
  // `ccOutput: data.ccOutput` is what distinguishes the two STATUS handlers
  // from the third system push in this file — the #664 billing-switch row,
  // which is its own shape and has no turn to fail.
  const pushes = DEV_CHAT.match(
    /DevChat\.messages\.push\(\{ role: 'system', content: data\.text,[^\n]*ccOutput: data\.ccOutput[^\n]*/g) || [];
  assert.equal(pushes.length, 2, 'both status handlers still push a system row');
  for (const p of pushes) {
    assert.match(p, /turnError: data\.turnError/,
      'a live failure must carry the flag, not just a persisted one');
  }
});

test('…and the reload path hydrates it from metadata', () => {
  assert.match(DEV_CHAT, /if \(m\.metadata\.turnError\) m\.turnError = true;/,
    'a failure must still read as a failure after a refresh');
});

test('the builder routes a failed turn away from the generic status row', () => {
  const at = DEV_CHAT.indexOf('if (msg.turnError) {');
  assert.ok(at > 0, 'the builder must branch on turnError');
  const branch = DEV_CHAT.slice(at, at + 200);
  assert.match(branch, /t: 'failure'/);

  // It must come BEFORE the generic fallback, or the fallback claims it.
  const fallback = DEV_CHAT.indexOf(
    "t: 'status', key, icon: msg._active ? 'spinner' : 'check',\n          html: msg.content");
  assert.ok(fallback > at, 'the failure branch must precede the generic system row');
});

test('a staging-build failure is NOT routed here', () => {
  // It carries `changesReady: true` and renders the Changes-ready card with
  // Preview disabled, which is the honest reading: the commit exists and is
  // proposable, only the preview did not build. Routing it to the failure
  // row would take that card away and lose the Propose action with it.
  const at = DEV_CHAT.indexOf('if (msg.turnError) {');
  const branch = DEV_CHAT.slice(at, at + 200);
  assert.doesNotMatch(branch, /stagingFailed/);
});

test('the row renders as a failure, in the platform\'s blocked token', () => {
  const { Row } = loadTsx('frontend/src/features/dev-chat/transcript.tsx');
  const html = renderToHtml(createElement(Row, {
    r: { t: 'failure', key: 'x', text: 'This turn failed: the agent exited.', stamp: '#1' },
  }));
  assert.match(html, /class="dc-failure"/);
  assert.match(html, /class="dc-failure-text">This turn failed: the agent exited\./);
  // NOT the ladder's tick — the whole point.
  assert.doesNotMatch(html, /dc-status-check/);
  assert.doesNotMatch(html, /✓/);

  // --state-blocked is the platform's existing "this blocks you" red, the
  // same token the board's checks-failing pill takes. A new hue here would
  // be a second vocabulary for a meaning that already has one.
  const at = APP_CSS.indexOf('.dc-failure {');
  const rule = APP_CSS.slice(at, APP_CSS.indexOf('}', at));
  assert.match(rule, /var\(--state-blocked\)/);
  assert.match(rule, /var\(--state-blocked-bg\)/);
});

test('no retry button — the retry pill already exists', () => {
  // The producers that set turnError also send
  // `quickReplies: turnPills('failed')`, so the one-tap retry is already in
  // the pill bar over the composer, with every other suggested next message.
  // A second control here would be two ways to do one thing.
  assert.match(SESSIONS, /turnError: true, quickReplies: turnPills\('failed'\)/);
  const at = TRANSCRIPT.indexOf('function Failure(');
  const body = TRANSCRIPT.slice(at, TRANSCRIPT.indexOf('\n}', at));
  assert.doesNotMatch(body, /<button/);
});

test('the failure row is a documented member of the row union', () => {
  assert.match(STORE, /\| \{ t: 'failure'; key: string; text: string; html\?: string; stamp: string \}/);
});

test('a declared check guards it in a browser', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((t) => (t.expectSelector || '').includes('.dc-failure'));
  assert.ok(check, 'the failure row must be guarded on a real route');
  assert.match(check.path, /sessions\/990412/, 'on the transcript fixture');
  assert.match(check.expectText, /^This turn failed:/);
});
