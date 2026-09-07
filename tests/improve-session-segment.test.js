// The view strip says where you are, even when that is a change (#1598).
//
// App / Workshop / Board is a segmented control, and a segmented control with
// nothing selected reads as broken rather than as "you are somewhere else".
// Inside a dev session all three went grey, which is the state that was
// reported as looking weird.
//
// A session is not a fourth DESTINATION — it is reached from a card or a
// notification, never from this strip — so the fourth segment is inert and
// exists only while you are in one. Outside a session the control is the three
// it has always been, and the declared checks that pin the order and the
// selected segment are untouched.
//
// Run with: node --test tests/improve-session-segment.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const TABS = 'frontend/src/features/improve/view-tabs.tsx';
const src = fs.readFileSync(path.join(ROOT, TABS), 'utf8');

test('a dev session is its own answer, and the other routes are unchanged', () => {
  const { activeAppView } = loadTsx(TABS);

  assert.equal(activeAppView('dev', 'sessions', 'feed'), 'session');
  assert.equal(activeAppView('dev', 'sessions', 'kanban'), 'session',
    'which board layout you last used does not change where you are');

  // The three destinations answer exactly as before.
  assert.equal(activeAppView('app', null, 'feed'), 'app');
  assert.equal(activeAppView('dev', 'forum', 'feed'), 'workshop');
  assert.equal(activeAppView('dev', 'forum', 'kanban'), 'board');
  assert.equal(activeAppView('dev', 'topic', 'kanban'), 'board');
  assert.equal(activeAppView('dev', 'topic', 'feed'), 'workshop');

  // The general chat is a different kind of place and still selects nothing;
  // giving it a segment is its own decision.
  assert.equal(activeAppView('dev', 'chat', 'feed'), null);
});

test('the fourth segment is inert, and only exists inside a session', () => {
  assert.match(src, /\{active === 'session' \? \(/,
    'rendered only while you are in one');
  const segment = src.slice(src.indexOf("{active === 'session' ? ("));
  const upToEnd = segment.slice(0, segment.indexOf('</div>'));
  assert.match(upToEnd, /<span\s/, 'a span, not a control you cannot use');
  assert.doesNotMatch(upToEnd, /<button|<a\s|onClick/,
    'the segment you are already on must not offer to take you there');
  assert.match(upToEnd, /aria-current="page"/);
  assert.match(upToEnd, /data-context-row="session"/);
  assert.match(upToEnd, /segClass\(true\)/,
    'it wears the same selected treatment as the other three');
});

test('it comes last, and claims no id from the shell inventory', () => {
  // The declared check pins the order with general sibling combinators
  // (`app ~ workshop ~ board`), so a fourth segment is only safe after them.
  const order = ['"app"', '"workshop"', '"board"', '"session"']
    .map((k) => src.indexOf(`data-context-row=${k}`));
  assert.ok(order.every((idx, i) => idx !== -1 && (i === 0 || idx > order[i - 1])),
    'app, workshop, board, then session');

  const segment = src.slice(src.indexOf("{active === 'session' ? ("));
  assert.doesNotMatch(segment.slice(0, segment.indexOf('</div>')), /\bid=/,
    'a conditional element is not in the built document, so it takes no inventory id');
});
