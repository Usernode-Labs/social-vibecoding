'use strict';

// #990: the trailing activity indicator must behave the same in ALL THREE
// client delivery channels, because which one carries a given turn is not
// under the user's control:
//
//   1. the primary POST /api/sessions/:id/chat SSE loop (DevChat.sendMessage)
//   2. the resumable GET /api/sessions/:id/events EventSource
//      (DevChat._handleResumedEvent) — used after a reload or a dead POST
//   3. the global WebSocket (App.handleSessionEvent in app.js) — the backup
//      channel for everything not in the server's SSE_ONLY set
//
// The reporter's turn was exactly the case where this matters: a long
// data-tool phase is where a POST SSE is most likely to die. If only channel 1
// arms the indicator, the fix is invisible on reload, which is how the
// previous one-shot spinner regressed in the first place.
//
// This is a source guard on the per-`case` wiring, in the style of the source
// guards in tests/cc-progress-summary.test.js: each channel's function body is
// sliced out, split into its `case` arms, and the arms that must show or hide
// the indicator are checked individually. `token`, `usage` and `error` are
// SSE_ONLY server-side, so app.js legitimately has no `token` arm — the WS
// channel's fresh-bubble handling lands on `mayor_reasoning` instead.
//
// Run with: node --test tests/dev-chat-activity-channel-parity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const DEV_CHAT = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const APP = read('public', 'js', 'app.js');
const SESSIONS = read('src', 'routes', 'sessions.js');

// Slice from `startMarker` to `endMarker` (both must exist and be ordered).
function slice(src, startMarker, endMarker, what) {
  const a = src.indexOf(startMarker);
  assert.ok(a > 0, `could not locate ${what} (start marker moved)`);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, `could not locate the end of ${what}`);
  return src.slice(a, b);
}

// The CODE of one `case 'x':` arm — up to the next `case '` at any depth,
// with `//` comment lines dropped. These arms are heavily commented (several
// of the comments name the very calls being asserted on, e.g. "the old
// _removeSpinner() here is what left…"), so matching against raw text would
// read prose as wiring.
function caseArm(block, type, channel) {
  const re = new RegExp(`case '${type}':`);
  const m = re.exec(block);
  assert.ok(m, `${channel} has no case '${type}'`);
  const rest = block.slice(m.index + m[0].length);
  const next = rest.search(/\n\s*case '/);
  const arm = next === -1 ? rest : rest.slice(0, next);
  return arm
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

const CHANNELS = [
  {
    name: 'POST SSE (DevChat.sendMessage)',
    block: () => slice(
      DEV_CHAT, '  async sendMessage(message, attachments = []) {',
      '  _handleResumedEvent(data, sessionId) {', 'the POST SSE handler'
    ),
    // Direct DevChat.* calls — same file, no ordering concern.
    show: 'DevChat._showActivity()',
    hide: 'DevChat._hideActivity()',
    freeze: 'DevChat._deactivateStatusForFreshBubble()',
    freshBubbleOn: 'token',
  },
  {
    name: 'resumable EventSource (_handleResumedEvent)',
    block: () => slice(
      DEV_CHAT, '  _handleResumedEvent(data, sessionId) {',
      '\n  _handleSpecUpdated(data) {', 'the resumable-stream handler'
    ),
    show: 'DevChat._showActivity()',
    hide: 'DevChat._hideActivity()',
    freeze: 'DevChat._deactivateStatusForFreshBubble()',
    freshBubbleOn: 'token',
  },
  {
    name: 'global WebSocket (App.handleSessionEvent)',
    block: () => slice(APP, '  handleSessionEvent(data) {', '\n  handleAppUpdate(data) {', 'the global-WS handler'),
    // app.js may execute before dev-chat.js defines DevChat, hence typeof.
    show: 'DevChat._showActivity()',
    hide: 'DevChat._hideActivity()',
    freeze: 'DevChat._deactivateStatusForFreshBubble()',
    // No `token` arm: token is SSE_ONLY, so the WS channel's first sign of a
    // fresh assistant bubble is the mayor_reasoning summary.
    freshBubbleOn: 'mayor_reasoning',
  },
];

// ── The status arm arms the indicator ───────────────────────────────────
//
// A `status` event means a new step just started and the previous one is
// done — the exact moment the indicator has to come (back) up. The OLD code
// did the opposite here (`_removeSpinner()`), which is the bug.

for (const ch of CHANNELS) {
  test(`#990: ${ch.name} — case 'status' shows the indicator`, () => {
    const arm = caseArm(ch.block(), 'status', ch.name);
    assert.ok(arm.includes(ch.show),
      `${ch.name}: a new step starting must (re-)arm the trailing indicator`);
    assert.ok(!/_removeSpinner\(\)|_hideActivity\(\)/.test(arm),
      `${ch.name}: case 'status' must not tear the indicator down — that is `
      + 'the #990 regression');
  });

  test(`#990: ${ch.name} — the indicator is armed BEFORE the re-render`, () => {
    const arm = caseArm(ch.block(), 'status', ch.name);
    const showIdx = arm.indexOf(ch.show);
    const renderIdx = arm.indexOf('DevChat.renderMessages()');
    assert.ok(showIdx > -1 && renderIdx > -1);
    assert.ok(showIdx < renderIdx,
      `${ch.name}: the flag must be set before renderMessages() so the `
      + 'indicator rides the single innerHTML write instead of appending after it');
  });
}

// ── Real content arriving stands the indicator down ─────────────────────

const HIDE_ON = ['platform_issue_draft', 'cc_progress', 'cc_log'];

for (const ch of CHANNELS) {
  for (const type of HIDE_ON) {
    test(`#990: ${ch.name} — case '${type}' hides the indicator`, () => {
      const arm = caseArm(ch.block(), type, ch.name);
      assert.ok(arm.includes(ch.hide),
        `${ch.name}: '${type}' puts real content on screen, so the dots must go`);
    });
  }
}

// ── A fresh assistant bubble both hides and freezes ─────────────────────

for (const ch of CHANNELS) {
  test(`#990: ${ch.name} — a fresh assistant bubble hides and freezes`, () => {
    const arm = caseArm(ch.block(), ch.freshBubbleOn, ch.name);
    assert.ok(arm.includes(ch.hide),
      `${ch.name}: the reply is visible now — the dots come down`);
    assert.ok(arm.includes(ch.freeze),
      `${ch.name}: the step the ladder still shows as live has finished, so it `
      + 'must be frozen with its real duration');
  });
}

// ── app.js guards its DevChat reach ─────────────────────────────────────

test('#990: app.js typeof-guards every activity call', () => {
  const block = slice(APP, '  handleSessionEvent(data) {', '\n  handleAppUpdate(data) {', 'the global-WS handler');
  const calls = block.match(/DevChat\._(showActivity|hideActivity|deactivateStatusForFreshBubble)\(/g) || [];
  assert.ok(calls.length >= 5, 'expected the WS channel to be wired at all');
  const guards = block.match(
    /typeof DevChat\._(showActivity|hideActivity|deactivateStatusForFreshBubble) === 'function'/g
  ) || [];
  assert.equal(guards.length, calls.length,
    'app.js can execute before dev-chat.js defines DevChat — every activity '
    + 'call needs its typeof guard, the same way the file guards its other '
    + 'optional DevChat reaches');
});

// ── The server-side event that drives all three ─────────────────────────

test('#990: the thinking status is a normal status event, so all three channels get it', () => {
  // Not in SSE_ONLY → it is broadcast on the WS and replayed by the resumable
  // stream, which is what makes the parity above reachable at runtime.
  const m = SESSIONS.match(/const SSE_ONLY = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'SSE_ONLY set not found in sessions.js');
  assert.ok(!/status/.test(m[1]),
    "'status' must stay off the SSE_ONLY list or the fix would be invisible "
    + 'on the WS and resumable channels');
});
