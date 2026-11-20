// The app-allowance consent dialog, end to end: the view model
// public/js/app-view.js builds, and the markup
// frontend/src/features/dev-board/modals/llm-consent-modal.tsx renders from
// it, plus the relay that opens it (`handleLlmBridgeMessage`).
//
// ── What this file is for ──────────────────────────────────────────────
//
// It was one of the Dev screen's last three `innerHTML` strings (with the
// Generate-proposal and credit-options dialogs, both retired with the dev
// chat's headless run), each a hand-transcribed copy of the same dialog: a
// scrim, a centring wrapper, a white/zinc-900 card and a two-button footer.
// Nothing asserted on its markup at all, so a conversion could have dropped
// a whole branch (the amber no-payer box, the BYOK opt-in) and every gate
// would have stayed green.
//
// The harness stubs `window.UsernodeReact.devBoard`, captures what
// `showLlmConsentModal` publishes, and renders it through the real
// component. Both halves are production code, composed exactly as they are
// at runtime.
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
    console, URL,
    location: { href: 'https://platform.invalid/' },
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, canAdminWrite: !!o.admin } },
    PlatformUI: { toast: (t) => { sandbox.__toast = t; } },
    Settings: { state: { hasApiKey: false } },
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
      mountLlmConsentModal: (host, view) => published.push({ kind: 'consent', host, view }),
      unmount: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, published, sandbox };
}

/** The last published view, brought across the vm boundary as plain data. */
const lastView = (published) => JSON.parse(JSON.stringify(published[published.length - 1].view));

const consentHtml = (view) => {
  const m = mod();
  m.llmConsentModalStore.set({ view });
  return renderToHtml(createElement(m.LlmConsentModal));
};

// ── App LLM consent ─────────────────────────────────────────────────────

const CONSENT = (over) => ({
  app: { name: 'RecipeBot' },
  maxCapCents: 2500,
  defaultCapCents: 100,
  entitlement: { limitCents: 1000, entitlementAvailable: true },
  hasOwnKey: false,
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
  assert.match(html, /spend from your weekly AI budget/);
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
  // "Connect GitHub or X" goes to Linked accounts, the GitHub/X rows' own
  // page since the settings restructure split them out of the connectors pane.
  assert.match(html, /href="#settings\/linked-accounts"/);
  // The second door is the person's own OpenRouter key (task 2275; it was
  // the Anthropic key part, which is gone).
  assert.match(html, /href="#settings\/openrouter"/);
  assert.match(html, /add your own OpenRouter key/);
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
  AppView.showLlmConsentModal(CONSENT({ entitlement: { limitCents: 0 }, hasOwnKey: true }));
  const view = lastView(published);
  assert.equal(view.capacity.byok.checked, true);
  assert.match(view.intro, /use your own OpenRouter key/);
  const html = consentHtml(view);
  assert.match(html, /id="llm-consent-byok"[^>]*checked/);
  assert.match(html, /required until platform credits are unlocked/);
});

test('a key with platform credits offers the opt-in unchecked, as a fallback', () => {
  const { AppView, published } = makeAppView();
  AppView.showLlmConsentModal(CONSENT({ hasOwnKey: true }));
  const view = lastView(published);
  assert.equal(view.capacity.byok.checked, false);
  assert.match(view.capacity.byok.label, /If my weekly platform budget runs out/);
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

// ── The relay that opens it (#1909) ─────────────────────────────────────
//
// Nothing on the Dev screen opens this dialog: it is reached ONLY from an
// app's own `usernode.requestLlmAccess()`, relayed by
// `handleLlmBridgeMessage`. Every case above renders a card that was
// already asked for, so a relay that never asks is invisible to all of
// them — which is how "Recipe bot requests permission with no visible
// prompt" survived: the relay gated on a hand-written two-frame allow-list
// while the shell owns THREE app frames, so a request from the landing
// viewer was dropped before the ack and the app was told, 15 seconds
// later, that it was not running inside the platform at all.
//
// These drive the real handler over the real dialog, so the assertion is
// "the card is published", not "the source text still says so".

/** An owned frame in the stub document, posting back into `posted`. */
function ownedFrame(sandbox, id, posted) {
  const frame = fakeNode();
  frame.id = id;
  frame.src = 'https://recipe-bot.apps.invalid/';
  if (id === 'app-iframe') sandbox.__AppView._appFrameDom._slug = 'recipe-bot';
  frame.contentWindow = { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) };
  sandbox.document._byId[id] = frame;
  return frame;
}

/** The bootstrap `GET /api/apps/:slug/llm-grant` the relay awaits. */
function stubBootstrap(sandbox, { status = 200, body = null } = {}) {
  const seen = [];
  sandbox.fetch = async (url, init) => {
    seen.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (body || { app: { name: 'RecipeBot', slug: 'recipe-bot' }, ...CONSENT() }),
    };
  };
  return seen;
}

/** Post one `__usernode_llm` message and let the relay's awaits settle. */
async function ask(AppView, source, type = 'request-access', id = 'llm-1') {
  AppView.handleLlmBridgeMessage({ data: { __usernode_llm: type, id }, source, origin: 'https://recipe-bot.apps.invalid' });
  await new Promise((r) => setTimeout(r, 0));
}

test('an app in the App tab gets the consent card, as it always has', async () => {
  const { AppView, published, sandbox } = makeAppView();
  const posted = [];
  const frame = ownedFrame(sandbox, 'app-iframe', posted);
  stubBootstrap(sandbox);
  AppView.appData = { slug: 'recipe-bot', name: 'RecipeBot', status: 'running' };

  await ask(AppView, frame.contentWindow);
  assert.equal(posted[0].__usernode_llm, 'ack', 'the bridge must stop its no-shell timer');
  assert.equal(published.at(-1).kind, 'consent');
  assert.match(lastView(published).intro, /spend from your weekly AI budget/);
});

test('an app in the landing viewer gets the same card, not silence', async () => {
  const { AppView, published, sandbox } = makeAppView();
  const posted = [];
  const frame = ownedFrame(sandbox, 'app-viewer-frame', posted);
  stubBootstrap(sandbox);
  // The landing screen has no `appData` — the viewer's app is recorded where
  // its document starts loading, which is the cover mount.
  const timers = [];
  AppView.mountViewerCover(
    { classList: { add() {} }, insertAdjacentHTML() {} },
    frame,
    { slug: 'recipe-bot', name: 'RecipeBot' },
    { timers, isCurrent: () => false },
  );
  assert.equal(AppView.appData, null, 'the App tab record is genuinely absent here');

  await ask(AppView, frame.contentWindow);
  timers.forEach(clearTimeout);
  assert.equal(posted[0].__usernode_llm, 'ack');
  assert.equal(published.at(-1).kind, 'consent', 'the grant/deny card, on the surface that asked');
  assert.equal(lastView(published).appName, 'RecipeBot');
});

test('a recognised request is always answered, even when the app cannot be named', async () => {
  const { AppView, published, sandbox } = makeAppView();
  const posted = [];
  const frame = ownedFrame(sandbox, 'app-viewer-frame', posted);
  stubBootstrap(sandbox);
  // No cover mount: nothing in the shell knows which app this frame holds.
  await ask(AppView, frame.contentWindow);
  assert.equal(posted[0].__usernode_llm, 'ack');
  assert.equal(posted[1].__usernode_llm, 'response');
  assert.match(posted[1].error, /could not be identified/);
  assert.equal(published.length, 0, 'and no empty dialog is opened over the app');
});

test('a signed-out visitor is told to sign in, not that something failed', async () => {
  const { AppView, sandbox } = makeAppView();
  const posted = [];
  const frame = ownedFrame(sandbox, 'app-viewer-frame', posted);
  // The bootstrap is session-authenticated; the landing viewer is the one
  // owned frame an anonymous visitor can reach.
  stubBootstrap(sandbox, { status: 401 });
  AppView.mountViewerCover(
    { classList: { add() {} }, insertAdjacentHTML() {} },
    frame,
    { slug: 'recipe-bot', name: 'RecipeBot' },
    { timers: [], isCurrent: () => false },
  );
  await ask(AppView, frame.contentWindow);
  assert.match(posted.at(-1).error, /Sign in/);
});

test('a window this shell does not own is still ignored entirely', async () => {
  const { AppView, published, sandbox } = makeAppView();
  const posted = [];
  ownedFrame(sandbox, 'app-iframe', posted);
  stubBootstrap(sandbox);
  AppView.appData = { slug: 'recipe-bot' };

  await ask(AppView, { postMessage: (m) => posted.push(m) });
  assert.deepEqual(posted, [], 'no ack, no reply — the gate is not widened to any frame');
  assert.equal(published.length, 0);
});

test('the read-only queries answer from the landing viewer too', async () => {
  const { AppView, published, sandbox } = makeAppView();
  const posted = [];
  const frame = ownedFrame(sandbox, 'app-viewer-frame', posted);
  stubBootstrap(sandbox, {
    body: {
      app: { name: 'RecipeBot', slug: 'recipe-bot' },
      grant: { status: 'active', dailyCapCents: 250, allowByok: false, spentTodayCents: 12 },
      maxCapCents: 2500,
    },
  });
  AppView.mountViewerCover(
    { classList: { add() {} }, insertAdjacentHTML() {} },
    frame,
    { slug: 'recipe-bot', name: 'RecipeBot' },
    { timers: [], isCurrent: () => false },
  );

  await ask(AppView, frame.contentWindow, 'get-usage');
  assert.deepEqual(posted.at(-1).value, {
    granted: true, spentCentsToday: 12, dailyCapCents: 250,
  });
  assert.equal(published.length, 0, 'the usage meter never opens the dialog');
});
