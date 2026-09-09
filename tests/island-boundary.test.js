// One island's blast radius.
//
// ── The hole ───────────────────────────────────────────────────────────
//
// main.tsx hydrates `document.body`, so the React tree IS the document.
// React's answer to an uncaught render or commit error is to unmount the
// root — which here means emptying the page. Reproduced in a browser before
// this was written: one island made to throw took the header, every screen
// and every listener with it, leaving `html`'s background — a black,
// unresponsive screen on a phone in dark mode. Which is how it gets reported.
//
// So: a boundary below the root, per island. A throw then costs that island
// and nothing else, and names itself in `window.UsernodeReact.islandErrors`
// so the next report can say WHICH one.
//
// Run with: node --test tests/island-boundary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SHELL = read('frontend/src/Shell.tsx');
const PORTALS = read('frontend/src/lib/legacy-portals.tsx');

let mod = null;
const boundary = () => (mod = mod || loadTsx('frontend/src/lib/island-boundary.tsx'));

test('the boundary catches, records which island, and renders the fallback', () => {
  const { Island, islandErrors } = boundary();
  const before = islandErrors.length;

  // getDerivedStateFromError is what flips it; componentDidCatch is what
  // makes the failure answerable afterwards.
  assert.deepEqual(Island.getDerivedStateFromError(), { failed: true });

  const inst = new Island({ name: 'HeaderMenu', children: 'live' });
  inst.componentDidCatch(new Error('boom'), { componentStack: '\n  at HeaderMenu' });
  assert.equal(islandErrors.length, before + 1);
  assert.deepEqual(
    { island: islandErrors[before].island, message: islandErrors[before].message },
    { island: 'HeaderMenu', message: 'boom' }
  );

  // Healthy: children, untouched.
  inst.state = { failed: false };
  assert.equal(inst.render(), 'live');
  // Failed: nothing, unless a caller supplied something.
  inst.state = { failed: true };
  assert.equal(inst.render(), null, 'no fallback means the island is simply absent');
  inst.props = { name: 'HeaderMenu', children: 'live', fallback: 'sorry' };
  assert.equal(inst.render(), 'sorry');
});

test('it renders NO DOM of its own, so the prerender and hydration are unchanged', () => {
  const { Island } = boundary();
  const html = renderToHtml(createElement(Island, { name: 'x' }, createElement('p', null, 'hi')));
  assert.equal(html, '<p>hi</p>', 'no wrapper element around the island');
});

test('the list is published for a bug report to read', () => {
  const SRC = read('frontend/src/lib/island-boundary.tsx');
  assert.match(SRC, /w\.UsernodeReact\.islandErrors = islandErrors;/,
    'window.UsernodeReact.islandErrors names what went, after the console is gone');
  // No retry and no reload: re-rendering the subtree that just threw usually
  // throws again, and a self-reloading page destroys whatever the reader was
  // in the middle of.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('location.reload'), 'the boundary never reloads the page');
  assert.ok(!/setState\(\{ failed: false/.test(code), 'and never retries on its own');
});

test('EVERY island in the Shell is wrapped — none may be added bare', () => {
  // The invariant that decays: someone adds the 25th island and forgets, and
  // the whole document is one throw away again. A bare `<Capitalized />` at
  // the tree's own indentation is what that looks like.
  const bare = [];
  for (const line of SHELL.split('\n')) {
    const m = /^ {6}<([A-Z][A-Za-z0-9]*) \/>$/.exec(line);
    if (m) bare.push(m[1]);
  }
  assert.deepEqual(bare, [], 'these islands render outside any <Island> boundary');

  const wrapped = Array.from(SHELL.matchAll(/<Island name="([A-Za-z0-9]+)"><([A-Za-z0-9]+) \/><\/Island>/g));
  assert.ok(wrapped.length >= 20, `expected the shell's islands to be wrapped, saw ${wrapped.length}`);
  for (const [, name, comp] of wrapped) {
    assert.equal(name, comp, 'the boundary is named for the component it guards');
  }
});

test('each legacy PORTAL is wrapped too, not the map around them', () => {
  // Every runtime-injected region — the dev board, the chat, the topic view,
  // an admin section — arrives through this one map. A boundary around the
  // map would let one of them take all the others down, and then the root.
  assert.match(
    PORTALS,
    /createElement\(Island, \{ name: `portal:\$\{entry\.host\.id \|\| 'anonymous'\}` \}, entry\.node\)/,
    'the boundary is inside the per-entry createPortal call'
  );
});
