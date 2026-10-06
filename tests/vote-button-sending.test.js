'use strict';

// #3987: the vote button says the vote is on its way.
//
// "Clicked yes and nothing happened for like 10 seconds." Until the server
// answered, the vote button sat there looking untouched. Now the moment the
// vote is committed to send the face carries the "Preview building…" pill's
// pattern — the arc, then "Voting…" — and goes disabled, so a second tap can
// neither land nor look ignored. It covers every home the VoteButton draws:
// the one-tap Approve, the Vote face behind the picker, the governance pair,
// and the touch fallback's prompt-then-send path. `castIssueVote` gains the
// same `onSend` hook `castVote` already documents, so a governance vote
// lights the spinner too.
//
// Run with: node --test tests/vote-button-sending.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

// ── A React small enough to step through ─────────────────────────────────
// tests/dialog-suspend-exit.test.js's: the hooks VoteButton uses, with
// updates from outside an event batched into a microtask render, and a JSX
// runtime that hands back plain objects the test can press.

function createFakeReact() {
  const slots = [];
  let cursor = 0;
  let renderFn = null;
  let scheduled = false;
  let unmounted = false;
  let layout = [];
  let passive = [];

  const changed = (prev, next) =>
    !prev || !next || prev.length !== next.length || prev.some((v, i) => !Object.is(v, next[i]));
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  const effectHook = (queue) => (effect, deps) => {
    const s = slot(() => ({ fresh: true, deps: undefined, cleanup: undefined }));
    if (!s.fresh && !changed(s.deps, deps)) return;
    s.fresh = false;
    s.deps = deps;
    queue().push(() => {
      if (typeof s.cleanup === 'function') s.cleanup();
      s.cleanup = effect();
    });
  };

  const React = {
    useRef: (current) => slot(() => ({ current })),
    useState(initial) {
      const s = slot(() => {
        const state = { value: initial };
        state.set = (next) => {
          const value = typeof next === 'function' ? next(state.value) : next;
          if (Object.is(value, state.value)) return;
          state.value = value;
          schedule();
        };
        return state;
      });
      return [s.value, s.set];
    },
    useMemo(factory, deps) {
      const s = slot(() => ({ fresh: true, deps: undefined, value: undefined }));
      if (s.fresh || changed(s.deps, deps)) {
        s.fresh = false;
        s.deps = deps;
        s.value = factory();
      }
      return s.value;
    },
    useCallback: (fn, deps) => React.useMemo(() => fn, deps),
    // The shell primitives call forwardRef at module load; nothing renders
    // them here, so the render function itself stands in.
    forwardRef: (render) => render,
    useLayoutEffect: effectHook(() => layout),
    useEffect: effectHook(() => passive),
  };

  function render() {
    cursor = 0;
    layout = [];
    passive = [];
    renderFn();
    for (const run of layout) run();
    for (const run of passive) run();
  }
  function schedule() {
    if (scheduled || unmounted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!unmounted) render();
    });
  }

  return {
    React,
    mount(fn) {
      renderFn = fn;
      render();
    },
    unmount() {
      unmounted = true;
      for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup();
    },
  };
}

const jsxRuntime = {
  Fragment: 'Fragment',
  jsx: (type, props, key) => ({ type, props, key }),
  jsxs: (type, props, key) => ({ type, props, key }),
};

/** Every element in a tree of those objects, depth first — portals included. */
function* elementsOf(node) {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* elementsOf(child);
    return;
  }
  if (typeof node !== 'object') { yield node; return; }
  yield node;
  yield* elementsOf(node.props?.children);
  // react-dom's createPortal under the stubbed runtime: { $$typeof, children, container }.
  if (node.$$typeof && node.children !== undefined) yield* elementsOf(node.children);
}

// Every microtask render cascade has run by the next task.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const yesSpec = { key: 'yes', cls: 'gc-vote-btn gc-vote-btn-yes', title: 'Yes', label: 'Yes (2/3)', act: { fn: 'castVote', args: [7, 'yes', 3] } };
const noSpec = { key: 'no', cls: 'gc-vote-btn gc-vote-btn-no', title: 'No', label: 'No (0/3)', act: { fn: 'castVote', args: [7, 'no', 3] } };

/**
 * Mount `VoteButton` against a stubbed `window.AppView.castVote` (or
 * `castIssueVote`) the test holds on a deferred. Returns finders for the
 * face button, the arc spinner and the picker.
 */
function mountVoteButton(t, { yes = yesSpec, no = noSpec, stub = null, touch = false } = {}) {
  const saved = ['window', 'document', 'PlatformUI'].map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = win;
  // nodeType 1: react-dom's createPortal answers for nothing else.
  globalThis.document = { addEventListener() {}, removeEventListener() {}, body: { nodeType: 1 } };
  if (touch) {
    globalThis.PlatformUI = {
      isTouch: () => true,
      actionSheet: ({ actions }) => { actions[0].handler(); },
    };
    win.PlatformUI = globalThis.PlatformUI;
  } else {
    delete globalThis.PlatformUI;
  }
  win.AppView = { [yes.act.fn]: stub };

  const fake = createFakeReact();
  const { VoteButton } = loadTsx('frontend/src/features/dev-board/card/dev-card.tsx', {
    stubs: { react: fake.React, 'react/jsx-runtime': jsxRuntime },
  });
  let tree = null;
  fake.mount(() => { tree = VoteButton({ yes, no }); });
  t.after(() => fake.unmount());

  const find = (match) => {
    for (const el of elementsOf(tree)) if (match(el)) return el;
    return null;
  };
  const face = () => find((el) => el.type === 'button' && /dev-vote-btn/.test(el.props?.className || ''));
  // The arc as the tree holds it: the `<Spinner />` element, since the fake
  // runtime hands back function elements unexpanded.
  const spinner = () => find((el) => (el.type === 'span'
      && /dc-status-spinner-arc/.test(el.props?.className || ''))
    || (typeof el.type === 'function' && el.type.name === 'Spinner'));
  const texts = () => {
    const out = [];
    for (const el of elementsOf(tree)) if (typeof el === 'string') out.push(el);
    return out.join('\n');
  };
  const toggleEvent = () => ({
    stopPropagation() {},
    currentTarget: { getBoundingClientRect: () => ({ top: 100, bottom: 130, right: 300 }) },
  });
  return { find, face, spinner, texts, toggleEvent };
}

// ── The one-tap Approve ───────────────────────────────────────────────

test('the Approve button says Voting… while its vote travels, and the call carries the bag last', async (t) => {
  const calls = [];
  let settleVote = null;
  const stub = (...args) => {
    calls.push(args);
    const bag = args[args.length - 1];
    assert.equal(typeof bag.onSend, 'function', 'the bag carries onSend');
    bag.onSend(args[1]);
    return new Promise((resolve) => { settleVote = resolve; });
  };
  const approve = { ...yesSpec, solo: true, approve: true };
  const { face, spinner, texts } = mountVoteButton(t, { yes: approve, stub });
  assert.equal(texts().includes('Voting…'), false, 'nothing is on its way yet');

  face().props.onClick({ stopPropagation() {} });
  await settle();
  assert.deepEqual(calls[0], [7, 'yes', 3, calls[0][3]], 'positional slots, bag last');
  assert.equal(calls[0][3].reason, null, 'one-tap Approve sends no line and asks for none');
  const sending = face();
  assert.equal(sending.props.disabled, true, 'a second tap cannot land');
  assert.ok(spinner(), 'the arc the Preview pill uses');
  assert.ok(texts().includes('Voting…'));
  assert.ok(!texts().includes('Approve'), 'the face is the spinner and the word, not its label');

  settleVote(true);
  await settle();
  assert.equal(face().props.disabled, false, 'settled: the button answers again');
  assert.equal(spinner(), null, 'the arc is gone');
  assert.ok(texts().includes('Approve'), 'and the face is its own again');
  assert.ok(!texts().includes('Voting…'));
});

// ── The Vote face, from the picker's send ─────────────────────────────

test('Vote yes closes the picker onto a Voting… face; a refusal settles it back with the caret', async (t) => {
  const calls = [];
  let settleVote = null;
  const stub = (...args) => {
    calls.push(args);
    args[args.length - 1].onSend(args[1]);
    return new Promise((resolve) => { settleVote = resolve; });
  };
  const { find, face, spinner, texts, toggleEvent } = mountVoteButton(t, { stub });

  face().props.onClick(toggleEvent());
  await settle();
  const pop = find((el) => el.props?.className === 'dev-vote-pop');
  assert.ok(pop, 'the picker is up');
  const picker = find((el) => typeof el.type === 'function' && el.type.name === 'VotePicker');
  assert.ok(picker, 'the panel inside it');

  picker.props.onSend();
  await settle();
  assert.deepEqual(calls[0], [7, 'yes', 3, calls[0][3]], 'castVote(sessionId, vote, epoch, bag)');
  assert.equal(calls[0][3].reason, null, 'a Yes with no line sends none');
  assert.equal(find((el) => el.props?.className === 'dev-vote-pop'), null, 'the picker is closed');
  assert.equal(face().props.disabled, true, 'the face cannot be pressed again');
  assert.ok(spinner(), 'the arc on the face');
  assert.ok(texts().includes('Voting…'));

  settleVote(false);
  await settle();
  assert.equal(face().props.disabled, false, 'a refusal clears the wait too');
  assert.equal(spinner(), null);
  assert.ok(texts().includes('Vote'), 'the face is its own again, caret and all');
  assert.ok(!texts().includes('Voting…'));
});

// ── The governance pair ───────────────────────────────────────────────

test('a governance vote dispatches castIssueVote with the same bag', async (t) => {
  const calls = [];
  let settleVote = null;
  const stub = (...args) => {
    calls.push(args);
    args[args.length - 1].onSend(args[1]);
    // Held, like the round-trip it stands for: an already-resolved promise
    // would clear the spinner the same microtask it lit.
    return new Promise((resolve) => { settleVote = resolve; });
  };
  const govYes = { ...yesSpec, act: { fn: 'castIssueVote', args: [11, 'up'] } };
  const govNo = { ...noSpec, act: { fn: 'castIssueVote', args: [11, 'down'] } };
  const { find, face, spinner, toggleEvent } = mountVoteButton(t, { yes: govYes, no: govNo, stub });

  face().props.onClick(toggleEvent());
  await settle();
  find((el) => typeof el.type === 'function' && el.type.name === 'VotePicker').props.onSend();
  await settle();
  assert.deepEqual(calls[0].slice(0, 2), [11, 'up'], 'castIssueVote(issueId, vote, bag)');
  assert.equal(calls[0].length, 3, 'two positional slots for this call, bag third');
  assert.equal(calls[0][2].reason, null);
  assert.equal(typeof calls[0][2].onSend, 'function');
  assert.ok(spinner(), 'the spinner lights here too, until the promise settles');
  settleVote(true);
  await settle();
  assert.equal(spinner(), null, 'and clears when it lands');
});

// ── The touch fallback ────────────────────────────────────────────────

test('the action-sheet fallback asks for its line first and passes onSend with no reason key', async (t) => {
  const calls = [];
  let settleVote = null;
  const stub = (...args) => {
    calls.push(args);
    const bag = args[args.length - 1];
    assert.equal(typeof bag.onSend, 'function');
    assert.equal('reason' in bag, false, 'no reason key: the call asks, as it always has');
    bag.onSend(args[1]);
    return new Promise((resolve) => { settleVote = resolve; });
  };
  const { face, spinner, texts, toggleEvent } = mountVoteButton(t, { stub, touch: true });

  face().props.onClick(toggleEvent());
  await settle();
  assert.deepEqual(calls[0].slice(0, 3), [7, 'yes', 3], 'the padded slots reach the call');
  assert.ok(texts().includes('Voting…'), 'the spinner starts only once the vote is committed to');
  assert.equal(face().props.disabled, true);

  settleVote(true);
  await settle();
  assert.equal(spinner(), null, 'and clears when it lands');
});

// ── The call side ─────────────────────────────────────────────────────

const APP_VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42, canAdminWrite: false } },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({ count: 0 }) },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetchCalls: 0,
    fetch: async () => {
      sandbox.fetchCalls += 1;
      return { ok: true, json: async () => ({}) };
    },
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 2 };
  AppView.refreshDevData = () => {};
  AppView.__sandbox = sandbox;
  return AppView;
}

test('castIssueVote fires onSend once its line is in hand, before its fetch starts', async () => {
  const AppView = makeAppView();
  AppView._govProposals = [{
    id: 11, kind: 'rename', status: 'open', payload: {},
    up_count: 0, down_count: 0, votes_required: 2, my_vote: null,
  }];
  const events = [];
  let settleFetch = null;
  AppView.__sandbox.fetch = () => {
    events.push('fetch');
    return new Promise((resolve) => {
      settleFetch = () => resolve({ ok: true, json: async () => ({}) });
    });
  };
  const vote = AppView.castIssueVote(11, 'up', {
    reason: 'the name should say what it grows',
    onSend: () => events.push('onSend'),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['onSend', 'fetch'], 'the line first, then the spinner, then the wire');
  settleFetch();
  assert.equal(await vote, undefined, 'the vote itself settles as it always did');
});

test('a cancelled No never reaches onSend, on either call', async (t) => {
  // The cancel lives in the prompt: with no `reason` key, `_askVoteReason`
  // asks for the line, and backing out answers false — which both calls
  // must honour before any onSend.
  const AppView = makeAppView();
  AppView.__sandbox.PlatformUI = { prompt: async () => null, toast: () => {} };
  AppView._govProposals = [{
    id: 11, kind: 'rename', status: 'open', payload: {},
    up_count: 0, down_count: 0, votes_required: 2, my_vote: null,
  }];
  let fired = false;
  const onSend = () => { fired = true; };
  await AppView.castIssueVote(11, 'down', { onSend });
  assert.equal(fired, false, 'the governance vote commits nothing');
  await AppView.castVote(7, 'no', 3, { onSend });
  assert.equal(fired, false, 'so does the PR vote');
  assert.equal(AppView.__sandbox.fetchCalls, 0, 'no wire traffic behind either');
});
