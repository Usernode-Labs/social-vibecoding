'use strict';

// #6016: one table of repository addresses, answered by all three places that
// decide whether an address names a repository:
//
//   - the server's parser, src/services/repo-ref.js parse()
//   - the browser's shared predicate, frontend/src/lib/repo-link.js namesRepo
//     (run from the shipped text through tests/lib/repo-link.js)
//   - the real Suggest an improvement dialog, whose "This app" option is
//     enabled exactly when the predicate is true.
//
// The two sides answer different questions — the server identifies the host,
// the browser only asks "has an owner and a name" — so each row carries its
// own expected answer per side. What must hold is that the browser accepts
// every address the server accepts, and rejects every address that names no
// repository at all.
//
// Run with: node --test tests/repo-address-table.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRef = require('../src/services/repo-ref');
const { repoLink, installRepoLink, REPO_LINK_RAW } = require('./lib/repo-link');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The git host this table is read against (tests/repo-ref.test.js's env).
const HOST_ENV = {
  GIT_HOST_URL: 'https://git.onhomeroom.com',
  GIT_HOST_INTERNAL_URL: 'http://forgejo-http.forgejo:3000',
  GIT_HOST_ORG: 'apps',
};

function withEnv(t) {
  const prior = {};
  for (const [k, v] of Object.entries(HOST_ENV)) {
    prior[k] = process.env[k];
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// address, the server's host (or null), the browser's answer
const ROWS = [
  ['https://github.com/acme/app', 'github', true],
  ['git@github.com:acme/app.git', 'github', true],
  ['https://git.onhomeroom.com/apps/mountain-trail', 'git_host', true],
  ['http://forgejo-http.forgejo:3000/apps/x.git', 'git_host', true],
  ['https://code.example.org/team/app', null, true], // a self-hosted Forgejo
  ['https://gitlab.com/o/r', null, true],
  ['https://github.com/o', null, false],
  ['https://git.onhomeroom.com/apps', null, false],
  ['', null, false],
  [null, null, false],
  ['not a url', null, false],
  ['javascript:alert(1)', null, false],
];

test('each side answers its own question for every address', (t) => {
  withEnv(t);
  for (const [address, host, names] of ROWS) {
    const parsed = repoRef.parse(address);
    assert.equal(parsed ? parsed.host : null, host, `repo-ref host for ${JSON.stringify(address)}`);
    assert.equal(repoLink.namesRepo(address), names, `namesRepo for ${JSON.stringify(address)}`);
  }
});

test('the two sides agree where they must', (t) => {
  withEnv(t);
  for (const [address] of ROWS) {
    const parsed = repoRef.parse(address);
    if (parsed) {
      assert.equal(repoLink.namesRepo(address), true,
        `${JSON.stringify(address)} is a repository to the server, so it is one to the browser`);
    }
    if (!repoLink.namesRepo(address)) {
      assert.equal(parsed, null,
        `${JSON.stringify(address)} names no repository to the browser, so none to the server either`);
    }
  }
});

test('the predicate is the shipped one, in both of its published forms', () => {
  // The file publishes itself as window.RepoLink for classic scripts.
  assert.match(REPO_LINK_RAW, /const RepoLink = \{[^}]*\bnamesRepo\b[^}]*\};/);
  const sandbox = {};
  const installed = installRepoLink(sandbox);
  for (const [address, , names] of ROWS) {
    assert.equal(installed.namesRepo(address), names, `installed namesRepo for ${JSON.stringify(address)}`);
    assert.equal(sandbox.RepoLink.namesRepo(address), names);
  }
});

test('an empty or missing address is not a repository', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, [], 'https://github.com', 'git@github.com:']) {
    assert.equal(repoLink.namesRepo(bad), false, JSON.stringify(bad));
  }
});

test('the real dialog enables "This app" exactly when the address names a repository', (t) => {
  withEnv(t);
  for (const [address, , names] of ROWS) {
    const h = makeHarness({ appData: { name: 'Example App', repo_url: address } });
    h.open();
    assert.equal(h.el('feedback-target-app').disabled, !names,
      `#feedback-target-app for ${JSON.stringify(address)} should be ${names ? 'enabled' : 'disabled'}`);
  }
  // A project with no address at all: not selectable, as before.
  const none = makeHarness({ appData: { name: 'No Repo' } });
  none.open();
  assert.equal(none.el('feedback-target-app').disabled, true);
});

test('both browser copies ask the one helper and keep no rule of their own', () => {
  const dialog = read('frontend/src/features/dialogs/feedback-controller.js');
  const pin = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(dialog, /import \{ namesRepo \} from '\.\.\/\.\.\/lib\/repo-link\.js';/);
  assert.equal((dialog.match(/namesRepo\(/g) || []).length, 1, 'the controller calls it once');
  assert.match(dialog, /const hasRepo = namesRepo\(repoUrl\);/);
  assert.match(pin, /import \{ namesRepo \} from '\.\.\/\.\.\/lib\/repo-link\.js';/);
  assert.equal((pin.match(/!namesRepo\(data\.repo_url\)/g) || []).length, 2,
    'comment mode asks it at both of its sites');
  for (const src of [dialog, pin]) {
    assert.doesNotMatch(src, /\^https\?:/, 'no copy of the repository regex');
  }
  // The controller's prose names github.com while explaining why the rule is
  // no longer GitHub-only; comment mode must not mention it at all.
  assert.doesNotMatch(pin, /github\\?\.com/, 'no github-only rule');
});

const CONTROLLER_TEXT = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback-controller.js'), 'utf8');
const FEEDBACK_SRC = CONTROLLER_TEXT
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  + '\n;globalThis.Feedback = Feedback;\n';

function makeEl(id) {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  const children = new Map();
  return {
    id,
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    className: '',
    innerHTML: '',
    placeholder: '',
    disabled: false,
    checked: false,
    focused: 0,
    listeners,
    classes,
    attrs,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
    },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev, arg) { for (const fn of (listeners[ev] || [])) fn(arg); },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeEl(`${id}${sel}`));
      return children.get(sel);
    },
    querySelectorAll: () => [],
    focus() { this.focused += 1; },
    click() { this.fire('click', { target: this, currentTarget: this }); },
  };
}

// `appData` poses the context the dialog opens in. null is home/leaderboard
// (no app open); a repo_url with no self_hosted flag is an ordinary app on
// its App or Dev tab, which is the two-destination case.
function makeHarness({ appData = null, sessionDraft = null } = {}) {
  const els = new Map();
  const fetchCalls = [];
  let timerId = 0;
  const timers = new Map();

  const AppView = {
    appData,
    issueStateAvailable: () => false,
    collectIssueState: async () => null,
    createPrForIssue: async () => {},
    close: () => {},
  };

  const sandbox = {
    // The binding the controller's i18n import gives it (the import line is stripped above).
    t: englishPlatformI18n().t,
    // #6016: the controller's namesRepo import (lib/repo-link.js), stripped
    // above like its other imports: the shipped predicate runs here.
    namesRepo: require('./lib/repo-link').repoLink.namesRepo,
    // The controller's KUDOS_PARKED import, stripped above too: these suites
    // drive the bounty row with the switch off (#5249). The parked state is
    // pinned in tests/feedback-bounty-ui.test.js.
    KUDOS_PARKED: false,
    console: { ...console, warn: () => {}, debug: () => {} },
    URLSearchParams,
    location: { search: '', hash: '', pathname: '/' },
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: (tag) => makeEl(tag),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      if (url === '/api/feedback/title') {
        return { ok: true, json: async () => ({ title: 'Generated Title' }) };
      }
      return { ok: true, json: async () => ({ issueUrl: 'https://example.invalid/1' }) };
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: {
      getItem: () => (sessionDraft ? JSON.stringify(sessionDraft) : null),
      setItem: () => {},
      removeItem: () => {},
    },
    AppView,
    PlatformUI: { pullToRefresh: () => {}, toast: () => {} },
    App: new Proxy({}, {
      get: (t, p) => t[p],
      set: (t, p, v) => { t[p] = v; return true; },
    }),
    alert: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FEEDBACK_SRC, sandbox);
  sandbox.init();

  // What the shell's own open path establishes before Feedback._open runs.
  sandbox.App.currentApp = appData ? 'example-app' : null;
  sandbox.App.currentTab = appData ? 'app' : 'home';
  sandbox.App.user = { id: 7 };

  const el = (id) => sandbox.document.getElementById(id);
  el('feedback-text-error').classList.add('hidden');
  el('feedback-modal').classList.add('hidden');

  return {
    sandbox,
    el,
    fetchCalls,
    open(opts = {}) { sandbox.Feedback._open(opts); },
    filed: () => fetchCalls.filter((c) => c.url === '/api/feedback'),
    hintShown: () => !el('feedback-target-hint').classList.contains('hidden'),
    checked: (which) => el(`feedback-target-${which}`).getAttribute('aria-checked'),
    caretShown: (which) => !el(`feedback-caret-${which}`).classList.contains('hidden'),
    async submit() {
      el('feedback-submit').fire('click');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    type(text) {
      el('feedback-text').value = text;
      el('feedback-text').fire('input');
    },
  };
}

