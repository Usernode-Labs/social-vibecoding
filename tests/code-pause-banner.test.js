// The project page's "code changes are paused" banner.
//
// Since the move off GitHub (25 Oct 2026) app code lives on Homeroom's own
// git host; only the platform's own repository is still on GitHub. While
// GitHub is paused (services/github-pause.js) nothing reaches it, so a change
// to that project's code cannot be proposed, pushed or merged from Homeroom:
// the worker's push and the merge each refuse. The project page says so
// once, above the cards, beside the merges-paused and release-stalled
// banners, and says that requests and discussions still work.
//
// Pinned here: the flag (true only for a repository on GitHub while GitHub
// is paused), the app payload that carries it (GET /api/apps/:slug
// `codeChangesPaused`), the writer (`AppView._renderCodePauseNotice`, beside
// the other two notices) and the render (absent for every other project; the
// amber sentence when paused, from the catalog).
//
// Run with: node --test tests/code-pause-banner.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const APP_VIEW_SRC = read('public', 'js', 'app-view.js');
const MOUNT_SRC = read('frontend', 'src', 'features', 'dev-board', 'mount.ts');
const APPS_SRC = read('src', 'routes', 'apps.js');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/code-pause-api.ts')));

const FRAME_PROPS = {
  selfHosted: true, readOnly: false, canCollaborate: true, showsMembers: false,
  cardCls: 'card', cardHoverCls: 'card-hover',
};

function bannerHtml(state) {
  const m = mod();
  m.codePauseStore.set({ ...state });
  const html = renderToHtml(createElement(m.DevBoardFrame, FRAME_PROPS));
  const at = html.indexOf('<div id="dev-code-pause-notice"');
  assert.ok(at >= 0, 'the frame has the banner slot');
  const end = html.indexOf('<div id="dev-body"', at);
  assert.ok(end > at, 'the banner sits above the board body');
  return html.slice(at, end);
}

test('codeChangesPaused: a repository on GitHub, while GitHub is paused, and nothing else', () => {
  const prev = process.env.GIT_HOST_URL;
  process.env.GIT_HOST_URL = 'https://git.onhomeroom.com';
  const pause = require('../src/services/github-pause');
  try {
    pause._setForTests({ on: true, deadStatus: null });
    assert.equal(pause.codeChangesPaused('https://github.com/Usernode-Labs/social-vibecoding'), true);
    assert.equal(pause.codeChangesPaused('https://git.onhomeroom.com/apps/notes-1a2b3c'), false,
      'a project on the git host is not held by GitHub');
    assert.equal(pause.codeChangesPaused(null), false);
    assert.equal(pause.codeChangesPaused(''), false);
    pause._setForTests({ on: false, deadStatus: null });
    assert.equal(pause.codeChangesPaused('https://github.com/Usernode-Labs/social-vibecoding'), false,
      'GitHub not paused: nothing is held');
    pause._setForTests({ on: false, deadStatus: 401 });
    assert.equal(pause.codeChangesPaused('https://github.com/Usernode-Labs/social-vibecoding'), true,
      'a dead bot token pauses GitHub too');
  } finally {
    pause._setForTests({ on: false, deadStatus: null });
    if (prev === undefined) delete process.env.GIT_HOST_URL; else process.env.GIT_HOST_URL = prev;
  }
});

test('the project payload carries it, read from the app\'s own repository', () => {
  const at = APPS_SRC.indexOf("router.get('/api/apps/:slug', async");
  const route = APPS_SRC.slice(at, APPS_SRC.indexOf('res.json({ app: appPayload });', at));
  assert.match(route, /codeChangesPaused: require\('\.\.\/services\/github-pause'\)\.codeChangesPaused\(appRow\.repo_url\),/);
});

test('the store is published from the app record, beside the other two notices', () => {
  assert.match(MOUNT_SRC, /publishCodePause\(state\) \{\s*codePauseStore\.set\(state\);/);
  assert.match(APP_VIEW_SRC,
    /AppView\._renderMainPauseNotice\(\);\s*AppView\._renderReleaseStallNotice\(\);\s*AppView\._renderCodePauseNotice\(\);/);

  const published = [];
  const sandbox = {
    console,
    PlatformI18n: englishPlatformI18n(),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {} },
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    UsernodeReact: { devBoard: { publishCodePause: (s) => published.push({ ...s }) } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${read('public', 'js', 'merge-status.js')}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  for (const appData of [
    { slug: 'usernode-2d5619', codeChangesPaused: true },
    { slug: 'notes-1a2b3c', codeChangesPaused: false },
    { slug: 'older-server' },
    null,
  ]) {
    AppView.appData = appData;
    AppView._renderCodePauseNotice();
  }
  assert.deepEqual(published, [
    { paused: true, slug: 'usernode-2d5619' },
    { paused: false, slug: 'notes-1a2b3c' },
    { paused: false, slug: 'older-server' },
    { paused: false, slug: null },
  ]);
});

test('every other project draws nothing: the initial render is the hidden, empty slot', () => {
  const { codePauseStore } = mod();
  assert.deepEqual({ ...codePauseStore.get() }, { paused: false, slug: null });
  const html = bannerHtml({ paused: false, slug: 'notes-1a2b3c' });
  assert.match(html, /^<div id="dev-code-pause-notice" class="px-3 pt-2 hidden"><\/div>/,
    'absent, not hidden inside, so a project that is fine carries no extra node');
});

test('paused: amber, above the cards, saying what is held and what still works', () => {
  const html = bannerHtml({ paused: true, slug: 'usernode-2d5619' });
  assert.match(html, /<div id="dev-code-pause-notice" class="px-3 pt-2">/, 'the slot shows');
  assert.match(html, /data-code-pause="github"/);
  assert.match(html, /border-amber-500\/40 bg-amber-500\/10/, 'the same amber as the pause and release banners');
  const sentence = message('project:codePause.notice');
  assert.equal(sentence,
    'Changes to this project’s code are paused while Homeroom moves off GitHub. Requests and discussions still work.');
  assert.ok(html.includes(sentence), html);
  assert.doesNotMatch(sentence, /—/, 'no em dash in copy');
  assert.doesNotMatch(html, /<button|<a /, 'nothing here is a verb: it is the project\'s state');
});
