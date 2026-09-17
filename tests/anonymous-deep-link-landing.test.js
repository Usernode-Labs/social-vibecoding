// #2375 — a signed-out visitor who follows a deep link lands on the landing
// page, and signing in from there still carries them to that link.
//
// Before, restoreFromHash answered every non-auth address (`/#settings`,
// `/app/<slug>/full`, a shared thread) with the bare sign-in form, and only a
// bare `/` reached the landing page and its Sign in / Join waitlist header.
// Now both land; the deep link is remembered on the way in.
//
// The part worth executing rather than pattern-matching is the hand-off: the
// remembered link lives only in memory (`AuthScreens._pendingHash`), and the
// visitor now takes one more step — landing's Sign in, `#login` — before any
// credential exchange. If that step cleared or overwrote it, sign-in would
// quietly end on the home feed. So this loads the real app.js router and the
// real auth-screens.js together and walks the whole path.
//
// Run with: node --test tests/anonymous-deep-link-landing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'public/js/auth-screens.js'), 'utf8');

const ORIGIN = 'https://usernode.example';

function boot(initial = {}) {
  const location = {
    origin: ORIGIN,
    pathname: initial.pathname || '/',
    search: initial.search || '',
    hash: initial.hash || '',
    replace(value) { applyUrl(value); },
  };
  Object.defineProperty(location, 'href', {
    get() { return `${ORIGIN}${location.pathname}${location.search}${location.hash}`; },
    set(value) { applyUrl(value); },
  });
  function applyUrl(value) {
    const next = new URL(value, location.href);
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  }
  const replaced = [];
  const history = {
    state: null,
    pushState(_state, _title, value) { applyUrl(value); },
    replaceState(_state, _title, value) {
      replaced.push(value);
      applyUrl(value);
    },
  };
  const element = {
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, appendChild() {},
    style: {},
  };
  const entered = [];
  const sandbox = {
    console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    location,
    history,
    navigator: {},
    document: {
      visibilityState: 'visible',
      title: '',
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return element; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { ...element }; },
      head: element,
      body: element,
      documentElement: element,
    },
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async (url) => {
      if (url === '/api/auth/me') {
        return { ok: true, status: 200, json: async () => ({ user: { id: 7, hasPlatformAccess: true } }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
    PlatformUI: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox);
  vm.runInContext(AUTH_SRC, sandbox);
  const { App, AuthScreens } = sandbox;
  App.user = null;
  App._setScreenVisible = () => {};
  App.clearSessionSnapshot = () => {};
  App.enterAuthed = (user) => entered.push({ user, url: location.pathname + location.search + location.hash });
  return { App, AuthScreens, location, replaced, entered };
}

// What landing's Sign in (`href="#login"`) does: a hash assignment, which
// fires hashchange, which runs the router again.
function followSignIn(harness) {
  harness.location.hash = '#login';
  harness.App.restoreFromHash();
}

test('a fragment deep link lands, is remembered, and survives Sign in into finishLogin', async () => {
  const h = boot({ hash: '#settings/connectors' });
  h.App.restoreFromHash();
  assert.equal(h.AuthScreens._current, 'landing',
    'a signed-out deep link is answered with the landing page, not the sign-in form');
  assert.equal(h.AuthScreens._pendingHash, '#settings/connectors');

  followSignIn(h);
  assert.equal(h.AuthScreens._current, 'login');
  assert.equal(h.AuthScreens._pendingHash, '#settings/connectors',
    'opening the sign-in form from landing keeps the remembered link');

  await h.AuthScreens.finishLogin();
  assert.equal(h.replaced.at(-1), '/#settings/connectors',
    'sign-in restores the deep link onto the URL before the authed boot');
  assert.equal(h.entered.length, 1);
  assert.equal(h.entered[0].url, '/#settings/connectors');
  assert.equal(h.AuthScreens._pendingHash, '', 'and consumes it');
});

test('a clean app path lands too, and sign-in returns to it with its query', async () => {
  const h = boot({ pathname: '/app/notes/full', search: '?path=%2Ft%2F12' });
  h.App.restoreFromHash();
  assert.equal(h.AuthScreens._current, 'landing');
  assert.equal(h.AuthScreens._pendingHash, '/app/notes/full?path=%2Ft%2F12');

  followSignIn(h);
  assert.equal(h.AuthScreens._current, 'login');

  await h.AuthScreens.finishLogin();
  assert.equal(h.replaced.at(-1), '/app/notes/full?path=%2Ft%2F12');
  assert.equal(h.entered[0].url, '/app/notes/full?path=%2Ft%2F12');
});

test('a bare / lands with nothing remembered, so sign-in goes home', async () => {
  const h = boot();
  h.App.restoreFromHash();
  assert.equal(h.AuthScreens._current, 'landing');
  assert.equal(h.AuthScreens._pendingHash, '');

  followSignIn(h);
  await h.AuthScreens.finishLogin();
  assert.equal(h.replaced.at(-1), '/');
});

test('an explicit auth address still opens its own screen', () => {
  for (const [hash, screen] of [['#login', 'login'], ['#signup', 'signup'], ['#waitlist', 'waitlist']]) {
    const h = boot({ hash });
    h.App.restoreFromHash();
    assert.equal(h.AuthScreens._current, screen, `${hash} is not redirected to landing`);
    assert.equal(h.AuthScreens._pendingHash, '', `${hash} is not a deep link`);
  }
});
