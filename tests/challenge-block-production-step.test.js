// The block-production challenge's page says which step THIS viewer is on
// (#2493).
//
// WHAT THIS PINS. The challenge's one CTA, "Open block production settings",
// went to Settings › Homeroom app — which the browser does not have, so it
// fell back to the Settings root, and which in the app is a long page with
// block production near the bottom. Admin feedback: a viewer who has no
// wallet yet has to request one first; a viewer who has one should be steered
// to delegation as the default, with producing on the phone itself offered
// only in the Android app, and with its warnings.
//
// So the page now reads GET /challenges-api/bp/state (the same session-authed
// state Settings' block-production card reads) and draws a step instead of the
// generic link — including when that read fails, which offers a retry rather
// than the link that led nowhere. Platform is a presentation hint only: the request and the
// delegation screen are enforced server-side / natively exactly as before.
//
// Behavioural: the shipped topochain-challenges.js runs in a vm (see
// tests/challenge-cta-route.test.js), and the page is rendered through the
// real DetailPage component.
//
// Run with: node --test tests/challenge-block-production-step.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const CHALLENGES_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');

function loadModule(win = {}) {
  const sandbox = {
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { ...win },
    console,
    setTimeout,
    clearTimeout,
    URL,
    location: {
      hash: '#leaderboard/challenges/1/7', search: '',
      origin: 'https://app.onhomeroom.com', hostname: 'app.onhomeroom.com',
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CHALLENGES_SRC, sandbox, { filename: 'topochain-challenges.js' });
  return { TC: sandbox.window.TopochainChallenges, sandbox };
}

const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const { TC } = loadModule();
const WEB = { native: false, android: false, wallet: false };
const IOS_APP = { native: true, android: false, wallet: true };
const ANDROID_APP = { native: true, android: true, wallet: true };
const step = (state, env) => plain(TC.blockProductionStep(state, env));

const BLOCKS = {
  id: 7,
  metric: { kind: 'blocks_produced', target: 1, label: 'blocks' },
  card_preview: { goal: 'Help run the network' },
  detail_modal: { cta_label: 'Open block production settings', cta_link: '#settings' },
};
const SHARE = {
  id: 8, metric: null,
  card_preview: { goal: 'Share the post' },
  detail_modal: { cta_label: 'Share', cta_link: '#settings/alerts' },
};

test('no wallet yet: the first step is requesting one, on every platform', () => {
  const none = { has_platform_access: true, bp_requested: false, bp_released: false };
  for (const env of [WEB, IOS_APP, ANDROID_APP]) {
    const s = step(none, env);
    assert.equal(s.step, 'request');
    assert.match(s.title, /request a wallet/i);
    assert.equal(s.action.label, 'Request a wallet');
    assert.equal(s.action.pending, false);
    assert.equal(s.onDevice, undefined, 'no production choice before there is a wallet');
  }
  const inFlight = plain(TC.blockProductionStep(none, WEB, true));
  assert.equal(inFlight.action.pending, true, 'a request in flight disables the button');
  assert.equal(inFlight.action.label, 'Requesting…');
});

test('requested but not released: a pending note, no button', () => {
  const s = step({ has_platform_access: true, bp_requested: true, bp_released: false }, ANDROID_APP);
  assert.equal(s.step, 'pending');
  assert.match(s.text, /admin/i);
  assert.equal(s.action, undefined);
});

test('no platform access yet: says so rather than offering a request', () => {
  const s = step({ has_platform_access: false, bp_requested: false, bp_released: false }, WEB);
  assert.equal(s.step, 'locked');
  assert.equal(s.action, undefined);
});

test('has a wallet: delegation is the default, on-device only in the Android app, with warnings', () => {
  const released = { has_platform_access: true, bp_requested: true, bp_released: true };

  const android = step(released, ANDROID_APP);
  assert.equal(android.step, 'account');
  assert.match(android.delegation.title, /Delegate.*recommended/i);
  assert.ok(android.onDevice, 'Android app offers producing on this phone');
  assert.match(android.onDevice.title, /this phone/i);
  assert.match(android.onDevice.warning, /background/i);
  assert.match(android.onDevice.warning, /battery/i);
  assert.match(android.onDevice.warning, /notification/i);
  assert.equal(android.onDeviceNote, null);
  assert.equal(android.action.label, 'Manage delegation');
  assert.equal(android.appNote, null);

  const ios = step(released, IOS_APP);
  assert.equal(ios.step, 'account');
  assert.equal(ios.onDevice, null, 'iOS never offers on-device production');
  assert.match(ios.onDeviceNote, /Android app/);
  assert.equal(ios.action.label, 'Manage delegation', 'iOS can still manage delegation');

  const web = step(released, WEB);
  assert.equal(web.onDevice, null, 'a browser never offers on-device production');
  assert.match(web.onDeviceNote, /Android app/);
  assert.equal(web.action, null, 'the browser has no wallet to open');
  assert.match(web.appNote, /Homeroom app/);

  // An Android phone in Chrome (no native bridge) is still a browser.
  const chrome = step(released, { native: false, android: true, wallet: false });
  assert.equal(chrome.onDevice, null);
  assert.equal(chrome.action, null);
});

test('loading and failure', () => {
  assert.equal(step(undefined, WEB).step, 'checking');
  const err = step(null, WEB);
  assert.equal(err.step, 'error', 'a failed read offers a retry, not the organiser link');
  assert.equal(err.action.label, 'Try again');
});

test('the environment: only the native Android app counts as Android', () => {
  const env = (win) => plain(loadModule(win).TC._bpEnv());
  assert.deepEqual(env({}), { native: false, android: false, wallet: false }, 'desktop browser');
  assert.deepEqual(env({ unNative: { platform: 'android' } }),
    { native: false, android: false, wallet: false }, 'Chrome on Android is a browser');
  assert.deepEqual(env({ unNative: { platform: 'ios' }, usernode: { isNative: true } }),
    { native: true, android: false, wallet: false }, 'iOS app, wallet row not offered');
  assert.deepEqual(env({
    unNative: { platform: 'android' }, usernode: { isNative: true },
    WalletSheet: { _visible: true, _stakingSupported: true, openFromRow() {} },
  }), { native: true, android: true, wallet: true }, 'Android app with its wallet');
  assert.deepEqual(env({
    unNative: { platform: 'android' }, usernode: { isNative: true },
    WalletSheet: { _visible: true, _stakingSupported: false, openFromRow() {} },
  }), { native: true, android: true, wallet: false },
  'an app without manageStaking gets no Manage delegation button');
  assert.deepEqual(env({ unNative: { platform: 'android' }, usernode: { isNative: 'yes' } }),
    { native: false, android: false, wallet: false }, 'isNative must be exactly true');
});

test('the detail view carries the step in place of the generic link, only for block production', () => {
  const { TC: T } = loadModule();
  T._challenges = [BLOCKS, SHARE];
  T._grouped = () => false;
  T._detailChallenge = BLOCKS;
  T._bpState = undefined;
  let v = plain(T.detailView());
  assert.equal(v.blockProduction.step, 'checking');
  assert.equal(v.cta, null, 'no generic link while the step is loading');

  T._bpState = { has_platform_access: true, bp_requested: false, bp_released: false };
  v = plain(T.detailView());
  assert.equal(v.blockProduction.step, 'request');
  assert.equal(v.cta, null);

  // The state could not be read: a retry, still never the Settings link.
  T._bpState = null;
  v = plain(T.detailView());
  assert.equal(v.blockProduction.step, 'error');
  assert.equal(v.cta, null);

  T._detailChallenge = SHARE;
  T._bpState = { has_platform_access: true, bp_requested: false, bp_released: false };
  v = plain(T.detailView());
  assert.equal(v.blockProduction, null, 'any other challenge keeps its own CTA');
  assert.equal(v.cta.href, '#settings/alerts');
});

test('a slow read from an earlier open never overwrites a newer one', async () => {
  const { TC: T, sandbox } = loadModule();
  const pending = [];
  sandbox.window.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  const answer = (data) => ({ ok: true, json: async () => ({ success: true, data }) });
  T._challenges = [BLOCKS];
  T._grouped = () => false;
  T._detailChallenge = BLOCKS;
  const first = T._loadBpState();
  T.retryBpState(); // a retry (or a reopen) starts a fresh read
  assert.equal(T._bpState, undefined, 'the retry shows the checking step');
  assert.equal(pending.length, 2);
  assert.equal(pending[0].url, '/challenges-api/bp/state');
  pending[1].resolve(answer({ has_platform_access: true, bp_requested: true, bp_released: true }));
  await new Promise((r) => setTimeout(r, 0));
  pending[0].resolve(answer({ has_platform_access: true, bp_requested: false, bp_released: false }));
  await first;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(T._bpState.bp_released, true, 'the newer answer stands');
});

test('requesting posts to the existing endpoint, then shows the pending step', async () => {
  const calls = [];
  const toasts = [];
  let firstRun = null;
  const { TC: T, sandbox } = loadModule({
    PlatformUI: { toast: (m, o) => toasts.push([m, o]) },
    NativeChrome: { maybeShowFirstRunPermissions: (o) => { firstRun = o; } },
  });
  sandbox.fetch = sandbox.window.fetch = async (url, opts) => {
    calls.push([url, opts && opts.method]);
    return { ok: true, json: async () => ({ success: true, data: { bp_requested: true, bp_released: false } }) };
  };
  T._challenges = [BLOCKS];
  T._grouped = () => false;
  T._detailChallenge = BLOCKS;
  T._bpState = { has_platform_access: true, bp_requested: false, bp_released: false };
  await T.requestBlockProduction();
  assert.deepEqual(calls, [['/challenges-api/bp/request', 'POST']]);
  assert.equal(T._bpState.bp_requested, true);
  assert.equal(plain(T.detailView()).blockProduction.step, 'pending');
  assert.equal(toasts.length, 1);
  assert.deepEqual(plain(firstRun), { force: true },
    'the Android device-setup sheet is offered the moment the account asks (#2960)');

  // A refusal keeps the request step and says why.
  sandbox.fetch = sandbox.window.fetch = async () => ({
    ok: false, json: async () => ({ success: false, error: 'Nope' }),
  });
  T._bpState = { has_platform_access: true, bp_requested: false, bp_released: false };
  await T.requestBlockProduction();
  assert.equal(plain(T.detailView()).blockProduction.step, 'request');
  assert.deepEqual(plain(toasts.at(-1)), ['Nope', { error: true }]);
});

test('the page renders each step', () => {
  const Pane = loadTsx('frontend/src/features/leaderboard/challenges-pane.tsx');
  const base = {
    key: '7', eyebrow: null, goal: 'Help run the network', deadline: null, amount: null,
    task: null, illustration: null, illustrationTone: null, state: 'new', stateLabel: 'Not started',
    fill: 0, counted: false, description: null, requirements: null, scoring: null,
    participants: 'Participants', pointsTotal: null, moreLabel: 'Show more →',
    entries: { kind: 'empty' }, cta: null,
  };
  const render = (bp) => renderToHtml(createElement(Pane.DetailPage, {
    view: { ...base, blockProduction: bp },
  }));
  const released = { has_platform_access: true, bp_requested: true, bp_released: true };

  const request = render(step({ has_platform_access: true, bp_requested: false, bp_released: false }, WEB));
  assert.match(request, /data-bp-step="request"/);
  assert.match(request, /<button[^>]*id="tc-bp-request"[^>]*>Request a wallet<\/button>/);
  assert.doesNotMatch(request, /settings\/usernode/);

  const err = render(step(null, WEB));
  assert.match(err, /data-bp-step="error"/);
  assert.match(err, /<button[^>]*id="tc-bp-retry"[^>]*>Try again<\/button>/);

  const android = render(step(released, ANDROID_APP));
  assert.match(android, /data-bp-step="account"/);
  assert.match(android, /data-bp-option="delegate"/);
  assert.match(android, /data-bp-option="on-device"/);
  assert.match(android, /data-bp-warning="on-device"/);
  assert.ok(android.indexOf('data-bp-option="delegate"') < android.indexOf('data-bp-option="on-device"'),
    'delegation comes first');
  assert.match(android, /<button[^>]*id="tc-bp-manage"[^>]*>Manage delegation<\/button>/);

  const ios = render(step(released, IOS_APP));
  assert.doesNotMatch(ios, /data-bp-option="on-device"/);
  assert.match(ios, /Android app/);

  const web = render(step(released, WEB));
  assert.doesNotMatch(web, /data-bp-option="on-device"/);
  assert.doesNotMatch(web, /tc-bp-manage/);
  assert.match(web, /Homeroom app/);

  assert.match(render(step(undefined, WEB)), /data-bp-step="checking"/);
  // Without a step the page is unchanged.
  assert.doesNotMatch(render(null), /data-bp-step/);
});
