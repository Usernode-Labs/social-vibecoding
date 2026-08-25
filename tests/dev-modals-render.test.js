// The Dev screen's three body-mounted modals, end to end: the view model
// public/js/app-view.js builds, and the markup
// frontend/src/features/dev-board/modals/ renders from it.
//
// ── What this file is for ──────────────────────────────────────────────
//
// These were the last three `innerHTML` strings on the Dev screen, and each
// was a hand-transcribed copy of the same dialog: a scrim, a centring
// wrapper, a white/zinc-900 card and a two-button footer. Nothing asserted
// on their markup at all — the only coverage was three source greps for copy
// — so a conversion could have dropped a whole branch (the amber
// no-payer box, the BYOK opt-in, the OpenRouter wording) and every gate
// would have stayed green.
//
// The harness stubs `window.UsernodeReact.devBoard`, captures what each
// `_show*Modal` publishes, and renders it through the real component. Both
// halves are production code, composed exactly as they are at runtime.
//
// Run with: node --test tests/dev-modals-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/dev-modals-api.ts')));

/** A DOM stub thin enough for the three dialogs and nothing else. */
function fakeNode() {
  return {
    id: '',
    className: '',
    classList: { add() {}, remove() {} },
    style: {},
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    remove() { this.removed = true; },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
  };
}

function makeAppView(opts) {
  const o = opts || {};
  const published = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, canAdminWrite: !!o.admin } },
    PlatformUI: { toast: (t) => { sandbox.__toast = t; } },
    CreditOptions: {
      cardHtml: () => '<div class="dc-credits-card">routes</div>',
      wire: (root, hooks) => { sandbox.__wired = { root, hooks }; },
    },
    Settings: { state: { hasApiKey: false } },
    BuildVenues: o.venue === false ? undefined
      : { venue: () => ({ label: 'Usernode', blurb: 'Runs on the platform.' }) },
    DevChat: {
      modelOptionText: (m) => `${m.id}: 40-60%`,
      modelNoteText: (m) => `${m.id} does medium changes`,
      MODEL_GUIDANCE_TOOLTIP: 'How to read these',
      _openRouterModelOptionLabel: (m) => `${m.id} (openrouter)`,
      _openRouterModelCostSummary: (m) => `${m.id} costs $1/Mtok`,
      _openRouterModelCompatibilitySummary: () => 'Tool use supported',
    },
    document: {
      _byId: {},
      getElementById(id) { return this._byId[id] || null; },
      createElement: () => fakeNode(),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.UsernodeReact = {
    devBoard: {
      mountAutoSessionModal: (host, view) => published.push({ kind: 'auto', host, view }),
      mountCreditOptionsModal: (host, view) => published.push({ kind: 'credits', host, view }),
      mountLlmConsentModal: (host, view) => published.push({ kind: 'consent', host, view }),
      unmount: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, published, sandbox };
}

/** The last published view, brought across the vm boundary as plain data. */
const lastView = (published) => JSON.parse(JSON.stringify(published[published.length - 1].view));

const autoHtml = (view) => {
  const m = mod();
  m.autoSessionModalStore.set({ view });
  return renderToHtml(createElement(m.AutoSessionModal));
};
const creditsHtml = (view) => {
  const m = mod();
  m.creditOptionsModalStore.set({ view });
  return renderToHtml(createElement(m.CreditOptionsModal));
};
const consentHtml = (view) => {
  const m = mod();
  m.llmConsentModalStore.set({ view });
  return renderToHtml(createElement(m.LlmConsentModal));
};

const MODELS = [{ id: 'opus' }, { id: 'sonnet' }];

// ── Generate proposal ───────────────────────────────────────────────────

test('the Generate-proposal dialog names the issue, the venue and the models', () => {
  const { AppView, published } = makeAppView();
  AppView._showAutoSessionModal(42, MODELS, 'sonnet');
  const view = lastView(published);
  assert.equal(view.issueNumber, 42);
  assert.equal(view.pickerLabel, 'Chat model');
  assert.equal(view.preselect, 'sonnet');
  assert.deepEqual(view.options.map((o) => o.id), ['opus', 'sonnet']);

  const html = autoHtml(view);
  assert.match(html, /Generate proposal for issue #42\?/);
  assert.match(html, /headless AI session/);
  assert.match(html, /Building in <b>Usernode<\/b>/, 'the venue is named before you confirm');
  assert.match(html, /id="auto-session-model"/);
  assert.match(html, /<option value="opus">opus: 40-60%<\/option>/);
  assert.match(html, /selected/, 'the preselected model is the one selected');
  assert.match(html, /Experimental/);
});

test("the picker's caption is the SELECTED model's, with its tooltip", () => {
  const { AppView, published } = makeAppView();
  AppView._showAutoSessionModal(42, MODELS, 'sonnet');
  const view = lastView(published);
  // #800: each option carries its own resolved caption, so the change
  // handler that used to rewrite one <p> is component state.
  assert.equal(view.options[1].note, 'sonnet does medium changes');
  assert.equal(view.options[1].noteTitle, 'How to read these');
  const html = autoHtml(view);
  assert.match(html, /id="auto-session-model-note"[^>]*title="How to read these"/);
  assert.match(html, /sonnet does medium changes/);
  assert.doesNotMatch(html, /opus does medium changes/, 'only the selected one is shown');
});

test('the OpenRouter branch swaps the copy, the label and the caption source', () => {
  const { AppView, published } = makeAppView();
  AppView._showAutoSessionModal(42, MODELS, 'opus', { provider: 'openrouter' });
  const view = lastView(published);
  assert.equal(view.pickerLabel, 'OpenRouter model');
  assert.equal(view.options[0].label, 'opus (openrouter)');
  assert.equal(view.options[0].note, 'opus costs $1/Mtok. Tool use supported');
  assert.equal(view.options[0].noteTitle, '', 'the Claude guidance tooltip is Claude-only');
  const html = autoHtml(view);
  assert.match(html, /does not use platform Claude credits/);
  assert.doesNotMatch(html, /headless AI session/);
});

test('no build-venues module leaves the venue line empty rather than broken', () => {
  const { AppView, published } = makeAppView({ venue: false });
  AppView._showAutoSessionModal(42, MODELS, 'opus');
  const view = lastView(published);
  assert.equal(view.venue, null);
  assert.doesNotMatch(autoHtml(view), /Building in/);
});

test('the dialog resolves through the named calls its buttons dispatch', async () => {
  const { AppView } = makeAppView();
  const pending = AppView._showAutoSessionModal(42, MODELS, 'sonnet');
  AppView._autoSessionConfirm('opus');
  assert.equal(await pending, 'opus');

  const second = AppView._showAutoSessionModal(42, MODELS, 'sonnet');
  AppView._autoSessionCancel();
  assert.equal(await second, null, 'cancel resolves null, as backdrop and Esc do');
});

test('the footer is the widget language: a filled neutral beside the primary', () => {
  const { AppView, published } = makeAppView();
  AppView._showAutoSessionModal(42, MODELS, 'opus');
  const html = autoHtml(lastView(published));
  // The secondary used to be `border border-zinc-300 …` — an outlined
  // control on a floating card, which the language never draws.
  assert.match(html, /data-role="cancel"[^>]*class="[^"]*bg-zinc-100 hover:bg-zinc-200/);
  assert.doesNotMatch(html, /data-role="cancel"[^>]*class="[^"]*border-zinc-300/);
  assert.match(html, /data-role="confirm"[^>]*class="[^"]*bg-violet-600/);
});

// ── Out of credits ──────────────────────────────────────────────────────

test("the credits modal hosts CreditOptions' own card and wires it after mounting", () => {
  const { AppView, published, sandbox } = makeAppView();
  AppView._showCreditOptionsModal('out of credits', {});
  const view = lastView(published);
  assert.match(view.cardHtml, /dc-credits-card/);
  assert.ok(sandbox.__wired, 'CreditOptions.wire ran');
  assert.equal(sandbox.__wired.root, published[published.length - 1].host,
    'wired to the same scrim the card was mounted into');

  const html = creditsHtml(view);
  assert.match(html, /dc-credits-modal-card/, 'the shared card class the dev chat also uses');
  assert.match(html, /routes/, "the other module's markup is rendered, not reimplemented");
  assert.match(html, /data-credits-close/);
  assert.match(html, /Not now/);
});

test('no CreditOptions module falls back to a toast rather than an empty scrim', () => {
  const { AppView, published, sandbox } = makeAppView();
  sandbox.CreditOptions = undefined;
  AppView._showCreditOptionsModal('out of credits', {});
  assert.equal(published.length, 0);
  assert.equal(sandbox.__toast, 'out of credits');
});

// ── App LLM consent ─────────────────────────────────────────────────────

const CONSENT = (over) => ({
  app: { name: 'RecipeBot' },
  maxCapCents: 2500,
  defaultCapCents: 100,
  entitlement: { limitCents: 1000, entitlementAvailable: true },
  hasApiKey: false,
  ...over,
});

test('the consent dialog prefills the cap and explains the budget it spends', () => {
  const { AppView, published } = makeAppView();
  AppView.showLlmConsentModal(CONSENT());
  const view = lastView(published);
  assert.equal(view.capacity.t, 'cap');
  assert.equal(view.capacity.prefill, '1.00');
  assert.equal(view.capacity.byok, null, 'no key on the account, no opt-in');

  const html = consentHtml(view);
  assert.match(html, /Allow RecipeBot to use AI\?/);
  assert.match(html, /spend from your daily AI budget/);
  assert.match(html, /id="llm-consent-cap"[^>]*value="1.00"/);
  assert.match(html, /You can change this anytime in Settings/);
  assert.match(html, /id="llm-consent-error"[^>]*class="hidden/, 'the error line starts empty');
});

test("an app's suggested cap is used, and labelled as the app's suggestion", () => {
  const { AppView, published } = makeAppView();
  AppView.showLlmConsentModal(CONSENT({ llm: { suggestedCapCents: 250, purpose: 'Summarise recipes' } }));
  const view = lastView(published);
  assert.equal(view.capacity.prefill, '2.50');
  const html = consentHtml(view);
  assert.match(html, /Suggested by this app/);
  assert.match(html, /Summarise recipes/, "the app's own reason, in quotes");
});

test('no payer replaces the whole field with the amber box and disables Allow', () => {
  const { AppView, published } = makeAppView();
  AppView.showLlmConsentModal(CONSENT({ maxCapCents: 0 }));
  const view = lastView(published);
  assert.equal(view.capacity.t, 'blocked');
  const html = consentHtml(view);
  assert.match(html, /No AI payer is available yet/);
  assert.match(html, /href="#settings\/connectors"/);
  assert.match(html, /href="#settings\/api-key"/);
  assert.doesNotMatch(html, /id="llm-consent-cap"/, 'no cap field to fill in');
  assert.match(html, /id="llm-consent-allow"[^>]*disabled/);
  assert.match(html, /Unavailable/);
});

test('an unreachable eligibility check says so instead of blaming the account', () => {
  const { AppView, published } = makeAppView();
  AppView.showLlmConsentModal(CONSENT({
    maxCapCents: 0, entitlement: { limitCents: 0, entitlementAvailable: false },
  }));
  const html = consentHtml(lastView(published));
  assert.match(html, /Credit eligibility could not be checked/);
  assert.doesNotMatch(html, /No AI payer is available yet/);
});

test('BYOK-only pre-checks the opt-in and rewrites both the intro and its label', () => {
  const { AppView, published } = makeAppView();
  AppView.showLlmConsentModal(CONSENT({ entitlement: { limitCents: 0 }, hasApiKey: true }));
  const view = lastView(published);
  assert.equal(view.capacity.byok.checked, true);
  assert.match(view.intro, /use your own Anthropic API key/);
  const html = consentHtml(view);
  assert.match(html, /id="llm-consent-byok"[^>]*checked/);
  assert.match(html, /required until platform credits are unlocked/);
});

test('a key with platform credits offers the opt-in unchecked, as a fallback', () => {
  const { AppView, published } = makeAppView();
  AppView.showLlmConsentModal(CONSENT({ hasApiKey: true }));
  const view = lastView(published);
  assert.equal(view.capacity.byok.checked, false);
  assert.match(view.capacity.byok.label, /If my daily platform budget runs out/);
  assert.doesNotMatch(consentHtml(view), /id="llm-consent-byok"[^>]*checked/);
});

test('validation stays in the module, and writes into the card\'s error host', async () => {
  const { AppView, sandbox } = makeAppView();
  // The dialog reads the field back by id, so the scrim has to answer for it.
  const err = { textContent: '', classList: { add() {}, remove() { err.shown = true; } } };
  const cap = { value: '0' };
  const scrim = fakeNode();
  scrim.querySelector = (sel) => (sel === '#llm-consent-error' ? err
    : (sel === '#llm-consent-cap' ? cap : null));
  sandbox.document.createElement = () => scrim;

  const pending = AppView.showLlmConsentModal(CONSENT());
  AppView._llmConsentAllow();
  assert.match(err.textContent, /at least \$0\.01/);
  assert.ok(err.shown, 'the error line is revealed, not left hidden');

  cap.value = '99';
  AppView._llmConsentAllow();
  assert.match(err.textContent, /can't exceed your own daily limit \(\$25\.00\)/);

  cap.value = '5';
  AppView._llmConsentAllow();
  // Cross-realm: the resolved object is the vm's, so compare it as data.
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)),
    { dailyCapCents: 500, allowByok: false });
});

test('Not now resolves null', async () => {
  const { AppView } = makeAppView();
  const pending = AppView.showLlmConsentModal(CONSENT());
  AppView._llmConsentDecline();
  assert.equal(await pending, null);
});
