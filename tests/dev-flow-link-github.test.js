// "Link GitHub" in the hand-off walkthrough goes to GitHub itself (#2679,
// #2680).
//
// The first step of the walkthrough used to be a button whose handler
// assigned `#settings/connectors` and left the person to find the Connect
// row on that screen — a whole screen between the step and the one thing it
// asks for, and the detour #2680 caught broken. The step is a real anchor
// now (public/js/dev-flow-select.js), straight at the social-identity
// connect route the Settings row itself uses, and dev-chat.js decides what
// the click does on each host:
//
//   * in a browser the anchor is left to the browser — a new tab, exactly
//     like "Fork on GitHub" (#1312) — and the status is re-read, the way
//     every other trip out of the card is handled;
//   * inside the Homeroom app the webview cannot reach github.com and the
//     system browser has its own cookie jar, so the click is cancelled and
//     the ACCOUNT-PINNED URL goes out through the bridge, through the very
//     helper the Settings row uses (features/settings/
//     native-social-connect.js), reached by name through the React bridge
//     because dev-chat.js cannot import.
//
// This drives the real DevChat in a vm sandbox — the harness
// tests/venue-return-to-chat.test.js established — because what matters is
// what the click DOES, and a regex over the source cannot see that. The
// helper is the real module, imported from where Settings imports it.
//
// Run with: node --test tests/dev-flow-link-github.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...rel) => fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
const SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const MOUNT_TS = read('frontend', 'src', 'features', 'dev-chat', 'mount.ts');
const DevFlowSelect = require('../public/js/dev-flow-select.js');

const ORIGIN = 'https://example.test';
const CONNECT = '/api/me/social-identities/github/connect';

async function makeDevChat({ native = false, bridge = null, published = true } = {}) {
  const { openNativeSocialConnect } = await import('../frontend/src/features/settings/native-social-connect.js');
  const opened = [];
  const noopEl = {
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, removeAttribute: () => {}, hasAttribute: () => false,
    getAttribute: () => null, focus: () => {}, scrollIntoView: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    appendChild: () => {}, insertAdjacentHTML: () => {}, remove: () => {},
    innerHTML: '', textContent: '', value: '', dataset: {},
  };
  const sandbox = {
    console,
    escapeHtml: (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    document: {
      getElementById: () => ({ ...noopEl }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    location: { search: '', hash: '', origin: ORIGIN },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.DevFlowSelect = DevFlowSelect;
  // `App.user.id` is what pins the system-browser trip to the signed-in
  // account, exactly as the Settings row reads it.
  sandbox.App = { user: { id: 7, externalFlowsAvailable: true, devFlowPreference: null }, currentApp: 'x' };
  sandbox.PlatformUI = { toast: () => {}, hasKit: () => false, menu: () => Promise.resolve(null) };
  // What frontend/src/features/dev-chat/mount.ts publishes, from the real
  // module — see the source pin below for the publication itself.
  sandbox.UsernodeReact = published ? { devChat: { openNativeSocialConnect } } : {};
  if (native) {
    sandbox.usernode = bridge || {
      isNative: true,
      openExternal: async (url) => { opened.push(url); return true; },
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat._resetDevFlow(7);
  DevChat.currentSession = {
    id: 7, status: 'active', build_venue: 'web-claude-code',
    agent_backend: 'claude_code', external_agent: null, pr_number: null,
    session_title: 'Demo',
  };
  DevChat.sessions = [DevChat.currentSession];
  DevChat.messages = [];
  DevChat.renderChatView = () => {};
  DevChat.renderMessages = () => {};
  const repaints = [];
  DevChat._repaintDevFlow = () => repaints.push({ notice: DevChat._devFlow.notice, error: DevChat._devFlow.error });
  const rereads = [];
  DevChat._devFlowEnsureStatus = async (force) => { rereads.push(!!force); };
  return { DevChat, sandbox, opened, repaints, rereads };
}

// What DevFlowSelect.wire() hands over for the rendered anchor: the action,
// the activated node and the click event itself.
function click() {
  const attrs = { 'data-flow-action': 'link-github', href: `${CONNECT}?intent=connect` };
  const anchor = { tagName: 'A', getAttribute: (name) => (name in attrs ? attrs[name] : null) };
  let prevented = 0;
  const event = { target: { closest: () => anchor }, preventDefault() { prevented += 1; } };
  return { anchor, event, prevented: () => prevented };
}

test('in a browser the anchor is left to navigate, and the walkthrough re-reads its status', async () => {
  const { DevChat, sandbox, opened, rereads } = await makeDevChat();
  const c = click();
  await DevChat._devFlowAction('link-github', c.anchor, c.event);
  assert.equal(c.prevented(), 0, 'the browser keeps the activation: a new tab, per #1312');
  assert.deepEqual(opened, [], 'no bridge, no scripted trip');
  assert.equal(sandbox.location.hash, '', 'and nothing sends this tab to Settings');
  assert.deepEqual(rereads, [true], 'the status is re-read, as after every trip out');
  assert.match(DevChat._devFlow.notice, /tab that just opened/);
  assert.equal(DevChat._devFlow.error, null);
});

test('inside the Homeroom app the click is cancelled and the account-pinned URL goes out through the bridge', async () => {
  const { DevChat, sandbox, opened, repaints, rereads } = await makeDevChat({ native: true });
  const c = click();
  await DevChat._devFlowAction('link-github', c.anchor, c.event);
  assert.equal(c.prevented(), 1, 'the webview cannot follow github.com itself');
  assert.deepEqual(opened, [`${ORIGIN}${CONNECT}?account=7&intent=connect`],
    'the SAME trip the Settings row makes, pinned to the signed-in account (#1734)');
  assert.equal(sandbox.location.hash, '', 'and nothing sends the app to Settings');
  assert.deepEqual(rereads, [], 'nothing to re-read until the person comes back');
  assert.equal(repaints.length, 1, 'the card says what happens next');
  assert.match(repaints[0].notice, /in your browser/);
  assert.match(repaints[0].notice, /same Homeroom account/);
  assert.equal(repaints[0].error, null);
});

test('an app build that cannot open the browser says so on the card', async () => {
  const { DevChat, sandbox, repaints } = await makeDevChat({ native: true, bridge: { isNative: true } });
  const c = click();
  await DevChat._devFlowAction('link-github', c.anchor, c.event);
  assert.equal(c.prevented(), 1);
  assert.equal(sandbox.location.hash, '');
  assert.equal(repaints.length, 1);
  assert.match(repaints[0].error, /Update the Homeroom app/, 'the helper\'s own reason, in place');
  assert.equal(repaints[0].notice, null);
  assert.equal(DevChat._devFlow.error, repaints[0].error);
});

test('a bundle without the bridge method falls back to Settings, where the row still is', async () => {
  const { DevChat, sandbox, opened } = await makeDevChat({ native: true, published: false });
  const c = click();
  await DevChat._devFlowAction('link-github', c.anchor, c.event);
  assert.equal(c.prevented(), 1);
  assert.deepEqual(opened, []);
  assert.equal(sandbox.location.hash, '#settings/connectors');
});

test('"Connect Homeroom" opens the steps in place, and sends nobody to Settings (#2706)', async () => {
  // It used to assign the Settings hash, which is the trip #2706 removed:
  // the steps are rendered under the card now, from the same source
  // Settings renders. This is the sibling of the #2679 change above — both
  // steps used to answer a question by navigating away from it.
  const { DevChat, sandbox, repaints } = await makeDevChat();
  await DevChat._devFlowAction('link-connector', {}, { preventDefault() {} });
  assert.equal(sandbox.location.hash, '', 'the tab stays on the session');
  assert.equal(DevChat._devFlow.connectorSteps, true);
  assert.equal(repaints.length, 1, 'and the launchpad repaints with them on it');
});

test('the bridge publishes the Settings helper for the dev chat to reach by name', () => {
  // dev-chat.js cannot import — a dozen tests load it as a script, this one
  // included — so the helper crosses the seam the way everything else does:
  // published on window.UsernodeReact.devChat by mount.ts.
  assert.match(MOUNT_TS, /import \{ openNativeSocialConnect \} from '\.\.\/settings\/native-social-connect\.js';/);
  assert.match(MOUNT_TS, /openNativeSocialConnect: typeof openNativeSocialConnect;/, 'typed on the bridge');
  assert.match(MOUNT_TS, /\n  openNativeSocialConnect,\n\};/, 'and on the object');
  assert.doesNotMatch(SRC, /^import /m, 'dev-chat.js stays import-free');
  assert.match(SRC, /react\.openNativeSocialConnect\(\{/, 'and reaches it through the bridge');
});
