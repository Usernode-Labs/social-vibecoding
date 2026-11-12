'use strict';

// #4938, #5974: Settings › Linked devices.
//
// What this pins about the pane (frontend/src/features/settings/sections/
// linked-phones.tsx), the registry row that offers it and its routes:
//
//   - it is a part of the Account group, at #settings/phones (the key and
//     the ids stay from when it was Linked phones), named Linked devices,
//     with its own keywords, and its wrapper ships hidden like every part;
//   - the prerendered markup carries both groups' headings and no device:
//     the lists are read in an effect, so hydration matches whatever the
//     account holds;
//   - it reads GET /api/me/phones and unlinks with DELETE /api/me/phones/:id,
//     and reads GET /api/me/browser-sessions and signs out with
//     DELETE /api/me/browser-sessions/:id, same-origin browser routes that
//     answer 404 for any device that is not the signed-in account's own;
//   - Unlink and Sign out ask once more on the row before they act, and the
//     Settings menu's count is phones and browsers together;
//   - a device not used for more than 30 days says "Not used since".
//
// The services are pinned by tests/linked-phones-postgres.test.js and
// tests/linked-browsers-postgres.test.js.
//
// Run with: node --test tests/settings-linked-phones-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const escape = (text) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PANE_PATH = 'frontend/src/features/settings/sections/linked-phones.tsx';
const PANE = read(PANE_PATH);
const SECTIONS = read('frontend/src/features/settings/sections/index.tsx');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const AUTH = read('src/routes/auth.js');

test('Linked devices is a part of the Account group with its own address and keywords', () => {
  assert.match(
    SETTINGS,
    /\{ key: 'phones', label: 'settings:nav\.part\.phones', group: 'settings:nav\.group\.account' \}/
  );
  assert.match(SETTINGS, /phones: 'settings:nav\.keywords\.phones'/);
  assert.match(SECTIONS, /<PrivacySection \/>[\s\S]*<LinkedPhonesSection \/>[\s\S]*<WalletSection \/>/);
  assert.equal(message('settings:nav.part.phones'), 'Linked devices');
  assert.equal(message('settings:phones.title'), 'Linked devices');
  assert.match(message('settings:nav.subtitle.phones'), /\bbrowsers\b/i);
  assert.match(message('settings:nav.keywords.phones'), /\bdevices?\b.*\bunlink\b/);
  assert.match(message('settings:nav.keywords.phones'), /\bbrowsers?\b/);
  assert.match(message('settings:nav.keywords.phones'), /\b(laptop|computer)\b/);
});

test('the prerendered pane is hidden, names both groups and lists no device', () => {
  const { LinkedPhonesSection } = loadTsx(PANE_PATH);
  const html = renderToHtml(createElement(LinkedPhonesSection, {}));
  assert.match(html, /^<div data-settings-section="phones" class="hidden">/);
  assert.match(html, /id="settings-phones-section"/);
  assert.match(html, /<div id="settings-phones-list" class="flex flex-col"><\/div>/);
  assert.match(html, /<div id="settings-browsers-list" class="flex flex-col"><\/div>/);
  assert.ok(html.includes(escape(message('settings:phones.title'))));
  assert.ok(html.includes(escape(message('settings:phones.intro'))));
  // The two groups, phones first, each with its explaining line.
  const phones = html.indexOf(`>${escape(message('settings:phones.group.phones'))}</h4>`);
  const browsers = html.indexOf(`>${escape(message('settings:phones.group.browsers'))}</h4>`);
  assert.ok(phones > 0 && browsers > phones, 'Phones, then Browsers');
  assert.ok(html.includes(escape(message('settings:phones.phonesNote'))), 'why one phone can be two rows');
  assert.ok(html.includes(escape(message('settings:phones.browsers.note'))));
  assert.doesNotMatch(html, /data-linked-phone=/);
  assert.doesNotMatch(html, /data-linked-browser=/);
});

test('the pane reads and acts through the account\'s own routes', () => {
  assert.match(PANE, /const ENDPOINT = '\/api\/me\/phones';/);
  assert.match(PANE, /const BROWSERS_ENDPOINT = '\/api\/me\/browser-sessions';/);
  assert.match(PANE, /method: 'DELETE'/);
  assert.match(PANE, /useEffect\(\(\) => \{ void load\(\); \}, \[load\]\);/, 'read in an effect, never during render');
  assert.match(PANE, /if \(asking\) void unlink\(phone\); else setConfirming\(phone\.id\);/, 'the first press only asks');
  assert.match(PANE, /if \(asking\) void signOut\(browser\); else setConfirming\(browser\.id\);/, 'the same for a browser');
  assert.match(AUTH, /router\.get\('\/api\/me\/phones'/);
  assert.match(AUTH, /router\.delete\('\/api\/me\/phones\/:id', sameOriginBrowserOnly/);
  assert.match(AUTH, /linkedPhones\.unlinkPhone\(client, req\.user\.id, phoneId\)/, 'scoped to the signed-in account');
  assert.match(AUTH, /if \(!unlinked\) return res\.status\(404\)/);
  assert.match(AUTH, /router\.get\('\/api\/me\/browser-sessions'/);
  assert.match(AUTH, /router\.delete\('\/api\/me\/browser-sessions\/:id', sameOriginBrowserOnly/);
  assert.match(AUTH, /linkedBrowsers\.signOutBrowser\(pool, req\.user\.id, sessionId, \{ currentToken \}\)/, 'scoped to the signed-in account');
  assert.match(AUTH, /if \(!signedOut\) return res\.status\(404\)/);
  // Signing this browser out drops its cookies as logout does, so the
  // reload lands signed out rather than on a cookie that names nothing.
  assert.match(AUTH, /if \(current\) \{\s+clearSessionCookies\(res\);/);
  // The session's id is a digest prefix, never the token, and the phone
  // route is untouched for the mobile app.
  assert.doesNotMatch(AUTH, /res\.json\(\{ (phones|browsers)[^}]*token/);
});

test('every device row and confirmation is catalog text', () => {
  for (const id of [
    'settings:phones.group.phones', 'settings:phones.group.browsers', 'settings:phones.phonesNote',
    'settings:phones.platform.android', 'settings:phones.platform.ios', 'settings:phones.platform.unknown',
    'settings:phones.thisPhone', 'settings:phones.unlink', 'settings:phones.cancel',
    'settings:phones.confirm', 'settings:phones.confirmThisPhone', 'settings:phones.empty',
    'settings:phones.loadFailed', 'settings:phones.unlinkFailed',
    'settings:phones.browsers.note', 'settings:phones.browsers.empty', 'settings:phones.browsers.name',
    'settings:phones.browsers.nameSystemOnly', 'settings:phones.browsers.unknown',
    'settings:phones.browsers.thisBrowser', 'settings:phones.browsers.signOut',
    'settings:phones.browsers.confirm', 'settings:phones.browsers.confirmThisBrowser',
    'settings:phones.browsers.loadFailed', 'settings:phones.browsers.signOutFailed',
  ]) {
    assert.ok(PANE.includes(`'${id}'`), `${id} is asked for by the pane`);
    assert.ok(message(id), `${id} has English text`);
  }
  for (const [word, ids] of Object.entries({
    browser: ['chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung'],
    os: ['mac', 'windows', 'linux', 'android', 'ios', 'ipad', 'chromeos'],
  })) {
    for (const key of ids) {
      const id = `settings:phones.browsers.${word}.${key}`;
      assert.ok(PANE.includes(`'${id}'`), `${id} is asked for by the pane`);
      assert.ok(message(id), `${id} has English text`);
    }
  }
  assert.equal(
    message('settings:phones.detail', { lastUsed: 'Oct 1, 2026', linked: 'Sep 2, 2026' }),
    'Last used Oct 1, 2026 · Linked Sep 2, 2026'
  );
  assert.equal(
    message('settings:phones.detailStale', { lastUsed: 'Oct 1, 2026', linked: 'Sep 2, 2026' }),
    'Not used since Oct 1, 2026 · Linked Sep 2, 2026'
  );
  assert.equal(
    message('settings:phones.browsers.detail', { lastUsed: 'Oct 1, 2026', signedIn: 'Sep 2, 2026' }),
    'Last used Oct 1, 2026 · Signed in Sep 2, 2026'
  );
  assert.equal(
    message('settings:phones.browsers.detailStale', { lastUsed: 'Oct 1, 2026', signedIn: 'Sep 2, 2026' }),
    'Not used since Oct 1, 2026 · Signed in Sep 2, 2026'
  );
  assert.equal(message('settings:phones.browsers.name', { browser: 'Chrome', os: 'Mac' }), 'Chrome on Mac');
  assert.match(message('settings:phones.phonesNote'), /one install/i);
});

// ── The pane runs, effects and all, on a React stepped by hand ───────────
// (the harness of tests/settings-privacy-pane.test.js)
function createSteppedReact() {
  const slots = [];
  let cursor = 0;
  let component = null;
  let dirty = false;
  let queued = [];
  const h = { tree: null };
  const changed = (prev, next) => !prev || prev.some((value, i) => !Object.is(value, next[i]));
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  h.React = {
    useRef: (current) => slot(() => ({ current })),
    useState(initial) {
      const s = slot(() => {
        const state = { value: initial };
        state.set = (next) => {
          const value = typeof next === 'function' ? next(state.value) : next;
          if (!Object.is(value, state.value)) { state.value = value; dirty = true; }
        };
        return state;
      });
      return [s.value, s.set];
    },
    useCallback(fn, deps) {
      const s = slot(() => ({ fn, deps }));
      if (changed(s.deps, deps)) { s.fn = fn; s.deps = deps; }
      return s.fn;
    },
    useEffect(effect, deps) {
      const s = slot(() => ({ effect: true, deps: null, cleanup: null }));
      if (!changed(s.deps, deps)) return;
      s.deps = deps;
      queued.push(() => {
        if (s.cleanup) s.cleanup();
        s.cleanup = effect();
      });
    },
  };
  const paint = () => {
    cursor = 0;
    dirty = false;
    queued = [];
    h.tree = component({});
    for (const run of queued) run();
  };
  h.mount = (fn) => { component = fn; paint(); };
  h.settle = async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (dirty) paint();
    }
  };
  return h;
}

function findAll(node, wanted, out = []) {
  if (Array.isArray(node)) { for (const item of node) findAll(item, wanted, out); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  if (wanted(node)) out.push(node);
  findAll(node.props.children, wanted, out);
  return out;
}

const DAY = 86400e3;
const HERE = '0123456789abcdef';
const AWAY = 'fedcba9876543210';

function fakeAccount() {
  const now = Date.now();
  return {
    phones: { phones: [
      { id: `nsi_${'A'.repeat(43)}`, platform: 'android', linkedAt: new Date(now - 100 * DAY).toISOString(), lastUsedAt: new Date(now - 45 * DAY).toISOString(), current: false },
    ] },
    browsers: { browsers: [
      { id: HERE, browser: 'chrome', os: 'mac', signedInAt: new Date(now - 3 * DAY).toISOString(), lastUsedAt: new Date(now).toISOString(), current: true },
      { id: AWAY, browser: 'safari', os: 'ios', signedInAt: new Date(now - 90 * DAY).toISOString(), lastUsedAt: new Date(now - 40 * DAY).toISOString(), current: false },
      { id: '00000000deadbeef', browser: null, os: null, signedInAt: new Date(now - 1 * DAY).toISOString(), lastUsedAt: new Date(now - 1 * DAY).toISOString(), current: false },
    ] },
  };
}

function mountPane(t, account) {
  const realFetch = globalThis.fetch;
  const realWindow = globalThis.window;
  t.after(() => { globalThis.fetch = realFetch; globalThis.window = realWindow; });
  const calls = [];
  const counts = [];
  let reloads = 0;
  const windowEvents = {};
  globalThis.window = {
    location: { reload() { reloads += 1; } },
    Settings: { _setNavStatus(key, count) { counts.push([key, count]); } },
  };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url === '/api/me/phones') return { ok: true, status: 200, json: async () => account.phones };
    if (url === '/api/me/browser-sessions') return { ok: true, status: 200, json: async () => account.browsers };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const h = createSteppedReact();
  const tr = (id) => id;
  const mod = loadTsx(PANE_PATH, {
    stubs: {
      react: h.React,
      '../../../lib/i18n/react': { useMessages: () => tr },
      '../../../lib/legacy-dom': { useWindowEvent: (name, fn) => { windowEvents[name] = fn; } },
      '@/components/ui/field': { SectionHeading: () => null },
    },
  });
  h.mount(mod.LinkedPhonesSection);
  const row = (attr, id) => findAll(h.tree, (el) => el.props.attrs && el.props.attrs[attr] === id)[0];
  const fire = (name, detail) => windowEvents[name]({ type: name, detail });
  return { h, calls, counts, reloads: () => reloads, row, fire };
}

test('both groups load, the menu counts them together, and a forgotten device says so', async (t) => {
  const { h, calls, counts, row } = mountPane(t, fakeAccount());
  await h.settle();
  assert.deepEqual(calls, ['GET /api/me/phones', 'GET /api/me/browser-sessions'], 'both lists, read together');
  assert.deepEqual(counts.at(-1), ['phones', 4], 'one phone and three browsers');

  const here = row('data-linked-browser', HERE);
  assert.equal(here.props.name, 'settings:phones.browsers.name', 'Chrome on Mac');
  assert.equal(here.props.here, 'settings:phones.browsers.thisBrowser');
  assert.equal(here.props.detail, 'settings:phones.browsers.detail');
  assert.equal(here.props.actionLabel, 'settings:phones.browsers.signOut');

  const away = row('data-linked-browser', AWAY);
  assert.equal(away.props.here, null);
  assert.equal(away.props.detail, 'settings:phones.browsers.detailStale', 'not used for 40 days');

  const nameless = row('data-linked-browser', '00000000deadbeef');
  assert.equal(nameless.props.name, 'settings:phones.browsers.unknown', 'a session from before the class was kept');

  const phone = row('data-linked-phone', `nsi_${'A'.repeat(43)}`);
  assert.equal(phone.props.detail, 'settings:phones.detailStale', 'a phone not used for 45 days');
  assert.equal(phone.props.actionLabel, 'settings:phones.unlink');
});

test('Sign out asks once more, can be taken back, and signs the browser out on the second press', async (t) => {
  const { h, calls, counts, reloads, row } = mountPane(t, fakeAccount());
  await h.settle();
  calls.length = 0;

  row('data-linked-browser', AWAY).props.onAction();
  await h.settle();
  assert.equal(row('data-linked-browser', AWAY).props.asking, true);
  assert.equal(row('data-linked-browser', AWAY).props.detail, 'settings:phones.browsers.confirm');
  assert.deepEqual(calls, [], 'the first press only asks');

  row('data-linked-browser', AWAY).props.onCancel();
  await h.settle();
  assert.equal(row('data-linked-browser', AWAY).props.asking, false);
  assert.equal(row('data-linked-browser', AWAY).props.detail, 'settings:phones.browsers.detailStale');

  row('data-linked-browser', AWAY).props.onAction();
  await h.settle();
  row('data-linked-browser', AWAY).props.onAction();
  await h.settle();
  assert.deepEqual(calls, [`DELETE /api/me/browser-sessions/${AWAY}`]);
  assert.equal(row('data-linked-browser', AWAY), undefined, 'the row is gone');
  assert.equal(reloads(), 0, 'another browser: this page stays');
  assert.deepEqual(counts.at(-1), ['phones', 3], 'the menu counts one fewer');
});

test('signing this browser out warns on the row and then starts the page again signed out', async (t) => {
  const { h, calls, reloads, row } = mountPane(t, fakeAccount());
  await h.settle();
  calls.length = 0;

  row('data-linked-browser', HERE).props.onAction();
  await h.settle();
  assert.equal(row('data-linked-browser', HERE).props.detail, 'settings:phones.browsers.confirmThisBrowser');
  assert.equal(reloads(), 0);

  row('data-linked-browser', HERE).props.onAction();
  await h.settle();
  assert.deepEqual(calls, [`DELETE /api/me/browser-sessions/${HERE}`]);
  assert.equal(reloads(), 1, 'signed out here: the shell reloads signed out');
});

test('opening another page of Settings reads nothing; opening this one reads again (#6591)', async (t) => {
  const { h, calls, fire } = mountPane(t, fakeAccount());
  await h.settle();
  calls.length = 0;

  fire('usernode:settings-section', { section: 'accessibility' });
  await h.settle();
  assert.deepEqual(calls, [], 'a hidden pane does not re-read on every switch');

  fire('usernode:settings-section', { section: 'phones' });
  await h.settle();
  assert.deepEqual(calls, ['GET /api/me/phones', 'GET /api/me/browser-sessions'], 'its own page reads both lists again');
});
