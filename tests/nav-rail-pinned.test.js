'use strict';

// #3319 — "Keep sidebar open in apps": a desktop-only preference that keeps
// the rail docked beside a running app, with the sidebar toggle in the
// header's corner where the app's ✕ was. ON BY DEFAULT now.
//
// Pinned here:
//   1. DEFAULT ON: nothing stored keeps the rail beside an app on the desktop,
//      puts `rail-pinned` on the body and empties the back slot (no ✕) — and
//      never on a phone, where the app keeps the whole screen and its ✕.
//   2. '0' IS OFF, THE OLD BEHAVIOUR: an app covers the rail and has its ✕.
//      A '1' stored while the switch was opt-in still reads as on.
//   3. STORAGE THAT THROWS READS AS THE DEFAULT.
//   4. A PRIVATE MEMBER'S FIRST APP keeps the old arrangement: no rail, no ✕.
//   5. THE CSS IS SCOPED TO THE DESKTOP BREAKPOINT.
//   6. THE SWITCH writes the key, and its first render is checked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const appSource = read('public/js/app.js');
const css = read('public/css/app.css');

function harness({ stored = null, phone = false, throws = false, user = null, appView = null, fetch = undefined } = {}) {
  const store = new Map(stored == null ? [] : [['usernode:rail-pinned', stored]]);
  const classes = new Set();
  const slots = [];
  const scopes = [];
  const described = [];
  const localStorage = throws
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} }
    : {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, console,
    document: {
      title: '',
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      body: {
        classList: {
          toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
          contains: (c) => classes.has(c),
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
        },
      },
    },
    addEventListener() {},
    matchMedia: () => ({ matches: !phone, addEventListener() {} }),
    localStorage,
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
    ...(fetch ? { fetch } : {}),
  });
  context.window = context;
  vm.runInContext(appSource, context);
  const { App } = context;
  context.UsernodeReact = {
    nav: { setScreen() {} },
    backButton: { set: (mode) => slots.push(mode) },
    communityScope: {
      setScope: (slug) => scopes.push(slug),
      describe: (slug, patch) => described.push([slug, patch]),
    },
  };
  if (appView) context.AppView = appView;
  App.currentTab = 'app';
  App.currentApp = 'garden-ab12';
  if (user) App.user = user;
  return {
    App, store, classes, scopes, described,
    shown: () => App.Visibility.read('platform-tabs'),
    // The running app's corner, as both writers publish it.
    corner: () => App._backSlotFor('app-view')[0],
    slots,
  };
}

test('default on: the rail stays beside a running app on the desktop, with no ✕', () => {
  const { App, classes, shown, corner } = harness();
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), true, 'nothing stored keeps the rail');
  assert.equal(classes.has('rail-pinned'), true);
  assert.equal(corner(), 'none', 'the sidebar toggle is the corner, not a ✕');
  // Leaving the app takes the class with it; the rail is up as always.
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  assert.equal(classes.has('rail-pinned'), false);
});

test('switched off, an open app covers the rail and has its ✕, as before', () => {
  const { App, classes, shown, corner } = harness({ stored: '0' });
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false);
  assert.equal(classes.has('rail-pinned'), false);
  assert.equal(corner(), 'close');
  // A '1' stored while the switch was opt-in still reads as on.
  const old = harness({ stored: '1' });
  old.App._syncPlatformTabs('app-view');
  assert.equal(old.shown(), true);
  assert.equal(old.corner(), 'none');
});

test('it does not reach the phone, chromeless, or the app\'s Workshop', () => {
  const phone = harness({ phone: true });
  phone.App._syncPlatformTabs('app-view');
  assert.equal(phone.shown(), false, 'a phone\'s app keeps the whole screen');
  assert.equal(phone.classes.has('rail-pinned'), false);
  assert.equal(phone.corner(), 'close', '…and its ✕');

  const { App, classes, shown } = harness();
  App.setChromeless(true);
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false, 'chromeless still takes the rail');
  App.setChromeless(false);
  App.currentTab = 'dev';
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), true, 'the app\'s Workshop has its rail anyway');
  assert.equal(classes.has('rail-pinned'), false, 'but it is not the running-app case');
});

test('a private member\'s first app keeps the old arrangement: no rail, and no ✕', () => {
  const { App, classes, shown, corner } = harness({ user: { id: 7, privateMember: true } });
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false, 'the mark menu\'s "Go to Homeroom" is the way on');
  assert.equal(classes.has('rail-pinned'), false);
  assert.equal(corner(), 'none');
});

// Anybody new the first session still owes its walk on Home (a maker of
// their first project, somebody new by an invite) is offered the same "Go to
// Homeroom" in the mark menu, and gets the same arrangement until they use it.
test('a newcomer owed the walk on Home gets the same: no rail and no ✕, until they go to Homeroom', () => {
  const walkKey = 'usernode:first-session:walk:7';
  const owed = harness({ user: { id: 7 } });
  owed.store.set(walkKey, JSON.stringify({ slug: 'notes-ab12', name: 'Notes' }));
  owed.App._syncPlatformTabs('app-view');
  assert.equal(owed.shown(), false);
  assert.equal(owed.classes.has('rail-pinned'), false);
  assert.equal(owed.corner(), 'none', '"Go to Homeroom" is the way on');

  // Once they have used it (goHome notes it), the app has its ✕ again.
  owed.store.set('usernode:private-home:7', String(Date.now()));
  owed.App._syncPlatformTabs('app-view');
  assert.equal(owed.corner(), 'none', 'the rail is back beside the app on a desktop');
  assert.equal(owed.shown(), true);

  // A walk that has run, or a record without a project, owes nothing.
  for (const value of ['done', '{}', 'not json']) {
    const after = harness({ user: { id: 7 } });
    after.store.set(walkKey, value);
    after.App._syncPlatformTabs('app-view');
    assert.equal(after.shown(), true, value);
  }
  // Somebody else's walk on this device is not theirs.
  const other = harness({ user: { id: 8 } });
  other.store.set(walkKey, JSON.stringify({ slug: 'notes-ab12', name: 'Notes' }));
  other.App._syncPlatformTabs('app-view');
  assert.equal(other.shown(), true);
});

// Kept by the account (Evan, 20 Oct 2026: "Shouldn't this be per account?"):
// /api/auth/me's homeWalkOwed and homeroomReached ride App.user, so a second
// device, with nothing of its own stored, agrees with the first.
test('the walk owed and Homeroom reached are the account\'s, so every device agrees', () => {
  // Owed on the account, nothing on this device: no ✕, no rail.
  const owed = harness({ user: { id: 7, homeWalkOwed: true } });
  owed.App._syncPlatformTabs('app-view');
  assert.equal(owed.shown(), false);
  assert.equal(owed.corner(), 'none');
  // Reached on the account (on another device): the app as anybody has it,
  // a private member's included.
  for (const user of [{ id: 7, homeroomReached: true }, { id: 7, privateMember: true, homeroomReached: true }]) {
    const reached = harness({ user });
    reached.store.set('usernode:first-session:walk:7', JSON.stringify({ slug: 'notes-ab12', name: 'Notes' }));
    reached.App._syncPlatformTabs('app-view');
    assert.equal(reached.shown(), true, JSON.stringify(user));
  }
  // The walk having run on this device is Homeroom reached too.
  const ran = harness({ user: { id: 7, privateMember: true } });
  ran.store.set('usernode:first-session:walk:7', 'done');
  ran.App._syncPlatformTabs('app-view');
  assert.equal(ran.shown(), true);
});

test('"Go to Homeroom" tells the account at once, and this document\'s user has it before the write lands', async () => {
  const posts = [];
  const fetch = (url, init) => { posts.push([url, init.method, JSON.parse(init.body)]); return Promise.resolve({ ok: true }); };
  const { App, store } = harness({ user: { id: 7, homeWalkOwed: true }, fetch });
  App._noteHomeWalk('owed');
  assert.deepEqual(posts, [], 'owed already: nothing to say');
  App._notePrivateHome();
  assert.ok(store.get('usernode:private-home:7'), 'this device\'s record, as before');
  assert.equal(App.user.homeroomReached, true);
  assert.equal(App.user.homeWalkOwed, false);
  assert.deepEqual(posts, [['/api/me/home-walk', 'POST', { state: 'reached' }]]);
  App._notePrivateHome();
  App._noteHomeWalk('owed');
  assert.equal(posts.length, 1, 'once reached, nothing more is written, and never owed again');
  assert.equal(App._privateNoClose(), false);
  // A write that fails costs the other devices the answer and nothing here.
  const failing = harness({ user: { id: 8 }, fetch: () => Promise.reject(new Error('offline')) });
  assert.doesNotThrow(() => failing.App._noteHomeWalk('owed'));
  assert.equal(failing.App.user.homeWalkOwed, true);
  const none = harness({ user: { id: 9 } });
  assert.doesNotThrow(() => none.App._noteHomeWalk('reached'), 'no fetch at all');
  assert.doesNotThrow(() => none.App._noteHomeWalk('bogus'));
  assert.equal(none.App.user.homeroomReached, true);
});

test('storage that throws reads as the default', () => {
  const { App, shown } = harness({ throws: true });
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), true);
  assert.doesNotThrow(() => App.setRailPinned(false));
});

test('setRailPinned writes the key and re-decides the rail and the corner at once', () => {
  const { App, store, shown, slots } = harness();
  // The router has revealed the app; the switch re-decides for that screen.
  App._revealedScreen = 'app-view';
  App._syncPlatformTabs();
  assert.equal(shown(), true);
  App.setRailPinned(false);
  assert.equal(store.get('usernode:rail-pinned'), '0');
  assert.equal(shown(), false);
  assert.equal(slots.at(-1), 'close', 'the ✕ is back the moment the rail goes');
  App.setRailPinned(true);
  assert.equal(store.has('usernode:rail-pinned'), false, 'on is the default: nothing stored');
  assert.equal(shown(), true);
  assert.equal(slots.at(-1), 'none');
  // Off the running app, the corner is the screen's own and is left alone.
  App._revealedScreen = 'settings-screen';
  const before = slots.length;
  App.setRailPinned(false);
  assert.equal(slots.length, before);
});

test('the running app\'s two corner writers agree (_backSlotFor and switchTab)', () => {
  // switchTab's App branch publishes the table's own answer rather than a
  // literal ✕, so the rail and the corner cannot disagree.
  assert.match(appSource,
    /if \(tab === 'app'\) \{[\s\S]{0,1200}App\.setBackIcon\(\.\.\.App\._backSlotFor\('app-view'\)\);\s*AppView\.renderAppTab\(\);/);
  assert.doesNotMatch(appSource, /App\.setBackIcon\('close',/);
  assert.match(appSource, /if \(App\._railBesideApp\(\)\) return \['none'\];/);
  assert.match(appSource, /const railPinned = inApp && App\._railBesideApp\(\);/);
});

// The Communities tab is on screen beside the app now, so it names the app's
// community rather than the last project page left, and a press on it goes to
// this app's Workshop (App.resumeWorkshopView reads the same view).
const VIEW_KEY = 'usernode_workshop_view_v1';
const garden = { launchRecordFor: (slug) => (slug === 'garden-ab12'
  ? { slug, name: 'Garden', icon_url: '/garden.png', icon_emoji: null } : null) };

test('an app opened beside the rail puts the Communities tab on its community', () => {
  const { App, store, scopes, described } = harness({ appView: garden });
  store.set(VIEW_KEY, JSON.stringify({ slug: 'whiteboard-cd34', path: '/app/whiteboard-cd34/dev/issues/7' }));
  App._syncPlatformTabs('app-view');
  assert.equal(scopes.at(-1), 'garden-ab12', 'the tab is on the open app');
  assert.deepEqual(JSON.parse(store.get(VIEW_KEY)),
    { slug: 'garden-ab12', path: '/app/garden-ab12/workshop' }, 'and a press goes to its Workshop');
  const [slug, patch] = described.at(-1);
  assert.equal(slug, 'garden-ab12');
  assert.equal(patch.name, 'Garden', 'its face is described from the record the app opened with');
  assert.equal(patch.iconUrl, '/garden.png');
  assert.equal(patch.iconEmoji, undefined, 'a field the record lacks is left to what the store knows');
});

test('a view already inside the open app is kept', () => {
  const { App, store, scopes } = harness({ appView: garden });
  const deeper = JSON.stringify({ slug: 'garden-ab12', path: '/app/garden-ab12/dev/issues/4' });
  store.set(VIEW_KEY, deeper);
  App._syncPlatformTabs('app-view');
  assert.equal(scopes.at(-1), 'garden-ab12');
  assert.equal(store.get(VIEW_KEY), deeper, 'the card you were reading there is still where the tab goes');
});

test('the tab is left alone where the rail is not beside the app', () => {
  for (const opts of [{ phone: true }, { stored: '0' }]) {
    const { App, store, scopes } = harness({ ...opts, appView: garden });
    const other = JSON.stringify({ slug: 'whiteboard-cd34', path: '/app/whiteboard-cd34/workshop' });
    store.set(VIEW_KEY, other);
    App._syncPlatformTabs('app-view');
    assert.deepEqual(scopes, [], JSON.stringify(opts));
    assert.equal(store.get(VIEW_KEY), other, JSON.stringify(opts));
  }
  // Nor on the app's own Workshop: its view is noted by updateHash as before.
  const { App, scopes } = harness({ appView: garden });
  App.currentTab = 'dev';
  App._syncPlatformTabs('app-view');
  assert.deepEqual(scopes, []);
});

test('the pinned frame rule lives only inside the desktop breakpoint', () => {
  const at = css.indexOf('body.rail-pinned:has(');
  assert.ok(at > 0, 'app.css has the pinned #app-view rule');
  assert.equal(css.match(/body\.rail-pinned/g).length, 1, 'one rule, not scattered overrides');
  const open = css.lastIndexOf('@media (min-width: 768px) {', at);
  assert.ok(open > 0, 'inside a min-width: 768px block');
  // No closing brace at column 0 between the media query and the rule: the
  // rule is still inside that block.
  assert.doesNotMatch(css.slice(open, at), /\n\}/);
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /#app-view\s*\{[^]*padding-left:\s*var\(--platform-rail-w, 0px\)/);
  assert.match(rule, /padding-right:\s*0/);
});

test('the Settings switch renders checked, desktop only, and writes through App', () => {
  const html = renderComponent('frontend/src/features/settings/sections/theme.tsx', 'ThemeSection', {});
  const at = html.indexOf('id="settings-rail-pinned"');
  assert.ok(at > 0, 'the switch is in Settings → Theme');
  const input = html.slice(html.lastIndexOf('<input', at), html.indexOf('>', at) + 1);
  assert.match(input, /checked/, 'the prerender is the default, on; the stored value arrives in an effect');
  assert.match(html, /Keep sidebar open in apps/);
  assert.match(html, /class="hidden md:block[^"]*"[^>]*>\s*<label/, 'hidden below 768px');

  const src = read('frontend/src/features/settings/sections/theme.tsx');
  assert.match(src, /RAIL_PINNED_KEY = 'usernode:rail-pinned'/);
  assert.match(src, /getItem\(RAIL_PINNED_KEY\) !== '0'/, 'on unless switched off');
  assert.match(src, /window\.App\.setRailPinned\(on\)/);
  assert.match(appSource, /RAIL_PINNED_KEY: 'usernode:rail-pinned'/, 'the same key on both sides');
});
