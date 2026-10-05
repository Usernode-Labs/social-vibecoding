'use strict';
const { withLanguage } = require('./lib/platform-language');

// An invite link opened in a browser whose session ended on the server
// (first-session run-through, 2026-10-05). The browser had been signed in as
// one test account; the account was removed, so its cookie answers 401. A
// fresh, valid invite opened there showed the ended session's cached Home and
// the toast "That invite link does not work." instead of the invite's page.
//
// Two things went wrong, and both are driven here through the real
// App._followInvite and App._reconcileSession, run in a VM over app.js:
//
//   - the follow replaced the invite address with "/" before the session had
//     been confirmed, so the reconcile's 401 reload landed on "/" and the
//     invite was lost;
//   - the link's own read answered 401 for the viewer's session, and the
//     follow told that as the link being broken.
//
// A link that really is dead still says why.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

const TOKEN = 'YigKXxtTzBB_TFZVTkjEtg';
const INVITE = `/invite/${TOKEN}`;
const SAM = { id: 41, username: 'sam_t1004', hasPlatformAccess: true };
const SNAPSHOT_KEY = 'usernode.session.v1';

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    has: (k) => map.has(k),
  };
}

function makeLocation(href) {
  let url = new URL(href);
  const loc = { reloads: [] };
  Object.defineProperties(loc, {
    href: { get: () => url.href, set: (v) => { url = new URL(v, url); } },
    origin: { get: () => url.origin },
    pathname: { get: () => url.pathname },
    search: { get: () => url.search },
    hash: { get: () => url.hash },
  });
  loc.reload = () => { loc.reloads.push(`${url.pathname}${url.search}${url.hash}`); };
  return loc;
}

const json = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

// `routes` maps a path to a function returning (a promise of) a response, or
// throwing for a read that never lands.
function harness({ routes, snapshotBoot = true, session = memoryStorage(), confirm = true } = {}) {
  const toasts = [];
  const painted = [];
  const asked = [];
  const local = memoryStorage();
  const location = makeLocation(`https://homeroom.test${INVITE}`);
  const context = vm.createContext(withLanguage({
    location,
    history: {
      pushState() {},
      replaceState(_state, _title, url) { location.href = url; },
    },
    URL, URLSearchParams, console, Promise, JSON, Date, Number, String,
    setTimeout, clearTimeout, AbortController,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: {
      title: '',
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      dispatchEvent() {},
      body: { classList: { toggle() {}, contains: () => false, add() {}, remove() {} } },
    },
    addEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    localStorage: local,
    sessionStorage: session,
    PlatformUI: {
      transition(fn, opts) { fn(); opts?.after?.(); },
      toast: (msg, opts) => toasts.push({ msg, error: !!(opts && opts.error) }),
    },
    ConfirmModal: { show: async () => confirm },
    fetch: async (url, opts) => {
      const p = new URL(url, location.href).pathname;
      asked.push(`${(opts && opts.method) || 'GET'} ${p}`);
      const route = routes[p];
      if (!route) throw new Error(`unexpected fetch ${p}`);
      return route();
    },
  }));
  context.window = context;
  vm.runInContext(appSource, context);
  const { App } = context;
  // The screens themselves are out of scope: record that Home was painted.
  App.restoreFromHash = () => painted.push(`${location.pathname}${location.search}`);
  App.connectEvents = () => {};
  App._syncViewer = () => {};
  // Boot as init() leaves it: from the snapshot (signed in, unconfirmed), or
  // from a verified /api/auth/me.
  App.user = { ...SAM };
  App._sessionFromSnapshot = snapshotBoot;
  local.setItem(SNAPSHOT_KEY, JSON.stringify({ user: SAM, savedAt: Date.now() }));
  if (!snapshotBoot) App._publishBootSession({ user: App.user });
  return { App, toasts, painted, asked, location, local, session };
}

const later = (ms, fn) => () => new Promise((resolve) => setTimeout(() => resolve(fn()), ms));
const LIVE = {
  live: true, reason: null, mine: null, slug: 'page-turners',
  project: { name: 'Page Turners' }, inviter: 'alex_t1005', inviterName: 'alex_t1005', inviterMadeIt: true, memberCount: 1,
};

test('a stale snapshot whose session the server ended: the reload lands on the invite page, and nothing calls the link broken', async () => {
  const h = harness({
    routes: {
      // The link's own read is the first to answer, as on the run-through.
      [`/api/invite-links/by-token/${TOKEN}`]: () => json(401, { error: 'Not authenticated' }),
      '/api/auth/me': later(20, () => json(401, { error: 'Not authenticated' })),
    },
  });
  const follow = h.App._followInvite(TOKEN);
  const reconcile = h.App._reconcileSession({ fromBoot: true });
  await Promise.all([follow, reconcile]);

  assert.deepEqual(h.location.reloads, [INVITE], 'one reload, onto the invite address');
  assert.deepEqual(h.toasts, [], 'no "That invite link does not work." toast');
  assert.deepEqual(h.painted, [], "the ended session's Home is never painted for the invite");
  assert.equal(h.local.has(SNAPSHOT_KEY), false, 'the stale snapshot is gone, so the reload boots signed out');
  assert.equal(await h.App._inviteFollow, false);
});

test('the worker answered /api/auth/me from its cache: the link\'s 401 is what ends the session, onto the invite page', async () => {
  const h = harness({
    routes: {
      // A cached 200 for the same account (service worker past its deadline).
      '/api/auth/me': () => json(200, { user: SAM }),
      [`/api/invite-links/by-token/${TOKEN}`]: later(20, () => json(401, { error: 'Not authenticated' })),
    },
  });
  await Promise.all([h.App._followInvite(TOKEN), h.App._reconcileSession({ fromBoot: true })]);

  assert.deepEqual(h.painted, ['/'], 'Home was painted once the session looked confirmed');
  assert.deepEqual(h.location.reloads, [INVITE], 'then the 401 reloads onto the invite address, not "/"');
  assert.deepEqual(h.toasts, []);
  assert.equal(h.local.has(SNAPSHOT_KEY), false, 'every cached trace of the ended session is dropped');
  assert.equal(h.App._sessionFromSnapshot, false);
});

test('the redeem answering 401 after the confirm is the session too, not "Could not join"', async () => {
  const h = harness({
    snapshotBoot: false,
    routes: {
      [`/api/invite-links/by-token/${TOKEN}`]: () => json(200, LIVE),
      [`/api/invite-links/by-token/${TOKEN}/redeem`]: () => json(401, { error: 'Not authenticated' }),
    },
  });
  await h.App._followInvite(TOKEN);
  assert.deepEqual(h.asked, [`GET /api/invite-links/by-token/${TOKEN}`, `POST /api/invite-links/by-token/${TOKEN}/redeem`]);
  assert.deepEqual(h.location.reloads, [INVITE]);
  assert.deepEqual(h.toasts, []);
});

test('a second 401 for the same address within the minute says signed out instead of reloading again', async () => {
  const session = memoryStorage({
    'usernode:invite-session-ended': JSON.stringify({ address: INVITE, at: Date.now() - 5000 }),
  });
  const h = harness({
    snapshotBoot: false,
    session,
    routes: { [`/api/invite-links/by-token/${TOKEN}`]: () => json(401, { error: 'Not authenticated' }) },
  });
  await h.App._followInvite(TOKEN);
  assert.deepEqual(h.location.reloads, [], 'no reload loop');
  assert.deepEqual(h.toasts, [{ msg: 'You are signed out. Sign in again to join.', error: true }]);
  assert.equal(h.local.has(SNAPSHOT_KEY), false);
});

test('an older note of a reload, or one for another link, does not hold this one back', async () => {
  for (const note of [
    { address: INVITE, at: Date.now() - 2 * 60 * 1000 },
    { address: '/invite/AAAAAAAAAAAAAAAAAAAAAA', at: Date.now() },
  ]) {
    const h = harness({
      snapshotBoot: false,
      session: memoryStorage({ 'usernode:invite-session-ended': JSON.stringify(note) }),
      routes: { [`/api/invite-links/by-token/${TOKEN}`]: () => json(401, {}) },
    });
    await h.App._followInvite(TOKEN);
    assert.deepEqual(h.location.reloads, [INVITE]);
    assert.deepEqual(h.toasts, []);
  }
});

test('a dead link still says why, for a signed-in viewer', async () => {
  const cases = [
    [404, { live: false, reason: 'unknown' }, 'That invite link does not work.'],
    [200, { live: false, reason: 'revoked' }, 'That invite link was turned off.'],
    [200, { live: false, reason: 'expired' }, 'That invite link has expired.'],
    [200, { live: false, reason: 'used_up' }, 'That invite link has been used as many times as it allows.'],
  ];
  for (const [status, body, words] of cases) {
    const h = harness({
      snapshotBoot: false,
      routes: { [`/api/invite-links/by-token/${TOKEN}`]: () => json(status, body) },
    });
    await h.App._followInvite(TOKEN);
    assert.deepEqual(h.toasts, [{ msg: words, error: true }], `${status} ${body.reason}`);
    assert.deepEqual(h.location.reloads, []);
    assert.equal(h.location.pathname, '/', 'the invite address is replaced as before');
    assert.equal(h.local.has(SNAPSHOT_KEY), true, 'a live session keeps its snapshot');
  }
});

test('a snapshot boot whose session is alive waits for the confirmation, then follows as before', async () => {
  const h = harness({
    routes: {
      '/api/auth/me': later(20, () => json(200, { user: SAM })),
      [`/api/invite-links/by-token/${TOKEN}`]: () => json(404, { live: false, reason: 'unknown' }),
    },
  });
  const follow = h.App._followInvite(TOKEN);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.location.pathname, INVITE, 'the address is kept until the session is confirmed');
  assert.deepEqual(h.painted, []);
  assert.deepEqual(h.asked, [`GET /api/invite-links/by-token/${TOKEN}`], 'the link is read meanwhile, not after');
  await Promise.all([follow, h.App._reconcileSession({ fromBoot: true })]);
  assert.deepEqual(h.painted, ['/']);
  assert.deepEqual(h.toasts, [{ msg: 'That invite link does not work.', error: true }]);
  assert.deepEqual(h.location.reloads, []);
});

test('a read that did not land is not a dead link', async () => {
  const h = harness({
    snapshotBoot: false,
    routes: { [`/api/invite-links/by-token/${TOKEN}`]: () => json(500, { error: 'Internal server error' }) },
  });
  await h.App._followInvite(TOKEN);
  assert.deepEqual(h.toasts, [{ msg: 'Could not open that invite link. Try again.', error: true }]);
});

test('offline on a snapshot boot: the shell stays signed in and the follow goes on as before', async () => {
  const offline = () => { throw new TypeError('Failed to fetch'); };
  const h = harness({
    routes: { '/api/auth/me': offline, [`/api/invite-links/by-token/${TOKEN}`]: offline },
  });
  await Promise.all([h.App._followInvite(TOKEN), h.App._reconcileSession({ fromBoot: true })]);
  assert.deepEqual(h.painted, ['/'], 'Home is painted from the snapshot');
  assert.deepEqual(h.toasts, [{ msg: 'Could not open that invite link. Try again.', error: true }]);
  assert.deepEqual(h.location.reloads, []);
  assert.equal(h.local.has(SNAPSHOT_KEY), true, 'the snapshot survives an unanswered read');
  assert.equal(h.App._sessionFromSnapshot, true);
});
