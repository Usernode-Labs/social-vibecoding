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
const { englishPlatformI18n } = require('./lib/platform-i18n');

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
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
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

function mountDialog(t, { kit = null, win = null } = {}) {
  const saved = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  // Present before the bundle evaluates: back-stack.ts creates the shell's
  // one stack at module load, and only when there is a window to hang it on.
  globalThis.window = win || {
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

// ── #3683: a close on the way somewhere ──────────────────────────────────
//
// "Open my chat with Homeroom bot" closes the create dialog and writes
// #messages/<id> in the same click. A plain close hands its back-press claim
// back by spending the record it pushed with history.back(), which a browser
// QUEUES — so the traversal landed after the new address and took the viewer
// straight back to where they were: the button did nothing. The navigating
// close spends that record a task later, and only if nothing moved.

/** A window whose address the test moves, and which logs every back(). */
function historyWindow(start) {
  const backs = [];
  const win = {
    location: { href: start },
    history: {
      state: null,
      pushState(state) { this.state = state; },
      back() { backs.push(win.location.href); },
    },
    addEventListener() {},
  };
  return { win, backs };
}

test('#3683: a plain close spends its record at once, ahead of the address the caller writes', async (t) => {
  // The bug, pinned so the reason for closeForNavigation stays visible: the
  // back() is asked for while the page is still on the old address, and the
  // browser runs it after the navigation below — undoing it.
  const { win, backs } = historyWindow('https://homeroom.test/');
  const { controller } = mountDialog(t, { win });
  controller().open();
  await settle();

  controller().close();
  assert.deepEqual(backs, ['https://homeroom.test/'], 'history.back() is already queued');
  win.location.href = 'https://homeroom.test/#messages/42';
  await settle();
});

test('#3683: closeForNavigation leaves the history alone when the caller navigates', async (t) => {
  const { win, backs } = historyWindow('https://homeroom.test/');
  const { root, lifecycle, controller, backClaims } = mountDialog(t, { win });
  controller().open();
  await settle();
  assert.equal(backClaims(), 1);

  controller().closeForNavigation();
  // openMessages(chat), in the same click: it writes the hash.
  win.location.href = 'https://homeroom.test/#messages/42';
  await settle();
  assert.deepEqual(backs, [], 'no history.back() is left to undo the navigation');
  assert.equal(backClaims(), 0, 'the claim is handed back all the same');
  assert.ok(root.classList.contains('hidden'), 'the dialog is closed');
  assert.deepEqual(lifecycle, ['onOpen', 'onClose'], 'with its ordinary teardown');
});

test('#3683: closeForNavigation still spends the record when nothing moved', async (t) => {
  // A destination that did not navigate after all (the side panel took the
  // conversation, or a guarded global was missing): the record must not
  // linger, or the next back press does nothing.
  const { win, backs } = historyWindow('https://homeroom.test/');
  const { controller, backClaims } = mountDialog(t, { win });
  controller().open();
  await settle();

  controller().closeForNavigation();
  assert.deepEqual(backs, [], 'not spent in the same task');
  await settle();
  assert.deepEqual(backs, ['https://homeroom.test/'], 'spent a task later, from on top of it');
  assert.equal(backClaims(), 0);
});

test('#3683: closeForNavigation is published with the controller', async (t) => {
  const { controller } = mountDialog(t);
  assert.equal(typeof controller().closeForNavigation, 'function');
});

// ── #3683, the fork dialog: the same race behind its own buttons ──────────
//
// The fork dialog ends on the progress card the create dialog uses, and each
// way out of it closed with a plain close and then wrote history in the same
// task: "Open app" the fork's address, "Set secrets" the record the secrets
// dialog pushes as it opens, and a reply with no slug the Home address. Each
// close queued a history.back() ahead of that write. These run the dialog
// itself, with its useDialog and the back stack as they ship, through a JSX
// runtime that hands back plain objects so a test can press its buttons.

const jsxRuntime = {
  Fragment: 'Fragment',
  jsx: (type, props, key) => ({ type, props, key }),
  jsxs: (type, props, key) => ({ type, props, key }),
};

/** Every element in a tree of those objects, depth first. */
function* elementsOf(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* elementsOf(child);
    return;
  }
  yield node;
  yield* elementsOf(node.props?.children);
}

/** Set a global for one test, and put back whatever was there. */
function stubGlobal(t, name, value) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, name, saved);
    else delete globalThis[name];
  });
  globalThis[name] = value;
}

function mountForkDialog(t, { reply }) {
  const { win, backs } = historyWindow('https://homeroom.test/app/source-app/dev');
  const went = [];
  win.App = {
    openAppTab(slug, tab) {
      went.push(['openAppTab', slug, tab]);
      win.location.href = `https://homeroom.test/app/${slug}`;
    },
    navigateHome() {
      went.push(['navigateHome']);
      win.location.href = 'https://homeroom.test/';
    },
  };
  // mountDialog for the globals and their restore; its probe dialog is
  // separate from the fork dialog mounted below, and stays closed.
  mountDialog(t, { win });
  stubGlobal(t, 'fetch', async () => ({ ok: true, json: async () => reply }));

  function CreateProgress() {}
  const fake = createFakeReact();
  const { ForkAppDialog } = loadTsx('frontend/src/features/dialogs/fork-app.tsx', {
    stubs: {
      // The shell primitives call forwardRef at module load; nothing renders
      // them here, so the render function itself stands in.
      react: { ...fake.React, forwardRef: (render) => render },
      'react/jsx-runtime': jsxRuntime,
      './create-progress': { CreateProgress },
      // The dialog's text, in English, without react-i18next: the fake React
      // has no context for it.
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t, RichMessage() { return null; } },
      './app-allowance': { AppAllowance() {}, useAppAllowance: () => ({ blocked: false }) },
      './app-allowance-store.js': { invalidateAppAllowance: async () => {} },
      '../../lib/use-store-state': { useStoreState: (store) => store.get() },
      './creation-progress-store.js': {
        creationProgressStore: { get: () => ({ status: 'creating' }), subscribe: () => () => {} },
        outcomeOf: () => 'ready',
        fetchCreationProgress() {},
        publishAppStatus() {},
        stopWatchingCreation() {},
        watchCreation() {},
      },
    },
  });

  const root = fakeNode('root');
  root.appendChild(fakeNode('backdrop', { isBackdrop: true })).appendChild(fakeNode('card'));
  root.classList.add('hidden');
  let tree = null;
  fake.mount(() => {
    tree = ForkAppDialog();
    for (const el of elementsOf(tree)) {
      const ref = el.props?.ref;
      if (!ref || typeof ref !== 'object' || ref.current) continue;
      if (el.props.id === 'fork-modal') ref.current = root;
      else if (el.props.id === 'fork-input') ref.current = { value: 'My fork', focus() {}, select() {} };
      else ref.current = fakeNode(el.props.id || 'node');
    }
  });
  t.after(() => fake.unmount());

  const find = (match) => {
    for (const el of elementsOf(tree)) if (match(el)) return el;
    return null;
  };
  return {
    win,
    backs,
    went,
    root,
    open: () => win.UsernodeReact.dialogs.fork.open({ slug: 'source-app', name: 'Source app' }),
    backClaims: () => win.UsernodeBackStack.size,
    async submit() {
      await find((el) => el.props?.id === 'fork-form').props.onSubmit({ preventDefault() {} });
      await settle();
    },
    progressCard: () => find((el) => el.type === CreateProgress),
  };
}

test('#3683: the fork dialog’s Open app is not undone by its own close', async (t) => {
  const h = mountForkDialog(t, { reply: { app: { slug: 'my-fork', name: 'My fork' } } });
  h.open();
  await settle();
  assert.equal(h.backClaims(), 1, 'the open fork dialog claims the back button');
  await h.submit();
  const card = h.progressCard();
  assert.ok(card, 'the fork in flight is reported on the progress card');

  card.props.onOpenApp();
  assert.deepEqual(h.went, [['openAppTab', 'my-fork', 'app']]);
  await settle();
  assert.deepEqual(h.backs, [], 'no history.back() is left to undo the fork’s address');
  assert.equal(h.backClaims(), 0, 'the claim is handed back all the same');
  assert.ok(h.root.classList.contains('hidden'), 'the dialog is closed');
});

test('#3683: the fork dialog’s Set secrets does not close the secrets dialog it opens', async (t) => {
  const h = mountForkDialog(t, { reply: { app: { slug: 'my-fork', name: 'My fork' } } });
  let secrets = null;
  // The secrets island's open, as far as history goes: it claims the back
  // button, which pushes a record of its own on top of the fork dialog's.
  h.win.Secrets = {
    open(slug) {
      secrets = slug;
      h.win.UsernodeBackStack.push(() => { secrets = null; });
    },
  };
  h.open();
  await settle();
  await h.submit();

  h.progressCard().props.onSetSecrets();
  // Whatever back() the close queued, the browser runs once the secrets
  // dialog's record is on: one traversal each, read by the shell's listener.
  for (let queued = h.backs.length; queued > 0; queued -= 1) h.win.UsernodeBackStack.handlePopstate();
  await settle();
  assert.equal(secrets, 'my-fork', 'the secrets dialog is still open');
  assert.deepEqual(h.backs, [], 'nothing was spent from under it');
  assert.equal(h.backClaims(), 1, 'and its claim on the back button is the only one');
});

test('#3683: a fork reply with no slug goes Home without undoing it', async (t) => {
  const h = mountForkDialog(t, { reply: { app: {} } });
  h.open();
  await settle();
  await h.submit();
  assert.deepEqual(h.went, [['navigateHome']]);
  assert.equal(h.progressCard(), null, 'nothing to follow, so no progress card');
  await settle();
  assert.deepEqual(h.backs, [], 'no history.back() is left to undo Home');
  assert.equal(h.backClaims(), 0);
  assert.ok(h.root.classList.contains('hidden'));
});

// ── #3683, the legacy controllers: members and app secrets ─────────────────
//
// Two more dialogs are driven from `public/js`-era controllers, and each had
// a way out that closed and then moved the address in the same task: leaving
// an app from the members dialog (Home), and the secrets dialog's "View
// proposal" link (its href). These run each controller as it ships against
// the real hook, with the probe dialog standing in for the island under the
// name the controller looks up.

/** A button or link whose listeners the test can fire, and wait on. */
function clickable(dataset = {}) {
  const listeners = [];
  return {
    dataset,
    disabled: false,
    addEventListener: (type, fn) => listeners.push(fn),
    click: () => Promise.all(listeners.map((fn) => fn({}))),
  };
}

/** `document.getElementById` answering for one list, whose query is fixed. */
function listHost(id, selector, items) {
  const list = { innerHTML: '', querySelectorAll: (sel) => (sel === selector ? items : []) };
  globalThis.document.getElementById = (asked) => (asked === id ? list : null);
}

test('#3683: leaving an app from the members dialog is not undone by its close', async (t) => {
  const { win, backs } = historyWindow('https://homeroom.test/app/team-app/dev');
  const { root, controller, backClaims } = mountDialog(t, { win });
  stubGlobal(t, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  const went = [];
  win.App = {
    user: { id: 7 },
    navigateHome() {
      went.push('navigateHome');
      win.location.href = 'https://homeroom.test/';
    },
  };
  win.AppView = { appData: { slug: 'team-app', can_manage: false } };
  const leave = clickable({ removeUser: '7' });
  listHost('members-list', '[data-remove-user]', [leave]);
  // The controller is a classic script: it reads its text through the global.
  stubGlobal(t, 'PlatformI18n', englishPlatformI18n());
  loadTsx('frontend/src/features/dialogs/members-controller.js').init();
  win.UsernodeReact.dialogs.members = controller();
  controller().open();
  await settle();

  win.AppView._renderCollaborators([{ userId: 7, username: 'me', status: 'active' }]);
  await leave.click();
  assert.deepEqual(went, ['navigateHome'], 'leaving goes Home');
  await settle();
  assert.deepEqual(backs, [], 'no history.back() is left to put the viewer back on the app');
  assert.equal(backClaims(), 0, 'the claim is handed back all the same');
  assert.ok(root.classList.contains('hidden'), 'the dialog is closed');
});

test('#3683: the secrets dialog’s View proposal link is not undone by its close', async (t) => {
  const { win, backs } = historyWindow('https://homeroom.test/app/my-app/dev');
  const { root, controller, backClaims } = mountDialog(t, { win });
  stubGlobal(t, 'App', { user: {} });
  const link = clickable();
  listHost('app-secrets-list', '[data-action="view-proposal"]', [link]);
  const { Secrets } = loadTsx('frontend/src/features/dialogs/app-secrets-controller.js');
  // Only the wiring is under test, not the rows' or the form's markup.
  Secrets.renderRow = () => '';
  Secrets.renderDeclareSection = () => {};
  win.UsernodeReact.dialogs.appSecrets = controller();
  controller().open();
  await settle();

  Secrets.render({ scope: 'app', manifestKnown: true, secrets: [{ key: 'API_KEY' }] });
  await link.click();
  // …and then the link's default action, after its listeners: the href.
  win.location.href = 'https://homeroom.test/app/my-app/dev#/app/my-app';
  await settle();
  assert.deepEqual(backs, [], 'no history.back() is left to undo the link');
  assert.equal(backClaims(), 0, 'the claim is handed back all the same');
  assert.ok(root.classList.contains('hidden'), 'the dialog is closed');
});
