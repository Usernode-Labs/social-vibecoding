'use strict';

// Settings → Connectors: which of the three "stop the permission prompts"
// cases a user sees, and what the read-only tip-status line says.
//
// #1218 shipped one block of prose headed "add this to
// ~/.claude/settings.json", which is the wrong file for Claude Code on the
// web (its container is built fresh, so a file on the user's own machine is
// not in it) and irrelevant in claude.ai chat and ChatGPT. #1219 split it
// into three labelled cases. The split is only worth anything if the right
// case survives — hence a test that drives the real render against the real
// staging fixtures rather than reading the markup.
//
// The fixtures come from routes/mcp-remote.js's own demoConnectorState, not
// from literals written here: the panel and the fixture that reviews it must
// not be able to drift apart.
//
// Run with: node --test tests/settings-connectors-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SETTINGS_SOURCE = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/settings/settings.js'), 'utf8'
);
const CONNECTORS_TSX = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/settings/sections/connectors.tsx'), 'utf8'
);
const { demoConnectorState } = require('../src/routes/mcp-remote');

// The ids the panel drives. Every one is in the rendered markup and in
// tests/baselines/shell-markup.json; a rename that misses one of the three
// files shows up here as a case that stopped being reachable.
const PANEL_IDS = [
  'connectors-section', 'connectors-list', 'connectors-status', 'connector-url',
  'connector-case-cc-local', 'connector-case-cc-web', 'connector-case-chat',
  'connector-hint-status',
];

function node(id) {
  const classes = new Set(id === 'connector-hint-status' ? ['hidden'] : []);
  return {
    id,
    value: '',
    textContent: '',
    children: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    hidden: () => classes.has('hidden'),
    appendChild(child) { this.children.push(child); },
    append(...kids) { this.children.push(...kids); },
    addEventListener() {},
  };
}

function harness(payload) {
  const nodes = new Map(PANEL_IDS.map((id) => [id, node(id)]));
  const context = vm.createContext({
    window: {
      location: { search: '', origin: 'https://social-vibecoding.usernodelabs.org' },
    },
    document: {
      addEventListener() {},
      getElementById: (id) => nodes.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => node(`created:${tag}`),
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });
  context.window.window = context.window;
  context.window.document = context.document;
  vm.runInContext(SETTINGS_SOURCE, context);
  return { Settings: context.window.Settings, nodes };
}

// Load through the real fixture the reviewer's URL would produce.
async function render(demoFlag) {
  const fixture = demoConnectorState(demoFlag);
  assert.ok(fixture, `?demo=${demoFlag} is a real fixture`);
  const { Settings, nodes } = harness({ ...fixture, demo: true });
  await Settings._loadConnectors();
  return nodes;
}

const cases = (nodes) => ({
  local: !nodes.get('connector-case-cc-local').hidden(),
  web: !nodes.get('connector-case-cc-web').hidden(),
  chat: !nodes.get('connector-case-chat').hidden(),
});
const hintLine = (nodes) => {
  const line = nodes.get('connector-hint-status');
  return line.hidden() ? null : line.textContent;
};

test('the fixtures cover every state the panel can be reviewed in', () => {
  // Named here so a state that quietly loses its fixture fails now, rather
  // than as an empty staging panel nobody can review.
  for (const flag of [
    '1', 'connectors-claude', 'connectors-claude-shown',
    'connectors-chatgpt', 'connectors-unknown', 'connectors-spent',
  ]) {
    assert.ok(demoConnectorState(flag), `?demo=${flag} resolves`);
  }
  assert.equal(demoConnectorState('nonsense'), null, 'anything else is not a fixture');
  assert.equal(demoConnectorState(undefined), null);
});

test('nothing connected shows all three cases', async () => {
  // The panel is advice, not a report on state: a user reading it before
  // connecting anything has no client name to classify, so every case is up.
  const { Settings, nodes } = harness({ connectors: [], hint: null });
  await Settings._loadConnectors();
  assert.deepEqual(cases(nodes), { local: true, web: true, chat: true });
});

test('a Claude connection keeps both Claude Code cases up', async () => {
  // "Claude" does not distinguish claude.ai chat from Claude Code — both
  // arrive as some spelling of it — so hiding the Claude Code cases on that
  // name would hide the fix from the surface that needs it most.
  const nodes = await render('connectors-claude');
  assert.deepEqual(cases(nodes), { local: true, web: true, chat: true });
});

test('an unrecognised client name shows everything rather than nothing', async () => {
  // The client name is chosen by whoever registered the connector. It only
  // ever decides what to SHOW, and falls open.
  const nodes = await render('connectors-unknown');
  assert.deepEqual(cases(nodes), { local: true, web: true, chat: true });
});

test('a ChatGPT-only connection hides the Claude Code cases and the status line', async () => {
  const nodes = await render('connectors-chatgpt');
  assert.deepEqual(cases(nodes), { local: false, web: false, chat: true },
    'the settings.json blocks are advice about a file ChatGPT does not read');
  // And NO status line. The tip is suppressed for this family
  // (hintSuppressedForClient in services/mcp-tools.js), so "not shown yet"
  // would read as a promise that one is coming and a count would report a
  // budget that can never be spent. The fixture omits `hint` entirely for
  // the same reason — a zeroed status is still a status.
  assert.equal(hintLine(nodes), null);
  assert.equal(demoConnectorState('connectors-chatgpt').hint, undefined,
    'the ChatGPT fixture carries no hint status at all');
});

test('a tip that has never been shown says so, and says what arms it', async () => {
  const nodes = await render('connectors-claude');
  const text = hintLine(nodes);
  assert.match(text, /has not sent you this tip in chat yet/);
  // The reset is "open a new chat", because that is what sends `initialize`.
  assert.match(text, /new conversation/);
});

test('a tip shown recently reports the count, the window and when', async () => {
  const nodes = await render('connectors-claude-shown');
  const text = hintLine(nodes);
  assert.match(text, /sent you this tip in chat once in the last 7 days/);
  assert.match(text, /most recently /);
  assert.match(text, /Open a new conversation to see it again\./,
    'budget left, so the line says how to see it again');
  assert.doesNotMatch(text, /limit of/);
});

test('a spent weekly budget says it will come back, not that it is over', async () => {
  const nodes = await render('connectors-spent');
  const text = hintLine(nodes);
  assert.match(text, /3 times in the last 7 days/);
  assert.match(text, /limit of 3 per connection per 7 days/);
  assert.match(text, /it will come back once the window rolls over\./,
    'a rolling window, not the lifetime cap this replaced');
});

test('the status line is read-only — there is no control that writes throttle state', () => {
  // The load-bearing absence. A "show it again" button is a button for
  // making the connector nag, and the throttle it would write is the same
  // one that keeps an armed hint from becoming one.
  // Checked against the MARKUP with its prose stripped: the comment above
  // the line names the button it is explaining the absence of, and reading
  // that as the button itself would be exactly backwards.
  const markup = CONNECTORS_TSX.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(markup, /connector-hint-reset|show it again|reset/i);
  assert.doesNotMatch(SETTINGS_SOURCE, /_resetConnectorHint|hint\/reset/);
  // Renders empty and hidden: filling it server-side would mismatch
  // hydration, and a console error on any route fails proposal checks.
  assert.match(
    CONNECTORS_TSX,
    /<p id="connector-hint-status" className="hidden[^"]*"><\/p>/,
    'the initial render emits the empty, hidden markup the shell shipped'
  );
});
