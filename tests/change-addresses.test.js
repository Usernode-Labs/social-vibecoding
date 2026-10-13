'use strict';

// #4367: a change that has a pull request is addressed by that number,
// `/app/<slug>/dev/changes/<N>`, the "Change #N" it shows on screen, so a
// change and its pull request share one number the way a request and its
// GitHub issue already do. Homeroom's own session ids overlap PR numbers in
// range, so the two spellings never guess between each other:
//
//   * `dev/changes/<N>` is always a PR number, looked up on the server
//     (GET /api/apps/:slug/changes/:number, pinned in proposal-by-id.test.js);
//   * `dev/proposals/<id>` is always a session id. It keeps working, and once
//     the change it names turns out to have a pull request the address is
//     REPLACED (not pushed) by the changes/ form;
//   * a draft or plan with no pull request keeps its session-id link.
//
// This pins the router's parse and serialize (public/js/app.js), the topic
// page's lookup and redirect (public/js/app-view.js), and the link builders.
//
// Run with: node --test tests/change-addresses.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── The router (public/js/app.js) ───────────────────────────────────────

function loadApp(initial = {}) {
  const origin = 'https://social-vibecoding.test';
  const location = {
    origin,
    pathname: initial.pathname || '/',
    search: initial.search || '',
    hash: initial.hash || '',
  };
  const calls = [];
  const applyUrl = (value) => {
    const next = new URL(value, `${origin}${location.pathname}${location.search}${location.hash}`);
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  };
  const history = {
    state: null,
    pushState(_s, _t, value) { calls.push(['push', value]); applyUrl(value); },
    replaceState(_s, _t, value) { calls.push(['replace', value]); applyUrl(value); },
  };
  const element = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, appendChild() {},
  };
  const document = {
    visibilityState: 'visible', title: '', addEventListener() {},
    getElementById() { return element; }, querySelector() { return null; },
    createElement() { return { ...element }; }, head: element,
  };
  const AppView = {
    appData: null, pendingInnerPath: null,
    launchRecordFor() { return null; }, beginLaunch() { return true; },
    open() { return new Promise(() => {}); }, close() {},
    _getViewMode() { return 'workshop'; },
  };
  const window = { location, history, addEventListener() {}, AppView };
  const context = vm.createContext({
    window, document, location, history, AppView,
    PlatformUI: { transition(fn) { fn(); }, pullToRefresh() {} },
    URL, URLSearchParams, AbortController,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, console, setTimeout, clearTimeout, fetch: async () => ({ ok: false }),
  });
  vm.runInContext(read('public/js/app.js'), context);
  return { App: window.App, AppView, calls, location };
}

test('a change with a pull request serializes as dev/changes/<N>; without one, by session id', () => {
  const { App } = loadApp({ search: '?demo=1' });
  assert.equal(App._appUrl('notes', 'dev', { kind: 'proposal', id: 7296, pr: 4509 }, 'topic'),
    '/app/notes/dev/changes/4509?demo=1');
  assert.equal(App._appUrl('notes', 'dev', { kind: 'proposal', id: 7296 }, 'topic'),
    '/app/notes/dev/proposals/7296?demo=1', 'a draft keeps its session-id address');
  // Before the page has looked the session up, the ref is the number alone.
  assert.equal(App._appUrl('notes', 'dev', { kind: 'proposal', id: null, pr: 4509 }, 'topic'),
    '/app/notes/dev/changes/4509?demo=1');
  // Only a proposal carries the number: an issue's address is its own.
  assert.equal(App._appUrl('notes', 'dev', { kind: 'issue', id: 12, pr: 99 }, 'topic'),
    '/app/notes/dev/issues/12?demo=1');
});

test('the PR number is digits only, never a guess', () => {
  const { App } = loadApp();
  assert.equal(App._changeNumber('4509'), 4509);
  assert.equal(App._changeNumber(4509), 4509);
  for (const bad of ['0', '-1', '12abc', 'abc', '', null, undefined, '1.5', '9999999999']) {
    assert.equal(App._changeNumber(bad), null, `${bad} is no change number`);
  }
  const norm = App._normalizeTab('dev', { kind: 'proposal', id: null, pr: '4509' }, 'topic');
  assert.deepEqual(JSON.parse(JSON.stringify(norm)),
    { tab: 'dev', subTab: 'topic', ref: { kind: 'proposal', id: null, pr: 4509 } });
  const bare = App._normalizeTab('dev', { kind: 'proposal', id: null, pr: 'x' }, 'topic');
  assert.equal(bare.subTab, 'forum', 'an unreadable number is the card list');
});

test('restoreFromHash reads dev/changes/<N> as a change by its PR number', () => {
  for (const initial of [
    { pathname: '/app/notes/dev/changes/4509' },
    { hash: '#app/notes/dev/changes/4509' },
  ]) {
    const { App, location } = loadApp(initial);
    const seen = [];
    App.currentApp = 'notes';
    App.currentTab = 'dev';
    App.currentSubTab = 'forum';
    App.switchTab = (tab, ref, subTab) => { seen.push({ tab, ref, subTab }); };
    App.restoreFromHash();
    assert.equal(seen.length, 1, JSON.stringify(initial));
    assert.equal(seen[0].tab, 'dev');
    assert.equal(seen[0].subTab, 'topic');
    assert.deepEqual(JSON.parse(JSON.stringify(seen[0].ref)), { kind: 'proposal', id: null, pr: 4509 });
    assert.equal(location.pathname, '/app/notes/dev/changes/4509', 'the clean form is the address');
  }
});

test('dev/proposals/<id> still reads as a session id', () => {
  const { App } = loadApp({ pathname: '/app/notes/dev/proposals/7296' });
  const seen = [];
  App.currentApp = 'notes';
  App.currentTab = 'dev';
  App.currentSubTab = 'forum';
  App.switchTab = (tab, ref, subTab) => { seen.push({ tab, ref, subTab }); };
  App.restoreFromHash();
  assert.deepEqual(JSON.parse(JSON.stringify(seen[0].ref)), { kind: 'proposal', id: 7296 });
});

test('moving between the two spellings of a change page replaces, never pushes', () => {
  const { App, calls } = loadApp({ pathname: '/app/notes/dev/proposals/7296' });
  App.currentApp = 'notes';
  App.currentTab = 'dev';
  App.currentSubTab = 'topic';
  App.updateHash({ ref: { kind: 'proposal', id: 7296, pr: 4509 } });
  assert.deepEqual(calls, [['replace', '/app/notes/dev/changes/4509']]);
});

test('a later address write keeps the PR number the page found (switchTab writes after render)', () => {
  // The redirect lands while the page renders; switchTab then writes the
  // address from the ref it was given, which has no number. It must not put
  // dev/proposals/<id> back.
  const { App, AppView, calls } = loadApp({ pathname: '/app/notes/dev/changes/4509' });
  App.currentApp = 'notes';
  App.currentTab = 'dev';
  App.currentSubTab = 'topic';
  AppView._devTopic = { kind: 'proposal', id: 7296, pr: 4509 };
  App.updateHash({ replace: false, ref: { kind: 'proposal', id: 7296 } });
  assert.deepEqual(calls, [], 'the address already names the change');
  App.updateHash({ ref: { kind: 'proposal', id: 7300 } });
  assert.deepEqual(calls, [['replace', '/app/notes/dev/proposals/7300']], 'another change is its own');
});

// ── The topic page (public/js/app-view.js) ──────────────────────────────

function loadAppView({ pathname = '/app/notes/dev/proposals/7296', fetchAnswer = null } = {}) {
  const calls = [];
  const location = { pathname, search: '', hash: '' };
  const history = {
    replaceState(_s, _t, url) { calls.push(['replace', url]); location.pathname = url; },
    pushState(_s, _t, url) { calls.push(['push', url]); },
  };
  const fetched = [];
  const c = {
    console,
    App: {
      currentApp: 'notes', currentTab: 'dev', currentSubTab: 'topic', embeddedPanel: false,
      _appUrl: (slug, tab, ref) => (ref.pr ? `/app/${slug}/dev/changes/${ref.pr}` : `/app/${slug}/dev/proposals/${ref.id}`),
      _noteWorkshopView(url) { calls.push(['note', url]); },
      switchTab(...args) { calls.push(['switchTab', ...args]); },
    },
    document: { getElementById: () => ({}), querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null },
    addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location, history, URLSearchParams,
    fetch: async (url) => {
      fetched.push(url);
      return fetchAnswer
        ? { ok: true, json: async () => fetchAnswer }
        : { ok: false, json: async () => ({}) };
    },
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(read('public/js/app-view.js'), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'notes' };
  return { av: c.av, calls, fetched, location };
}

test('an old proposals/<id> address of a change with a PR becomes changes/<N>, replaced', () => {
  const { av, calls, location } = loadAppView();
  av._devTopic = { kind: 'proposal', id: 7296 };
  assert.equal(av._canonicalizeChangeAddress({ id: 7296, pr_number: 4509 }), true);
  assert.deepEqual(calls[0], ['replace', '/app/notes/dev/changes/4509']);
  assert.ok(!calls.some(([kind]) => kind === 'push'), 'no Back entry');
  assert.equal(location.pathname, '/app/notes/dev/changes/4509');
  assert.equal(av._devTopic.pr, 4509, 'later address writes keep the number');
});

test('a draft with no pull request keeps its session-id address', () => {
  const { av, calls } = loadAppView();
  av._devTopic = { kind: 'proposal', id: 7296 };
  assert.equal(av._canonicalizeChangeAddress({ id: 7296, pr_number: null }), false);
  assert.deepEqual(calls, []);
});

test('the redirect touches only this topic’s own proposals/<id> address', () => {
  const other = loadAppView({ pathname: '/app/notes/dev/proposals/17296' });
  other.av._devTopic = { kind: 'proposal', id: 7296 };
  assert.equal(other.av._canonicalizeChangeAddress({ id: 7296, pr_number: 4509 }), false);
  assert.deepEqual(other.calls, []);
  const stale = loadAppView();
  stale.av._devTopic = { kind: 'proposal', id: 7296 };
  assert.equal(stale.av._canonicalizeChangeAddress({ id: 7297, pr_number: 4509 }), false,
    'a row for another session is not this page');
});

test('the topic page looks a PR number up on the server, and a miss is no session', async () => {
  const hit = loadAppView({ fetchAnswer: { sessionId: 7296, prNumber: 4509 } });
  assert.equal(await hit.av._sessionIdForChange(4509), 7296);
  assert.deepEqual(hit.fetched, ['/api/apps/notes/changes/4509']);
  const miss = loadAppView();
  assert.equal(await miss.av._sessionIdForChange(4509), null);
});

test('a changes/<N> link with no change on this app falls back like any missing topic', () => {
  const src = read('public/js/app-view.js');
  const body = src.slice(src.indexOf('  async _renderTopicSubView(content, ref) {'));
  const lookup = body.slice(0, body.indexOf('AppView._devTopic = ref.pr'));
  assert.match(lookup, /ref\.kind === 'proposal' && !ref\.id && ref\.pr/);
  assert.match(lookup, /_sessionIdForChange\(ref\.pr\)/);
  assert.match(lookup, /if \(!id\) \{[\s\S]*App\.switchTab\('dev'\)/,
    'no session for the number: the same card-list fallback as a bad id');
  assert.match(body, /AppView\._canonicalizeChangeAddress\(AppView\._findTopicItem\(\)\)/,
    'the old address is rewritten once the change has resolved');
});

test('opening a change from a card goes straight to its PR-number address', () => {
  const { av, calls } = loadAppView();
  av._proposals = [{ id: 7296, pr_number: 4509 }];
  av.openTopic('proposal', 7296);
  const sw = calls.find(([kind]) => kind === 'switchTab');
  assert.deepEqual(JSON.parse(JSON.stringify(sw.slice(1))),
    ['dev', { kind: 'proposal', id: 7296, pr: 4509 }, 'topic']);
});

// ── The link builders ───────────────────────────────────────────────────

test('the shared builders pick the PR number when there is one', () => {
  const { changeHref } = require('../src/services/change-destination');
  assert.equal(changeHref('notes', 7296, 4509), '#app/notes/dev/changes/4509');
  assert.equal(changeHref('notes', 7296, null), '#app/notes/dev/proposals/7296');
  assert.equal(changeHref('notes', 7296, 0), '#app/notes/dev/proposals/7296');
  const fe = loadTsx('frontend/src/lib/change-href.ts');
  assert.equal(fe.changeHref('notes', 7296, 4509), '#app/notes/dev/changes/4509');
  assert.equal(fe.changeHref('notes', 7296), '#app/notes/dev/proposals/7296');
});

test('builders that know the PR number use it', () => {
  // Request and change pages: "Addressed by" and "Went live as part of".
  const view = read('public/js/app-view.js');
  assert.match(view, /href: n \? `#app\/\$\{slug\}\/dev\/changes\/\$\{n\}` : `#app\/\$\{slug\}\/dev\/proposals\/\$\{ref\.sessionId\}`/);
  assert.match(view, /href: n \? `#app\/\$\{slug\}\/dev\/changes\/\$\{n\}` : `#app\/\$\{slug\}\/dev\/proposals\/\$\{id\}`/);
  // Notifications open a change by its number.
  const notif = read('frontend/src/features/notifications/notifications.js');
  assert.match(notif, /_changeRef\(item\.sessionId, item\.prNumber\)/);
  // Shared cards, the bot's tray and activity cards, the PR body's shots link.
  for (const rel of [
    'src/services/shared-objects.js', 'src/services/homeroom-bot-tray.js',
    'src/services/homeroom-bot-activity.js', 'src/services/pr-metadata.js',
    'src/services/homeroom-bot-live.js', 'src/services/suggest-back.js',
    'frontend/src/features/admin/admin-small-changes.tsx', 'frontend/src/features/admin/admin-gallery.tsx',
    'frontend/src/features/profile/profile-store.js',
    'frontend/src/features/dev-board/workshop/community-card.tsx',
  ]) {
    assert.match(read(rel), /changeHref|dev\/changes\//, `${rel} builds the PR-number link`);
  }
});

test('connector webPath keeps the session id an agent passes back', () => {
  // mcp-charter: "proposalId … the last number in webPath".
  const { changeWebPath } = require('../src/services/change-destination');
  assert.equal(changeWebPath('https://h.test', 'notes', 7296), 'https://h.test/#app/notes/dev/proposals/7296');
});

test('the side panel and link embeds read dev/changes/<N> as a change', () => {
  const routes = loadTsx('frontend/src/features/side-panel/routes.ts');
  const page = routes.panelPage('app/notes/dev/changes/4509');
  assert.equal(page.kind, 'proposal');
  assert.equal(page.key, 'app/notes/dev/changes/4509');
  assert.equal(routes.parentRoute('app/notes/dev/changes/4509'), routes.parentRoute('app/notes/dev/proposals/7296'),
    'Back climbs to the same Workshop from either spelling');
  const links = loadTsx('frontend/src/features/messages/homeroom-links.ts');
  const link = links.pageOf('app/notes/dev/changes/4509');
  assert.equal(link.type, 'proposal');
  assert.equal(link.prNumber, 4509);
  assert.equal(link.sessionId, undefined, 'the number is never taken for a session id');
  assert.equal(link.href, '#app/notes/dev/changes/4509');
  assert.notEqual(link.key, links.pageOf('app/notes/dev/proposals/4509').key,
    'PR #4509 and session 4509 are two different cards');
  assert.equal(links.sameItem(link, { type: 'proposal', appSlug: 'notes', prNumber: 4509, sessionId: 7296 }), true);
  assert.equal(links.sameItem(link, { type: 'proposal', appSlug: 'notes', sessionId: 4509 }), false);
});

test('a fix asked with a changes/<N> link picks that change, by its PR number', () => {
  const { pickChange } = require('../src/services/homeroom-bot-chat');
  const changes = [
    { id: 7296, prNumber: 4509, issueNumber: 1, title: 'Dark mode' },
    { id: 4509, prNumber: 4600, issueNumber: 2, title: 'Light mode' },
  ];
  const byPr = pickChange({ words: 'fix https://h.test/app/notes/dev/changes/4509 please', changes, slug: 'notes' });
  assert.equal(byPr.change.id, 7296, 'the number is the PR, never taken for session 4509');
  const byId = pickChange({ words: 'fix #app/notes/dev/proposals/4509', changes, slug: 'notes' });
  assert.equal(byId.change.id, 4509, 'the old spelling is still a session id');
  assert.equal(pickChange({ words: 'see /app/other/dev/changes/4509', changes, slug: 'notes' }), null,
    'another app’s link is not this one’s change');
});
