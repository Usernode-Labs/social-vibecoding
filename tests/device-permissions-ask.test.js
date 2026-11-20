'use strict';

// Device capabilities without an admin hold, asked for by the app when it
// needs them (20 Nov 2026):
//
//   1. The release-holds `capability` rule tells the full admins and holds
//      nothing, naming the project and what it now asks for ("Stylist now
//      asks for the camera"). A change another holding rule trips is held,
//      with the capability as one of its reasons.
//   2. The platform's prompt offers "Allow this time" beside "Always allow".
//      A one-time grant is never stored: the shell keeps it for the open
//      app's frame, the reload that puts it in force keeps it, and closing
//      the app ends it.
//   3. requestPermission({ place }) and usernode.takeSavedPlace() carry the
//      app's place across that reload.
//
// Run with: node --test tests/device-permissions-ask.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const holds = require('../src/services/release-holds');
const { ACTIONS } = require('../src/services/mail/actions');
const { buildMessage } = require('../src/services/mail/templates');
const { loadAppView, plain } = require('./lib/app-view-vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const file = (name, lines) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, '@@ -1,2 +1,3 @@', ...lines].join('\n');

function pool(routes) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql: String(sql), params });
      for (const [pattern, answer] of routes) {
        if (pattern.test(String(sql))) return typeof answer === 'function' ? answer(params, String(sql)) : answer;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ── 1. The rule tells, and does not hold ───────────────────────────────

test('a device capability alone tells the admins and holds nothing; with a rule that holds, it is still held', () => {
  assert.equal(holds.holds(['capability']), false, 'a capability alone holds nothing');
  assert.equal(holds.holds(['capability', 'unread']), false);
  assert.equal(holds.holds(['capability', 'wallet']), true, 'another holding rule still holds');
  assert.equal(holds.holds(['capability', 'content']), true);
  const rule = holds.RULES.find((r) => r.key === 'capability');
  assert.equal(rule.holds, false);
});

test('the capabilities a change adds are read off its dapp.json lines, in catalogue order', () => {
  const diff = file('dapp.json', ['+  "permissions": [', '+    { "capability": "camera", "reason": "Takes your photo" },', '+    "microphone"', '+  ]']);
  assert.deepEqual(holds.capabilitiesAdded(diff), ['microphone', 'camera']);
  assert.deepEqual(holds.capabilitiesAdded(file('public/app.js', ['+  const camera = "camera";'])), [],
    'the word in an app file is not a declaration');
  assert.deepEqual(holds.capabilitiesAdded(file('dapp.json', ['-  "permissions": ["camera"]'])), [],
    'taking one out asks for nothing');
  assert.deepEqual(holds.capabilitiesOf(['capability', 'capability:camera', 'capability:bogus', 'wallet']), ['camera']);
  assert.deepEqual(holds.cleanRules(['capability', 'capability:camera']), ['capability'],
    'every gate, card and list reads the rules without the tags');
});

test('a change that only asks for the camera is a notice carrying its name; one that also sends tokens is held', async () => {
  holds._resetCache();
  const camera = file('dapp.json', ['+  "permissions": [{ "capability": "camera", "reason": "Takes your photo" }]']);
  const db = pool([[/INSERT INTO release_holds/, { rows: [{ id: 4, opened: true }], rowCount: 1 }]]);
  const told = [];
  const out = await holds.evaluate({
    pool: db, session: { id: 31 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'c'.repeat(40),
    deps: { isFirstVersion: async () => false, notify: async (a) => { told.push(a.sessionId); }, github: { getProposalDiff: async () => ({ diff: camera }) } },
  });
  assert.equal(out.state, 'notice', 'not held: the admins are told');
  assert.deepEqual(out.rules, ['capability']);
  const insert = db.seen.find((q) => /INSERT INTO release_holds/.test(q.sql));
  assert.match(insert.sql, /'notice'\)/, 'a row no gate reads');
  assert.deepEqual(insert.params[3], ['capability', 'capability:camera'], 'the row names what it asks for');
  assert.ok(db.seen.some((q) => /SET status = 'fixed'[\s\S]*status = 'waiting'/.test(q.sql)),
    'a hold it had for this reason alone ends with the new version');
  assert.deepEqual(told, [31]);

  holds._resetCache();
  const both = file('dapp.json', ['+  "permissions": ["camera"]'])
    + '\n' + file('public/app.js', ['+  await usernode.sendTransaction(to, amount);']);
  const db2 = pool([[/INSERT INTO release_holds/, { rows: [{ id: 5, opened: true }], rowCount: 1 }]]);
  const held = await holds.evaluate({
    pool: db2, session: { id: 32 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'd'.repeat(40),
    deps: { isFirstVersion: async () => false, notify: async () => {}, github: { getProposalDiff: async () => ({ diff: both }) } },
  });
  assert.deepEqual([held.state, held.rules], ['held', ['wallet', 'capability']], 'held, with the capability among its reasons');
  const waiting = db2.seen.find((q) => /INSERT INTO release_holds/.test(q.sql));
  assert.match(waiting.sql, /ON CONFLICT \(session_id\) WHERE status = 'waiting'/);
});

test('the notice names the project and the capability in the bell row\'s detail and the mail', async () => {
  const mails = [];
  let detail = null;
  const db = pool([
    [/UPDATE release_holds rh SET notified_at = NOW\(\)/, (params) => ({
      rows: [{ id: 8, rules: ['capability', 'capability:camera'], status: 'notice', session_id: params[0], author_id: 5, app_id: 2, app_slug: 'stylist', app_name: 'Stylist', title: 'Open a live camera view' }],
    })],
    [/INSERT INTO notifications/, (params) => { detail = params[3]; return { rows: [{ id: 100, user_id: 8 }] }; }],
    [/SELECT id, email, locale FROM users/, { rows: [{ id: 8, email: 'a@example.com', locale: null }] }],
    [/SELECT username FROM users/, { rows: [{ username: 'homeroom_bot' }] }],
  ]);
  const out = await holds.notifyIfDue({
    pool: db, sessionId: 40,
    deps: { notifications: { hydrateAndPush: async () => {} }, sendMail: async (_c, mail) => { mails.push(mail); } },
  });
  assert.deepEqual(out, { notified: 1 });
  assert.equal(detail, 'notice:capability|capability:camera', 'what it asks for, as tags after the rules');
  assert.equal(mails[0].held, false);
  assert.equal(mails[0].asks, true);
  assert.equal(mails[0].unread, false);
  assert.deepEqual(mails[0].reasons, ['It now asks to see and record video from your camera']);
});

test('the mail says why a change that is not held is told about, and still reads a notice from before', () => {
  const values = ACTIONS.release_hold.values;
  assert.deepEqual([values({ held: false, asks: true }).asks, values({ held: false, asks: true }).unread], [true, false]);
  assert.deepEqual([values({ held: false }).asks, values({ held: false }).unread], [false, true],
    'a notice from before `asks` was a change not read in full');
  assert.equal(values({}).unread, false, 'a held change is neither');

  const payload = {
    to: 'a@example.com', appName: 'Stylist', title: 'Open a live camera view', author: 'homeroom_bot',
    reasons: ['It now asks to see and record video from your camera'], held: false, asks: true, unread: false,
    url: 'https://app.onhomeroom.com/#app/stylist/dev/proposals/14140',
  };
  const mail = buildMessage('release_hold', payload);
  assert.equal(mail.subject, 'Stylist now asks for a device capability: Open a live camera view');
  assert.match(mail.text, /each person is asked before the app can use it/);
  assert.doesNotMatch(mail.text, /read only the first part/, 'and not the too-large paragraph');
  const big = buildMessage('release_hold', { ...payload, asks: false, unread: true, reasons: ['It could not be read in full'] });
  assert.equal(big.subject, 'Not read in full: Open a live camera view');
  assert.match(big.text, /read only the first part of it/);
});

test('the phone push says which project now asks for what, and that it is not held', () => {
  const { buildNotificationCopy } = require('../src/services/mobile-push-policy');
  const copy = (detail, extra = {}) => buildNotificationCopy('release_hold', { appName: 'Stylist', sessionTitle: 'Open a live camera view', detail, ...extra });
  const camera = copy('notice:capability|capability:camera');
  assert.match(camera.title, /Stylist/);
  assert.match(camera.title, /Now asks for the camera/);
  assert.equal(camera.body, '“Open a live camera view” is not held: each person is asked first');
  assert.match(copy('notice:capability|capability:camera,capability:microphone').title, /Now asks for the microphone and the camera/);
  assert.match(copy('notice:capability').title, /Now asks for a device capability/);
  assert.match(copy('notice:unread').title, /A change was not read in full/, 'the too-large notice is as before');
  assert.match(copy('wallet,capability|capability:camera').title, /A change needs your approval/, 'a held change still asks');
});

// ── The bell row ───────────────────────────────────────────────────────

function loadBell() {
  const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
  const src = read('frontend/src/features/notifications/notifications.js').replace(/^import \{ agoStamp \}.*$/m, '');
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams, Intl,
    location: { search: '', hash: '#home' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { title: '', getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => ({ forEach: () => {} }), body: { appendChild: () => {} } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    PlatformUI: { isTouch: () => false, toast() {} },
    App: { user: { id: 1 }, _isScreenVisible: () => false },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(src, sandbox);
  return sandbox.Notifications;
}

test('the bell row says which project now asks for what, and asks nothing of the reader', () => {
  const N = loadBell();
  const row = (detail, extra = {}) => N._rowView({
    id: 1, kind: 'release_hold', detail, appName: 'Stylist', appSlug: 'stylist', sessionId: 14140,
    sessionTitle: 'Open a live camera view', createdAt: new Date().toISOString(), ...extra,
  });
  const camera = row('notice:capability|capability:camera');
  assert.equal(camera.label, 'Stylist now asks for the camera');
  assert.equal(camera.segments[0].v, 'Open a live camera view');
  assert.ok(!camera.needsYou, 'a notice asks nothing of the reader');
  assert.equal(row('notice:capability|capability:camera,capability:microphone').label, 'Stylist now asks for the microphone and the camera',
    'several, in catalogue order, joined as a list');
  assert.equal(row('notice:capability').label, 'Stylist now asks for a device capability', 'a row from before the names');
  assert.equal(row('notice:capability|capability:camera', { appName: '' }).label, 'A project now asks for the camera');
  assert.equal(row('notice:unread').label, 'Not read in full', 'the too-large notice is as before');
  assert.equal(row('wallet,capability|capability:camera').label, 'Needs your approval', 'a held change still asks for a vote');
  assert.deepEqual(plain(N._releaseHoldNotice('notice:capability,unread|capability:camera,capability:bogus')),
    { rules: ['capability', 'unread'], tags: ['capability:camera', 'capability:bogus'], capabilities: ['camera'] });
});

// ── 2. "Allow this time" ───────────────────────────────────────────────
//
// The relay runs as written in public/js/app-view.js, in the vm the board's
// suites use. Its `fetch` is that realm's global, reached through one of its
// own functions, so a stub there sees every call the relay makes.

function shell({ decision }) {
  const AppView = loadAppView();
  const realm = AppView.grantedForSlug.constructor('return this')();
  const posted = [];
  const fetches = [];
  const renav = [];
  let el = { isConnected: true };
  AppView.appData = { slug: 'stylist' };
  AppView.iframePermissionsSlug = 'stylist';
  AppView.iframePermissions = { effective: [] };
  AppView._appFrame = () => ({ frame: () => el, hasFrame: () => true });
  AppView.ownedFrameFor = () => 'app-iframe';
  AppView._bridgeRequest = () => ({ slug: 'stylist', current: () => true, post: (v) => posted.push(plain(v)) });
  AppView._frameAllowsCapability = () => false;
  AppView._renavigateForPermissions = async (slug) => { renav.push(slug); return true; };
  AppView.showPermissionConsentModal = async (view) => { AppView.__lastView = plain(view); return decision; };
  realm.fetch = async (url, opts = {}) => {
    fetches.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    if (String(url).endsWith('/permissions')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          app: { slug: 'stylist', name: 'Stylist' },
          declared: [{ capability: 'camera', reason: 'Takes your photo' }],
          effective: [],
          catalogue: [{ name: 'camera', label: 'Camera', blurb: 'see and record video from your camera' }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  let n = 0;
  const ask = async (type, extra = {}) => {
    n += 1;
    const id = `p-${n}`;
    await AppView.handlePermissionBridgeMessage({ data: { __usernode_permission: type, id, capability: 'camera', ...extra }, source: {}, origin: 'https://stylist.example' });
    return posted.filter((m) => m.id === id && m.__usernode_permission === 'response').map((m) => m.value)[0];
  };
  return { AppView, fetches, renav, ask, setEl: (next) => { el = next; } };
}

const stored = (fetches) => fetches.filter((f) => f.url === '/api/me/permission-grants' && f.method === 'POST');

test('"Allow this time" grants for the open frame, stores nothing, reloads into it, and ends when the app closes', async () => {
  const s = shell({ decision: 'once' });
  const answer = await s.ask('request', { place: { screen: 'photo', draftId: 7 } });
  assert.deepEqual(answer, { capability: 'camera', state: 'granted', active: false, reloadRequired: true, scope: 'once' });
  assert.equal(s.AppView.__lastView.allowOnce, true, 'the App tab offers it');
  assert.deepEqual(stored(s.fetches), [], 'nothing is sent to the server');
  assert.deepEqual(s.renav, ['stylist'], 'the frame reloads to put it in force');
  assert.deepEqual(plain(s.AppView.grantedForSlug('stylist')), ['camera'],
    'the reload\'s `allow` carries it, on the same frame');

  // After the reload: the place comes back once, and the grant answers at once.
  assert.deepEqual(await s.ask('take-place'), { place: { screen: 'photo', draftId: 7 } });
  assert.deepEqual(await s.ask('take-place'), { place: null }, 'read once');
  const again = await s.ask('get');
  assert.equal(again.state, 'granted');
  assert.equal(again.scope, 'once');
  const all = await s.ask('get-all');
  assert.deepEqual(all.grantedOnce, ['camera']);

  // Closing the app: the next launch is a different frame, and the grant is gone.
  s.setEl({ isConnected: true });
  assert.deepEqual(plain(s.AppView.grantedForSlug('stylist')), [], 'a new frame starts without it');
  assert.equal(s.AppView._onceGrants.has('stylist'), false);
  const after = await s.ask('get');
  assert.deepEqual([after.state, after.reason], ['denied', 'not_granted'], 'so it is asked for again');
});

test('a frame that was removed drops the grant even if it is handed back', async () => {
  const s = shell({ decision: 'once' });
  const el = { isConnected: true };
  s.setEl(el);
  await s.ask('request');
  assert.deepEqual(plain(s.AppView.grantedForSlug('stylist')), ['camera']);
  el.isConnected = false;
  assert.deepEqual(plain(s.AppView.grantedForSlug('stylist')), []);
});

test('"Always allow" stores the grant as before, and says so in `scope`', async () => {
  const s = shell({ decision: 'always' });
  const answer = await s.ask('request', { place: { screen: 'photo' } });
  assert.deepEqual(answer, { capability: 'camera', state: 'granted', active: false, reloadRequired: true, scope: 'always' });
  assert.equal(stored(s.fetches).length, 1, 'stored for this app');
  assert.deepEqual(plain(s.AppView.grantedForSlug('stylist')), [], 'not a one-time grant: the server\'s answer carries it');
  assert.deepEqual(await s.ask('take-place'), { place: { screen: 'photo' } }, 'its place is kept across the reload too');
});

test('a dismissal is a denial: nothing stored, nothing granted, no reload', async () => {
  for (const decision of [null, false, true, 'yes']) {
    const s = shell({ decision });
    const answer = await s.ask('request');
    assert.deepEqual(answer, { capability: 'camera', state: 'denied', active: false, reason: 'declined' }, String(decision));
    assert.deepEqual(stored(s.fetches), []);
    assert.deepEqual(s.renav, []);
    assert.deepEqual(plain(s.AppView.grantedForSlug('stylist')), []);
  }
});

test('outside the App tab there is no one-time grant to give, and no place to keep', async () => {
  const s = shell({ decision: 'once' });
  s.AppView.ownedFrameFor = () => 'staging-iframe';
  const answer = await s.ask('request', { place: { screen: 'photo' } });
  assert.equal(s.AppView.__lastView.allowOnce, false, 'a preview offers only the lasting answer');
  assert.deepEqual([answer.state, answer.reason], ['denied', 'declined']);
  assert.deepEqual(await s.ask('take-place'), { place: null });
});

test('a place too large to keep is not kept', () => {
  const AppView = loadAppView();
  assert.equal(AppView._savePermissionPlace('stylist', { blob: 'x'.repeat(20000) }), false);
  assert.equal(AppView._takePermissionPlace('stylist'), null);
  assert.equal(AppView._savePermissionPlace('stylist', { screen: 'photo' }), true);
  AppView._permissionPlaces.get('stylist').at -= AppView.PERMISSION_PLACE_TTL_MS + 1;
  assert.equal(AppView._takePermissionPlace('stylist'), null, 'and one left too long is gone');
});

test('the dialog\'s three buttons dispatch three different answers', () => {
  const AppView = loadAppView();
  const got = [];
  AppView._permissionConsentSettle = (c) => got.push(c);
  AppView._permissionConsentAllow();
  AppView._permissionConsentAllowOnce();
  AppView._permissionConsentDecline();
  assert.deepEqual(got, ['always', 'once', null]);
  const shellSrc = read('public/js/app-view.js');
  assert.match(shellSrc, /AppView\._permissionConsentSettle = \(choice\) => done\(choice === 'always' \|\| choice === 'once' \? choice : null\);/,
    'anything else, a dismissal included, resolves as a denial');
});

// ── The prompt, as it renders ──────────────────────────────────────────

test('the prompt shows Allow this time beside Always allow on the App tab, and only the lasting answer elsewhere', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const entry = 'frontend/src/features/dev-board/modals/permission-consent-modal.tsx';
  const base = { capability: 'camera', label: 'Camera', title: 'Allow Stylist to see and record video from your camera?', reason: 'Takes your photo', note: 'Only Stylist gets this.' };
  const both = renderComponent(entry, 'PermissionConsentCard', { view: { ...base, confirmLabel: 'Always allow', onceLabel: 'Allow this time' } });
  assert.match(both, /id="permission-consent-decline"/);
  assert.match(both, /id="permission-consent-allow-once"[^>]*>Allow this time</);
  assert.match(both, /id="permission-consent-allow"[^>]*>Always allow</);
  assert.ok(both.indexOf('permission-consent-allow-once') < both.indexOf('id="permission-consent-allow"'),
    'the one-time answer sits beside the lasting one, before it (dapp.json selects the pair as siblings)');
  const one = renderComponent(entry, 'PermissionConsentCard', { view: { ...base, confirmLabel: 'Allow', onceLabel: null } });
  assert.doesNotMatch(one, /permission-consent-allow-once/);
  assert.match(one, /id="permission-consent-allow"[^>]*>Allow</);
});

test('the words: what each answer lasts, in the catalog with descriptions, and no em dashes', () => {
  const i18n = englishPlatformI18n();
  assert.equal(i18n.t('changes:dialog.permission.allowOnce'), 'Allow this time');
  assert.equal(i18n.t('changes:dialog.permission.allowAlways'), 'Always allow');
  assert.match(i18n.t('changes:dialog.permission.noteChoicesReopen', { app: 'Stylist' }), /until you close Stylist\. Always allow lasts until you take it back in Settings\. The app will reopen/);
  for (const [ns, prefix] of [['changes', 'dialog.permission.'], ['notifications', 'row.releaseHold.']]) {
    const catalog = JSON.parse(read(`frontend/locales/en/${ns}.json`));
    for (const [key, entry] of Object.entries(catalog).filter(([k]) => k.startsWith(prefix))) {
      assert.ok(entry.description && entry.description.length > 20, `${ns}:${key} has a description`);
      assert.doesNotMatch(entry.text, /—/, `${ns}:${key} has no em dash`);
    }
  }
});

// ── 3. The bridge ──────────────────────────────────────────────────────

test('the bridge sends the place with the request and reads it back once, in both copies', () => {
  const bridge = read('public/usernode-bridge/v1/bridge.js');
  assert.equal(read('public/usernode-bridge.js'), bridge, 'the unversioned mirror matches');
  assert.match(bridge, /window\.usernode\.requestPermission = function requestPermission\(capability, options\)/);
  assert.match(bridge, /if \(extra && extra\.place !== undefined\) message\.place = extra\.place;/);
  assert.match(bridge, /window\.usernode\.takeSavedPlace = function takeSavedPlace\(\)/);
  assert.match(bridge, /permissionCall\("take-place", null\)/);

  // Run the bridge's permission block against a fake parent and check the wire.
  const sent = [];
  const listeners = [];
  const parent = { postMessage: (m) => sent.push(m) };
  const win = { usernode: {}, parent, addEventListener: (type, fn) => listeners.push(fn) };
  const block = bridge.slice(bridge.indexOf('  (function () {\n    var _PERM_ACK_TIMEOUT_MS'), bridge.indexOf('  // App file storage (#752)'));
  const sandbox = { window: win, document: {}, console: { log() {} }, setTimeout: () => 0, clearTimeout: () => {}, Promise, Math, Date, String, Error, _BRIDGE_TAG: '[t]' };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  const reply = (id, value) => listeners.forEach((fn) => fn({ source: parent, data: { __usernode_permission: 'response', id, value } }));
  const asked = win.usernode.requestPermission('camera', { place: { screen: 'photo' } });
  assert.equal(sent[0].__usernode_permission, 'request');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].place)), { screen: 'photo' });
  reply(sent[0].id, { state: 'granted', scope: 'once' });
  const taken = win.usernode.takeSavedPlace();
  assert.equal(sent[1].__usernode_permission, 'take-place');
  assert.ok(!('place' in sent[1]));
  reply(sent[1].id, { place: { screen: 'photo' } });
  return Promise.all([asked, taken]).then(([a, place]) => {
    assert.equal(a.scope, 'once');
    assert.deepEqual(JSON.parse(JSON.stringify(place)), { screen: 'photo' });
  });
});

test('the conventions tell app builders about both answers and the saved place', () => {
  const doc = read('src/prompts/app-conventions.md');
  assert.match(doc, /\*\*Allow this time\*\* beside \*\*Always\s+allow\*\*/);
  assert.match(doc, /usernode\.takeSavedPlace\(\)/);
  assert.match(doc, /requestPermission\('camera', \{ place:/);
  assert.match(doc, /Declaring a capability holds no change for an admin\./);
});
