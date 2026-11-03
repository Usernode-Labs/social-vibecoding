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
const { englishPlatformI18n } = require('./lib/platform-i18n');

// The ids the panel drives. Every one is in the rendered markup and in
// tests/baselines/shell-markup.json; a rename that misses one of the three
// files shows up here as a case that stopped being reachable.
const PANEL_IDS = [
  'connectors-section', 'connectors-list', 'connectors-status', 'connector-url',
  'connector-case-cc-local', 'connector-case-cc-web', 'connector-case-chat',
  'connector-hint-status', 'connector-url-test', 'connector-test-status',
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

function harness(payload, options = {}) {
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
    fetch: options.fetch || (async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      headers: { get: () => null },
    })),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    // settings.js reads its text through this global; the real English catalog.
    PlatformI18n: englishPlatformI18n(),
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

// ── #6135: Test connection ─────────────────────────────────────────────
//
// The button reads one route and paints one line. These drive the real
// _testConnector against the real English catalog, with fetch stubbed at the
// network boundary only.

const { message } = require('./lib/platform-i18n');
const { demoConnectionTest } = require('../src/routes/mcp-remote');

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
  };
}

function testHarness(fetchImpl) {
  const { Settings, nodes } = harness(null, { fetch: fetchImpl });
  return { Settings, nodes };
}

const statusLine = (nodes) => nodes.get('connector-test-status');
const shown = (nodes) => !statusLine(nodes).hidden();
const errorInk = (nodes) => statusLine(nodes).classList.contains('text-red-700');

test('a passing test names the product and when it was last used', async () => {
  const fixture = demoConnectionTest('1');
  const { Settings, nodes } = testHarness(async () => response(fixture));
  await Settings._testConnector();

  const lastUsed = new Date(fixture.connection.last_used_at).toLocaleString();
  assert.equal(
    statusLine(nodes).textContent,
    message('settings:connectors.test.result.okUsed', {
      product: fixture.connection.client_name,
      lastUsed,
    }),
    'the line names the product and its last use, in the Connected list date format'
  );
  assert.ok(shown(nodes), 'a result is revealed');
  assert.equal(errorInk(nodes), false, 'a passing result is ordinary text');
  assert.equal(nodes.get('connector-url-test').disabled, false, 'the button can be pressed again');
});

test('a passing test with no last use omits the date', async () => {
  const fixture = demoConnectionTest('1');
  fixture.connection.last_used_at = null;
  const { Settings, nodes } = testHarness(async () => response(fixture));
  await Settings._testConnector();

  assert.equal(
    statusLine(nodes).textContent,
    message('settings:connectors.test.result.ok', {
      product: fixture.connection.client_name,
    })
  );
  assert.equal(errorInk(nodes), false);
});

test('a working server with nothing connected is a failure-looking line with its next step', async () => {
  const { Settings, nodes } = testHarness(async () => response(demoConnectionTest('connectors-test-none')));
  await Settings._testConnector();

  assert.equal(statusLine(nodes).textContent, message('settings:connectors.test.result.not_connected'));
  assert.ok(shown(nodes));
  assert.equal(errorInk(nodes), true, 'failures take the error ink');
});

test('a 404 from the surface gate is "not available here"', async () => {
  const { Settings, nodes } = testHarness(async () => response({ error: 'not_found' }, { status: 404 }));
  await Settings._testConnector();

  assert.equal(statusLine(nodes).textContent, message('settings:connectors.test.result.unavailable_here'));
  assert.equal(errorInk(nodes), true);
});

test('a server error is a test that could not run', async () => {
  const { Settings, nodes } = testHarness(async () => response({ error: 'temporarily_unavailable' }, { status: 503 }));
  await Settings._testConnector();
  assert.equal(statusLine(nodes).textContent, message('settings:connectors.test.result.test_failed'));
});

test('an unknown leg is settled by the page, against its own origin', async () => {
  // The deployment could not hairpin to its public origin, so the server
  // said 'unknown' for discovery. The page fetches the two metadata
  // documents itself and recomputes the same code.
  const origin = 'https://social-vibecoding.usernodelabs.org';
  const calls = [];
  const fixture = {
    code: 'ok',
    enabled: true,
    discovery: 'unknown',
    mcp: 'ok',
    connection: { active: 1, inactive: 0, client_name: 'Claude.ai', last_used_at: null },
    checked_at: new Date().toISOString(),
  };
  const { Settings, nodes } = testHarness(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).indexOf('/api/me/connectors/test') === 0) return response(fixture);
    if (String(url) === `${origin}/.well-known/oauth-protected-resource/mcp`) {
      return response({ resource: `${origin}/mcp` });
    }
    if (String(url) === `${origin}/.well-known/oauth-authorization-server`) {
      return response({ issuer: origin });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  await Settings._testConnector();

  const urls = calls.map((call) => call.url);
  assert.ok(urls.includes(`${origin}/.well-known/oauth-protected-resource/mcp`));
  assert.ok(urls.includes(`${origin}/.well-known/oauth-authorization-server`));
  assert.equal(
    statusLine(nodes).textContent,
    message('settings:connectors.test.result.ok', { product: 'Claude.ai' }),
    'the settled leg recomputes the passing code'
  );
});

test('a browser fallback that cannot reach the network is test_failed', async () => {
  const fixture = {
    code: 'ok',
    enabled: true,
    discovery: 'unknown',
    mcp: 'ok',
    connection: { active: 1, inactive: 0, client_name: 'Claude.ai', last_used_at: null },
    checked_at: new Date().toISOString(),
  };
  const { Settings, nodes } = testHarness(async (url) => {
    if (String(url).indexOf('/api/me/connectors/test') === 0) return response(fixture);
    throw new TypeError('Failed to fetch');
  });
  await Settings._testConnector();
  assert.equal(statusLine(nodes).textContent, message('settings:connectors.test.result.test_failed'));
  assert.equal(errorInk(nodes), true);
});

test('the browser fallback probes /mcp without a credential', async () => {
  const origin = 'https://social-vibecoding.usernodelabs.org';
  let mcpInit = null;
  const fixture = {
    code: 'ok',
    enabled: true,
    discovery: 'ok',
    mcp: 'unknown',
    connection: { active: 1, inactive: 0, client_name: 'Claude.ai', last_used_at: null },
    checked_at: new Date().toISOString(),
  };
  const { Settings, nodes } = testHarness(async (url, init = {}) => {
    if (String(url).indexOf('/api/me/connectors/test') === 0) return response(fixture);
    if (String(url) === `${origin}/mcp`) {
      mcpInit = init;
      return response({}, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/mcp"' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  await Settings._testConnector();

  assert.ok(mcpInit, 'the MCP leg was probed');
  assert.equal(mcpInit.method, 'POST');
  assert.equal(mcpInit.body, '{}');
  assert.equal(
    (mcpInit.headers || {}).authorization,
    undefined,
    'no Authorization header: the 401 challenge is the reachable result'
  );
  assert.equal(
    statusLine(nodes).textContent,
    message('settings:connectors.test.result.ok', { product: 'Claude.ai' })
  );
});

test('a stale answer cannot overwrite a newer test', async () => {
  const first = demoConnectionTest('connectors-test-none');
  const second = demoConnectionTest('1');
  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });
  let calls = 0;
  const { Settings, nodes } = testHarness(async () => {
    calls += 1;
    if (calls === 1) { await gate; return response(first); }
    return response(second);
  });

  const slow = Settings._testConnector();
  await Settings._testConnector();
  resolveFirst();
  await slow;

  assert.match(statusLine(nodes).textContent, /^Working:/,
    'the newer passing result stands');
});
