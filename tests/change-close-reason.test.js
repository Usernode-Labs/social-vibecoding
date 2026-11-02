'use strict';

// #6100: a closed change says why. The proposal machine keeps the reason it
// closed with (its `close_reason`), and both places people look word it from
// their own catalog:
//
//   - the change's page: the hero reads "Closed" (a closed session row is
//     'archived'), and the Votes card's closed note adds the one sentence;
//   - the bell: the author's "Closed" row, and a "Ready to try" row whose
//     change has closed since.
//
// A reason this build does not know (an older close, a newer one) shows the
// plain note and nothing else. The server side is
// tests/workflow-proposal-postgres.test.js (P13b).
//
// Run with: node --test tests/change-close-reason.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// The English catalogs, read straight from frontend/locales/en: the same
// words the real runtime serves, without loading it through the frontend
// toolchain (these two legacy modules only ever call `t`).
const ENGLISH = {};
for (const file of fs.readdirSync(path.join(ROOT, 'frontend', 'locales', 'en')).filter((f) => f.endsWith('.json'))) {
  const entries = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'locales', 'en', file), 'utf8'));
  ENGLISH[file.slice(0, -5)] = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.text]));
}

function message(id, values) {
  const at = id.indexOf(':');
  const text = ENGLISH[id.slice(0, at)] && ENGLISH[id.slice(0, at)][id.slice(at + 1)];
  if (text == null) throw new Error(`No English catalog entry for ${id}`);
  return Object.entries(values || {}).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(String(v)), text);
}

const englishPlatformI18n = () => ({ t: message, htmlText: message, listText: (id, v) => message(id, v) });

// ── The change page (public/js/app-view.js) ─────────────────────────────

function makeAppView() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42 } },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({ count: 0 }), give: () => {}, retract: () => {} },
    PlatformUI: { isTouch: () => false, actionSheet: () => {}, toast: () => {} },
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
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${read('public', 'js', 'merge-status.js')}\n${read('public', 'js', 'app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 2, activeUsers: 3 };
  AppView._mergedCtx = { majority: 2 };
  AppView._voteRoster = {};
  return AppView;
}

// A closed change as the details read hands it over: its session row says
// 'archived', and the reason the close recorded rides beside it.
const CLOSED = (over) => ({
  id: 7, app_slug: 'demo', user_id: 42, username: 'ada', session_title: 'Dark mode for the reading list',
  status: 'archived', created_at: '2026-10-20T00:00:00Z', close_reason: 'auto-rejected',
  ...over,
});

test('the page says Closed, and its Votes card says why', () => {
  const AppView = makeAppView();
  const view = AppView._changeVotesView(CLOSED(), {});
  assert.equal(view.figure, message('changes:page.votes.figure.closed'), 'no vote count for a change nobody can vote on');
  assert.equal(view.tone, 'muted');
  assert.deepEqual([...view.note], [
    message('changes:page.votes.note.closed'),
    message('changes:page.votes.note.closedWhy.autoRejected'),
  ], 'the existing note, then why');
  assert.equal(AppView._topicHeroView('proposal', CLOSED()).status, message('changes:page.hero.status.closed'),
    'the hero says Closed, not the raw word archived');
});

test('an unknown or missing reason keeps the plain note', () => {
  const AppView = makeAppView();
  for (const reason of [null, undefined, 'unknown', 'a-reason-from-a-newer-build']) {
    const view = AppView._changeVotesView(CLOSED({ close_reason: reason }), {});
    assert.deepEqual([...view.note], [message('changes:page.votes.note.closed')], String(reason));
  }
});

// ── The bell (frontend/src/features/notifications/notifications.js) ─────

const NOTIFICATIONS_SRC = read('frontend', 'src', 'features', 'notifications', 'notifications.js')
  .replace(/^import \{ agoStamp \}.*$/m, '');

function loadBell() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams,
    location: { search: '', hash: '#home' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      title: '', getElementById: () => null, addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }), body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    PlatformUI: { isTouch: () => false, toast() {} },
    App: { user: { id: 1 }, openAppTab: () => {}, _isScreenVisible: () => false },
    UsernodeReact: { workshop: { setTab: () => {} } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = () => ({ text: 'now', title: '' });
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(NOTIFICATIONS_SRC, sandbox);
  return sandbox.Notifications;
}

const subject = (view) => view.segments.map((s) => s.v).join(' ');

test('the author\'s Closed row names the change and gives the reason', () => {
  const N = loadBell();
  const row = (extra) => ({
    id: 7, kind: 'change_closed', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Demo', appSlug: 'demo', sessionId: 42, prTitle: 'Dark mode for the reading list',
    sessionTitle: 'Dark mode for the reading list', closeReason: 'auto-rejected', ...extra,
  });
  const view = N._rowView(row());
  assert.equal(view.label, message('notifications:row.changeClosed.label'));
  assert.equal(subject(view), `Dark mode for the reading list ${message('notifications:row.closedWhy.autoRejected')}`);
  assert.equal(view.needsYou, false, 'there is nothing left to do');
  assert.equal(view.icon, '\u{1F5C2}️');

  // A reason this build does not know, or none at all: the row stands alone.
  for (const reason of [null, 'unknown']) {
    const bare = N._rowView(row({ closeReason: reason }));
    assert.equal(subject(bare), 'Dark mode for the reading list', String(reason));
  }
});

test('a Ready to try row that closed gives the same reason', () => {
  const N = loadBell();
  const row = (extra) => ({
    id: 8, kind: 'change_ready', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Demo', appSlug: 'demo', sourceUsername: 'alex', sessionId: 42,
    sessionStatus: 'archived', prTitle: 'Water reminders', closeReason: 'red-checks', ...extra,
  });
  const view = N._rowView(row());
  assert.equal(view.label, message('notifications:row.changeReady.closed'));
  assert.equal(subject(view), `Water reminders ${message('notifications:row.closedWhy.redChecks')}`);
  assert.equal(subject(N._rowView(row({ closeReason: null }))), 'Water reminders', 'an older close keeps the plain row');
});

test('every reason the machine can close with has words on the page and in the bell', () => {
  const AppView = makeAppView();
  const N = loadBell();
  const machine = read('src', 'workflow', 'proposal', 'machine.ts');
  const fn = /function closedLine\([\s\S]*?\n\}/.exec(machine);
  assert.ok(fn, 'closedLine still exists');
  const codes = [...fn[0].matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);
  assert.ok(codes.length >= 16, `closedLine's reasons were read (${codes.length})`);
  // The bell's own map is not exported; read it off a row.
  for (const code of codes) {
    const pageId = AppView.CLOSE_REASON_IDS[code];
    assert.ok(pageId, `the page words ${code}`);
    assert.ok(message(pageId).length > 0, `the catalog has ${pageId}`);
    const view = N._rowView({
      id: 1, kind: 'change_closed', createdAt: new Date().toISOString(), readAt: null,
      appName: 'Demo', appSlug: 'demo', sessionId: 42, prTitle: 'A change', closeReason: code,
    });
    assert.equal(view.label, message('notifications:row.changeClosed.label'));
    assert.equal(view.segments.length, 2, `the bell words ${code}`);
    assert.ok(view.segments[1].v && view.segments[1].v !== 'A change', code);
  }
});
