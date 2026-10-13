// The agent chat's model pill waits for the model catalog, which the composer
// reads once per page (frontend/src/features/agent-session/store.ts
// loadModelCatalog). Its reads had no deadline and it was never read again:
// one request that stalled (a phone app resuming on a radio still waking up)
// held the catalog, and with it the model pill, for the rest of the page,
// while the credits pill beside it (a different read) still showed. A read
// that failed outright left a catalog that was missing that part for good.
//
// Each read now has a deadline, whatever answered is published so the pill
// appears, and a part that did not answer is read again, alone, on the next
// call, which comes when a conversation is opened or routed to, when the page
// comes back to the foreground and when the network returns.
//
// Run with: node --test tests/agent-session-model-catalog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const LIST = '/api/me/coding-agent/models?backend=codex_openrouter';

const BODIES = {
  '/api/models': { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }], default: 'claude-opus-5-5' },
  '/api/me/coding-agent': {
    defaultBackend: 'codex_openrouter',
    backends: { codex_openrouter: { model: 'z-ai/glm-5.3-flash', reasoningEffort: null } },
    codexAvailable: true,
    defaultReasoningEffort: 'xhigh',
  },
  '/api/model-notes': { typicalChange: { inputTokens: 1, outputTokens: 1 }, models: {} },
  [LIST]: {
    recommendedModelId: 'z-ai/glm-5.3-flash',
    models: [{ id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', isRecommended: true, supportsReasoning: true }],
  },
};

// `answer(url, attempt)` decides each request: 'ok', 'stall' (never
// settles), 'fail' (a network error) or 'error' (an HTTP 500).
function world(answer) {
  const doc = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.window = {
    App: { user: { id: 1, username: 'ada', hasPlatformAccess: true } },
    UsernodeReact: {},
    location: { hash: '' },
    PlatformUI: { toast: () => {} },
  };
  globalThis.document = doc;
  const requests = [];
  const attempts = {};
  globalThis.fetch = (url) => {
    const key = String(url);
    requests.push(key);
    attempts[key] = (attempts[key] || 0) + 1;
    const how = answer(key, attempts[key]);
    if (how === 'stall') return new Promise(() => {});
    if (how === 'fail') return Promise.reject(new TypeError('Load failed'));
    if (how === 'error') return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => BODIES[key] });
  };
  return { requests };
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.fetch;
}

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function load() {
  return {
    store: loadTsx('frontend/src/features/agent-session/store.ts'),
    choice: loadTsx('frontend/src/features/agent-session/model-choice.ts'),
  };
}

// What the composer's pill needs (index.tsx useModelChoice: `ready`).
function pill({ choice }, catalog) {
  const current = choice.effectiveChoice(null, catalog);
  const options = choice.pickerOptions(catalog, current);
  const selected = options.find((option) => option.value === choice.choiceValue(current));
  return { ready: !!(options.length && current), label: selected ? selected.label : null };
}

test('a read that never settles no longer holds the model pill for the rest of the page', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world((url, attempt) => (url === LIST && attempt === 1 ? 'stall' : 'ok'));
  try {
    const mods = load();
    const first = mods.store.loadModelCatalog();
    await settle();
    assert.equal(mods.store.getAgentSessionState().catalog, null, 'still waiting on the list');
    t.mock.timers.tick(30_000);
    await first;
    const partial = mods.store.getAgentSessionState().catalog;
    assert.ok(partial, 'what answered is published once the list runs out of time');
    assert.equal(partial.defaultBackend, 'codex_openrouter');
    assert.deepEqual(partial.openrouter, []);
    assert.deepEqual(pill(mods, partial), { ready: true, label: 'z-ai/glm-5.3-flash' },
      'the pill shows, on the saved model, before the list has answered');

    // The next call (a conversation opening, the page returning to the
    // foreground, the network coming back) reads the list alone.
    w.requests.length = 0;
    await mods.store.loadModelCatalog();
    assert.deepEqual(w.requests, [LIST]);
    const full = mods.store.getAgentSessionState().catalog;
    assert.equal(full.openrouter.length, 1);
    assert.deepEqual(pill(mods, full), { ready: true, label: 'Z.ai: GLM 5.3 Flash' });
    assert.equal(full.anthropicDefault, 'claude-opus-5-5', 'what answered the first time is kept');

    // Complete: nothing is read again.
    w.requests.length = 0;
    await mods.store.loadModelCatalog();
    assert.deepEqual(w.requests, []);
  } finally { cleanup(); }
});

test('a stalled base read is also bounded, and a later call reads it and the list it gates', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world((url, attempt) => (url === '/api/me/coding-agent' && attempt === 1 ? 'stall' : 'ok'));
  try {
    const mods = load();
    const first = mods.store.loadModelCatalog();
    await settle();
    t.mock.timers.tick(10_000);
    await first;
    const partial = mods.store.getAgentSessionState().catalog;
    assert.ok(partial);
    assert.ok(!w.requests.includes(LIST), 'the list waits for the preferences that say OpenRouter is offered');
    assert.deepEqual(pill(mods, partial), { ready: true, label: 'Opus 5.5' });

    w.requests.length = 0;
    await mods.store.loadModelCatalog();
    assert.deepEqual(w.requests, ['/api/me/coding-agent', LIST]);
    assert.deepEqual(pill(mods, mods.store.getAgentSessionState().catalog), { ready: true, label: 'Z.ai: GLM 5.3 Flash' });
  } finally { cleanup(); }
});

test('a failed or refused read keeps what did answer and is the only one asked again', async () => {
  const w = world((url, attempt) => {
    if (attempt > 1) return 'ok';
    if (url === '/api/models') return 'fail';
    if (url === '/api/model-notes') return 'error';
    return 'ok';
  });
  try {
    const mods = load();
    await mods.store.loadModelCatalog();
    const partial = mods.store.getAgentSessionState().catalog;
    assert.deepEqual(partial.anthropic, []);
    assert.equal(partial.notes, null);
    assert.equal(partial.openrouter.length, 1);
    assert.deepEqual(pill(mods, partial), { ready: true, label: 'Z.ai: GLM 5.3 Flash' });

    w.requests.length = 0;
    await mods.store.loadModelCatalog();
    assert.deepEqual(w.requests.slice().sort(), ['/api/model-notes', '/api/models']);
    const full = mods.store.getAgentSessionState().catalog;
    assert.equal(full.anthropic.length, 1);
    assert.ok(full.notes);
    assert.equal(full.openrouter.length, 1, 'the list that answered the first time is kept');
  } finally { cleanup(); }
});

test('it is asked again when a conversation is routed to, on the foreground and on the network', () => {
  // Opening a conversation, or routing back to the one already open (Home,
  // then Back), goes through openAgentSession; the composer stays mounted
  // across that, so its own mount effect would not run again.
  const store = read('frontend/src/features/agent-session/store.ts');
  const open = store.slice(store.indexOf('export async function openAgentSession('));
  assert.match(open.slice(0, open.indexOf("if (id === 'new') return openDraft(host);")), /void loadModelCatalog\(\);/,
    'before anything else, on every route into a conversation');

  const src = read('frontend/src/features/agent-session/index.tsx');
  const hook = src.slice(src.indexOf('function useModelChoice()'), src.indexOf('function useCredit()'));
  assert.match(hook, /useEffect\(\(\) => \{ void loadModelCatalog\(\); \}, \[\]\);/);
  assert.match(hook, /window\.addEventListener\('online', retry\);/);
  assert.match(hook, /document\.addEventListener\('visibilitychange', retry\);/);
  assert.match(hook, /window\.removeEventListener\('online', retry\);/);
  assert.match(hook, /document\.removeEventListener\('visibilitychange', retry\);/);
  assert.match(hook, /document\.visibilityState !== 'hidden'/);
});
