// The shell's half of the frame door (public/js/app-view.js
// handleFrameDoorMessage; docs/plans/browser-site-isolation.md, step 4).
//
// A private app on another site than the shell keeps its door with a
// partitioned cookie; when a frame navigates without one, the app gate
// answers with a page that asks the shell for a fresh token
// (src/services/edge-gate.js, tests/edge-gate-frame-door.test.js). What this
// pins about the answer:
//   * it is a token for the app the asking FRAME shows (the App tab's frame,
//     or the staging preview), whatever the message says;
//   * it goes only to the origin that frame was pointed at, so a frame
//     navigated elsewhere, a page nested in an app, the landing viewer and
//     anything the shell does not own get nothing;
//   * a frame that changed while the token was minted gets nothing, and a
//     failed mint says so (null), so the page stops instead of waiting.
// The real app-view.js runs here, with a stand-in document and window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AppView = require('../public/js/app-view.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/app-view.js'), 'utf8');
const APP_SRC = 'https://privapp.onhomeroom.app/?token=old&un-theme=light';
const APP_ORIGIN = 'https://privapp.onhomeroom.app';
const NONCE = 'AbCdEfGhIjKlMnOpQrStUv';

const realMint = AppView._mintToken;
test.afterEach(() => {
  AppView._mintToken = realMint;
  AppView._stagingPreview = null;
  delete global.document;
  delete global.window;
  delete global.App;
});

function shell({ mint = async () => 'fresh-token', userId = 10 } = {}) {
  const posted = [];
  const minted = [];
  const frame = (src) => {
    const el = { src, contentWindow: null };
    el.contentWindow = { postMessage: (data, origin) => posted.push({ frame: el, data, origin }) };
    return el;
  };
  const frames = {
    'app-iframe': frame(APP_SRC),
    'staging-iframe': frame('https://privapp--s42.onhomeroom.app/?token=old'),
    'app-viewer-frame': frame('https://pubapp.onhomeroom.app/'),
  };
  global.document = { getElementById: (id) => frames[id] || null };
  global.window = {
    location: { href: 'https://app.onhomeroom.com/#app/privapp' },
    UsernodeReact: { appFrame: { slug: () => 'privapp' } },
  };
  global.App = { user: { id: userId } };
  AppView._mintToken = (slug) => { minted.push(slug); return mint(slug); };
  const ask = (frameId, opts = {}) => AppView.handleFrameDoorMessage({
    source: frames[frameId] ? frames[frameId].contentWindow : frameId,
    origin: opts.origin || new URL(frames[frameId].src).origin,
    data: 'data' in opts ? opts.data : { __usernode_frame_door: 'open', nonce: NONCE },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { frames, posted, minted, ask, settle };
}

test('the window listener hands every message to the frame door', () => {
  assert.match(SRC, /try \{ AppView\.handleFrameDoorMessage\(e\); \} catch \{\}/);
});

test('the App tab’s frame gets a fresh token for its own app, at its own origin', async () => {
  const s = shell();
  s.ask('app-iframe', { data: { __usernode_frame_door: 'open', nonce: NONCE, slug: 'someone-elses-app' } });
  await s.settle();
  assert.deepEqual(s.minted, ['privapp'], 'the frame names the app, never the message');
  assert.equal(s.posted.length, 1);
  assert.equal(s.posted[0].frame, s.frames['app-iframe']);
  assert.equal(s.posted[0].origin, APP_ORIGIN);
  assert.deepEqual(s.posted[0].data, { __usernode_frame_door: 'token', nonce: NONCE, token: 'fresh-token' });
});

test('the staging preview gets its app’s token too', async () => {
  const s = shell();
  AppView._stagingPreview = { slug: 'privapp' };
  s.ask('staging-iframe');
  await s.settle();
  assert.deepEqual(s.minted, ['privapp']);
  assert.equal(s.posted[0].origin, 'https://privapp--s42.onhomeroom.app');
});

test('nobody else is answered', async () => {
  const s = shell();
  s.ask('app-viewer-frame');
  s.ask({ postMessage() { throw new Error('a window the shell does not own'); } }, { origin: APP_ORIGIN });
  s.ask('app-iframe', { origin: 'https://evil.example' });
  s.ask('app-iframe', { origin: 'https://other.onhomeroom.app' });
  for (const data of [
    { __usernode_frame_door: 'open' },
    { __usernode_frame_door: 'open', nonce: 'short' },
    { __usernode_frame_door: 'open', nonce: '<script>alert(1)</script>xxxxxxxx' },
    { __usernode_frame_door: 'token', nonce: NONCE },
    'open',
    null,
  ]) s.ask('app-iframe', { data });
  await s.settle();
  assert.deepEqual(s.minted, []);
  assert.deepEqual(s.posted, []);
});

test('a frame that changed while the token was minted gets nothing', async () => {
  let release;
  const s = shell({ mint: () => new Promise((resolve) => { release = resolve; }) });
  s.ask('app-iframe');
  s.frames['app-iframe'].src = 'https://otherapp.onhomeroom.app/?token=x';
  release('fresh-token');
  await s.settle();
  assert.deepEqual(s.posted, []);
});

test('a failed mint answers null, so the page stops asking', async () => {
  const s = shell({ mint: async () => null });
  s.ask('app-iframe');
  await s.settle();
  assert.deepEqual(s.posted[0].data, { __usernode_frame_door: 'token', nonce: NONCE, token: null });
});
