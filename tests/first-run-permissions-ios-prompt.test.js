const { withLanguage } = require("./lib/platform-language");
// The first-run "Set up your device" trigger on iOS, and what is left of the
// iOS sheet.
//
// On iOS that sheet was only ever the notification prompt (its "Allow
// notifications" button calls usernode.requestPermissions()), and it came on
// the first screen of a fresh install, before the person had made anything
// worth hearing about. iOS presents its own prompt once, so that ask was
// answered "no", or never seen, for good. Decision D10 (#12) removed it: the
// session-setup and anonymous-entry triggers present NOTHING on iOS, whatever
// the marker or the permission says, and the ask moved to the moment the
// Homeroom bot starts building a new app (NativeChrome.askForPing, pinned in
// tests/create-progress-ping-ask.test.js).
//
// What this file still pins:
//
//   - iOS: the trigger presents nothing, reads nothing to decide that when
//     the kit can tell, and records nothing;
//   - the sheet itself, which the ?shot=notif-permissions link still draws
//     in its iOS variant: a grant closes it, a denial keeps it open;
//   - the one-shot and ghost-click rules, which now guard Android's sheet.
//
// Run with: node --test tests/first-run-permissions-ios-prompt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const nativeChromeSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'native-chrome.js'), 'utf8');

// The sheet must reach signed-out users too: the OS notification prompt
// (and the Android alarm/battery asks) are device-level, not
// account-level, so entering the anonymous shell is also a trigger.

function fakeNode(tag) {
  const node = {
    tag,
    className: '',
    disabled: false,
    children: [],
    listeners: {},
    _text: '',
    appendChild(child) { node.children.push(child); return child; },
    addEventListener(type, fn) { node.listeners[type] = fn; },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text; },
    set(value) { node._text = value == null ? '' : String(value); node.children = []; },
  });
  return node;
}

// Boot native-chrome.js in a sandbox and return handles for driving
// maybeShowFirstRunPermissions under different device states.
function boot(opts) {
  const sheets = [];
  const stored = { ...(opts.stored || {}) };
  const capabilities = opts.capabilities ||
    ['getSettingsState', 'getSocialPushState'];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: opts.user !== undefined ? opts.user : { id: 'u1' } },
    unNative: opts.unNative !== undefined ? opts.unNative
      : { toast() {}, platform: opts.kitPlatform || 'ios' },
    usernode: {
      isNative: true,
      async getBridgeInfo() { return { version: 5, capabilities }; },
      async getSettingsState() { return { permissions: opts.permissions }; },
      async getSocialPushState() {
        if (opts.socialPushState === undefined) return null;
        return opts.socialPushState;
      },
      async requestPermissions() {
        return { granted: false, permissions: opts.permissions };
      },
      async openBatterySettings() { return true; },
    },
    PlatformUI: {
      sheet(sheetOpts) {
        if (opts.kitSheetUnavailable) return null;
        const handle = {
          dismissed: false,
          dismiss() {
            handle.dismissed = true;
            if (sheetOpts.onDismiss) sheetOpts.onDismiss();
          },
        };
        sheetOpts.handle = handle;
        sheets.push(sheetOpts);
        return handle;
      },
    },
    localStorage: {
      getItem(key) { return Object.hasOwn(stored, key) ? stored[key] : null; },
      setItem(key, value) { stored[key] = String(value); },
    },
    document: {
      getElementById() { return null; },
      createElement(tag) { return fakeNode(tag); },
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    // Real, REF'D timers. An unref'd timer here starves the grant-recheck
    // loop (native-chrome's only setTimeout, bounded at 4 iterations): the
    // test awaits a promise the timer resolves, node sees nothing keeping
    // the event loop alive, and the whole file dies with "Promise
    // resolution is still pending but the event loop has already resolved"
    // — cancelling every later test in the file with it.
    setTimeout, clearTimeout,
    setInterval() {},
    // #2960: the Android sheet waits for block production. `opts.bp` is the
    // /challenges-api/bp/state payload; Android cases here have asked.
    fetch(url) {
      if (url === '/challenges-api/bp/state') {
        return Promise.resolve({ ok: true, async json() {
          return { success: true,
            data: opts.bp || { bp_requested: true, bp_released: false } };
        } });
      }
      return Promise.reject(new Error('unexpected fetch'));
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(withLanguage(sandbox));
  vm.runInContext(nativeChromeSource, sandbox);
  return { sandbox, sheets, stored };
}

function findButton(node, text) {
  if (node.tag === 'button' && node.textContent === text) return node;
  for (const child of node.children || []) {
    const found = findButton(child, text);
    if (found) return found;
  }
  return null;
}

const MARKER = 'sv:onboarding_permissions_done';
const IOS_UNPROMPTED = {
  enabled: false,
  permissionStatus: 'notDetermined',
  registrationStatus: 'unregistered',
  deliveryActive: false,
};

const ASKED_AT = 'sv:device_permissions_asked_at';
const IOS_PERMS = {
  platform: 'ios', exactAlarmGranted: false, batteryOptDisabled: null,
};
const ANDROID_PERMS = {
  platform: 'android', exactAlarmGranted: false, batteryOptDisabled: false,
};

// Counts every bridge read the trigger makes, so "decided without asking
// the app anything" is an assertion rather than a hope.
function countReads(sandbox) {
  const reads = { settings: 0, push: 0 };
  const settings = sandbox.usernode.getSettingsState;
  const push = sandbox.usernode.getSocialPushState;
  sandbox.usernode.getSettingsState = async () => { reads.settings += 1; return settings(); };
  sandbox.usernode.getSocialPushState = async () => { reads.push += 1; return push(); };
  return reads;
}

// ── iOS: session setup presents nothing (#12, D10) ────────────────────

test('iOS: session setup presents nothing, whatever the marker or the ' +
     'permission says, and reads nothing to decide it', async () => {
  for (const permissionStatus of ['notDetermined', 'denied', 'authorized']) {
    for (const stored of [{}, { [MARKER]: '1' }]) {
      const { sandbox, sheets, stored: after } = boot({
        stored,
        permissions: IOS_PERMS,
        socialPushState: { ...IOS_UNPROMPTED, permissionStatus },
      });
      const reads = countReads(sandbox);
      await sandbox.NativeChrome.maybeShowFirstRunPermissions();
      const label = `${permissionStatus}, ${stored[MARKER] ? 'marked' : 'unmarked'}`;
      assert.equal(sheets.length, 0,
        `${label}: the notification ask belongs to the create dialog now`);
      assert.deepEqual({ ...reads }, { settings: 0, push: 0 },
        `${label}: the kit says iOS, so no bridge read is spent on it`);
      assert.equal(after[MARKER], stored[MARKER],
        `${label}: nothing is recorded either way`);
      assert.equal(sandbox.NativeChrome.firstRunSheetPresented(), false,
        `${label}: the terms gate is not held behind a sheet that never opened`);
    }
  }
});

test('iOS by the snapshot\'s own word: a page whose kit cannot tell still ' +
     'presents nothing', async () => {
  // The fast path keys on the kit's platform. A kit that reports something
  // else (or none at all) falls through to the settings read, and the
  // snapshot's `platform` decides the same thing.
  for (const unNative of [{ toast() {}, platform: 'desktop' }, null]) {
    const { sandbox, sheets, stored } = boot({
      unNative,
      permissions: { ...IOS_PERMS, exactAlarmGranted: true },
      socialPushState: IOS_UNPROMPTED,
    });
    await sandbox.NativeChrome.maybeShowFirstRunPermissions();
    assert.equal(sheets.length, 0);
    assert.notEqual(stored[MARKER], '1', 'and records nothing');
  }
});

test('decideFirstRunSheet skips iOS before anything else', () => {
  const { sandbox } = boot({ permissions: IOS_PERMS });
  const decide = sandbox.NativeChrome.decideFirstRunSheet;
  assert.equal(decide({ isAndroid: false, needsAlarm: true, needsBattery: false }),
    'skip', 'a missing notification permission is not a reason here any more');
  assert.equal(decide({ isAndroid: false, needsAlarm: false, needsBattery: false }),
    'skip', 'and nothing to ask is not "done": no marker is written for iOS');
  assert.equal(decide({}), 'skip', 'an unknown platform is not Android');
});

test('anonymous: native session stays closed; iOS presents nothing and ' +
     'Android device permissions remain available', async () => {
  const ios = boot({
    user: null,
    permissions: IOS_PERMS,
    socialPushState: IOS_UNPROMPTED,
  });
  assert.equal(await ios.sandbox.NativeChrome.enterAnonymous(), false,
    'anonymous pages never receive session authority');
  if (ios.sandbox.NativeChrome._firstRunPromise) {
    await ios.sandbox.NativeChrome._firstRunPromise;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ios.sheets.length, 0, 'anonymous iOS entry asks for nothing');

  const android = boot({
    user: null,
    kitPlatform: 'android',
    capabilities: ['getSettingsState', 'requestNotificationPermission'],
    permissions: { ...ANDROID_PERMS, notificationsGranted: false },
  });
  android.sandbox.usernode.requestNotificationPermission = async () => ({ granted: false });
  assert.equal(await android.sandbox.NativeChrome.enterAnonymous(), false);
  // Anonymous entry fires the device-only sheet itself: wait for that run,
  // without calling maybeShowFirstRunPermissions() here (that would mask a
  // missing trigger).
  if (android.sandbox.NativeChrome._firstRunPromise) {
    await android.sandbox.NativeChrome._firstRunPromise;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(android.sheets.length, 1,
    'anonymous Android entry still offers the device-level notification ask');
});

// ── Android: the trigger's own rules ───────────────────────────────────

test('a degraded kit (sheet unavailable) must NOT write either marker: ' +
     'nothing was shown', async () => {
  const { sandbox, sheets, stored } = boot({
    kitSheetUnavailable: true,
    kitPlatform: 'android',
    permissions: ANDROID_PERMS,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
  assert.notEqual(stored[MARKER], '1',
    'a launch that presented nothing must leave the next launch its chance');
  assert.equal(stored[ASKED_AT], undefined, 'and must not start the day-long wait');
});

test('concurrent and repeat triggers in one document present exactly one ' +
     'sheet', async () => {
  const { sandbox, sheets } = boot({
    kitPlatform: 'android',
    permissions: ANDROID_PERMS,
  });
  await Promise.all([
    sandbox.NativeChrome.maybeShowFirstRunPermissions(),
    sandbox.NativeChrome.maybeShowFirstRunPermissions(),
  ]);
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1,
    'the sv:session/auth-status trigger storm must not stack sheets');
});

test('Android: asked within the last day, the sheet waits with no ' +
     'bridge reads', async () => {
  let settingsReads = 0;
  const { sandbox, sheets } = boot({
    stored: { [MARKER]: '1', [ASKED_AT]: String(Date.now()) },
    kitPlatform: 'android',
    permissions: ANDROID_PERMS,
  });
  const inner = sandbox.usernode.getSettingsState;
  sandbox.usernode.getSettingsState = async () => { settingsReads += 1; return inner(); };
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 0);
  assert.equal(settingsReads, 0,
    'an Android device asked today keeps the instant-return fast path');
});

test('Android: the old marker alone no longer ends the asking', async () => {
  let settingsReads = 0;
  const { sandbox } = boot({
    stored: { [MARKER]: '1' },
    kitPlatform: 'android',
    permissions: ANDROID_PERMS,
  });
  const inner = sandbox.usernode.getSettingsState;
  sandbox.usernode.getSettingsState = async () => { settingsReads += 1; return inner(); };
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(settingsReads, 1,
    'a device that skipped once, or lost a permission later, is re-checked');
});

test('Android: an unmarked device still gets the sheet', async () => {
  const { sandbox, sheets } = boot({
    kitPlatform: 'android',
    permissions: ANDROID_PERMS,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  assert.equal(sheets.length, 1);
});

// ── The iOS sheet itself (what ?shot=notif-permissions draws) ──────────
//
// public/js/app.js presents it through NativeChrome.presentPermissionsSheet
// with iOS permissions, and so do these tests: the trigger above no longer
// does on iOS.

function presentIosSheet(sandbox, sheets, pushStatus) {
  const dismissals = [];
  const handle = sandbox.NativeChrome.presentPermissionsSheet({
    perms: IOS_PERMS,
    isAndroid: false,
    pushStatus,
    onDismiss: (info) => dismissals.push(info),
  });
  assert.ok(handle, 'the kit presented the sheet');
  assert.equal(sheets.length, 1);
  return { sheet: sheets[0], dismissals };
}

test('iOS sheet: granting closes it, even when the native status read ' +
     'still lags behind the OS dialog', async () => {
  const { sandbox, sheets } = boot({
    permissions: IOS_PERMS,
    socialPushState: IOS_UNPROMPTED, // stays stale after the grant
  });
  sandbox.usernode.requestPermissions = async () => ({
    granted: true,
    permissions: { ...IOS_PERMS, exactAlarmGranted: true },
  });
  const { sheet, dismissals } = presentIosSheet(sandbox, sheets, 'undetermined');
  const allow = findButton(sheet.contentEl, 'Allow notifications');
  assert.ok(allow, 'the sheet renders the Allow notifications button');
  await allow.listeners.click();
  assert.equal(sheet.handle.dismissed, true, 'a successful grant closes the sheet');
  assert.equal(dismissals.length, 1);
  assert.equal(dismissals[0].interacted, true, 'and it was an answer, not a ghost');
});

test('iOS sheet: a requestPermissions that resolves before the user ' +
     'answers still closes once the status settles to granted', async () => {
  const { sandbox, sheets } = boot({ permissions: IOS_PERMS });
  let reads = 0;
  sandbox.usernode.getSocialPushState = async () => {
    reads += 1;
    return {
      ...IOS_UNPROMPTED,
      permissionStatus: reads >= 3 ? 'authorized' : 'notDetermined',
    };
  };
  sandbox.usernode.requestPermissions = async () => ({
    granted: false, permissions: IOS_PERMS,
  });
  sandbox.NativeChrome._FIRST_RUN_RECHECK_MS = 1;
  const { sheet } = presentIosSheet(sandbox, sheets, 'undetermined');
  const allow = findButton(sheet.contentEl, 'Allow notifications');
  await allow.listeners.click();
  assert.equal(sheet.handle.dismissed, true,
    'the settled granted status closes the sheet');
});

test('iOS sheet: a denial keeps it open and un-granted', async () => {
  const { sandbox, sheets } = boot({
    permissions: IOS_PERMS,
    socialPushState: IOS_UNPROMPTED,
  });
  const { sheet } = presentIosSheet(sandbox, sheets, 'undetermined');
  sandbox.usernode.getSocialPushState = async () => ({
    ...IOS_UNPROMPTED, permissionStatus: 'denied',
  });
  sandbox.usernode.requestPermissions = async () => ({
    granted: false, permissions: IOS_PERMS,
  });
  const allow = findButton(sheet.contentEl, 'Allow notifications');
  await allow.listeners.click();
  assert.equal(sheet.handle.dismissed, false);
  assert.ok(findButton(sheet.contentEl, 'Skip for now'),
    'the dismiss affordance is still there');
});

// ── The sheet must survive its own opening tap ─────────────────────────
//
// A tap that presents an overlay leaves a synthesized click behind
// ~300ms later, and it lands on the backdrop that tap just put on screen.
// The kit now refuses that click (decideBackdropDismiss in
// public/usernode-native/v1/native.js), but these markers end the asking
// for a day, so they must not depend on the kit alone: a dismissal nobody
// could have read, from a user who pressed nothing on the sheet, is not an
// answer.

test('a dismissal too fast to have been read leaves both markers unwritten', async () => {
  const { sandbox, sheets, stored } = boot({
    kitPlatform: 'android',
    permissions: ANDROID_PERMS,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  // The ghost: nothing on the sheet was touched, and it arrives at once.
  sheets[0].handle.dismiss();
  assert.notEqual(stored[MARKER], '1',
    'a ghost-click dismissal must not count as an answer');
  assert.equal(stored[ASKED_AT], undefined,
    'nor start the day-long wait before the next offer');
});

test('a dismissal the user could have read records first-run done', async () => {
  const { sandbox, sheets, stored } = boot({
    kitPlatform: 'android',
    permissions: ANDROID_PERMS,
  });
  sandbox.NativeChrome._FIRST_RUN_MIN_SEEN_MS = 5;
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  await new Promise((resolve) => setTimeout(resolve, 20));
  sheets[0].handle.dismiss();
  assert.equal(stored[MARKER], '1', 'a real "not now" is still an answer');
  assert.ok(Number(stored[ASKED_AT]) > 0, 'and waits a day before asking again');
});

test('pressing Skip records first-run done however fast it happens', async () => {
  // Interaction, not elapsed time, is what makes a dismissal an answer:
  // otherwise the guard would eat a decisive tap made in under 450ms.
  const { sandbox, sheets, stored } = boot({
    kitPlatform: 'android',
    permissions: ANDROID_PERMS,
  });
  await sandbox.NativeChrome.maybeShowFirstRunPermissions();
  const skip = findButton(sheets[0].contentEl, 'Skip for now');
  assert.ok(skip, 'the sheet renders its dismiss affordance');
  skip.listeners.click();
  assert.equal(stored[MARKER], '1');
});

// ── Completing the grant (shared with Settings → Homeroom app) ─────────

test('settleIosPushGrant polls past a lagging status and kicks push registration', async () => {
  const { sandbox } = boot({ permissions: IOS_PERMS });
  let reads = 0;
  sandbox.usernode.getSocialPushState = async () => {
    reads += 1;
    return {
      ...IOS_UNPROMPTED,
      permissionStatus: reads >= 3 ? 'authorized' : 'notDetermined',
    };
  };
  sandbox.NativeChrome._FIRST_RUN_RECHECK_MS = 1;
  let kicked = 0;
  sandbox.SocialPush = { getState() { kicked += 1; } };
  // requestPermissions resolved with granted:false — the OS dialog had not
  // been answered yet. The settled status is the answer, not that flag.
  const settled = await sandbox.NativeChrome.settleIosPushGrant(false);
  assert.equal(settled.granted, true);
  assert.equal(settled.status, 'granted');
  assert.equal(kicked, 1,
    'a fresh grant starts push registration now, not on the next app resume');
});

test('settleIosPushGrant reports a denial and starts no registration', async () => {
  const { sandbox } = boot({ permissions: IOS_PERMS });
  sandbox.usernode.getSocialPushState = async () => ({
    ...IOS_UNPROMPTED, permissionStatus: 'denied',
  });
  let kicked = 0;
  sandbox.SocialPush = { getState() { kicked += 1; } };
  const settled = await sandbox.NativeChrome.settleIosPushGrant(true);
  assert.equal(settled.granted, false, 'a determined denial beats the grant flag');
  assert.equal(settled.status, 'denied');
  assert.equal(kicked, 0);
});

test('Settings’ Allow notifications completes the grant the same way', () => {
  // The Settings row used to be a bare
  // _unApply(usernode.requestPermissions()) — one read, no polling, no
  // SocialPush kick — so on iOS it repainted "Not granted" moments after a
  // real grant. Both screens go through settleIosPushGrant now.
  const settingsJs = fs.readFileSync(
    path.join(root, 'frontend', 'src', 'features', 'settings', 'settings.js'), 'utf8');
  assert.match(settingsJs, /_unRequestPermissions\(isAndroid\)/,
    'the button routes through the completing path');
  const at = settingsJs.indexOf('async _unRequestPermissions(');
  assert.ok(at > -1, 'settings.js defines _unRequestPermissions');
  const fn = settingsJs.slice(at, settingsJs.indexOf('\n    // Awaits a bridge setter', at));
  assert.match(fn, /settleIosPushGrant/,
    'iOS grants settle through the shared native-chrome helper');
  // #1079: the row is a component driven by a published model, so repainting
  // from the settled answer IS the publish.
  assert.match(fn, /_publishUsernode\(\)/,
    'the row repaints from the settled answer');
  assert.ok(!/_unApply\(window\.usernode\.requestPermissions\(\)\)/.test(settingsJs),
    'the old single-read path must not survive anywhere');
});

// ── ?shot=notif-permissions dispatches its ghost click synchronously ───────
//
// presentSheet appends the sheet/backdrop and wires the guard before it
// returns. Dispatch there, while the opening gesture's ghost window is true
// by construction; deferring to a timer or frame makes a headless/background
// scheduler part of the assertion and has made unrelated proposals go red.

test('the ghost click targets the synchronously presented sheet', () => {
  const app = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const shot = app.slice(app.indexOf('  _applyNotifPermissionsShot() {'));
  const body = shot.slice(0, shot.indexOf('\n  },'));

  assert.doesNotMatch(body, /requestAnimationFrame|performance\.now/,
    'no scheduler decides whether the synthetic ghost lands in time');
  const presentAt = body.indexOf('const sheet = NativeChrome.presentPermissionsSheet');
  const backdropAt = body.indexOf("const backdrop = document.querySelector('.un-backdrop')");
  const clickAt = body.indexOf('backdrop.click()');
  const markerAt = body.indexOf(
    "sheet.el.setAttribute('data-un-ghost-click', 'dispatched')");
  assert.ok(presentAt >= 0 && presentAt < backdropAt && backdropAt < clickAt && clickAt < markerAt,
    'present, dispatch, and mark happen synchronously in that order');
  assert.match(body, /if \(!backdrop\) return;/,
    'a missing backdrop cannot produce a false-positive marker');
  assert.doesNotMatch(body, /document\.querySelector\('\.un-sheet'\)/,
    'the marker belongs to the exact returned sheet');
});
