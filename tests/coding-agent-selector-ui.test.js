'use strict';

// Browser contract for the session-pinned Claude/Codex selector. The dialog
// itself is DOM-heavy, so these tests exercise the two consequential seams:
// createSession must send the user's explicit choice, and an existing-session
// change must go through reset-agent-context and update the pinned row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8',
);

function makeHarness() {
  const requests = [];
  const toasts = [];
  let responder = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: {},
    hidden: false,
    visibilityState: 'visible',
  };
  const sandbox = {
    console,
    document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { sendBeacon: () => true },
    EventSource: class { close() {} },
    URL,
    Blob: class {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: async (url, options = {}) => {
      // Ignore the fire-and-forget model-catalog read at module load.
      if (url === '/api/models') return { ok: false, json: async () => ({}) };
      requests.push({ url, options });
      return responder(url, options);
    },
    escapeHtml: (value) => String(value ?? ''),
    PlatformUI: { toast: (message) => toasts.push(message) },
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  return {
    DevChat: sandbox.__DevChat,
    requests,
    toasts,
    respondWith(fn) { responder = fn; },
  };
}

test('OpenRouter model labels show exact rates, cost tier, and advisory compatibility', () => {
  const h = makeHarness();
  const label = h.DevChat._openRouterModelOptionLabel({
    id: 'vendor/model',
    name: 'Model',
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 4,
    costTier: 'medium',
    compatibility: 'experimental',
  });
  assert.equal(label, 'Model — Medium cost · $0.25 /M input · $4 /M output · unverified');

  const limited = h.DevChat._openRouterModelOptionLabel({
    id: 'vendor/limited',
    inputPricePerMillion: 100,
    outputPricePerMillion: null,
    costTier: 'unknown',
    compatibility: 'blocked',
  });
  assert.equal(limited, 'vendor/limited — Price unavailable · $100 /M input · ? /M output · limited');
});

test('new session creation sends the explicit Claude choice', async () => {
  const h = makeHarness();
  h.respondWith(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ session: { id: 41, agent_backend: 'claude_code' } }),
  }));

  const session = await h.DevChat.createSession('demo', undefined, {
    backend: 'claude_code', model: null, reasoningEffort: null,
  });

  assert.equal(session.id, 41);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/apps/demo/sessions');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), {
    backend: 'claude_code', model: null, reasoningEffort: null,
  });
});

test('new session creation sends the exact Codex model and effort with the issue link', async () => {
  const h = makeHarness();
  h.respondWith(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ session: { id: 42, agent_backend: 'codex_openrouter' } }),
  }));

  await h.DevChat.createSession('demo', 287, {
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });

  assert.deepEqual(JSON.parse(h.requests[0].options.body), {
    issueNumber: 287,
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });
});

test('creation asks nothing and sends no backend key', async () => {
  // Creating a session used to open the agent chooser first, so a modal
  // stood between "Propose a change" and a chat — and cancelling it left
  // nothing behind. It asks nothing now: the session is created with the
  // server's own default and the venue line above the composer says which
  // one that was.
  //
  // The three keys must be ABSENT rather than null. A `backend: null` is
  // still an explicit choice in the request body, and the server would
  // have to decide what a null choice means; omitting them leaves the
  // default exactly where it already lives.
  const h = makeHarness();
  let chooserOpened = false;
  h.DevChat._chooseCodingAgent = async () => { chooserOpened = true; return null; };
  h.respondWith(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ session: { id: 43, agent_backend: 'claude_code' } }),
  }));

  const session = await h.DevChat.createSession('demo');

  assert.equal(chooserOpened, false, 'no chooser is opened at creation time');
  assert.equal(session.id, 43);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0].options.body), {});
});

test('switching an idle session uses reset-agent-context and updates its pinned backend', async () => {
  const h = makeHarness();
  const current = {
    id: 51,
    agent_backend: 'claude_code',
    agent_model: null,
    agent_reasoning_effort: null,
  };
  h.DevChat.currentSession = current;
  h.DevChat.sessions = [current];
  h.DevChat.messages = [];
  h.DevChat.renderChatView = () => {};
  h.DevChat._chooseCodingAgent = async () => ({
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'medium',
  });
  h.respondWith(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      session: {
        id: 51,
        agent_backend: 'codex_openrouter',
        agent_model: 'openai/gpt-5.3-codex',
        agent_reasoning_effort: 'medium',
      },
      message: { id: 99, role: 'system', content: 'Coding agent switched.' },
    }),
  }));

  await h.DevChat._switchCurrentCodingAgent();

  assert.equal(h.requests[0].url, '/api/sessions/51/reset-agent-context');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), {
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'medium',
  });
  assert.equal(h.DevChat.currentSession.agent_backend, 'codex_openrouter');
  assert.equal(h.DevChat.messages.at(-1).content, 'Coding agent switched.');
});

test('live progress keeps the exact runtime provider identity', () => {
  const h = makeHarness();
  h.DevChat.messages = [];
  h.DevChat._appendProgressLine('Reading the repository', {
    agentBackend: 'codex_openrouter',
    agentModel: 'openai/gpt-5.3-codex',
  });

  const progress = h.DevChat.messages.at(-1);
  assert.equal(progress.agentBackend, 'codex_openrouter');
  assert.equal(progress.agentModel, 'openai/gpt-5.3-codex');
  assert.equal(h.DevChat._activityAgentName(progress), 'Codex');
  assert.equal(h.DevChat._activityAgentName({}), 'Claude Code');
});
