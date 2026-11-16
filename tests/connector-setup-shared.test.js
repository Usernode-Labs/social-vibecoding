// The connector walkthrough is taught on TWO screens, from one source
// (#2706).
//
// Settings › Connectors teaches the "connect Homeroom" steps for Claude and
// ChatGPT, and so does Homeroom bot's new thread when Claude Code or ChatGPT
// is picked as the builder and its connector is not there yet
// (frontend/src/features/messages/thread-builder.tsx, BuilderSetup). The risk
// that comes with a second screen is a second copy of six and four steps of
// product-specific prose, which drifts the first time either product moves a
// button — and the facts here are the ones people already get wrong (the
// exact connector name, "there is no client secret", ChatGPT's plugins
// directory, reworked for #4431 and #4433). So the steps live in
// frontend/src/features/settings/connector-setup-steps.tsx and both screens
// render that module.
//
// This file pins the arrangement rather than the prose: one owner for the
// steps, no second copy on either screen, no host written into the copy, and
// the ticks that are Settings' alone. What the builder's card renders is
// tests/bot-new-thread.test.js's subject.
//
// Run with: node --test tests/connector-setup-shared.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// The scripts under test read their text from the language runtime's
// global; give them the real English one.
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const fs = require('node:fs');
const path = require('node:path');

const read = (...rel) => fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
// The assertions below are about COPY, and a header comment is free to
// explain what the copy may not say. Same idiom as
// tests/connector-setup-codex.test.js.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { message } = require('./lib/platform-i18n');
// The pane's prose lives in the catalog (frontend/locales/en/settings.json).
// This is the English of every message a stretch of source wires, in order:
// what a reader of that stretch sees, less the markup. Inline code and
// emphasis appear as the catalog's numbered tags (<1>homeroom</1>).
const wiredEnglish = (source) => [...source.matchAll(/['"]((?:settings|core):[\w.]+)['"]/g)]
  .map((match) => message(match[1])).join('\n');

const STEPS = read('frontend', 'src', 'features', 'settings', 'connector-setup-steps.tsx');
const SETTINGS_SECTION = read('frontend', 'src', 'features', 'settings', 'sections', 'connectors.tsx');
const SETTINGS_JS = read('frontend', 'src', 'features', 'settings', 'settings.js');
const BUILDER = read('frontend', 'src', 'features', 'messages', 'thread-builder.tsx');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

test('the shared module is the only place the two walkthroughs are written', () => {
  // Six and four, the counts both routes' summaries in Settings advertise
  // ("6 steps · also sets up Claude Code", "4 steps · in the plugins
  // directory" — ChatGPT reworked for #4431, then to the direct
  // chatgpt.com/plugins opening for #4433).
  const claude = STEPS.slice(STEPS.indexOf('export function ClaudeSetupSteps'),
    STEPS.indexOf('export function ChatgptSetupSteps'));
  const chatgpt = STEPS.slice(STEPS.indexOf('export function ChatgptSetupSteps'));
  assert.equal((claude.match(/<SetupStep n=\{\d\}/g) || []).length, 6);
  assert.equal((chatgpt.match(/<SetupStep n=\{\d\}/g) || []).length, 4);
  assert.equal(message('settings:connectors.claudeSteps.open.title'), 'Open connector settings.');
  assert.equal(message('settings:connectors.chatgptSteps.directory.title'), 'Open the plugins directory.');

  // Neither consumer restates them. A `SetupStep` in Settings is legitimate
  // — the Codex and generic-client routes still render rows in that idiom —
  // so the assertion is on the product walkthroughs' own first lines, which
  // are what a copy would have to reproduce.
  for (const [name, src] of [['Settings', SETTINGS_SECTION], ['the thread builder', BUILDER]]) {
    assert.doesNotMatch(src, /Open connector settings\./, `${name} does not restate Claude's steps`);
    assert.doesNotMatch(src, /Open the plugins directory\./, `${name} does not restate ChatGPT's steps`);
    // Nor wires the steps' own messages: those ids belong to the shared module.
    assert.doesNotMatch(src, /settings:connectors\.(claudeSteps|chatgptSteps)\./, `${name} renders the module, not its messages`);
  }
  assert.match(SETTINGS_SECTION, /<ClaudeSetupSteps track="claude" \/>/);
  assert.match(SETTINGS_SECTION, /<ChatgptSetupSteps track="chatgpt" \/>/);
  assert.match(BUILDER, /from '\.\.\/settings\/connector-setup-steps'/);
});

test('the shared steps point at nothing that exists on only one of the screens', () => {
  // Claude's step 2 used to send the reader to the "Name it homeroom"
  // disclosure "under these steps" for why the spelling matters. That block
  // is on the Settings pane and nowhere else, so on another screen the
  // sentence pointed at nothing. The reason is in the step now; Settings
  // keeps the disclosure for what a step should not carry.
  const prose = `${stripComments(STEPS)}\n${wiredEnglish(STEPS)}`;
  assert.doesNotMatch(prose, /under these steps/);
  assert.doesNotMatch(prose, /Stop the permission prompts|connector-case-|Name it homeroom/);
  // The one thing a step may point at is the value each caller renders
  // above it, and both callers do render it. Claude's steps still do.
  // ChatGPT's step 3 names the endpoint itself instead, but carries it the
  // same way — from the caller, never written into the copy: the thread
  // builder passes the live value as a prop, and Settings' interior ships a
  // fill-in placeholder that settings.js replaces with the same derived
  // origin the #connector-url field shows.
  assert.match(wiredEnglish(STEPS), /the MCP server URL above/);
  assert.match(STEPS, /title=\{t\('settings:connectors\.chatgptSteps\.url\.title'\)\}/);
  assert.equal(message('settings:connectors.chatgptSteps.url.title'), 'Enter Homeroom MCP server URL.');
  assert.match(STEPS, /data-connector-step-url="1"/);
  assert.match(BUILDER, /<ChatgptSetupSteps url=\{url\} \/>/);
  assert.match(SETTINGS_JS, /data-connector-step-url/,
    'Settings fills the ChatGPT step from the derived origin, as it fills the field');
  assert.match(BUILDER, /<ConnectorUrl url=\{url\} \/>/);
  assert.match(SETTINGS_SECTION, /id="connector-url"/);
  // And the fact the cross-reference was carrying survived the move.
  assert.match(wiredEnglish(STEPS), /Claude Code builds its permission rules/);
});

test('Settings keeps its route, and everything that is only on it', () => {
  // #2706 shares the STEPS, not the pane. The reference a step on another
  // screen has no business reproducing has to still be there, or this
  // became a migration nobody asked for.
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
});

test('neither screen writes a host into the copy', () => {
  // The rule sections/connectors.tsx states and #2706 inherits: a host in
  // prose goes stale on a fork or a config change, so the live value is
  // passed in — Claude's steps say "the MCP server URL above", and
  // ChatGPT's step 3 renders the caller's value instead of pointing at
  // the one above it. The fill-in placeholder in the shared steps is
  // spelled with angle brackets so it cannot read as a plausible address,
  // in the source or in the prerendered document.
  for (const [name, src] of [
    ['the shared steps', STEPS],
    ['the thread builder', BUILDER],
  ]) {
    assert.doesNotMatch(src, /onhomeroom\.com/, `${name} names no host`);
    assert.doesNotMatch(src, /https:\/\/[a-z0-9.-]*\/mcp/, `${name} hardcodes no endpoint`);
  }
  assert.match(BUILDER, /const url = typeof window === 'undefined' \? '' : `\$\{window\.location\.origin\}\/mcp`;/,
    'the thread builder builds it from the live origin, as Settings does');
});

// ── #6136: the ticks and the step's Copy are Settings' alone ───────────

test('the thread builder asks for no ticks and no new Copy', () => {
  assert.doesNotMatch(BUILDER, /\btrack\b/, 'the builder does not ask for ticks');
  assert.doesNotMatch(BUILDER, /connector-chatgpt-url-copy|data-connector-step-tick|data-connector-progress/);
});

test('Settings renders a tick per step and an empty, hidden progress line per guide', () => {
  const { ConnectorsSection } = loadTsx('frontend/src/features/settings/sections/connectors.tsx');
  const html = renderToHtml(createElement(ConnectorsSection));
  const ticks = (guide) => (html.match(new RegExp(`data-connector-step-tick="${guide}:\\d"`, 'g')) || []).length;
  assert.deepEqual(
    ['claude', 'chatgpt', 'codex', 'generic'].map(ticks),
    [6, 4, 3, 4],
    'the counts the summaries advertise',
  );
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 17, 'every tick ships not done');
  assert.doesNotMatch(html, /aria-pressed="true"/);
  for (const [guide, total] of [['claude', 6], ['chatgpt', 4], ['codex', 3], ['generic', 4]]) {
    assert.match(
      html,
      new RegExp(`<p data-connector-progress="${guide}" data-total="${total}" hidden=""[^>]*></p>`),
      `${guide}'s line is empty and hidden until settings.js writes it`,
    );
  }
  assert.equal((html.match(/id="connector-chatgpt-url-copy"/g) || []).length, 1, 'one Copy, in ChatGPT');
});

test('the steps module stays stateless: the ticks are settings.js\'s DOM state', () => {
  assert.doesNotMatch(stripComments(STEPS), /useState|useEffect|useReducer|useRef/);
  // The done look is read off aria-pressed, so nothing writes a class at runtime.
  assert.match(STEPS, /group-aria-pressed:bg-violet-600/);
  const ticks = SETTINGS_JS.slice(
    SETTINGS_JS.indexOf('    _wireConnectorStepTicks() {'),
    SETTINGS_JS.indexOf('    async _disconnectConnector(id, button) {'),
  );
  assert.ok(ticks.length > 200, 'located the tick code');
  assert.doesNotMatch(ticks, /classList|className|innerHTML/);
});
