// UI contract for the grouped model/key selector in the dev-chat composer.
//
// Same approach as openSession-streaming-reset.test.js: dev-chat.js is a
// plain browser script (`const DevChat = {…}`), so we load its source
// into a vm context, expose DevChat, and drive the REAL renderChatView
// against a minimal fake DOM — asserting on the markup a user would see
// rather than on tokens in the source.
//
// What must hold:
//   1. OpenRouter is the first native optgroup, Anthropic is the second, and
//      every option repeats its key source in the closed control.
//   2. The OpenRouter shortlist prefers the saved model, otherwise the
//      server-recommended GLM, while preserving the current session model.
//   3. "Add more OpenRouter models…" opens the existing catalog dialog.
//   4. Provider changes route through reset-agent-context; direct Anthropic
//      model changes remain a lightweight local preference.
//   5. The existing no-price/no-caption and allowlist drift contracts hold.
//
// Run with: node --test tests/model-selector-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeComposerBridge } = require('./lib/dev-composer-html');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { SW_VERSION } = require('../public/sw.js');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

// ── Minimal fake DOM ────────────────────────────────────────────────
// Registry-backed like the streaming-reset harness (getElementById keeps
// returning the same handle across innerHTML rewrites), plus real
// listener capture and a real classList.toggle, so a class the composer
// toggles at runtime can be asserted.
function makeElement(id) {
  const classes = new Set();
  const listeners = new Map();
  return {
    id,
    style: {},
    dataset: {},
    _attrs: {},
    _children: [],
    _listeners: listeners,
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    scrollTop: 0,
    className: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: (x, force) => {
        const on = force === undefined ? !classes.has(x) : !!force;
        if (on) classes.add(x); else classes.delete(x);
        return on;
      },
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    // Test seam: dispatch a captured listener.
    _fire(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    appendChild(c) { this._children.push(c); return c; },
    removeChild() {},
    insertBefore(c) { this._children.push(c); return c; },
    replaceChildren() { this._children = []; },
    append() {}, prepend() {}, remove() {},
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, setSelectionRange() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
    },
  };
}

function makeHarness() {
  // #1078: the whole composer is features/dev-chat/composer.tsx's, so
  // `renderChatView` writes an empty `#dc-composer-bar` and publishes a view
  // model into it. `html` below is the template's markup PLUS the rendered
  // composer, which is what a reader actually sees.
  const composer = makeComposerBridge();
  const registry = new Map();
  // #1191: the runner strip's markup is
  // features/dev-chat/composer-chrome.tsx's, so `_renderRunnerControls()`
  // publishes a { kind, label } view. `runnerHtml()` below renders the
  // component from it, so the assertions still read the strip as a reader
  // sees it — and the select's change handler is a prop, invoked directly.
  let runnerView = { kind: 'none', label: '' };
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };

  const document = {
    _title: 'MyApp',
    get title() { return this._title; },
    set title(v) { this._title = v; },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__created_${tag}`),
    addEventListener() {}, removeEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    hidden: false,
    visibilityState: 'visible',
  };

  const storage = new Map();
  const sandbox = {
    console,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: { sendBeacon: () => true },
    EventSource: class { constructor() { this.readyState = 1; } close() {} },
    URL,
    Blob: class { constructor() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    // Real-ish escaping so an assertion on "—" / "·" isn't defeated by a
    // pass-through stub, while still keeping the markup readable.
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    UsernodeReact: {
      devChat: {
        mountRunnerControls: () => {},
        publishRunner: (v) => { runnerView = v; },
        mountQuickReplies: () => {},
        publishQuickReplies: () => {},
        mountBudgetPill: () => {},
        publishBudgetPill: () => {},
        mountAttachStrip: () => {},
        publishAttachStrip: () => {},
      },
    },
    PlatformUI: {
      isTouch: () => false, hasKit: () => false, toast: () => {},
      alert: async () => ({}), confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {}, detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The runner strip publishes through the composer bridge too, so its own
  // capture below rides on the same object.
  sandbox.UsernodeReact = Object.assign({}, sandbox.UsernodeReact, {
    devChat: Object.assign({}, composer.bridge, {
      publishRunner: (v) => { runnerView = v; composer.bridge.publishRunner(v); },
    }),
  });

  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize the heavy DOM plumbing renderChatView calls — none of it
  // touches the model row, and all of it wants a real document.
  for (const fn of [
    'renderMessages', 'refreshBudget', 'initScrollTracking', 'restoreSessionScroll',
    '_setupTextareaResize', '_setupKeyboardShortcuts', '_restoreDraft',
    'renderSessionList', '_loadSpecViewer', '_startHeartbeat', '_setNotifyOnDone',
    '_renderQuickReplies', '_wireQuickReplies',
    '_renderBanners', '_renderSessionHeader',
    '_setupAttachments', '_renderSavedDrafts', '_wireSavedDrafts', '_syncSaveDraftBtn',
  ]) DevChat[fn] = () => {};
  DevChat.currentSession = { id: 7, branch_name: 'dev/x', session_title: 'A change' };
  DevChat.messages = [];

  return {
    DevChat,
    getEl,
    composer,
    // The kit stub the module reads as `window.PlatformUI`. Exposed so a
    // test can swap in a menu recorder — dev-chat.js resolves it at call
    // time, and inside the vm context `window` IS this sandbox.
    kit: sandbox.PlatformUI,
    sandbox,
    runnerView: () => JSON.parse(JSON.stringify(runnerView)),
    runnerHtml: () => renderComponent(
      'frontend/src/features/dev-chat/composer-chrome.tsx', 'RunnerControlsView',
      JSON.parse(JSON.stringify(runnerView)),
    ),
  };
}

// The three-model map GET /api/models sends: label + guidance copy, and
// nothing measured. Mirrors src/services/models.js — the copy-drift guard
// at the bottom of this file is what keeps that true.
function guidanceMap() {
  return {
    'claude-sonnet-5': {
      label: 'Sonnet 5',
      changeSize: {
        short: 'simple, small changes',
        long: 'One small thing at a time: a text tweak, a colour, a single file.',
      },
    },
    'claude-opus-5': {
      label: 'Opus 5',
      changeSize: {
        short: 'general coding work',
        long: 'Anything from a quick fix to a multi-file feature, a refactor, or debugging that needs real digging.',
      },
    },
    'claude-fable-5-1': {
      label: 'Fable 5.1',
      changeSize: {
        short: 'design, taste, and difficult coding',
        long: 'Design and taste (how a screen looks, reads, and feels) plus the most difficult coding work.',
      },
    },
  };
}

function pickerData(overrides = {}) {
  return {
    defaultBackend: 'codex_openrouter',
    backends: { codex_openrouter: { model: null, reasoningEffort: 'high' } },
    codexAvailable: true,
    credentialConfigured: true,
    recommendedModelId: 'z-ai/glm-5.3-flash',
    models: [
      {
        id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash',
        isFavorite: true, isRecommended: true, compatibility: 'verified',
        supportsReasoning: true,
      },
      {
        id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5',
        isFavorite: true, compatibility: 'verified', supportsReasoning: true,
      },
      {
        id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash',
        isFavorite: false, compatibility: 'verified', supportsReasoning: false,
      },
    ],
    ...overrides,
  };
}

function render(overrides) {
  const h = makeHarness();
  h.DevChat.MODELS = (overrides && overrides.models) || guidanceMap();
  h.DevChat.selectedModel = (overrides && overrides.selected) || 'claude-opus-5';
  if (overrides && overrides.session) h.DevChat.currentSession = overrides.session;
  h.DevChat._modelPickerData = overrides && 'pickerData' in overrides
    ? overrides.pickerData
    : pickerData();
  // build-venues.js is outside this focused harness. Mirror its ordinary
  // in-chat result so provider-specific composer controls are exercised.
  h.DevChat._currentVenueId = () => h.DevChat._isOpenRouterSession()
    ? 'usernode-openrouter'
    : 'usernode-claude';
  h.DevChat.renderChatView();
  return {
    ...h,
    html: h.getEl('dc-view').innerHTML + h.composer.html(),
    view: () => h.composer.state(),
  };
}

// ── 1. no price text anywhere ───────────────────────────────────────

test('the composer renders no price text at all (#800)', () => {
  const { html } = render();
  assert.ok(!html.includes('MTok'), 'found "MTok" in the composer markup');
  // Valid again now that the picker shows no measured cost figure either.
  assert.ok(!html.includes('$'), 'found a "$" in the composer markup');
});

test('the seed MODELS map carries no price and no measured figures', () => {
  const { DevChat } = makeHarness();
  for (const [id, meta] of Object.entries(DevChat.MODELS)) {
    assert.equal(meta.outputCostPerMTok, undefined, `${id} still seeds a price`);
    assert.equal(meta.stats, undefined, `${id} still seeds a stats block`);
  }
  // And Haiku is gone from the seed set too, so the dropdown never offers
  // it even before /api/models resolves.
  assert.ok(!('claude-haiku-4-5' in DevChat.MODELS));
});

// ── 2. ONE FLAT LIST (#2569) ────────────────────────────────────────
//
// The picker used to be two optgroups, "OpenRouter key" and "Anthropic
// key", with every label repeating its key source — so the first question
// it asked was whose key pays, rather than which model. It is one list
// now, and the key survives as a `title` on each option.

test('the composer renders one flat list with no provider headings', () => {
  const { html, view } = render();
  assert.match(html, /<select[^>]*id="dc-model-select"[^>]*aria-label="Chat model and API key"/);
  assert.ok(!html.includes('<optgroup'), 'no headings at all');
  assert.equal(view().models.groups, undefined, 'the grouped shape is gone');
  assert.ok(Array.isArray(view().models.options));
});

test('no label names a provider; the key is a title instead', () => {
  const { html, view } = render();
  for (const option of view().models.options) {
    assert.ok(!/^OpenRouter key ·|^Anthropic key ·/.test(option.label),
      `"${option.label}" still carries a key prefix`);
  }
  // An Anthropic-authored model reached through OpenRouter reads as its own
  // name, and its title is what says which key pays.
  const sonnet = view().models.options.find(
    (o) => o.value === 'openrouter:anthropic/claude-sonnet-4.5');
  assert.equal(sonnet.label, 'Claude Sonnet 4.5');
  assert.equal(sonnet.title, 'Runs on your OpenRouter key');
  const opus = view().models.options.find((o) => o.value === 'anthropic:claude-opus-5');
  assert.equal(opus.label, 'Opus 5');
  assert.match(opus.title, /platform Claude allowance/);
  assert.match(html, /title="Runs on your OpenRouter key"/);
  assert.ok(!html.includes('general coding work'),
    '#1589: verbose guidance must not widen the closed native control');
});

test('the five starting models come first, in the documented order', () => {
  const { view } = render();
  // The curated OpenRouter pair (the server's recommendation first), then
  // the three Anthropic models. Whatever else the account uses follows.
  assert.deepEqual(view().models.options.slice(0, 5).map((o) => o.value), [
    'openrouter:z-ai/glm-5.3-flash',
    'anthropic:claude-sonnet-5',
    'anthropic:claude-opus-5',
    'anthropic:claude-fable-5-1',
    'openrouter:anthropic/claude-sonnet-4.5',
  ].slice(0, 5));
  assert.equal(view().models.options[0].value, 'openrouter:z-ai/glm-5.3-flash',
    'the server-recommended GLM leads');
  // The catalog door is last, always.
  const last = view().models.options[view().models.options.length - 1];
  assert.equal(last.value, 'openrouter:__add_more__');
});

test('a saved OpenRouter model is offered even when it is not a starter', () => {
  const saved = render({
    pickerData: pickerData({
      backends: {
        codex_openrouter: {
          model: 'anthropic/claude-sonnet-4.5', reasoningEffort: 'medium',
        },
      },
    }),
  });
  const values = saved.view().models.options.map((o) => o.value);
  assert.ok(values.includes('openrouter:anthropic/claude-sonnet-4.5'),
    'a saved model the picker would otherwise not list is still selectable');
  assert.equal(values[0], 'openrouter:z-ai/glm-5.3-flash',
    'the starting pair still leads — a saved choice does not reorder the list');
});

test('an unsent change displays the saved OpenRouter default before creation', () => {
  const pending = {
    pending: true,
    id: null,
    app_slug: 'demo',
    pending_agent_choice: null,
  };
  const saved = render({
    session: pending,
    pickerData: pickerData({
      backends: {
        codex_openrouter: {
          model: 'anthropic/claude-sonnet-4.5', reasoningEffort: 'medium',
        },
      },
    }),
  });

  assert.equal(
    saved.view().models.selected,
    'openrouter:anthropic/claude-sonnet-4.5',
    'the client-only placeholder must reflect the provider the server will resolve on first send',
  );
  assert.equal(saved.DevChat.currentSession.pending_agent_choice, null,
    'displaying the saved default must not turn it into an explicit per-session override');
});

test('an explicit pending Anthropic pick overrides a saved OpenRouter default', () => {
  const pending = {
    pending: true,
    id: null,
    app_slug: 'demo',
    pending_agent_choice: {
      backend: 'claude_code', model: null, reasoningEffort: null,
    },
    agent_backend: 'claude_code',
  };
  const selected = render({ session: pending });

  assert.equal(selected.view().models.selected, 'anthropic:claude-opus-5');
});

test('the saved OpenRouter default ships through a fresh shell cache', () => {
  const version = Number(String(SW_VERSION).replace(/^v/, ''));
  assert.ok(version >= 29,
    `expected the OpenRouter-default shell cache, got ${SW_VERSION}`);
});

test('the declared checks follow the flat native selector', () => {
  const dapp = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const picker = dapp.tests.filter(
    (t) => (t.expectSelector || '').includes('dc-model-select'));
  assert.equal(picker.length, 3, 'direct selection, catalog door, and OpenRouter selection are guarded');
  // #2569: no check may depend on an optgroup, and one of them asserts
  // there is none.
  for (const t of picker) {
    assert.ok(!/optgroup\[label=/.test(t.expectSelector),
      `${t.name} still selects inside a provider heading`);
    assert.ok(!/(?:OpenRouter|Anthropic) key ·/.test(t.expectText || ''),
      `${t.name} still expects a key prefix in an option label`);
  }
  assert.ok(picker.some((t) => /:not\(:has\(optgroup\)\)/.test(t.expectSelector)
    && /Opus 5/.test(t.expectText || '')), 'the flat shape and a direct model are guarded');
  assert.ok(picker.some((t) => /__add_more__/.test(t.expectSelector)
    && /Add more OpenRouter/.test(t.expectText || '')), 'the catalog action is guarded');
  assert.ok(picker.some((t) => /openai\/gpt-5\.3-codex/.test(t.expectSelector)
    && /Runs on your OpenRouter key/.test(t.expectSelector)), 'the key hint is guarded');
});

test('the guidance copy survives on the helper and proposal summaries stay concise', () => {
  // The positioning encoded by `changeSize.short` remains the same:
  // Sonnet = simple/small, Opus = general coding, Fable = design/taste plus
  // the most difficult coding. Generate proposal now renders the short value
  // as a separate summary instead of concatenating it into an option label.
  const { DevChat } = makeHarness();
  const text = (id) => DevChat.modelOptionText(DevChat.MODELS[id]);
  assert.equal(text('claude-sonnet-5'), 'Sonnet 5: simple, small changes');
  assert.equal(text('claude-opus-5'), 'Opus 5: general coding work');
  assert.equal(text('claude-fable-5-1'), 'Fable 5.1: design, taste, and difficult coding');
  const APP_VIEW = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
  );
  assert.match(APP_VIEW, /m\.changeSize && m\.changeSize\.short/,
    'the proposal summary reads the same authoritative short guidance');
  assert.doesNotMatch(APP_VIEW, /DevChat\.modelOptionText\(m\)/,
    'the dialog no longer builds a verbose select label');
});

test('OpenRouter sessions select their pinned model in the same flat control', () => {
  const { html, view } = render({
    session: {
      id: 7,
      branch_name: 'dev/openrouter',
      session_title: 'OpenRouter change',
      agent_backend: 'codex_openrouter',
      agent_model: 'anthropic/claude-sonnet-4.5',
    },
  });

  assert.match(html, /id="dc-model-select"/);
  assert.match(html, />Claude Sonnet 4\.5</);
  assert.equal(view().models.selected, 'openrouter:anthropic/claude-sonnet-4.5');
  assert.ok(!html.includes('<optgroup'));
  assert.doesNotMatch(html, /id="dc-openrouter-model"/,
    'the separate row above the composer is retired');
  assert.doesNotMatch(html, /id="dc-openrouter-model-change"/);
  assert.doesNotMatch(html, /Sonnet 5: simple, small changes/);
  assert.doesNotMatch(html, /Opus 5: general coding work/);
  assert.doesNotMatch(html, /Fable 5.1: design, taste, and difficult coding/);
});

test('the Add more option opens the provider-locked catalog', async () => {
  const h = makeHarness();
  h.DevChat.currentSession = {
    id: 7,
    branch_name: 'dev/openrouter',
    agent_backend: 'codex_openrouter',
    agent_model: 'deepseek/deepseek-v4-flash',
  };
  h.DevChat._currentVenueId = () => 'usernode-openrouter';
  h.DevChat._modelPickerData = pickerData();
  let calledWith = null;
  h.DevChat._switchCurrentCodingAgent = async (...args) => { calledWith = args; };
  h.DevChat._ensureModelPickerData = async () => h.DevChat._modelPickerData;

  h.DevChat.renderChatView();
  assert.match(h.composer.html(), /value="openrouter:__add_more__"/,
    'the action renders as the final OpenRouter option');
  await h.DevChat._onModelPicked('openrouter:__add_more__');

  assert.ok(calledWith, 'the catalog option was not wired');
  assert.equal(calledWith[0], null);
  assert.equal(calledWith[1].fixedBackend, 'codex_openrouter');
});

test('an OpenRouter session without a pinned model falls back to saved choice, then GLM', () => {
  const session = { id: 7, agent_backend: 'codex_openrouter', agent_model: null };
  const glm = render({ session });
  assert.equal(glm.view().models.selected, 'openrouter:z-ai/glm-5.3-flash');

  const saved = render({
    session,
    pickerData: pickerData({
      backends: { codex_openrouter: { model: 'anthropic/claude-sonnet-4.5' } },
    }),
  });
  assert.equal(saved.view().models.selected, 'openrouter:anthropic/claude-sonnet-4.5');
});

test('provider picks reset context with the matching backend and saved effort', async () => {
  const h = makeHarness();
  h.DevChat.MODELS = guidanceMap();
  h.DevChat._modelPickerData = pickerData();
  h.DevChat._currentVenueId = () => h.DevChat._isOpenRouterSession()
    ? 'usernode-openrouter'
    : 'usernode-claude';
  const calls = [];
  h.DevChat._switchCurrentCodingAgent = async (choice) => { calls.push(choice); };

  await h.DevChat._onModelPicked('openrouter:z-ai/glm-5.3-flash');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pop())), {
    backend: 'codex_openrouter',
    model: 'z-ai/glm-5.3-flash',
    reasoningEffort: 'high',
  });

  h.DevChat.currentSession.agent_backend = 'codex_openrouter';
  h.DevChat.currentSession.agent_model = 'z-ai/glm-5.3-flash';
  await h.DevChat._onModelPicked('anthropic:claude-fable-5-1');
  assert.equal(h.DevChat.selectedModel, 'claude-fable-5-1');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pop())), {
    backend: 'claude_code', model: null, reasoningEffort: null,
  });
});

test('a provider switch disables the selector and collapses rapid duplicate picks', async () => {
  const h = render();
  let release;
  let calls = 0;
  h.DevChat._switchCurrentCodingAgent = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
  };

  const first = h.DevChat._onModelPicked('openrouter:z-ai/glm-5.3-flash');
  await Promise.resolve();
  assert.equal(h.view().models.changeDisabled, true);
  await h.DevChat._onModelPicked('openrouter:anthropic/claude-sonnet-4.5');
  assert.equal(calls, 1, 'the second pick must not race the first reset');
  release();
  await first;
  assert.equal(h.view().models.changeDisabled, false);
});

test('no option implies a size ladder between Opus and Fable', () => {
  // The superseded copy positioned Fable as the "bigger" model. Opus is
  // now the general coding pick and Fable the taste pick, so those strings
  // must not come back. On the HELPER since #1589: the composer renders
  // names, so its markup would pass this vacuously.
  const { DevChat } = makeHarness();
  const all = Object.values(DevChat.MODELS).map((m) => DevChat.modelOptionText(m)).join(' | ');
  assert.ok(!all.includes('Fable 5.1: big or tricky work'));
  assert.ok(!all.includes('a few files'));
  // #809: Opus is the general-purpose coding model, not one reserved for
  // big or tricky changes — the old restrictive wording must not return.
  assert.ok(
    !all.includes('Opus 5: big or tricky coding'),
    'Opus option reverted to the superseded "big or tricky" framing'
  );
});

test('modelOptionText degrades to the bare label without guidance', () => {
  const { DevChat } = makeHarness();
  assert.equal(DevChat.modelOptionText({ label: 'Opus 5' }), 'Opus 5');
  assert.equal(DevChat.modelOptionText({ label: 'Opus 5', changeSize: {} }), 'Opus 5');
  assert.equal(DevChat.modelOptionText(null), '');
});

// ── 3. the caption the composer no longer paints ────────────────────

test('the composer paints no model caption at all (#1353)', () => {
  // It said "Opus 5: best for anything from a quick fix to a multi-file
  // feature, a refactor, or debugging that needs real digging." directly
  // under an <option> reading "Opus 5: general coding work", on every
  // render of every session. Two sentences of the same advice, and the
  // longer one was between the picker and the text box.
  const { html, getEl, DevChat } = render({ selected: 'claude-opus-5' });
  assert.ok(!html.includes('dc-model-note'), 'no caption element is rendered');
  assert.ok(!html.includes('best for'), 'and none of its copy either');
  assert.equal(getEl('dc-model-note').textContent, '', 'nothing fills one after render');
  assert.equal(typeof DevChat._renderModelNote, 'undefined',
    'and the filler is gone rather than left pointing at an absent element');
});

test('the retired long-caption helper stays safe but Generate proposal no longer uses it', () => {
  const { DevChat } = makeHarness();
  assert.equal(
    DevChat.modelNoteText(DevChat.MODELS['claude-opus-5']),
    'Opus 5: best for anything from a quick fix to a multi-file feature, '
      + 'a refactor, or debugging that needs real digging.'
  );
  assert.equal(
    DevChat.modelNoteText(DevChat.MODELS['claude-sonnet-5']),
    'Sonnet 5: best for one small thing at a time: a text tweak, a colour, a single file.'
  );
  assert.equal(DevChat.modelNoteText({ label: 'Opus 5' }), '', 'no guidance, no sentence');
  assert.match(DevChat.MODEL_GUIDANCE_TOOLTIP, /general coding pick/);
  assert.match(DevChat.MODEL_GUIDANCE_TOOLTIP, /genuinely difficult/);
  assert.ok(
    !/Bigger models/i.test(DevChat.MODEL_GUIDANCE_TOOLTIP),
    'tooltip reverted to the superseded "bigger models cost more" framing'
  );
  const APP_VIEW = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
  );
  assert.doesNotMatch(APP_VIEW, /DevChat\.modelNoteText\(m\)/,
    'the simplified dialog does not render the redundant long caption');
});

test('the direct picker still follows the selection without a caption to update', async () => {
  const { DevChat, view } = render({ selected: 'claude-opus-5' });
  assert.equal(view().models.selected, 'anthropic:claude-opus-5');
  await DevChat._onModelPicked('anthropic:claude-fable-5-1');
  assert.equal(DevChat.selectedModel, 'claude-fable-5-1');
  assert.equal(view().models.selected, 'anthropic:claude-fable-5-1');
});

test('the Fable option owns difficult coding without displacing Opus as the general pick', () => {
  // The trio's positioning: Sonnet = simple/small, Opus = general
  // coding, Fable = design/taste plus the MOST difficult coding. Fable
  // gaining "difficult coding" must not revert Opus to a
  // big-or-tricky-only framing. Asserted on the helper since #1589 moved
  // this copy out of the composer's own markup.
  const { DevChat } = makeHarness();
  const text = (id) => DevChat.modelOptionText(DevChat.MODELS[id]);
  assert.equal(text('claude-fable-5-1'), 'Fable 5.1: design, taste, and difficult coding');
  assert.notEqual(text('claude-opus-5'), 'Opus 5: big or tricky coding');
  assert.equal(text('claude-opus-5'), 'Opus 5: general coding work');
});

// ── 4. missing guidance degrades, never crashes ─────────────────────

test('a model with no guidance renders a bare label', () => {
  // Missing editorial guidance must still leave a useful model name rather
  // than an empty option. #2569: the label is the name alone.
  const models = { 'claude-opus-5': { label: 'Opus 5' } };
  const { html, view } = render({ models });

  assert.ok(html.includes('>Opus 5<'), 'expected the model name in the control');
  const direct = view().models.options.filter((o) => o.value.startsWith('anthropic:'));
  assert.deepEqual(direct, [{
    value: 'anthropic:claude-opus-5',
    label: 'Opus 5',
    title: 'Runs on the platform Claude allowance, or your own Anthropic key',
  }]);
  assert.ok(!html.includes('best for'));
});

test('an option with no label at all falls back to the model id', () => {
  // The composer reads `meta.label` directly now instead of going through
  // modelOptionText, so its own empty case has to be its own.
  const { html } = render({ models: { 'claude-opus-5': {} } });
  assert.ok(html.includes('>claude-opus-5<'),
    'an id is a worse name than "Opus 5" and a much better one than nothing');
});

test('a garbage MODELS entry does not throw the whole chat view', () => {
  assert.doesNotThrow(() => {
    render({ models: { 'claude-opus-5': { label: 'Opus 5', changeSize: null } } });
  });
});

// ── 5. copy-drift guard ─────────────────────────────────────────────
// The guidance copy lives in TWO places by design: src/services/models.js
// is authoritative, and dev-chat.js seeds a duplicate purely so the
// dropdown paints correctly before /api/models resolves. Nothing else in
// the suite would notice them diverging, and a drift would show users one
// string then silently swap it for another mid-load.

test('the dev-chat seed map matches src/services/models.js exactly', () => {
  const server = require('../src/services/models');
  const { DevChat } = makeHarness();

  assert.deepEqual(
    Object.keys(DevChat.MODELS).sort(),
    Object.keys(server.MODELS).sort(),
    'seed map and allowlist offer different models'
  );

  for (const [id, serverMeta] of Object.entries(server.MODELS)) {
    const seedMeta = DevChat.MODELS[id];
    assert.ok(seedMeta, `${id} missing from the dev-chat seed map`);
    assert.equal(seedMeta.label, serverMeta.label, `${id} label drifted`);
    assert.equal(
      seedMeta.changeSize.short, serverMeta.changeSize.short,
      `${id} changeSize.short drifted between models.js and dev-chat.js`
    );
    assert.equal(
      seedMeta.changeSize.long, serverMeta.changeSize.long,
      `${id} changeSize.long drifted between models.js and dev-chat.js`
    );
  }
});

// ── #907: the "Run on" runner controls, in the same composer row ────

test('the composer is byte-identical for a session with no machine attached', () => {
  const { html, getEl } = render();
  // The host span ships in the markup so nothing has to be inserted later,
  // and stays empty — .dc-runner:empty is display:none, so no gap appears.
  assert.ok(html.includes('id="dc-runner"'), 'the host span is in the composer');
  const { DevChat, runnerHtml } = makeHarness();
  DevChat._renderRunnerControls();
  assert.equal(runnerHtml(), '', 'the strip draws nothing at all');
  // Nobody who never runs the CLI sees the words.
  assert.ok(!html.includes('Run on:'));
  assert.ok(!html.includes('Running on your machine'));
});

test('an attached machine gets a selector and a live chip', () => {
  const { DevChat, runnerHtml } = makeHarness();
  DevChat._applyRunnerState({
    runner: 'local',
    localAgent: { leaseId: '7', label: "Evan's laptop", runtime: 'claude-code' },
  });
  const html = runnerHtml();
  assert.match(html, /Run on:/);
  assert.match(html, /<option value="local"[^>]*>Evan&#x27;s laptop<\/option>/);
  assert.match(html, /<option value="platform">Homeroom<\/option>/);
  assert.match(html, /Running on your machine/);
  // The chip explains the division of labour, because "running on your
  // machine" otherwise reads as "Homeroom has stopped doing anything".
  assert.match(html, /Homeroom still opens the PR/);
});

test('a label the user typed on their own machine is escaped, not interpreted', () => {
  const { DevChat, runnerHtml } = makeHarness();
  DevChat._applyRunnerState({
    runner: 'local',
    localAgent: { leaseId: '7', label: '<img src=x onerror=alert(1)>' },
  });
  const html = runnerHtml();
  assert.ok(!html.includes('<img'), 'the label reached the DOM unescaped');
  assert.match(html, /&lt;img/);
  // It rides in a `title` too, which is the attribute context the string
  // renderer needed a separate escape for.
  assert.match(html, /title="The last turn ran on|title="Spec and coding turns in this session run on &lt;img/);
});

test('a machine that has gone leaves a past-tense chip, not a live one', () => {
  const { DevChat, runnerHtml } = makeHarness();
  DevChat._applyRunnerState({
    runner: 'local', runnerLabel: 'laptop', localAgent: { leaseId: '7', label: 'laptop' },
  });
  // The lease is gone but chat_sessions still remembers where the last turn
  // ran, which is what /status sends as runnerLabel.
  DevChat._applyRunnerState({ runner: 'local', runnerLabel: 'laptop', localAgent: null });
  const html = runnerHtml();
  assert.match(html, /dc-runner-chip-past/);
  assert.match(html, /Last turn: laptop/);
  // No selector: there is nothing left to select between.
  assert.ok(!html.includes('dc-runner-select'));
  assert.match(html, /the next turn runs on Homeroom/);
});

test('choosing Homeroom hands the session back and never leaves a half-set select', async () => {
  const { DevChat, runnerView } = makeHarness();
  const requests = [];
  let confirmed = true;
  DevChat._applyRunnerState({ runner: 'local', localAgent: { leaseId: '7', label: 'laptop' } });
  globalThis.__runnerFetch = null;
  DevChat._handBackToUsernode = async function patched() {
    const agent = DevChat._localAgent;
    if (!agent || agent.demo || !confirmed) return;
    requests.push(`DELETE /api/me/local-agents/${agent.leaseId}`);
    DevChat._localAgent = null;
    DevChat._renderRunnerControls();
  };
  // #1191: the handler is the select's onChange prop, so it is invoked
  // directly rather than through a listener registry.
  const { RunnerControlsView } = loadTsx('frontend/src/features/dev-chat/composer-chrome.tsx');
  const onChange = () => {
    const parts = RunnerControlsView(runnerView()).props.children;
    const select = parts.find((child) => child && child.props && child.props.id === 'dc-runner-select');
    assert.ok(select, 'the live strip renders a selector');
    return select.props.onChange;
  };
  const previous = global.window;
  global.window = { DevChat };
  try {
    const event = { target: { value: 'platform' } };
    onChange()(event);
    await new Promise((resolve) => setImmediate(resolve));
    // The select snaps back before the async work: a dropdown left reading
    // "Homeroom" while the lease is still held is a lie about where the next
    // turn goes.
    assert.equal(event.target.value, 'local');
    assert.deepEqual(requests, ['DELETE /api/me/local-agents/7']);

    // Selecting the machine that is already running it is a no-op.
    requests.length = 0;
    DevChat._applyRunnerState({ runner: 'local', localAgent: { leaseId: '8', label: 'desktop' } });
    onChange()({ target: { value: 'local' } });
    assert.deepEqual(requests, []);
  } finally {
    if (previous === undefined) delete global.window; else global.window = previous;
  }
});

test('the hand-back is the browser-side escape hatch, and refuses demo rows', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'), 'utf8'
  );
  const fn = source.slice(
    source.indexOf('  async _handBackToUsernode() {'),
    source.indexOf('  _sanitizeStoredModel() {')
  );
  // It must not require the machine to cooperate — the whole point is the
  // laptop that was closed without detaching.
  assert.match(fn, /method: 'DELETE'/);
  assert.match(fn, /res\.status !== 204 && res\.status !== 404/,
    'an already-gone lease is success, not an error toast');
  assert.match(fn, /agent\.demo/);
  assert.match(fn, /confirm\(/, 'detaching is destructive enough to confirm');
});

test('runner state is per session and never bleeds across a switch', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'), 'utf8'
  );
  // openSession clears all three before the /status read re-establishes them.
  assert.match(
    source,
    /DevChat\._runner = null;\n\s+DevChat\._runnerLabel = null;\n\s+DevChat\._localAgent = null;/
  );
  const { DevChat, getEl } = makeHarness();
  DevChat._applyRunnerState({ runner: 'local', localAgent: { leaseId: '7', label: 'laptop' } });
  DevChat._runner = null;
  DevChat._runnerLabel = null;
  DevChat._localAgent = null;
  DevChat._renderRunnerControls();
  assert.equal(getEl('dc-runner').innerHTML, '');
});
