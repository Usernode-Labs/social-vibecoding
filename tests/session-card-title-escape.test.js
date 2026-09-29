'use strict';

// #3010: "text misformatted when submitted by agent chat": a change's title
// with a quote in it read `&quot;` on its Dev board card (and `&amp;` for an
// ampersand).
//
// AppView._sessionCardLabel still returned escapeHtml's output from when the
// session cards were innerHTML templates. Its readers are React card models
// now (card/fold.tsx draws `title.text` as a text child and `title.title` as
// an attribute; card/list-rows.tsx draws the archived rows' `label`), and
// React escapes both, so the title was escaped twice. The agent-session
// Mayor names changes in prose, quotes and all, which is how it surfaced.
// The proposal meta's provenance words (an imported PR's author) had the
// same double escape.
//
// The real app-view.js runs here, with its own escapeHtml, and the models
// are rendered through the real card component.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { cardHtml } = require('./lib/dev-card-html');
const { loadTsx, createElement, renderToHtml } = require('./lib/render-tsx');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const MERGE_STATUS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8');

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42 } },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({ count: 0 }) },
    PlatformUI: { isTouch: () => false, toast: () => {} },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    UsernodeReact: { devBoard: { mountCardMenu: () => {}, publishCardMenu: () => {} } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._sharedById = {};
  AppView._proposalsCtx = { majority: 3 };
  return AppView;
}

const TITLE = 'Add an "Open app" button & keep the chat docked';

test('the session card label is the title as written', () => {
  const AppView = makeAppView();
  assert.equal(AppView._sessionCardLabel({ id: 7, session_title: TITLE }), TITLE);
  assert.equal(AppView._sessionCardLabel({ id: 7 }), 'Session #7');
});

test('a quoted title renders once-escaped on the own, shared and archived cards', () => {
  const AppView = makeAppView();
  const session = { id: 51, user_id: 42, session_title: TITLE, status: 'active', username: 'maya' };
  const escaped = 'Add an &quot;Open app&quot; button &amp; keep the chat docked';
  for (const model of [AppView._mySessionCardModel(session), AppView._sharedSessionCardModel(session)]) {
    assert.equal(model.title.text, TITLE);
    const html = cardHtml(model);
    assert.ok(html.includes(escaped), 'the markup escapes it once, so it reads as written');
    assert.doesNotMatch(html, /&amp;quot;|&amp;amp;/, 'never twice');
  }

  AppView._archivedSessions = [session];
  const row = AppView._archivedToggleRow();
  assert.equal(row.rows[0].label, TITLE);
  const { ListRowView } = loadTsx('frontend/src/features/dev-board/card/list-rows.tsx');
  const html = renderToHtml(createElement(ListRowView, { row }));
  assert.ok(html.includes(escaped), 'the archived row reads as written');
  assert.doesNotMatch(html, /&amp;quot;|&amp;amp;/);
});

test('the proposal meta\'s provenance words are plain text too', () => {
  const AppView = makeAppView();
  assert.equal(
    AppView._proposalProvenanceWords({ source: 'imported', imported_pr_author: "o'brien" }),
    "imported from GitHub (o'brien)",
  );
});
