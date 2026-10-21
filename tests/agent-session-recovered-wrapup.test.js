// A build an agent session dispatched, recovered after a restart, ends with
// the conversation's own wrap-up.
//
// The turn that dispatched the build writes its wrap-up from the build's
// result (mayor/agent-turn.js writeWrapUp). A restart mid-build or
// mid-wrap-up ends that turn with its process; restart recovery finishes the
// change's tail and used to write the CLASSIC recovered wrap-up
// (routes/sessions.js runRecoveredWrapUp): the dev-chat Mayor's prompt, the
// change's slice as history, no wrapUp/dispatch marks, and the change's
// channels only. The conversation's Mayor then read, in its own history, a
// reply that was not its own, and a screen following the conversation was
// not told. Now the recovered wrap-up of a conversation's change is
// written the way the dead turn would have written it, at most once, and
// not at all when the live turn had already written it.
//
// Run with: node --test tests/agent-session-recovered-wrapup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const agentTurn = require('../src/services/mayor/agent-turn');
const dispatch = require('../src/services/mayor/agent-dispatch');
const actions = require('../src/services/agent-session-actions');
const audiences = require('../src/services/mcp-audiences');

const USER = { id: 7, username: 'ada' };
const CONFIG = { dataEncryptionKey: 'test-only-data-key', port: 3000 };
const TURN_ID = '77777777-7777-4777-8777-777777777777';

const SESSION = {
  id: 5, status: 'open', title: 'Dark mode',
  focusApp: { id: 3, slug: 'recipe-box', name: 'Recipe box' }, focusContext: {},
  activeChange: { id: 50, appSlug: 'recipe-box', title: 'Dark mode', status: 'active', prNumber: 12 },
  changes: [],
};

// The conversation as it stands when recovery writes the wrap-up: the
// user's ask, the Mayor's reply that dispatched the build, and the coding
// agent's completion card (written by finalizeRecoveredTurn just before).
const HISTORY_DESC = [
  { id: 13, session_id: 50, role: 'system', content: 'Claude Code finished', metadata: { ccOutput: 'Added a dark-mode toggle.', ccOutcome: 'success' } },
  { id: 12, session_id: 50, role: 'assistant', content: 'Building the toggle now.', metadata: { dispatch: 'build', agentTurnId: 'dead-turn' } },
  { id: 11, session_id: 50, role: 'user', content: 'Add dark mode', metadata: {} },
];

// A pool with the conversation's reads and real turn_effects receipts.
function conversationPool() {
  const calls = [];
  const effects = new Map();
  let nextId = 900;
  const query = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim())) return { rows: [], rowCount: 0 };
    if (/INSERT INTO turn_effects/i.test(text)) {
      const key = `${params[0]}:${params[1]}`;
      if (effects.has(key)) return { rows: [], rowCount: 0 };
      effects.set(key, { state: 'pending', result: params[3] ? JSON.parse(params[3]) : null });
      return { rows: [{ state: 'pending' }], rowCount: 1 };
    }
    if (/SELECT state(, result)? FROM turn_effects/i.test(text)) {
      const row = effects.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE turn_effects/i.test(text)) {
      const row = effects.get(`${params[0]}:${params[1]}`);
      if (!row || row.state !== 'pending') return { rows: [], rowCount: 0 };
      row.state = 'completed';
      row.result = JSON.parse(params[2]);
      return { rows: [{ result: row.result }], rowCount: 1 };
    }
    if (/FROM user_agent_preferences/.test(text)) return { rows: [] };
    if (/SELECT summary_md, summary_through_id FROM agent_sessions/.test(text)) {
      return { rows: [{ summary_md: null, summary_through_id: 0 }] };
    }
    if (/FROM chat_session_messages\s+WHERE agent_session_id = \$1 AND id > \$3/.test(text)) {
      return { rows: HISTORY_DESC.map((r) => ({ ...r })) };
    }
    if (/active_turn->>'id' AS turn_id FROM agent_sessions/.test(text)) return { rows: [{ turn_id: 'dead-turn' }] };
    if (/INSERT INTO chat_session_messages/.test(text) && /RETURNING id/.test(text)) {
      nextId += 1;
      return { rows: [{ id: nextId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { calls, effects, query, async connect() { return { query, release() {} }; } };
}

function scriptedModel(steps) {
  const requests = [];
  return {
    requests,
    isEnabled: () => true,
    estimateCostCents: () => 6,
    async streamChat(args) {
      requests.push(args);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return {
        text: step.text || '',
        toolUses: step.toolUses || [],
        rawContent: [],
        usage: { input_tokens: 100, output_tokens: 20 },
        servedModel: 'claude-opus-5-5',
      };
    },
  };
}

function recoveryDeps(model) {
  const published = [];
  const settled = [];
  const deps = {
    llm: model,
    models: { resolve: (m) => m || 'claude-opus-5-5' },
    limits: {
      resolveBillingPath: async () => ({ apiKey: null }),
      settleTurnSpend: async (_pool, userId, cents, opts) => { settled.push({ userId, cents, ...opts }); },
      recordSpend: async (_pool, userId, cents, opts) => { settled.push({ userId, cents, ...opts, direct: true }); },
      checkBudget: async () => ({}),
    },
    agentSessions: {
      getAgentSession: async (_pool, { userId, id }) => (userId === 7 && id === 5 ? SESSION : null),
      getAgentChoice: async () => null,
    },
    attachments: { loadForHistory: async () => new Map() },
    sessionBus: { publish: (key, event) => published.push([key, event]), subscriberCount: () => 0 },
  };
  return { deps, published, settled };
}

const insertsIn = (pool) => pool.calls.filter((c) => /INSERT INTO chat_session_messages/.test(c.sql));

test('the recovered wrap-up is the conversation\'s: its Mayor, its history, its row, its screen', async () => {
  const model = scriptedModel([{
    text: 'Dark mode is in: there is a toggle in the toolbar.',
    toolUses: [{ id: 'r1', name: 'suggest_replies', input: { replies: ['Try it', 'Make it the default'] } }],
  }]);
  const { deps, published, settled } = recoveryDeps(model);
  const pool = conversationPool();

  const out = await agentTurn.writeRecoveredWrapUp({
    pool, config: CONFIG, agentSessionId: 5, userId: 7, username: 'ada', changeId: 50,
    kind: 'build', toolResultText: 'Commit abc12345 pushed. Opened PR #12. Staging redeployed: https://x.example',
    turnId: TURN_ID, deps,
  });
  assert.equal(out.ok, true);

  // The conversation's Mayor, told the result the lost tool_use carried.
  assert.equal(model.requests.length, 1);
  const call = model.requests[0];
  assert.match(call.systemPrompt, /This conversation is an agent session/, 'the agent session\'s prompt, not the dev chat\'s');
  assert.ok(call.systemPrompt.endsWith(agentTurn.WRAP_UP_NOTE), 'with the wrap-up\'s own rule');
  assert.deepEqual(call.tools.map((t) => t.name), ['suggest_replies']);
  assert.equal(call.telemetryContext.component, 'mayor_phase_2');
  const history = pool.calls.find((c) => /WHERE agent_session_id = \$1 AND id > \$3/.test(c.sql));
  assert.ok(history, 'the history is the conversation\'s');
  assert.equal(call.messages[0].role, 'user');
  assert.equal(call.messages[0].content, 'Add dark mode');
  const last = call.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content, /Commit abc12345 pushed\. Opened PR #12\./);
  assert.doesNotMatch(last.content.replace(/Do not mention a restart[^.]*\./, ''), /restart/i);

  // One row, in the conversation, marked as the dispatch's wrap-up.
  const rows = insertsIn(pool);
  assert.equal(rows.length, 1);
  assert.match(rows[0].sql, /\(session_id, agent_session_id, role, content, model, cost_cents, metadata\)/);
  assert.deepEqual(rows[0].params.slice(0, 5),
    [50, 5, 'Dark mode is in: there is a toggle in the toolbar.', 'claude-opus-5-5', 6]);
  const meta = JSON.parse(rows[0].params[5]);
  assert.equal(meta.wrapUp, true);
  assert.equal(meta.dispatch, 'build');
  assert.equal(meta.recovered, true);
  assert.equal(meta.agentTurnId, 'dead-turn');
  assert.deepEqual(meta.quickReplies, ['Try it', 'Make it the default']);

  // A screen following the conversation paints it.
  assert.deepEqual(published.map(([key, event]) => [key, event.type, event.wrapUp || false]), [
    [agentTurn.busKey(5), 'mayor_reasoning', true],
    [agentTurn.busKey(5), 'quick_replies', false],
  ]);
  assert.equal(published[0][1].messageId, 901);

  // Billed as the live wrap-up is, behind the turn's receipt.
  assert.deepEqual(settled, [{
    userId: 7, cents: 6, turnByok: false, turnId: TURN_ID, sessionId: 50, effectKey: 'turn_wrapup_spend',
  }]);
});

test('a recovery that runs again writes nothing twice', async () => {
  const model = scriptedModel([{ text: 'Done.' }]);
  const { deps, published, settled } = recoveryDeps(model);
  const pool = conversationPool();
  const args = {
    pool, config: CONFIG, agentSessionId: 5, userId: 7, changeId: 50, toolResultText: 'Built.', turnId: TURN_ID, deps,
  };
  await agentTurn.writeRecoveredWrapUp(args);
  const again = await agentTurn.writeRecoveredWrapUp(args);
  assert.equal(again.alreadyPosted, true);
  assert.equal(model.requests.length, 1, 'one model call');
  assert.equal(insertsIn(pool).length, 1, 'one row');
  assert.equal(published.filter(([, e]) => e.type === 'mayor_reasoning').length, 1);
  assert.equal(settled.length, 1);
});

test('when nobody can pay or the model fails, the conversation still gets its fixed close', async () => {
  for (const [label, depsFor] of [
    ['no payer', (d) => { d.limits.resolveBillingPath = async () => ({ error: 'budget' }); }],
    ['model fails', () => {}],
  ]) {
    const model = scriptedModel([new Error('provider down')]);
    const { deps, published } = recoveryDeps(model);
    depsFor(deps);
    const pool = conversationPool();
    // eslint-disable-next-line no-await-in-loop
    const out = await agentTurn.writeRecoveredWrapUp({
      pool, config: CONFIG, agentSessionId: 5, userId: 7, changeId: 50, kind: 'build', isError: true,
      toolResultText: 'The push failed.', turnId: TURN_ID, deps,
    });
    assert.equal(out.ok, false, label);
    const rows = insertsIn(pool);
    assert.equal(rows.length, 1, label);
    assert.equal(rows[0].params[2], agentTurn.fallbackWrapUp({ ran: true, isError: true, kind: 'build' }), label);
    assert.equal(JSON.parse(rows[0].params[5]).wrapUp, true, label);
    assert.equal(published[0][1].type, 'mayor_reasoning', label);
  }
});

// ── The live turn and recovery share the wrap-up's receipt ──────────────

const CHANGE_ROW = {
  id: 50, user_id: 7, app_id: 3, status: 'active', app_slug: 'recipe-box', app_name: 'Recipe box',
  repo_url: 'https://github.com/example/recipe-box', agent_backend: 'claude_code', agent_model: null,
};

function fakeShim() {
  return {
    toolNames: [...audiences.AGENT_MAYOR_TOOLS],
    modelTools: audiences.AGENT_MAYOR_TOOLS.map((name) => ({ name, description: name, input_schema: { type: 'object' } })),
    async call(name) { return { isError: false, text: `{"tool":"${name}"}` }; },
    async close() {},
  };
}

test('a restart after the live wrap-up was written, before the change was released, posts no second one', async () => {
  const pool = conversationPool();
  const finished = [];
  const model = scriptedModel([
    { text: 'Building it.', toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Add the toggle' } }] },
    { text: 'The toggle is in.' },
  ]);
  const { deps } = recoveryDeps(model);
  await agentTurn.runAgentTurn({
    pool, config: CONFIG, user: USER, agentSessionId: 5, turnId: 'turn-live-1',
    messageText: 'Add dark mode',
    mayor: { ok: true, provider: 'anthropic', client: model, model: 'claude-opus-5-5', apiKey: null, spendRecorded: true, byok: false },
    res: null,
    deps: {
      ...deps,
      openMayorMcp: async () => fakeShim(),
      agentSessions: {
        ...deps.agentSessions,
        appendConversationEvent: async () => {},
        releaseTurnLease: async () => {},
        renewTurnLease: async () => true,
      },
      actions,
      debugAccess: { isEligible: async () => false },
      dispatch: {
        ...dispatch,
        loadActiveChange: async () => CHANGE_ROW,
        canDispatch: () => true,
        // The process dies after the wrap-up row, before finish() releases
        // the change's durable turn: finish never runs.
        runDispatch: async (args) => ({
          ran: true, changeId: 50, kind: args.kind, isError: false, stopped: false, turnId: TURN_ID,
          toolResultText: 'Built and pushed.', finish: async (opts) => { finished.push(opts); },
        }),
      },
    },
  });
  assert.equal(pool.effects.get(`${TURN_ID}:turn_wrapup_message`)?.state, 'completed',
    'the live wrap-up row commits with its receipt');
  const liveRows = insertsIn(pool).filter((c) => /'assistant'/.test(c.sql));
  assert.equal(liveRows.length, 2, 'the reply before the dispatch, and the wrap-up');

  // Restart recovery reaches the same change and turn.
  const recoveryModel = scriptedModel([{ text: 'A second wrap-up nobody should see.' }]);
  const out = await agentTurn.writeRecoveredWrapUp({
    pool, config: CONFIG, agentSessionId: 5, userId: 7, changeId: 50, toolResultText: 'Built.', turnId: TURN_ID,
    deps: recoveryDeps(recoveryModel).deps,
  });
  assert.equal(out.alreadyPosted, true);
  assert.equal(recoveryModel.requests.length, 0, 'no model call');
  assert.equal(insertsIn(pool).filter((c) => /'assistant'/.test(c.sql)).length, 2, 'no second wrap-up');
});

// ── runRecoveredWrapUp routes a conversation's change there ─────────────

test('runRecoveredWrapUp writes a conversation\'s change\'s wrap-up into the conversation, and a dev chat\'s as before', async () => {
  const sessionsRoutes = require('../src/routes/sessions');
  const original = agentTurn.writeRecoveredWrapUp;
  const asked = [];
  agentTurn.writeRecoveredWrapUp = async (args) => { asked.push(args); return { ok: true, text: 'x' }; };
  try {
    const pool = conversationPool();
    await sessionsRoutes.runRecoveredWrapUp({
      pool, config: CONFIG,
      session: { id: 50, user_id: 7, username: 'ada', agent_session_id: 5, app_name: 'Recipe box' },
      sessionId: 50, outcome: 'code', dispatchSummary: 'Commit abc pushed.', fallbackPillKind: 'code_done',
      turnModel: null, turnId: TURN_ID,
    });
    assert.equal(asked.length, 1);
    assert.deepEqual(
      [asked[0].agentSessionId, asked[0].userId, asked[0].changeId, asked[0].kind, asked[0].isError,
        asked[0].toolResultText, asked[0].turnId],
      [5, 7, 50, 'build', false, 'Commit abc pushed.', TURN_ID],
    );
    assert.equal(insertsIn(pool).length, 0, 'the classic wrap-up is not written as well');

    await sessionsRoutes.runRecoveredWrapUp({
      pool, config: CONFIG,
      session: { id: 51, user_id: 7, agent_session_id: null, agent_backend: 'codex_openrouter', agent_model: 'z/glm' },
      sessionId: 51, outcome: 'spec', dispatchSummary: 'Spec written.', fallbackPillKind: 'spec_done',
      turnModel: null, turnId: null,
    });
    assert.equal(asked.length, 1, 'a dev chat keeps its own recovered wrap-up');
    const classic = insertsIn(pool);
    assert.equal(classic.length, 1);
    assert.match(classic[0].sql, /\(session_id, role, content, model, token_count, cost_cents, metadata\)/);
    assert.equal(classic[0].params[0], 51);
  } finally {
    agentTurn.writeRecoveredWrapUp = original;
  }
});
