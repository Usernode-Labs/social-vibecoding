// The connector walkthrough is taught on TWO screens now, from one source
// (#2706).
//
// The ask was to put the "connect Homeroom" steps for Claude and ChatGPT on
// the dev session page itself, inline, instead of sending the reader to
// Settings. The risk that comes with that ask is a second copy of six and
// seven steps of product-specific prose, which drifts the first time either
// product moves a button — and the facts here are the ones people already
// get wrong (the exact connector name, "there is no client secret",
// ChatGPT's Developer-mode gate). So the steps live in
// frontend/src/features/settings/connector-setup-steps.tsx and both screens
// render that module.
//
// This file pins the arrangement rather than the prose: one owner for the
// steps, no second copy on either screen, no host written into the copy, and
// the seam between the launchpad's innerHTML card and the React island that
// sits beside it.
//
// Run with: node --test tests/connector-setup-shared.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...rel) => fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
// The assertions below are about COPY, and a header comment is free to
// explain what the copy may not say. Same idiom as
// tests/connector-setup-codex.test.js.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const STEPS = read('frontend', 'src', 'features', 'settings', 'connector-setup-steps.tsx');
const SETTINGS_SECTION = read('frontend', 'src', 'features', 'settings', 'sections', 'connectors.tsx');
const INLINE = read('frontend', 'src', 'features', 'dev-chat', 'connector-setup-inline.tsx');
const VIEW = read('frontend', 'src', 'features', 'dev-chat', 'view.tsx');
const DEV_CHAT = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const FLOW_SELECT = read('public', 'js', 'dev-flow-select.js');

const DevFlowSelect = require('../public/js/dev-flow-select.js');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

let cached = null;
const card = () => (cached || (cached = loadTsx('frontend/src/features/dev-chat/connector-setup-inline.tsx')));
const cardHtml = (view) => renderToHtml(createElement(card().ConnectorSetupInline, {
  view: { product: 'Claude', url: 'https://example.test/mcp', connected: false, ...view },
}));

test('the shared module is the only place the two walkthroughs are written', () => {
  // Six and seven, the counts both routes' summaries in Settings advertise
  // ("6 steps · also sets up Claude Code", "7 steps · needs Developer mode").
  const claude = STEPS.slice(STEPS.indexOf('export function ClaudeSetupSteps'),
    STEPS.indexOf('export function ChatgptSetupSteps'));
  const chatgpt = STEPS.slice(STEPS.indexOf('export function ChatgptSetupSteps'));
  assert.equal((claude.match(/<SetupStep n=\{\d\}/g) || []).length, 6);
  assert.equal((chatgpt.match(/<SetupStep n=\{\d\}/g) || []).length, 7);

  // Neither consumer restates them. A `SetupStep` in Settings is legitimate
  // — the Codex and generic-client routes still render rows in that idiom —
  // so the assertion is on the product walkthroughs' own first lines, which
  // are what a copy would have to reproduce.
  for (const [name, src] of [['Settings', SETTINGS_SECTION], ['the launchpad card', INLINE]]) {
    assert.doesNotMatch(src, /Open connector settings\./, `${name} does not restate Claude's steps`);
    assert.doesNotMatch(src, /Turn on Developer mode\./, `${name} does not restate ChatGPT's steps`);
  }
  assert.match(SETTINGS_SECTION, /<ClaudeSetupSteps \/>/);
  assert.match(SETTINGS_SECTION, /<ChatgptSetupSteps \/>/);
  assert.match(INLINE, /from '\.\.\/settings\/connector-setup-steps'/);
});

test('the shared steps point at nothing that exists on only one of the screens', () => {
  // Claude's step 2 used to send the reader to the "Name it homeroom"
  // disclosure "under these steps" for why the spelling matters. That block
  // is on the Settings pane and nowhere else, so on the launchpad the
  // sentence pointed at nothing. The reason is in the step now; Settings
  // keeps the disclosure for what a step should not carry.
  const prose = stripComments(STEPS);
  assert.doesNotMatch(prose, /under these steps/);
  assert.doesNotMatch(prose, /Stop the permission prompts|connector-case-|Name it homeroom/);
  // The one thing a step may point at is the value each caller renders
  // above it, and both callers do render it.
  assert.match(STEPS, /the MCP server URL above/);
  assert.match(INLINE, /<ConnectorUrl url=\{url\} \/>/);
  assert.match(SETTINGS_SECTION, /id="connector-url"/);
  // And the fact the cross-reference was carrying survived the move.
  assert.match(STEPS, /Claude Code builds its permission rules/);
});

test('Settings keeps its route, and everything that is only on it', () => {
  // #2706 moves the STEPS, not the pane. The reference a launchpad step has
  // no business reproducing has to still be there, or this became a
  // migration nobody asked for.
  for (const marker of [
    'data-settings-section="connectors"',
    'id="connector-url"',
    'connector-prompt-help',
    'connector-setup-codex',
    'connector-open-claude',
    'connector-open-chatgpt',
  ]) {
    assert.ok(SETTINGS_SECTION.includes(marker), `${marker} stays on the Settings pane`);
  }
  // And the card points back at it rather than replacing it.
  assert.match(INLINE, /href="#settings\/connectors"/);
});

test('neither screen writes a host into the copy', () => {
  // The rule sections/connectors.tsx states and #2706 inherits: a host in
  // prose goes stale on a fork or a config change, so the live value is
  // passed in and the steps say "the MCP server URL above".
  for (const [name, src] of [['the shared steps', STEPS], ['the launchpad card', INLINE]]) {
    assert.doesNotMatch(src, /onhomeroom\.com/, `${name} names no host`);
    assert.doesNotMatch(src, /https:\/\/[a-z0-9.-]*\/mcp/, `${name} hardcodes no endpoint`);
  }
  assert.match(DEV_CHAT, /url: `\$\{window\.location\.origin\}\/mcp`/,
    'the launchpad builds it from the live origin, as Settings does');
});

test('the card is a React island BESIDE the walkthrough card, never inside it', () => {
  // AGENTS.md: a region may hold state only when its whole subtree is
  // React-owned. The walkthrough card is still DevFlowSelect's innerHTML, so
  // the two are siblings — and the nesting branch is the only one that wraps
  // the slot's contents, because `.dc-launchpad-slot:empty` has to keep
  // collapsing an ordinary session's chat.
  const branch = VIEW.slice(VIEW.indexOf('s.connectorSetup ? ('), VIEW.indexOf('<DevSessionChecks'));
  assert.match(branch, /<div dangerouslySetInnerHTML=\{\{ __html: s\.launchpadHtml \}\} \/>\s*\n\s*<ConnectorSetupInline/,
    'the innerHTML card and the island are siblings');
  assert.doesNotMatch(INLINE, /dangerouslySetInnerHTML/, 'and nothing is injected into the island');
  // Nothing outside React looks a node inside the card up.
  assert.doesNotMatch(FLOW_SELECT, /connector-setup/);
  assert.doesNotMatch(DEV_CHAT, /getElementById\('dc-connector-setup/);
});

// ── The behaviour, driven against the real DevChat ──────────────────────
//
// The same vm harness tests/dev-flow-link-github.test.js uses: a regex over
// the source cannot say what the card decides, and what it decides is the
// whole of #2706 — the steps are on screen for the reader who is stuck on
// that step, without anybody pressing anything.

function makeDevChat({ venue = 'web-claude-code' } = {}) {
  const noopEl = {
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, hasAttribute: () => false,
    getAttribute: () => null, focus() {}, scrollIntoView() {},
    querySelector: () => null, querySelectorAll: () => [],
    appendChild() {}, insertAdjacentHTML() {}, remove() {},
    innerHTML: '', textContent: '', value: '', dataset: {},
  };
  const sandbox = {
    console,
    document: {
      getElementById: () => ({ ...noopEl }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild() {} },
    },
    location: { search: '', hash: '', origin: 'https://example.test' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: { sendBeacon() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.DevFlowSelect = DevFlowSelect;
  // The two modules _launchpadVenue leans on, stubbed to the venue under
  // test — the derivation itself is tests/launchpad.test.js's subject.
  sandbox.Launchpad = { isLaunchpad: (v) => ['web-claude-code', 'web-codex', 'own-tools-pr'].includes(v) };
  sandbox.BuildVenues = { currentVenue: () => venue };
  sandbox.App = { user: { id: 7, externalFlowsAvailable: true, devFlowPreference: null }, currentApp: 'x' };
  sandbox.PlatformUI = { toast() {}, hasKit: () => false, menu: () => Promise.resolve(null) };
  sandbox.UsernodeReact = {};
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat._resetDevFlow(7);
  DevChat.currentSession = { id: 7, status: 'active', build_venue: venue, session_title: 'Demo' };
  DevChat.sessions = [DevChat.currentSession];
  DevChat.messages = [];
  DevChat.renderChatView = () => {};
  DevChat.renderMessages = () => {};
  DevChat._repaintDevFlow = () => {};
  DevChat._devFlowEnsureStatus = async () => {};
  return { DevChat, sandbox };
}

const status = (count) => ({
  available: true,
  github: { linked: true, login: 'octo' },
  fork: { state: 'ready', owner: 'octo', repo: 'x' },
  connectors: { count },
});

test('with no connector the steps are already on screen — nothing to press', () => {
  const { DevChat } = makeDevChat();
  DevChat._devFlow.status = status(0);
  const view = DevChat._connectorSetupView();
  assert.ok(view, 'the card renders for the step the reader is standing on');
  assert.equal(view.product, 'Claude');
  assert.equal(view.url, 'https://example.test/mcp');
  assert.equal(view.connected, false);
});

test('a ChatGPT hand-off is taught ChatGPT\'s steps, not Claude\'s', () => {
  // Claude Code signs in as a Claude.ai account and Codex as a ChatGPT one,
  // and the connector is added in THAT account — the same mapping the
  // walkthrough's own copy makes.
  const { DevChat } = makeDevChat({ venue: 'web-codex' });
  DevChat._devFlow.status = status(0);
  assert.equal(DevChat._connectorSetupView().product, 'ChatGPT');
  assert.equal(DevFlowSelect.connectorProduct('codex'), 'ChatGPT');
});

test('an existing connector puts the steps away, and the hint brings them back', () => {
  const { DevChat, sandbox } = makeDevChat();
  DevChat._devFlow.status = status(2);
  assert.equal(DevChat._connectorSetupView(), null, 'nothing to teach unasked');

  // The count spans every account, so "show the steps" in the card's hint is
  // the second-account case — and it opens here, not on Settings.
  const html = DevFlowSelect.wizardHtml({ agent: 'claude-code', status: status(2) });
  assert.match(html, /data-flow-action="link-connector">show the steps</);
  assert.doesNotMatch(html.slice(html.indexOf('dc-flow-card-hint')), /#settings\/connectors/);

  DevChat._devFlowAction('link-connector', {}, { preventDefault() {} });
  assert.equal(sandbox.location.hash, '', 'and the tab never leaves the session');
  const view = DevChat._connectorSetupView();
  assert.ok(view);
  assert.equal(view.connected, true, 'the lead says which case this is');
});

test('"I\'ve added it" closes the card and re-reads the step', async () => {
  const { DevChat } = makeDevChat();
  DevChat._devFlow.status = status(0);
  const forced = [];
  DevChat._devFlowEnsureStatus = async (force) => { forced.push(!!force); };
  await DevChat._devFlowConnectorDone();
  assert.deepEqual(forced, [true], 'a fresh read, not the cached one');
  assert.equal(DevChat._connectorSetupView(), null, 'and the card stands down');
});

test('the own-tools venue is not taught a connector it does not need', () => {
  // A local agent is handed a CLI token instead; there is no MCP connector
  // in that road at all, and no launchpad connector step to answer.
  const { DevChat } = makeDevChat({ venue: 'own-tools-pr' });
  DevChat._devFlow.status = status(0);
  assert.equal(DevChat._connectorSetupView(), null);
});

// ── The rendered card ───────────────────────────────────────────────────
//
// Executed, not grepped, for the reason tests/lib/render-tsx.js exists: the
// declared checks in dapp.json select on this markup, and a check that
// cannot resolve its selector gates merge. These assert the same shapes.

test('the card renders the hooks the declared checks select on', () => {
  const html = cardHtml();
  assert.match(html, /data-connector-setup="Claude"/);
  assert.match(html, /<ol[^>]*>\s*<li/, 'the steps are a real list, for the :first-child selector');
  assert.match(html, /Open connector settings\./, 'Claude step 1, from the shared module');
  assert.match(html, /data-connector-setup-url="1"[^>]*value="https:\/\/example\.test\/mcp"|value="https:\/\/example\.test\/mcp"[^>]*data-connector-setup-url="1"/,
    'the live URL is on screen beside the step that says to paste it');
  assert.match(html, /href="#settings\/connectors"[^>]*>More connector settings</);
  assert.match(html, /class="dc-flow-actions"/, 'the card reuses the walkthrough\u2019s own action row');
});

test('a ChatGPT card renders ChatGPT\'s seven steps and its recap', () => {
  const html = cardHtml({ product: 'ChatGPT' });
  assert.match(html, /data-connector-setup="ChatGPT"/);
  assert.match(html, /Turn on Developer mode\./);
  assert.equal((html.match(/<li class="flex gap-3">/g) || []).length, 7);
  assert.match(html, /In short:/);
  assert.doesNotMatch(html, /Add custom connector/, 'and none of Claude\u2019s');
});

test('the card states the fact that sends people back thinking it failed', () => {
  // A connector added mid-conversation is not in the conversation it was
  // added from. Neither product's own walkthrough says so, and it is the
  // difference between "connected" and "why can it still not see my apps".
  assert.match(cardHtml(), /start a NEW Claude conversation/i);
  assert.match(cardHtml({ product: 'ChatGPT' }), /start a NEW ChatGPT chat/i);
});

test('the lead tells the two cases apart, because the count spans every account', () => {
  assert.match(cardHtml({ connected: false }), /once per account/);
  assert.match(cardHtml({ connected: true }), /connector on another account/);
});
