'use strict';

// #2993: Settings > Delete account after its account-details check fails.
//
// Opening the form runs `show()`, which asks GET /api/auth/account-deletion
// whether a password is required. `passwordRequired` starts null, the form
// draws "Loading account details…" while it is null, and the submit button is
// disabled while it is null. A failed check used to set only `error`, so the
// loading line stayed up beside the red error forever, the submit could never
// enable, and there was no way to ask again short of reloading.
//
// This drives the real component (frontend/src/features/settings/delete-account.tsx)
// through loading -> error -> retry -> success. renderToStaticMarkup runs no
// state updates, so `react` is stubbed with a minimal hook store and the
// component is called as a plain function: the element tree it returns is
// what the assertions read, and the Buttons' own props carry the handlers.
//
// Run with: node --test tests/delete-account-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTsx, FRONTEND } = require('./lib/render-tsx');

const RealReact = require(require.resolve('react', { paths: [FRONTEND] }));

function createHookStore() {
  const slots = [];
  let cursor = 0;
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  const React = {
    ...RealReact,
    useRef: (current) => slot(() => ({ current })),
    useState(initial) {
      const s = slot(() => {
        const state = { value: initial };
        state.set = (next) => { state.value = typeof next === 'function' ? next(state.value) : next; };
        return state;
      });
      return [s.value, s.set];
    },
  };
  return { React, begin() { cursor = 0; } };
}

// Flatten a React element tree: every element (by type/props) and its text.
function walk(node, out = { elements: [], text: [] }) {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node.props) {
    out.elements.push(node);
    walk(node.props.children, out);
  }
  return out;
}

const textOf = (el) => walk(el.props.children).text.join('');

function mount(fetchImpl) {
  const store = createHookStore();
  const mod = loadTsx('frontend/src/features/settings/delete-account.tsx', {
    stubs: { react: store.React, './facade.js': { ensureSettings: async () => null } },
  });
  const calls = [];
  global.fetch = async (url, opts) => { calls.push(url); return fetchImpl(url, opts); };
  const render = () => { store.begin(); return walk(mod.DeleteAccount()); };
  return { render, calls };
}

const flush = () => new Promise((r) => setImmediate(r));
const button = (tree, label) => tree.elements.find((e) => typeof e.props.onClick === 'function' && textOf(e).includes(label))
  || tree.elements.find((e) => e.props.type === 'submit' && textOf(e).includes(label));
const hasText = (tree, s) => tree.text.join('\n').includes(s);

test.afterEach(() => { delete global.fetch; });

test('#2993: a failed check swaps the loading line for Try again, and a retry that succeeds enables the form', async () => {
  let fail = true;
  const { render, calls } = mount(async () => fail
    ? { ok: false, json: async () => ({ error: 'Could not load account details.' }) }
    : { ok: true, json: async () => ({ passwordRequired: false }) });

  let tree = render();
  button(tree, 'Delete account').props.onClick();

  // Loading: the status line is up, no retry, submit disabled.
  tree = render();
  assert.ok(hasText(tree, 'Loading account details'), 'loading line while the check is in flight');
  assert.equal(button(tree, 'Try again'), undefined, 'no retry while loading');
  assert.equal(button(tree, 'Delete my account permanently').props.disabled, true);

  // Failure: error shown, loading line gone, Try again offered, submit still disabled.
  await flush();
  tree = render();
  assert.equal(calls[0], '/api/auth/account-deletion');
  assert.ok(hasText(tree, 'Could not load account details.'), 'the error is shown');
  assert.ok(!hasText(tree, 'Loading account details'), 'the loading line does not linger beside the error');
  const retry = button(tree, 'Try again');
  assert.ok(retry, 'a Try again control is offered');
  assert.equal(retry.props.variant, 'pillNeutral', 'the retry is the neutral secondary pill');
  assert.equal(retry.props.ink, 'neutral', 'with its paired neutral ink');
  assert.equal(button(tree, 'Delete my account permanently').props.disabled, true, 'submit stays disabled after a failed check');

  // Retry: the error clears and the loading line returns while the new check runs.
  fail = false;
  retry.props.onClick();
  tree = render();
  assert.ok(!hasText(tree, 'Could not load account details.'), 'the error clears on retry');
  assert.ok(hasText(tree, 'Loading account details'), 'loading again while the retry is in flight');
  assert.equal(calls.length, 2, 'Try again re-runs the check');

  // Success: form usable once DELETE is typed.
  await flush();
  tree = render();
  assert.ok(!hasText(tree, 'Loading account details'));
  assert.equal(button(tree, 'Try again'), undefined, 'the retry goes away once the check succeeds');
  const confirm = tree.elements.find((e) => e.props.autoComplete === 'off' && typeof e.props.onChange === 'function');
  confirm.props.onChange({ target: { value: 'DELETE' } });
  tree = render();
  assert.equal(button(tree, 'Delete my account permanently').props.disabled, false, 'submit enables after a successful retry');
});

test('#2993: a network failure (fetch throws) also offers Try again', async () => {
  const { render } = mount(async () => { throw new TypeError('Failed to fetch'); });
  let tree = render();
  button(tree, 'Delete account').props.onClick();
  await flush();
  tree = render();
  assert.ok(hasText(tree, 'Failed to fetch'));
  assert.ok(!hasText(tree, 'Loading account details'));
  assert.ok(button(tree, 'Try again'));
});

test('the source keeps the retry keyed on the failed-check state', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/settings/delete-account.tsx'), 'utf8');
  assert.match(src, /passwordRequired === null \? \(error \?/);
  assert.match(src, /disabled=\{busy \|\| confirmation !== 'DELETE' \|\| passwordRequired === null/);
});
