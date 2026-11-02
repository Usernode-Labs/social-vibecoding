// usernode.offline: an app's last reads, kept for offline
// (docs/plans/project-apps-offline-data.md).
//
// An app that opens with no connection has its code but not its data. The
// bridge keeps the last answer of each read an app wraps, in the app's own
// storage, sealed with a key the shell holds for the signed-in person, and
// gives it back when the read cannot be answered. Three halves:
//
//   1. The bridge block (between __USERNODE_OFFLINE_DATA_BEGIN__ / _END__),
//      run in a fake-window sandbox with Node's own WebCrypto, the shell
//      played by the test: what is kept, when the copy is used, whose it is,
//      the caps and the age.
//   2. The shell's answer (public/js/app-view.js, loaded whole into a vm):
//      a key only for the mounted app frame, one per person and per app.
//   3. Sign-out drops the key (public/js/app.js _dropCachedSession).
//
// Run with: node --test tests/usernode-offline-data.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.join(__dirname, '..');
const versioned = path.join(root, 'public', 'usernode-bridge', 'v1', 'bridge.js');
const unversioned = path.join(root, 'public', 'usernode-bridge.js');
const PLATFORM = 'https://app.onhomeroom.com';
const DAY = 24 * 60 * 60 * 1000;

function extractBlock(src) {
  const begin = src.indexOf('/* __USERNODE_OFFLINE_DATA_BEGIN__ */');
  const end = src.indexOf('/* __USERNODE_OFFLINE_DATA_END__ */');
  assert.ok(begin !== -1 && end !== -1 && end > begin, 'offline-data block markers present');
  return src.slice(begin, end);
}
const BLOCK = extractBlock(fs.readFileSync(versioned, 'utf8'));

// localStorage as the browser has it, shared between loads of one app.
function memoryStorage({ quota = Infinity } = {}) {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      const used = [...map].reduce((n, [key, val]) => n + (key === k ? 0 : key.length + val.length), 0);
      if (used + k.length + String(v).length > quota) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
  };
}

const randomKey = () => Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');

// One load of an app's page with the bridge block in it. `shell` is how the
// parent answers the key request: a key (base64), null, or 'silent'.
function load({
  storage = memoryStorage(),
  shell = randomKey(),
  shellOrigin = PLATFORM,
  framed = true,
  token = true,
  platformJson = PLATFORM,
  now = Date.UTC(2026, 10, 2, 10, 42),
} = {}) {
  const listeners = [];
  const timers = [];
  const clock = { now };
  const asked = [];
  const parent = {
    postMessage(msg) {
      if (!msg || msg.__usernode_kept !== 'key') return;
      asked.push(msg.id);
      if (shell === 'silent') return;
      Promise.resolve().then(() => {
        const e = { source: parent, origin: shellOrigin, data: { __usernode_kept: 'key', id: msg.id, key: shell } };
        listeners.slice().forEach((fn) => fn(e));
      });
    },
  };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const sandbox = {
    usernode: {},
    localStorage: storage,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    URL,
    URLSearchParams,
    Date: FakeDate,
    location: { search: token ? '?token=a.b.c' : '', origin: 'https://chores-abc.onhomeroom.com' },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout(id) { timers[id - 1] = null; },
    fetch: async (url) => {
      assert.equal(url, '/usernode-bridge/v1/platform.json');
      if (platformJson === 'offline') throw new TypeError('Load failed');
      return { ok: true, json: async () => ({ platform_origin: platformJson }) };
    },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    removeEventListener(type, fn) {
      const i = listeners.indexOf(fn);
      if (type === 'message' && i !== -1) listeners.splice(i, 1);
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.parent = framed ? parent : sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BLOCK, sandbox);
  return {
    offline: sandbox.usernode.offline,
    storage,
    clock,
    asked,
    // The key request's 3 s limit, run now.
    timeout() { timers.splice(0).forEach((fn) => fn && fn()); },
  };
}

const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));
const answered = (status) => () => Promise.reject(Object.assign(new Error(`HTTP ${status}`), { status }));
// Values built in the vm realm compare by shape, not prototype.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ── 1. The bridge ─────────────────────────────────────────────────────────

test('a read that worked is kept, and comes back with its time when the next one cannot be answered', async () => {
  const key = randomKey();
  const storage = memoryStorage();
  const first = load({ storage, shell: key });
  const fresh = await first.offline.read('chores', async () => ({ chores: [{ id: 1, name: 'Bins' }] }));
  assert.equal(fresh.fromCopy, false);
  assert.deepEqual(plain(fresh.value), { chores: [{ id: 1, name: 'Bins' }] });
  assert.equal(await first.offline.available(), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(storage.getItem('usernode:kept:chores'), 'the copy is in the app\'s own storage');

  const later = load({ storage, shell: key, now: Date.UTC(2026, 10, 2, 18, 5) });
  const copy = await later.offline.read('chores', unreachable);
  assert.equal(copy.fromCopy, true);
  assert.deepEqual(plain(copy.value), { chores: [{ id: 1, name: 'Bins' }] });
  assert.equal(copy.savedAt, Date.UTC(2026, 10, 2, 10, 42), 'the time it was kept, for the app to say');
  assert.equal(copy.error.name, 'TypeError', 'and why the read failed');
});

test('a copy is sealed: none of the data is in storage as text', async () => {
  const storage = memoryStorage();
  const h = load({ storage });
  assert.equal(await h.offline.put('list', { item: 'Oat milk for Ada' }), true);
  const raw = storage.getItem('usernode:kept:list');
  assert.doesNotMatch(raw, /Oat milk|Ada/);
  const entry = JSON.parse(raw);
  assert.deepEqual(Object.keys(entry).sort(), ['c', 'iv', 'k', 't']);
});

test('another person on the device cannot open the first one\'s copies, and they are deleted on sight', async () => {
  const storage = memoryStorage();
  const ada = load({ storage, shell: randomKey() });
  await ada.offline.put('chores', { mine: 'Ada' });
  await ada.offline.put('week', { mine: 'Ada' });
  assert.equal([...storage.map.keys()].filter((k) => k.startsWith('usernode:kept:')).length, 2);

  // Signed out and in as someone else: the shell has another key for them.
  const bo = load({ storage, shell: randomKey() });
  await assert.rejects(bo.offline.read('chores', unreachable), /Failed to fetch/, 'nothing of Ada\'s is shown');
  assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith('usernode:kept:')), [], 'both copies gone');
});

test('with no shell to ask, nothing is kept and a read is just the read', async () => {
  for (const opts of [{ framed: false }, { shell: null }]) {
    const storage = memoryStorage();
    const h = load({ storage, ...opts });
    const fresh = await h.offline.read('chores', async () => ({ n: 1 }));
    assert.equal(fresh.fromCopy, false);
    await assert.rejects(h.offline.read('chores', unreachable), /Failed to fetch/);
    assert.equal(await h.offline.available(), false);
    assert.equal(await h.offline.put('chores', { n: 1 }), false);
    assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith('usernode:kept:')), [], JSON.stringify(opts));
  }
});

test('a shell that never answers costs one wait, then nothing is kept', async () => {
  const h = load({ shell: 'silent' });
  const avail = h.offline.available();
  h.timeout();
  assert.equal(await avail, false);
  assert.equal(h.asked.length, 1, 'asked once per load');
  await h.offline.put('chores', { n: 1 });
  assert.equal(h.asked.length, 1, 'and not again');
});

test('a key is believed only from the platform\'s origin', async () => {
  const h = load({ shellOrigin: 'https://evil.example' });
  assert.equal(await h.offline.available(), false);

  const storage = memoryStorage();
  const key = randomKey();
  const online = load({ storage, shell: key });
  await online.offline.put('chores', { n: 1 });
  assert.equal(storage.getItem('usernode:platform-origin'), PLATFORM, 'remembered from platform.json');
  // Offline, platform.json cannot load: the remembered origin answers.
  const offline = load({ storage, shell: key, platformJson: 'offline' });
  assert.deepEqual(plain((await offline.offline.get('chores')).value), { n: 1 });
  // A platform.json that names a plain-http origin is not believed.
  assert.equal(await load({ platformJson: 'http://app.onhomeroom.com', shellOrigin: 'http://app.onhomeroom.com' }).offline.available(), false);
});

test('which failures use the copy, which stand, and which delete it', async () => {
  const storage = memoryStorage();
  const key = randomKey();
  const h = load({ storage, shell: key });
  await h.offline.put('chores', { n: 1 });

  for (const status of [500, 502, 503, 504, 408, 429]) {
    assert.equal((await h.offline.read('chores', answered(status))).fromCopy, true, `${status} uses the copy`);
  }
  assert.equal((await h.offline.read('chores', () => Promise.reject(new Error('no status')))).fromCopy, true,
    'an error with no status is no answer');
  for (const status of [400, 401, 409, 422]) {
    await assert.rejects(h.offline.read('chores', answered(status)), new RegExp(`HTTP ${status}`), `${status} stands`);
  }
  assert.ok(await h.offline.get('chores'), 'and leaves the copy');

  // An offline mount carried no token: its 401 is the missing sign-in.
  const tokenless = load({ storage, shell: key, token: false });
  assert.equal((await tokenless.offline.read('chores', answered(401))).fromCopy, true);

  for (const status of [403, 404, 410]) {
    await h.offline.put('chores', { n: 1 });
    await assert.rejects(h.offline.read('chores', answered(status)), new RegExp(`HTTP ${status}`));
    assert.equal(await h.offline.get('chores'), null, `${status}: the copy is deleted`);
  }
});

test('caps: a copy too large is not kept and takes its older copy with it; the oldest make room', async () => {
  const storage = memoryStorage();
  const h = load({ storage });
  await h.offline.put('big', { text: 'small' });
  assert.equal(await h.offline.put('big', { text: 'x'.repeat(250_001) }), false);
  assert.equal(await h.offline.get('big'), null, 'the older copy went too');

  // 1,000,000 characters in all: five copies of ~260k (sealed) cannot fit.
  for (let i = 0; i < 5; i++) {
    h.clock.now += 1000;
    assert.equal(await h.offline.put(`n${i}`, { text: 'y'.repeat(190_000) }), true, `n${i} kept`);
  }
  const kept = [...storage.map.keys()].filter((k) => k.startsWith('usernode:kept:')).sort();
  assert.ok(!kept.includes('usernode:kept:n0'), 'the copy kept longest ago made room');
  assert.ok(kept.includes('usernode:kept:n4'), 'the newest is there');
  const total = kept.reduce((n, k) => n + k.length + storage.getItem(k).length, 0);
  assert.ok(total <= 1_000_000, `all copies together stay under the cap (${total})`);
});

test('an app whose own storage is full keeps nothing, and nothing breaks', async () => {
  const storage = memoryStorage({ quota: 5_000 });
  const h = load({ storage });
  assert.equal(await h.offline.put('chores', { text: 'z'.repeat(10_000) }), false);
  assert.equal((await h.offline.read('chores', async () => ({ n: 1 }))).fromCopy, false);
});

test('a copy older than 30 days is not given back', async () => {
  const storage = memoryStorage();
  const key = randomKey();
  const h = load({ storage, shell: key });
  await h.offline.put('chores', { n: 1 });
  const month = load({ storage, shell: key, now: h.clock.now + 31 * DAY });
  await assert.rejects(month.offline.read('chores', unreachable), /Failed to fetch/);
  assert.equal(storage.getItem('usernode:kept:chores'), null, 'swept when the key came');
});

test('a copy cannot be moved to another name', async () => {
  const storage = memoryStorage();
  const key = randomKey();
  const h = load({ storage, shell: key });
  await h.offline.put('mine', { secret: 1 });
  storage.setItem('usernode:kept:theirs', storage.getItem('usernode:kept:mine'));
  assert.equal(await h.offline.get('theirs'), null);
  assert.equal(storage.getItem('usernode:kept:theirs'), null);
  assert.deepEqual(plain((await h.offline.get('mine')).value), { secret: 1 });
});

test('the newest keep of a name wins, and a remove outranks one on its way', async () => {
  const h = load();
  const a = h.offline.put('chores', { v: 'old' });
  const b = h.offline.put('chores', { v: 'new' });
  await Promise.all([a, b]);
  assert.deepEqual(plain((await h.offline.get('chores')).value), { v: 'new' });
  const c = h.offline.put('chores', { v: 'late' });
  await h.offline.remove('chores');
  await c;
  assert.equal(await h.offline.get('chores'), null);
});

test('names and read functions are checked; a read that returns nothing keeps nothing', async () => {
  const h = load();
  for (const bad of ['', 'x'.repeat(101), 7, null]) {
    await assert.rejects(h.offline.read(bad, async () => 1), /a name is a string of 1 to 100 characters/);
  }
  await assert.rejects(h.offline.read('chores', 'not a function'), /readFn must be a function/);
  await h.offline.put('chores', { n: 1 });
  await h.offline.read('chores', async () => undefined);
  assert.deepEqual(plain((await h.offline.get('chores')).value), { n: 1 }, 'the copy stays');
});

test('both hosted bridge copies carry the block, byte for byte', () => {
  const a = fs.readFileSync(versioned, 'utf8');
  const b = fs.readFileSync(unversioned, 'utf8');
  assert.equal(extractBlock(b), extractBlock(a));
});

// ── 2. The shell's answer ─────────────────────────────────────────────────

function shellHarness({ user = { id: 7 }, slug = 'chores-abc' } = {}) {
  const src = fs.readFileSync(path.join(root, 'public', 'js', 'app-view.js'), 'utf8');
  const frames = {};
  const mkFrame = (id, origin) => {
    const win = { posted: [], postMessage(msg, target) { this.posted.push({ msg, target }); } };
    frames[id] = { id, src: `${origin}/#un-theme=dark`, contentWindow: win };
    return frames[id];
  };
  mkFrame('app-iframe', 'https://chores-abc.onhomeroom.com');
  mkFrame('staging-iframe', 'https://chores-abc--s12.onhomeroom.com');
  const storage = memoryStorage();
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    App: { user },
    document: {
      getElementById: (id) => frames[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      documentElement: { classList: { contains: () => false } },
    },
    location: { origin: PLATFORM, hostname: 'app.onhomeroom.com', href: `${PLATFORM}/` },
    localStorage: storage,
    crypto: webcrypto,
    TextEncoder,
    atob,
    btoa,
    URL,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    UsernodeReact: { appFrame: { slug: () => slug } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  const ask = async (frameId, id = 'kept-1') => {
    const frame = frames[frameId];
    const origin = new URL(frame.src).origin;
    const before = frame.contentWindow.posted.length;
    AppView.handleAppDataKeyMessage({ source: frame.contentWindow, origin, data: { __usernode_kept: 'key', id } });
    await new Promise((r) => setTimeout(r, 20));
    const sent = frame.contentWindow.posted.slice(before);
    return sent.length ? { ...sent[0].msg, target: sent[0].target } : undefined;
  };
  return { AppView, sandbox, frames, storage, ask, mkFrame };
}

test('the shell gives the mounted app frame a key of 32 bytes, the same one each load', async () => {
  const h = shellHarness();
  const first = await h.ask('app-iframe');
  assert.equal(first.__usernode_kept, 'key');
  assert.equal(first.id, 'kept-1');
  assert.equal(first.target, 'https://chores-abc.onhomeroom.com', 'posted to the frame\'s own origin only');
  assert.equal(Buffer.from(first.key, 'base64').length, 32);
  assert.equal((await h.ask('app-iframe', 'kept-2')).key, first.key);
  assert.doesNotMatch(h.storage.getItem('usernode:app-data-key'), new RegExp(first.key.replace(/[+/=]/g, '.')),
    'the app\'s key is derived, never the stored one');
});

test('each app gets its own key, and each person theirs', async () => {
  const h = shellHarness();
  const chores = await h.ask('app-iframe');
  h.frames['app-iframe'].src = 'https://gym-9de81f.onhomeroom.com/';
  assert.notEqual((await h.ask('app-iframe')).key, chores.key, 'another origin, another key');
  h.frames['app-iframe'].src = 'https://chores-abc.onhomeroom.com/';
  h.sandbox.App.user = { id: 8 };
  assert.notEqual((await h.ask('app-iframe')).key, chores.key, 'another person, another key');
});

test('signing out drops the key: what was sealed with it never opens again', async () => {
  const h = shellHarness();
  const before = await h.ask('app-iframe');
  h.AppView.clearAppDataKey();
  assert.equal(h.storage.getItem('usernode:app-data-key'), null);
  assert.notEqual((await h.ask('app-iframe')).key, before.key);
});

test('a staging preview and a signed-out shell are told there is no key; other frames are not answered', async () => {
  const h = shellHarness();
  assert.equal((await h.ask('staging-iframe')).key, null);
  const signedOut = shellHarness({ user: null });
  assert.equal((await signedOut.ask('app-iframe')).key, null);
  const stranger = { posted: [], postMessage(m) { this.posted.push(m); } };
  h.AppView.handleAppDataKeyMessage({ source: stranger, origin: 'https://evil.example', data: { __usernode_kept: 'key', id: 'x' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(stranger.posted, []);
});

test('a bridge and a shell agree: what one load keeps the next opens', async () => {
  const shell = shellHarness();
  const storage = memoryStorage();
  const keyFor = async () => (await shell.ask('app-iframe')).key;
  const first = load({ storage, shell: await keyFor() });
  await first.offline.put('chores', { n: 3 });
  const second = load({ storage, shell: await keyFor() });
  assert.deepEqual(plain((await second.offline.get('chores')).value), { n: 3 });
  shell.AppView.clearAppDataKey();
  const afterSignOut = load({ storage, shell: await keyFor() });
  assert.equal(await afterSignOut.offline.get('chores'), null);
});

// ── 3. Sign-out ───────────────────────────────────────────────────────────

test('the session sweep drops the key, except for a restored session\'s new token', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const start = app.indexOf('  _dropCachedSession({ apiCache = true, keepUnsent = false } = {}) {');
  assert.ok(start !== -1);
  const body = app.slice(start, app.indexOf('\n  },\n', start));
  assert.match(body, /if \(!keepUnsent && typeof AppView !== 'undefined'\) AppView\.clearAppDataKey\(\);/);
  const view = fs.readFileSync(path.join(root, 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(view, /try \{ AppView\.handleAppDataKeyMessage\(e\); \} catch \{\}/, 'the shell listens');
});
