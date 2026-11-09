// The project page's "code changes are paused" banner.
//
// Since the move off GitHub (25 Oct 2026) app code lives on Homeroom's own
// git host; what is still on GitHub is the platform's own repository, which
// Homeroom acts on as the GitHub App, and three apps on the suspended bot's
// account. While GitHub is paused (services/github-pause.js), or for a
// repository Homeroom cannot act on (services/github.js canActOn), a change
// to that project's code cannot be proposed, pushed or merged from Homeroom:
// the worker's push and the merge each refuse. The project page says so
// once, above the cards, beside the merges-paused and release-stalled
// banners, and says that requests and discussions still work.
//
// Pinned here: the flag (true only for a repository on GitHub that is
// paused or out of Homeroom's reach), the app payload that carries it (GET /api/apps/:slug
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

// A stand-in for the GitHub App, installed on the given accounts.
function fakeApp(logins) {
  return {
    eachInstallation: {
      async *iterator() {
        for (const [i, login] of logins.entries()) yield { installation: { id: 100 + i, account: { login } } };
      },
    },
    octokit: { auth: async () => ({ token: 'ghs_test_installation_token' }) },
  };
}

test('codeChangesPaused: a repository on GitHub that is paused or out of Homeroom\'s reach, and nothing else', async () => {
  const prev = { url: process.env.GIT_HOST_URL, repo: process.env.USERNODE_PLATFORM_REPO };
  process.env.GIT_HOST_URL = 'https://git.onhomeroom.com';
  process.env.USERNODE_PLATFORM_REPO = 'https://github.com/Usernode-Labs/social-vibecoding';
  const pause = require('../src/services/github-pause');
  const github = require('../src/services/github');
  const PLATFORM = 'https://github.com/Usernode-Labs/social-vibecoding';
  const HELD_BACK = 'https://github.com/usernode-bot/dtv-610ccb';
  try {
    pause._setForTests({ on: false, deadStatus: null });
    assert.equal(pause.codeChangesPaused('https://git.onhomeroom.com/apps/notes-1a2b3c'), false,
      'a project on the git host is not held by GitHub');
    assert.equal(pause.codeChangesPaused(null), false);
    assert.equal(pause.codeChangesPaused(''), false);

    github._setAppForTests(null);
    assert.equal(pause.codeChangesPaused(PLATFORM), true, 'no GitHub App: nothing can act on it');

    github._setAppForTests(fakeApp(['someone-else']));
    await github.checkActingInstallation();
    assert.equal(pause.codeChangesPaused(PLATFORM), true,
      'the App is not installed on the platform repository\'s owner');

    github._setAppForTests(fakeApp(['someone-else', 'usernode-labs']));
    assert.equal(pause.codeChangesPaused(PLATFORM), false,
      'not held while the first lookup is on its way: the call itself needs the installation');
    await github.checkActingInstallation();
    assert.equal(pause.codeChangesPaused(PLATFORM), false,
      'installed on its owner (matched without regard to case): code changes go ahead');
    assert.equal(pause.codeChangesPaused(HELD_BACK), true,
      'an app on the bot\'s own account stays held: Homeroom acts on GitHub only for its own repository');

    pause._setForTests({ on: true, deadStatus: null });
    assert.equal(pause.codeChangesPaused(PLATFORM), true, 'the platform setting pauses GitHub');
    pause._setForTests({ on: false, deadStatus: 401 });
    assert.equal(pause.codeChangesPaused(PLATFORM), true, 'a dead bot token, seen by an old process, pauses it too');
  } finally {
    pause._setForTests({ on: false, deadStatus: null });
    github._setAppForTests(null);
    if (prev.url === undefined) delete process.env.GIT_HOST_URL; else process.env.GIT_HOST_URL = prev.url;
    if (prev.repo === undefined) delete process.env.USERNODE_PLATFORM_REPO; else process.env.USERNODE_PLATFORM_REPO = prev.repo;
  }
});

test('on web a missing or stale reading does not hold the project, and a real pause still warns', async (t) => {
  const PLATFORM = 'https://github.com/Usernode-Labs/social-vibecoding';
  const prev = { role: process.env.PROCESS_ROLE, repo: process.env.USERNODE_PLATFORM_REPO };
  process.env.PROCESS_ROLE = 'web';
  process.env.USERNODE_PLATFORM_REPO = PLATFORM;
  const reads = require('../src/services/github-read-access');
  const pause = require('../src/services/github-pause');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const state = { record: null };
  const pool = { async query() { return { rows: [{ access: state.record }] }; } };
  const cfg = { githubAppId: '123', dataEncryptionKey: 'test-only-data-key', platformRepoUrl: PLATFORM };
  const snapshot = (installed, ageMs = 0) => ({
    scope: '123:usernode-labs/social-vibecoding', installed,
    checkedAt: new Date(now - ageMs).toISOString(),
  });
  try {
    pause._setForTests({ on: false, deadStatus: null });
    await reads.init(cfg, pool);
    assert.equal(pause.codeChangesPaused(PLATFORM), false, 'no snapshot yet is unknown, not a hold');

    state.record = snapshot(true, 7 * 60_000);
    await reads.init(cfg, pool);
    assert.equal(pause.codeChangesPaused(PLATFORM), false, 'a stale reading is unknown, not a hold');

    state.record = snapshot(false);
    await reads.init(cfg, pool);
    assert.equal(pause.codeChangesPaused(PLATFORM), true, 'the App is known to be gone');

    state.record = snapshot(true, 7 * 60_000);
    await reads.init(cfg, pool);
    pause._setForTests({ on: true });
    assert.equal(pause.codeChangesPaused(PLATFORM), true, 'a real pause still warns with the same stale snapshot');
  } finally {
    pause._setForTests({ on: false, deadStatus: null });
    await reads.init(null, null);
    if (prev.role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = prev.role;
    if (prev.repo === undefined) delete process.env.USERNODE_PLATFORM_REPO; else process.env.USERNODE_PLATFORM_REPO = prev.repo;
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
