'use strict';

// The agent-session screen (#2779 step 4, docs/agent-sessions.md).
//
// What the user sees in a conversation with the Mayor is decided in one pure
// module, features/agent-session/transcript.ts, so the rules are pinned here
// rather than in a browser:
//
//   1. A CARD SHOWS EXACTLY WHAT IT WILL RUN. Its rows are its input, labelled,
//      and an input it cannot label is still shown rather than dropped.
//   2. A CARD PAST ITS EXPIRY IS EXPIRED even when the server has not swept it
//      yet: a Confirm that the server will refuse is not offered.
//   3. ONE OUTCOME, SAID ONCE. The action_result / action_dismissed note is
//      written for the Mayor (which reads text); under a card the transcript
//      draws, the card's own outcome line says it, so the note is skipped.
//   4. EACH WRITER MAPS TO ONE KIND: conversation events are dividers, the
//      coding agent's completion is an agent item, a live preview is a
//      preview item, anything else is a quiet note.
//   5. REPLY SUGGESTIONS BELONG TO THE LAST THING SAID, and only while it is
//      last.
//
// The inbox half: an agent session is an agent conversation, listed under
// Agents on the one clock, never under People.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
const inbox = loadTsx('frontend/src/features/messages/inbox.ts');

const NOW = Date.parse('2026-09-01T12:00:00Z');
const LATER = '2026-09-01T13:00:00Z';
const EARLIER = '2026-09-01T11:00:00Z';

const card = (over = {}) => ({
  id: 'a1',
  toolName: 'promote_change',
  title: 'Put the change up for the group vote',
  input: { changeId: 12, title: 'Dark mode', linkedIssues: [4, 7] },
  expiresAt: LATER,
  ...over,
});
const row = (id, role, content, metadata = {}, changeId = null) => ({
  id, role, content, metadata, changeId, createdAt: null,
});

test('a card lists exactly the input it will run with, labelled', () => {
  assert.deepEqual(
    transcript.cardRows({ slug: 'notes', changeId: 12, linkedIssues: [4, 7], body: '  two\n lines ', empty: '', none: null }),
    [['App', 'notes'], ['Change', '#12'], ['Links', 'Request #4, Request #7'], ['Details', 'two lines']],
  );
  // A key with no label of its own is still shown, humanised, never dropped.
  assert.deepEqual(transcript.cardRows({ baseBranch: 'main', dry_run: true }), [['Base Branch', 'main'], ['Dry run', 'true']]);
  // Long values are clipped for the card; the server holds the full input.
  const [[, long]] = transcript.cardRows({ body: 'x'.repeat(500) });
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('…'));
});

test('a pending card past its expiry is drawn expired; a decided one keeps its state and says its outcome', () => {
  const none = new Map();
  assert.equal(transcript.cardView(card(), none, NOW).status, 'pending');
  assert.equal(transcript.cardView(card({ expiresAt: EARLIER }), none, NOW).status, 'expired');

  const done = new Map([['a1', {
    id: 'a1', toolName: 'promote_change', title: '', status: 'done', expiresAt: EARLIER,
    result: { ok: true, text: 'raw', structured: { nextStep: 'The vote is open.' } },
  }]]);
  const view = transcript.cardView(card({ expiresAt: EARLIER }), done, NOW);
  assert.equal(view.status, 'done', 'a decided card is not re-labelled expired');
  assert.equal(view.outcome, 'The vote is open.');
});

test('the transcript maps each writer to one kind, and says a card outcome once', () => {
  const items = transcript.buildTranscript([
    row(1, 'user', 'Add dark mode to notes'),
    row(2, 'system', 'Started change #12', { agentSessionEvent: 'change_started' }, 12),
    row(3, 'assistant', 'Here is the plan.', { confirmations: [card()], quickReplies: ['Go ahead', ' '] }),
    row(4, 'system', 'Confirmed: Put the change up', { agentSessionEvent: 'action_result', actionId: 'a1', ok: true }),
    row(5, 'system', 'Confirmed elsewhere', { agentSessionEvent: 'action_result', actionId: 'zz', ok: false }),
    row(6, 'system', 'Built it', { ccOutput: 'Added a toggle.', ccOutcome: 'no_changes' }, 12),
    row(7, 'system', 'Preview is live', { stagingUrl: 'https://pr-9.example.test', prNumber: 9 }, 12),
    row(8, 'system', 'Preview (not a link)', { stagingUrl: 'javascript:alert(1)' }, 12),
    row(9, 'system', 'The turn failed', { agentSessionEvent: 'turn_failed' }),
    row(10, 'system', '   '),
  ], [], NOW);

  assert.deepEqual(items.map((i) => i.kind), ['user', 'divider', 'mayor', 'note', 'agent', 'preview', 'note', 'note']);
  const [, divider, mayor, foreign, agent, preview, unsafe, failed] = items;
  assert.equal(divider.event, 'change_started');
  assert.deepEqual(mayor.quickReplies, ['Go ahead'], 'a blank suggestion is not a button');
  assert.equal(mayor.cards.length, 1);
  assert.ok(!items.some((i) => i.key === 'm4'), "the drawn card's own outcome note is not repeated under it");
  assert.equal(foreign.tone, 'error', 'an outcome for a card this transcript does not draw is still said');
  assert.equal(agent.outcome, 'no_changes');
  assert.equal(agent.changeId, 12);
  assert.equal(preview.url, 'https://pr-9.example.test');
  assert.equal(preview.prNumber, 9);
  assert.equal(unsafe.kind, 'note', 'only an http(s) preview URL becomes a link');
  assert.equal(failed.tone, 'error');
});

test('reply suggestions belong to the last thing said, and only while it is last', () => {
  const said = transcript.buildTranscript([row(1, 'assistant', 'Which app?', { quickReplies: ['Notes', 'Recipes'] })]);
  assert.deepEqual(transcript.latestReplies(said), ['Notes', 'Recipes']);
  const answered = transcript.buildTranscript([
    row(1, 'assistant', 'Which app?', { quickReplies: ['Notes', 'Recipes'] }),
    row(2, 'user', 'Notes'),
  ]);
  assert.deepEqual(transcript.latestReplies(answered), []);
});

test('the header pill and the live line say where things stand in words', () => {
  assert.equal(transcript.changeStatusLabel('active'), 'In progress');
  assert.equal(transcript.changeStatusLabel('paused'), 'Parked');
  assert.equal(transcript.changeStatusLabel('promoted'), 'In vote');
  assert.equal(transcript.changeStatusLabel(null), 'No active change');
  assert.equal(transcript.changeStatusLabel('active', true), 'Building');
  assert.equal(transcript.toolActivity('dispatch_coding_agent'), 'The coding agent is building');
  // A write tool the list does not name is one that ends in a card.
  assert.equal(transcript.toolActivity('start_change'), 'Preparing a confirmation');
});

test('an agent session is an agent conversation in the inbox: under Agents on the one clock, never under People', () => {
  const base = {
    conversations: [{ id: 1, lastActivityAt: '2026-09-01T10:00:00Z' }],
    discussions: [],
    agents: [],
    sessions: [{ key: 's1', lastActivityAt: '2026-09-01T09:00:00Z' }],
    mayors: [{ id: 7, lastActivityAt: '2026-09-01T11:00:00Z' }, { id: 8, lastActivityAt: null }],
  };
  const all = inbox.buildInbox({ ...base, filter: 'all' });
  assert.deepEqual(all.map((e) => e.key), ['mayor:7', 'person:1', 'session:s1', 'mayor:8']);
  assert.ok(all.filter((e) => e.kind === 'mayor').every((e) => e.section === 'chats'));
  assert.deepEqual(inbox.buildInbox({ ...base, filter: 'agents' }).map((e) => e.key), ['mayor:7', 'session:s1', 'mayor:8']);
  assert.deepEqual(inbox.buildInbox({ ...base, filter: 'people' }).map((e) => e.key), ['person:1']);
  assert.equal(inbox.admits('channels', 'mayor'), false);
});

test('the screen is reachable by address, on a phone and in the desktop Messages pane', () => {
  const app = read('public/js/app.js');
  const messages = read('frontend/src/features/messages/store.ts');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="AgentSessionScreen"/);
  assert.match(app, /'agent-session-screen'/);
  assert.match(app, /navigateToAgentSession\(/);
  assert.match(messages, /kind === 'agent'/);
  // The address the store hands out is the Messages one; app.js swaps it
  // for the full screen on a phone.
  assert.match(read('frontend/src/features/agent-session/store.ts'), /#messages\/agent\/\$\{id\}/);
});

test('New change opens an UNSENT conversation: nothing is created, in the side panel beside a running app or by address elsewhere', async () => {
  // The panel's own rules (an app on its App tab, a desktop-width window, the
  // top document) are tests/side-panel.test.js's; here the store only has to
  // ASK it first, with the hint riding along, and navigate as it always has
  // when it declines.
  const taken = [];
  let accept = true;
  const win = {
    location: { hash: '' },
    UsernodeReact: { sidePanel: { take: (route, hint) => { taken.push([route, hint]); return accept; } } },
    App: {},
    PlatformUI: { toast: () => {} },
  };
  const requests = [];
  globalThis.window = win;
  globalThis.fetch = async (url, init) => {
    requests.push([url, init && init.method]);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    store.startAgentSession({ slug: 'notes-ab12', entry: 'improve' });
    assert.deepEqual(requests, [], 'opening New change writes nothing');
    assert.deepEqual(taken, [['messages/agent/new', { agentHint: { slug: 'notes-ab12', entry: 'improve' } }]],
      'the panel is asked first, and the hint rides into its document');
    assert.equal(win.location.hash, '', 'and the top window stays on the running app');

    accept = false;
    store.startAgentSession({ slug: 'notes-ab12', entry: 'improve' });
    assert.equal(win.location.hash, '#messages/agent/new', 'declined: the unsent address is followed as before');
    assert.deepEqual(requests, []);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test('the first message creates the session with the hint and the model picked meanwhile, then takes its address in place', async () => {
  const replaced = [];
  let restored = 0;
  const win = {
    location: { hash: '#agent/new' },
    history: { state: null, replaceState: (_state, _unused, url) => { replaced.push(url); win.location.hash = url; } },
    App: { restoreFromHash: () => { restored += 1; }, setHeaderTitle: () => {} },
    UsernodeReact: {},
    PlatformUI: { toast: () => {} },
  };
  const session = {
    id: 7, title: null, status: 'open', focusApp: { id: 3, slug: 'notes-ab12', name: 'Notes' }, focusContext: { entry: 'improve' },
    agent: { backend: 'claude_code', model: 'claude-fable-5-1', reasoningEffort: null },
    activeChange: null, busy: false, lastActivityAt: null, createdAt: null,
  };
  const requests = [];
  globalThis.window = win;
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = async (url, init = {}) => {
    requests.push([url, init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
    const body = url.startsWith('/api/agent-sessions/draft')
      ? { draft: { focusApp: session.focusApp, focusContext: { entry: 'improve' } } }
      : url === '/api/agent-sessions' ? { session }
        : /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
          : /\/actions$/.test(url) ? { actions: [] }
            : { session, turn: null };
    return { ok: true, status: 200, body: null, json: async () => body };
  };
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    store.prepareAgentDraft({ slug: 'notes-ab12', entry: 'improve' });
    await store.openAgentSession({ id: 'new', host: 'screen' });
    await new Promise((resolve) => setImmediate(resolve));
    let state = store.getAgentSessionState();
    assert.equal(state.id, null);
    assert.deepEqual(state.draft.focusApp, session.focusApp, 'what it is about is previewed, not saved');
    assert.deepEqual(requests.map(([url, method]) => [url, method]), [['/api/agent-sessions/draft?slug=notes-ab12&entry=improve', 'GET']]);
    assert.equal(store.agentSessionController.currentId(), 'new');

    await store.chooseAgent({ backend: 'claude_code', model: 'claude-fable-5-1', reasoningEffort: null });
    assert.equal(requests.length, 1, 'a pick on an unsent conversation is held, not sent');

    await store.sendAgentMessage('Add dark mode');
    const create = requests.find(([url, method]) => url === '/api/agent-sessions' && method === 'POST');
    assert.deepEqual(create[2], {
      hint: { slug: 'notes-ab12', entry: 'improve' },
      agent: { backend: 'claude_code', model: 'claude-fable-5-1', reasoningEffort: null },
    });
    const turn = requests.findIndex(([url]) => url === '/api/agent-sessions/7/turns');
    assert.ok(turn > requests.indexOf(create), 'created first, then the message is posted to it');
    assert.deepEqual(requests[turn][2], { message: 'Add dark mode' });
    assert.deepEqual(replaced, ['#agent/7'], 'the unsent address becomes the session\'s own, in place');
    assert.equal(restored, 1, 'and the router hears it');
    state = store.getAgentSessionState();
    assert.equal(state.id, 7);
    assert.equal(state.draft, null);
    assert.equal(store.agentSessionController.currentId(), 7);

    // Routed again by that address, the store keeps what it has: the same
    // conversation, not a reload that would drop a turn in flight.
    const before = requests.length;
    await store.openAgentSession({ id: 7, host: 'screen' });
    assert.equal(requests.length, before);

    // New change again from here starts a fresh unsent conversation, even
    // where the address it goes to does not change.
    win.location.hash = '#messages/agent/new';
    await store.openAgentSession({ id: 'new', host: 'messages' });
    store.startAgentSession({ slug: 'recipes-cd34', entry: 'messages' });
    assert.deepEqual(store.getAgentSessionState().draft.hint, { slug: 'recipes-cd34', entry: 'messages' });
    await store.openAgentSession({ id: 7, host: 'screen' });

    // On a session, a pick is saved at once and applies from the next turn.
    await store.chooseAgent({ backend: 'claude_code', model: 'claude-sonnet-5', reasoningEffort: null });
    const patch = requests.find(([url, method]) => url === '/api/agent-sessions/7/agent' && method === 'PATCH');
    assert.deepEqual(patch[2], { backend: 'claude_code', model: 'claude-sonnet-5', reasoningEffort: null });
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('a message the server refuses goes back to the composer instead of vanishing', async () => {
  const session = { id: 7, title: null, status: 'open', focusApp: null, focusContext: {}, agent: null, activeChange: null, busy: false, lastActivityAt: null, createdAt: null };
  globalThis.window = { location: { hash: '#agent/7' }, App: {}, UsernodeReact: {}, PlatformUI: { toast: () => {} } };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = async (url) => {
    if (/\/turns$/.test(url)) return { ok: false, status: 503, json: async () => ({ error: 'LLM not configured' }) };
    const body = /\/messages\?/.test(url) ? { messages: [], nextAfter: null } : /\/actions$/.test(url) ? { actions: [] } : { session, turn: null };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    await store.openAgentSession({ id: 7, host: 'screen' });
    await store.sendAgentMessage('Add dark mode');
    const state = store.getAgentSessionState();
    assert.equal(state.error, 'LLM not configured');
    assert.equal(state.returnedText, 'Add dark mode');
    assert.equal(state.turn.running, false);
    store.clearReturnedText();
    assert.equal(store.getAgentSessionState().returnedText, null);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('the picker offers the platform\'s models, keeps the conversation\'s own, and carries reasoning only where offered', () => {
  const choice = loadTsx('frontend/src/features/agent-session/model-choice.ts');
  const catalog = {
    anthropic: [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' }],
    anthropicDefault: 'claude-opus-5-5',
    defaultBackend: 'claude_code',
    savedOpenRouter: { model: 'moonshot/kimi-k3', reasoningEffort: 'low' },
    defaultReasoningEffort: 'medium',
    codexAvailable: true,
    openrouter: [
      { id: 'z-ai/glm-5', name: 'GLM 5', isRecommended: true, supportsReasoning: true },
      { id: 'moonshot/kimi-k3', name: 'Kimi K3', supportsReasoning: true },
      { id: 'plain/model', name: 'Plain', supportsReasoning: false, isFavorite: true },
      { id: 'other/model', name: 'Other' },
    ],
    recommendedOpenRouterId: 'z-ai/glm-5',
  };
  assert.deepEqual(choice.pickerOptions(catalog, null).map((o) => o.value), [
    'openrouter:z-ai/glm-5', 'anthropic:claude-sonnet-5', 'anthropic:claude-opus-5-5',
    'openrouter:moonshot/kimi-k3', 'openrouter:plain/model',
  ], 'recommended first, then Claude, then what this account uses; not the whole catalog');
  assert.ok(choice.pickerOptions(catalog, { backend: 'codex_openrouter', model: 'gone/model', reasoningEffort: null })
    .some((o) => o.value === 'openrouter:gone/model'), 'the conversation\'s own model is always an option');
  assert.deepEqual(choice.pickerOptions({ ...catalog, codexAvailable: false }, null).map((o) => o.value),
    ['anthropic:claude-sonnet-5', 'anthropic:claude-opus-5-5'], 'no OpenRouter where it is not offered');

  // No choice of its own: the default, as the server resolves it.
  assert.deepEqual(choice.effectiveChoice(null, catalog), { backend: 'claude_code', model: 'claude-opus-5-5', reasoningEffort: null });
  assert.deepEqual(choice.effectiveChoice(null, { ...catalog, defaultBackend: 'codex_openrouter' }),
    { backend: 'codex_openrouter', model: 'moonshot/kimi-k3', reasoningEffort: 'low' });
  assert.deepEqual(choice.effectiveChoice({ backend: 'claude_code', model: null, reasoningEffort: null }, catalog).model, 'claude-opus-5-5');

  const onKimi = { backend: 'codex_openrouter', model: 'moonshot/kimi-k3', reasoningEffort: 'high' };
  assert.deepEqual(choice.choiceFromValue('openrouter:z-ai/glm-5', catalog, onKimi),
    { backend: 'codex_openrouter', model: 'z-ai/glm-5', reasoningEffort: 'high' }, 'the effort carries to a model that offers one');
  assert.deepEqual(choice.choiceFromValue('openrouter:plain/model', catalog, onKimi),
    { backend: 'codex_openrouter', model: 'plain/model', reasoningEffort: null }, 'and is dropped where it is not');
  assert.deepEqual(choice.choiceFromValue('anthropic:claude-sonnet-5', catalog, onKimi),
    { backend: 'claude_code', model: 'claude-sonnet-5', reasoningEffort: null });
  assert.equal(choice.choiceFromValue('bogus', catalog, null), null);
  assert.equal(choice.offersReasoning(onKimi, catalog), true);
  assert.equal(choice.offersReasoning({ backend: 'claude_code', model: 'claude-sonnet-5', reasoningEffort: null }, catalog), false);
  assert.equal(choice.effortOptions(catalog)[0].label, 'Default (Medium)');
  assert.deepEqual(choice.effortOptions(catalog).slice(1).map((o) => o.value), ['minimal', 'low', 'medium', 'high', 'xhigh'],
    'the server\'s own effort list');
});

test('the unsent address is routed on every surface', () => {
  const app = read('public/js/app.js');
  assert.match(app, /if \(id === 'new'\) return \{ kind: 'agent', id: 'new' \};/, '#messages/agent/new is an agent session, not a chat');
  assert.match(app, /if \(parts\[1\] === 'new'\) \{\s*App\.navigateToAgentSession\('new'\);/);
  const messages = loadTsx('frontend/src/features/messages/store.ts');
  assert.deepEqual(messages.validAgentThread({ kind: 'agent', id: 'new' }), { kind: 'agent', id: 'new' });
  assert.equal(messages.fullScreenAddress({ kind: 'agent', id: 'new' }), '#agent/new');
  // Leaving the pane deactivates only the conversation it still shows: the
  // unsent one becomes its session under the pane, and is not torn down.
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /const same = id === 'new' \? current\.id === null : current\.id === id;/);
});
