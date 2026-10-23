'use strict';

// usernode.ready() — an app's "my first screen is drawn" (the bridge's
// __USERNODE_READY__ block). The shell half, which holds the launch cover
// until the message comes, is pinned in tests/app-launch.test.js (4b); this
// file pins the sender, and that every ready-made starter calls it once its
// first screen (ready, empty or error) is drawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'public/usernode-bridge/v1/bridge.js'), 'utf8');
const sender = bridge.split('/* __USERNODE_READY_BEGIN__ */')[1]
  .split('/* __USERNODE_READY_END__ */')[0];

function harness({ standalone = false } = {}) {
  const posts = [];
  const window = { usernode: {}, parent: { postMessage(message) { posts.push(message.__usernode_ready); } } };
  if (standalone) window.parent = window;
  vm.runInNewContext(sender, { window });
  return { usernode: window.usernode, posts };
}

const tick = () => new Promise((r) => setImmediate(r));

test('ready(promise) says waiting at once and drawn when the first render settles', async () => {
  const h = harness();
  let done;
  h.usernode.ready(new Promise((r) => { done = r; }));
  assert.deepEqual(h.posts, ['waiting']);
  done();
  await tick();
  assert.deepEqual(h.posts, ['waiting', 'drawn']);
});

test('a first render that fails is a first screen too', async () => {
  const h = harness();
  h.usernode.ready(Promise.reject(new Error('offline')));
  await tick();
  assert.deepEqual(h.posts, ['waiting', 'drawn']);
});

test('ready() with nothing says drawn, and only the first call counts', async () => {
  const h = harness();
  h.usernode.ready();
  h.usernode.ready(Promise.resolve());
  await tick();
  assert.deepEqual(h.posts, ['drawn']);
});

test('outside a Homeroom frame it posts nothing', async () => {
  const h = harness({ standalone: true });
  h.usernode.ready(Promise.resolve());
  await tick();
  assert.deepEqual(h.posts, []);
});

test('both hosted bridge copies carry it', () => {
  assert.equal(fs.readFileSync(path.join(root, 'public/usernode-bridge.js'), 'utf8'), bridge);
});

test('the app conventions document the call', () => {
  const doc = fs.readFileSync(path.join(root, 'src/prompts/app-conventions.md'), 'utf8');
  assert.match(doc, /usernode\.ready\(/);
});

// ── The ready-made starters ───────────────────────────────────────────

const appTemplates = require('../src/services/app-templates');
const STARTERS = appTemplates.TEMPLATE_IDS.filter((id) => id !== 'empty');

test('there are starters to check', () => {
  assert.ok(STARTERS.length >= 24, `${STARTERS.length} starters`);
});

for (const id of STARTERS) {
  const pub = appTemplates.starterFiles(id).filter((f) => /^public\//.test(f.path));
  const js = pub.filter((f) => /\.js$/.test(f.path)).map((f) => f.content).join('\n');

  test(`the ${id} starter says when its first screen is drawn`, () => {
    // The promise of the first load, which settles once ready, empty or
    // error is on screen, handed to usernode.ready, guarded for a page
    // opened outside Homeroom.
    const calls = js.match(/if \(window\.usernode && window\.usernode\.ready\) window\.usernode\.ready\(first\);/g) || [];
    assert.equal(calls.length, 1, 'once');
    assert.match(js, /var first = (?:load|refresh|loadToday)\(\);|var first = api\('GET', '\/api\/room'\)/);
  });

  if (/^game-/.test(id)) continue;
  test(`the ${id} starter fades its content in where the loading shapes were`, () => {
    const html = pub.find((f) => f.path === 'public/index.html').content;
    assert.match(html, /@keyframes appear \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
    assert.match(html, /@media \(prefers-reduced-motion: no-preference\) \{ \.appear \{ animation: appear 200ms ease-out; \} \}/,
      'not under reduced motion');
    assert.match(html, /class="[^"]*\bappear"[^>]*\bhidden\b|\bhidden\b[^>]*class="[^"]*\bappear"/, 'on a region the first load shows');
  });
}
