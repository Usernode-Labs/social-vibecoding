'use strict';

// #2346: `suspend()` resolves when the dialog has actually left the screen.
//
// The feedback dialog's native screenshot suspends the dialog and then asks
// the phone to photograph the page. Since #1474 the card rides the kit's exit
// animation instead of vanishing on the close tick, so "suspended" and "off
// screen" are ~180–300ms apart — and a capture taken in between is a picture
// of the dialog. The hook's promise is what lets the capture wait for the
// second of those.
//
// tests/dialog-behaviour.test.js pins this hook's source. This file RUNS it:
// use-dialog.ts, static-modal.ts, kit-surface.ts and back-stack.ts bundled as
// they ship, against a hand-stepped React (effects included, which
// renderToStaticMarkup never runs), a fake kit whose exit the test ends when
// it chooses, and just enough DOM for the card lift.
//
// Run with: node --test tests/dialog-suspend-exit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

// ── A React small enough to step through ─────────────────────────────────

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
    useLayoutEffect: effectHook(() => layout),
    useEffect: effectHook(() => passive),
  };

  function render() {
    cursor = 0;
    layout = [];
    passive = [];
    renderFn();
    // Layout effects before passive ones, as React commits them.
    for (const run of layout) run();
    for (const run of passive) run();
  }
  // Updates from outside a React event are batched into a later task, which
  // is the part of React's timing the exit bookkeeping actually depends on.
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

// ── Just enough DOM for the card lift ────────────────────────────────────

function fakeNode(label, extra = {}) {
  const classes = new Set();
  const node = {
    label,
    parentNode: null,
    childNodes: [],
    dataset: {},
    style: {},
    ...extra,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
    },
    get firstElementChild() {
      return node.childNodes.find((child) => !child.isComment) || null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const at = node.childNodes.indexOf(child);
      if (at >= 0) node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    replaceChild(next, old) {
      if (next.parentNode) next.parentNode.removeChild(next);
      const at = node.childNodes.indexOf(old);
      node.childNodes[at] = next;
      next.parentNode = node;
      old.parentNode = null;
      return old;
    },
    querySelector(selector) {
      assert.equal(selector, '[data-modal-backdrop]', 'the only query the lift makes');
      return node.childNodes.find((child) => child.isBackdrop) || null;
    },
    contains: () => false,
  };
  return node;
}

/** A kit whose exit animation ends only when the test says so. */
function fakeKit() {
  const presentations = [];
  return {
    presentations,
    hasKit: () => true,
    isTouch: () => true,
    modal({ contentEl, onDismiss }) {
      const shell = fakeNode('kit-shell');
      shell.appendChild(contentEl);
      const presentation = { shell, dismissed: false, finishExit: () => onDismiss() };
      presentations.push(presentation);
      return { el: shell, dismiss: () => { presentation.dismissed = true; } };
    },
  };
}

const GLOBALS = ['window', 'document', 'MutationObserver', 'PlatformUI'];

function mountDialog(t, { kit = null } = {}) {
  const saved = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  // Present before the bundle evaluates: back-stack.ts creates the shell's
  // one stack at module load, and only when there is a window to hang it on.
  globalThis.window = {
    history: { state: null, pushState(state) { this.state = state; }, back() {} },
    addEventListener() {},
  };
  globalThis.document = { createComment: (text) => fakeNode(text, { isComment: true }), activeElement: null };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  if (kit) globalThis.PlatformUI = kit;
  else delete globalThis.PlatformUI;

  const fake = createFakeReact();
  const { useDialog } = loadTsx('frontend/src/features/dialogs/use-dialog.ts', {
    stubs: { react: fake.React },
  });

  const root = fakeNode('root');
  const backdrop = root.appendChild(fakeNode('backdrop', { isBackdrop: true }));
  const card = backdrop.appendChild(fakeNode('card'));
  root.classList.add('hidden');

  const lifecycle = [];
  fake.mount(() => {
    const dialog = useDialog('probe', {
      onOpen: () => lifecycle.push('onOpen'),
      onClose: () => lifecycle.push('onClose'),
    });
    dialog.rootRef.current = root;
  });
  const controller = () => globalThis.window.UsernodeReact.dialogs.probe;
  const backClaims = () => globalThis.window.UsernodeBackStack.size;
  return { fake, root, backdrop, card, lifecycle, controller, backClaims };
}

// Every microtask render cascade has run by the next task.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const stateOf = (promise) =>
  Promise.race([promise.then(() => 'resolved'), settle().then(() => 'pending')]);

// ── The contract ─────────────────────────────────────────────────────────

test('with the kit, suspend() resolves only once the exit animation has finished', async (t) => {
  const kit = fakeKit();
  const { root, backdrop, card, lifecycle, controller, backClaims } = mountDialog(t, { kit });

  controller().open();
  await settle();
  assert.equal(kit.presentations.length, 1, 'the card is presented in the kit shell');
  assert.equal(backClaims(), 1, 'the open dialog claims the back button');

  const exited = controller().suspend();
  await settle();
  const [first] = kit.presentations;
  assert.ok(first.dismissed, 'the suspension asked the kit to dismiss');
  assert.ok(root.classList.contains('hidden'));
  // The bug in one assertion: the root is hidden, but the card is still in
  // the kit's shell, on screen, fading out. A photo taken now shows it.
  assert.equal(card.parentNode, first.shell, 'the card is still on screen mid-exit');
  assert.equal(await stateOf(exited), 'pending', 'so suspend() has not resolved yet');

  first.finishExit();
  assert.equal(await stateOf(exited), 'resolved', 'the exit landing resolves it');
  assert.equal(card.parentNode, backdrop, 'with the card home, out of the kit shell');
  assert.deepEqual(lifecycle, ['onOpen'], 'and no teardown ran — the draft is coming back');
  assert.equal(backClaims(), 1, 'nor was the back-press claim spent on a suspension');

  controller().resume();
  await settle();
  assert.equal(kit.presentations.length, 2, 'resume presents the card again');
  assert.equal(card.parentNode, kit.presentations[1].shell);
  assert.deepEqual(lifecycle, ['onOpen'], 'without re-running onOpen');
  assert.equal(backClaims(), 1, 'and the restored dialog still answers back');
});

test('without the kit, suspend() resolves as soon as the dialog is hidden', async (t) => {
  const { root, lifecycle, controller } = mountDialog(t);

  controller().open();
  await settle();
  assert.ok(!root.classList.contains('hidden'));

  const exited = controller().suspend();
  assert.equal(await stateOf(exited), 'resolved', 'nothing animates, so nothing to wait for');
  assert.ok(root.classList.contains('hidden'));
  assert.deepEqual(lifecycle, ['onOpen']);
});

test('suspend() on a dialog that is not open resolves at once', async (t) => {
  const kit = fakeKit();
  const { controller } = mountDialog(t, { kit });
  assert.equal(await stateOf(controller().suspend()), 'resolved');
  assert.equal(kit.presentations.length, 0);
});

test('a resume before the exit lands settles the wait rather than stranding it', async (t) => {
  const kit = fakeKit();
  const { lifecycle, controller } = mountDialog(t, { kit });

  controller().open();
  await settle();
  const exited = controller().suspend();
  await settle();
  assert.equal(await stateOf(exited), 'pending');

  // A capture that failed fast: back before the kit finished the exit, whose
  // callback the generation guard will now drop — so it can never resolve this.
  controller().resume();
  assert.equal(await stateOf(exited), 'resolved');

  kit.presentations[0].finishExit();
  await settle();
  assert.deepEqual(lifecycle, ['onOpen'], 'the stale exit tears nothing down');
});

test('unmounting mid-suspension settles the wait', async (t) => {
  const kit = fakeKit();
  const { fake, controller } = mountDialog(t, { kit });

  controller().open();
  await settle();
  const exited = controller().suspend();
  await settle();
  assert.equal(await stateOf(exited), 'pending');

  fake.unmount();
  assert.equal(await stateOf(exited), 'resolved');
});

test('an ordinary kit dismissal still closes the dialog and runs its teardown', async (t) => {
  // The suspension guard on onKitDismiss must not swallow a real dismissal.
  const kit = fakeKit();
  const { root, lifecycle, controller, backClaims } = mountDialog(t, { kit });

  controller().open();
  await settle();
  assert.equal(backClaims(), 1);

  // A backdrop tap: the kit dismisses and exits on its own, React not asked.
  kit.presentations[0].finishExit();
  await settle();
  assert.ok(root.classList.contains('hidden'));
  assert.deepEqual(lifecycle, ['onOpen', 'onClose']);
  assert.equal(backClaims(), 0, 'the claim is handed back');
});
