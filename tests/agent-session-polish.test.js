'use strict';

// Agent chat polish (#2779 follow-ups):
//
//   #3033 A SUGGESTED REPLY GOES INTO THE BOX. Tapping a pill fills the
//         message box, to be edited or sent, as the dev chat's pills do; it
//         no longer sends on its own.
//   #3032 PROPOSE ASKS INLINE. The staging card's "Propose to group" opens a
//         small panel under the button, the vote picker's frame, instead of a
//         full-screen dialog.
//   #3028 (the spinner in place of a row's icon) is pinned with the other
//         activity marks, in tests/agent-session-activity.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, createElement, renderToHtml } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const panel = read('frontend/src/features/agent-session/index.tsx');

// ── #3033 ──────────────────────────────────────────────────────────────

test('#3033: a tapped reply is put in the box, not sent', () => {
  globalThis.window = { location: { hash: '' }, App: {}, UsernodeReact: {}, PlatformUI: { toast() {} } };
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    store.fillComposer('Add a feature');
    const first = store.getAgentSessionState().composerFill;
    assert.equal(first.text, 'Add a feature');
    store.clearComposerFill();
    assert.equal(store.getAgentSessionState().composerFill, null);
    store.fillComposer('Add a feature');
    assert.ok(store.getAgentSessionState().composerFill.seq > first.seq, 'the same pill twice is a second fill');
    store.clearComposerFill();
    store.fillComposer('   ');
    assert.equal(store.getAgentSessionState().composerFill, null, 'nothing to put in');
  } finally {
    delete globalThis.window;
  }

  const replies = panel.slice(panel.indexOf('function Replies('), panel.indexOf('function Replies(') + 1200);
  assert.match(replies, /onClick=\{\(\) => fillComposer\(reply\)\}/);
  assert.doesNotMatch(replies, /sendAgentMessage/, 'no send from a pill');

  const composer = panel.slice(panel.indexOf('function Composer('));
  assert.match(composer, /const fill = snapshot\.composerFill;\s*useEffect\(\(\) => \{\s*if \(!fill\) return;\s*update\(fill\.text\);\s*clearComposerFill\(\);/,
    'the box takes it, replacing what was there, as the dev chat does');
  assert.match(composer, /window\.matchMedia\('\(pointer: coarse\)'\)\.matches/);
  assert.match(composer, /if \(field && !coarse\) \{\s*field\.focus\(\);\s*try \{ field\.setSelectionRange\(fill\.text\.length, fill\.text\.length\); \}/,
    'focus and the caret at the end, but no keyboard raised on a phone');
});

// ── #3032 ──────────────────────────────────────────────────────────────

test('#3032: Propose opens a panel under the button, in the vote picker\'s frame', () => {
  const confirm = loadTsx('frontend/src/features/agent-session/propose-confirm.tsx');
  const html = renderToHtml(createElement(confirm.ProposeConfirmPanel, {
    title: 'Dark mode', prNumber: 14, headId: 'h', onCancel() {}, onPropose() {},
  }));
  assert.match(html, /^<div class="dev-vote-switch-label" id="h">Put this up for the group’s vote\?<\/div>/);
  assert.match(html, /data-agent-session-propose-line="true">“Dark mode” \(PR #14\) goes to the vote\. Its preview and checks run again on the way\.<\/p>/);
  assert.match(html, /<div class="dev-vote-reason-actions"><button type="button" class="dev-vote-reason-cancel">Cancel<\/button>/);
  assert.match(html, /class="dev-vote-reason-send dev-vote-reason-send-yes" data-agent-session-propose-confirm="true">Propose<\/button>/);
  assert.equal(confirm.proposeLine('', null), '“This change” goes to the vote. Its preview and checks run again on the way.');

  const button = renderToHtml(createElement(confirm.ProposeButton, {
    changeId: 50, title: 'Dark mode', prNumber: 14, className: 'x', busy: false, proposing: false,
  }));
  assert.match(button, /^<button type="button" class="x" aria-haspopup="dialog" data-agent-session-preview-propose="true">Propose to group<\/button>$/,
    'closed, only the button; the panel is not in the page until it opens');
  assert.match(renderToHtml(createElement(confirm.ProposeButton, {
    changeId: 50, title: 'Dark mode', prNumber: 14, className: 'x', busy: true, proposing: true,
  })), /disabled=""[^>]*>Proposing…<\/button>/);

  const src = read('frontend/src/features/agent-session/propose-confirm.tsx');
  assert.match(src, /className="dev-vote-pop"\s+role="dialog"/, 'desktop: the vote picker\'s popover frame');
  assert.match(src, /placeUnderAnchor\(rect,/, 'placed under the button by the shared helper');
  assert.match(src, /useAnchoredDismiss\(open, \[btnRef, popRef\], shut\);/, 'outside click, Escape and scroll close it');
  assert.match(src, /kit\.isTouch\(\) && openSheet\(kit\)/, 'touch: the kit\'s bottom sheet, as voting');
  assert.match(src, /const propose = \(\) => \{\s*shut\(\);\s*void proposeChange\(changeId\);/);
  const store = read('frontend/src/features/agent-session/store.ts');
  const proposeFn = store.slice(store.indexOf('export async function proposeChange('), store.indexOf('export const RETRY_GIVE_UP_MS'));
  assert.doesNotMatch(proposeFn, /confirm/, 'no full-screen dialog left on the way');
  assert.match(panel, /<ProposeButton\s+changeId=\{item\.changeId\}\s+title=\{change\?\.title\}\s+prNumber=\{prNumber\}\s+className=\{CARD_PRIMARY\}/);
});
