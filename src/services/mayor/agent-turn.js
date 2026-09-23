'use strict';

// One Mayor turn in an agent session (#2779, spec: docs/agent-sessions.md,
// "The Mayor").
//
// The classic turn (./turn.js) is built around one change: its spec, its
// worker, its pull request, the per-change dispatch tail and its recovery.
// An agent session's turn is built around the conversation instead, and it
// is kept a separate module on purpose: classic sessions keep running the code
// that the golden tests pin byte for byte, and nothing here can change how
// they behave.
//
// Shape of a turn:
//
//   1. The user's message is recorded, on the active change's slice when
//      there is one, and on the conversation in every case.
//   2. The Mayor runs a bounded tool loop. Its tools are the platform MCP
//      (reads run at once), plus two moves of its own: switch_active_change
//      and set_focus_app.
//   3. A tool that changes something never runs from the model. It becomes a
//      sealed confirmation card (services/agent-session-actions.js), and the
//      model is told nothing happened yet. recheck_change is the one
//      exception: it re-runs checks on a commit already there, moves no code
//      and clears no vote, so it runs at once with a one-action write grant.
//   4. The reply, the cards and what the tools did are recorded as one
//      assistant row, and the turn's cost is billed as a Mayor call.
//
// Dispatching the coding agent from here arrives in the next step of #2779.
//
// Transport: every event is written to the turn's own SSE response and
// published on the conversation's bus (`agent:<id>`), so a client whose POST
// stream drops can resume through GET /api/agent-sessions/:id/events. Nothing
// is broadcast on the global WebSocket: the conversation is private to its
// owner.

const crypto = require('node:crypto');
const log = require('../logger');

const MAX_TOOL_ROUNDS = 6;
const HISTORY_ROWS = 120;
const TITLE_MAX = 80;
const EMPTY_REPLY_TEXT = 'I could not put an answer together that time. Could you say that again?';

const IMMEDIATE_WRITE_TOOLS = new Set(['recheck_change']);

const SWITCH_ACTIVE_CHANGE_TOOL = Object.freeze({
  name: 'switch_active_change',
  description: 'Make one of this conversation\'s earlier changes the active change again, parking the current one. '
    + 'Only changes this conversation started, and only ones still open. Use it when the user wants to go back to '
    + 'earlier work ("the dark-mode one").',
  input_schema: {
    type: 'object',
    properties: {
      changeId: { type: 'integer', description: 'The change id, from the CHANGES list or get_change.' },
    },
    required: ['changeId'],
  },
});

const SET_FOCUS_APP_TOOL = Object.freeze({
  name: 'set_focus_app',
  description: 'Record which app the user means when they do not name one. It changes nothing on the app; it is '
    + 'the default this conversation uses from now on.',
  input_schema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'The app slug, as list_apps returns it.' },
    },
    required: ['slug'],
  },
});

// Stop handles for the turns this process is running, by agent session id.
const stopRegistry = new Map();

function busKey(agentSessionId) {
  return `agent:${agentSessionId}`;
}

function defaults(deps = {}) {
  return {
    llm: deps.llm || require('../llm'),
    models: deps.models || require('../models'),
    limits: deps.limits || require('../limits'),
    openrouterMayor: deps.openrouterMayor || require('../openrouter-mayor'),
    openMayorMcp: deps.openMayorMcp || require('./mcp-shim').openMayorMcp,
    agentSessions: deps.agentSessions || require('../agent-sessions'),
    actions: deps.actions || require('../agent-session-actions'),
    sessionBus: deps.sessionBus || require('../session-bus'),
    getAgentMayorPrompt: deps.getAgentMayorPrompt || require('./agent-prompt').getAgentMayorPrompt,
    buildMayorMessages: deps.buildMayorMessages || require('./messages').buildMayorMessages,
    stripFakeCompletionMarker: deps.stripFakeCompletionMarker || require('./messages').stripFakeCompletionMarker,
  };
}

// ── Who runs the Mayor, and who pays ───────────────────────────────────
//
// The same rules as a classic session's Mayor, keyed on the user's default
// coding backend because an agent session has no backend of its own yet: an
// OpenRouter user's Mayor runs on their OpenRouter model and key (and an
// included key is gated on, and billed to, the shared weekly pool); everyone
// else's runs on Anthropic through the limit-first platform or BYOK path.
async function resolveAgentMayor({ pool, config, userId, agentSessionId, requestedModel, deps = {} }) {
  const d = defaults(deps);
  const { rows } = await pool.query(
    `SELECT backend, model_id FROM user_agent_preferences
      WHERE user_id = $1 AND is_default = TRUE`,
    [userId]
  );
  const pref = rows[0];
  if (pref && pref.backend === 'codex_openrouter') {
    const resolved = await d.openrouterMayor.resolveForSession({
      pool,
      config,
      session: { id: null, agent_model: pref.model_id },
      userId,
      sessionKey: `homeroom-agent-${agentSessionId}`,
    });
    if (resolved.error) {
      return {
        ok: false, status: 503, code: 'mayor_unavailable',
        error: `Your OpenRouter setup cannot run the Mayor (${resolved.error}). Check your coding agent in Settings.`,
      };
    }
    if (resolved.usesIncludedKey) {
      const budget = await d.limits.checkBudget(pool, userId);
      if (budget.error) {
        return {
          ok: false, status: 429, code: 'budget_exceeded', error: budget.error,
          reason: budget.reason || null, verificationRequired: !!budget.verificationRequired,
        };
      }
    }
    return {
      ok: true,
      provider: 'openrouter',
      client: resolved.client,
      model: resolved.modelLabel,
      apiKey: null,
      spendRecorded: !!resolved.usesIncludedKey,
      byok: false,
    };
  }
  if (!d.llm.isEnabled()) return { ok: false, status: 503, code: 'llm_not_configured', error: 'LLM not configured' };
  const billing = await d.limits.resolveBillingPath(pool, config.dataEncryptionKey, userId);
  if (billing.error) {
    return {
      ok: false, status: 429, code: 'budget_exceeded', error: billing.error,
      reason: billing.reason || null, verificationRequired: !!billing.verificationRequired,
    };
  }
  return {
    ok: true,
    provider: 'anthropic',
    client: d.llm,
    model: d.models.resolve(requestedModel),
    apiKey: billing.apiKey || null,
    spendRecorded: true,
    byok: !!billing.apiKey,
  };
}

// ── History ────────────────────────────────────────────────────────────

async function loadHistory(pool, agentSessionId) {
  const { rows } = await pool.query(
    `SELECT id, session_id, role, content, metadata
       FROM chat_session_messages
      WHERE agent_session_id = $1
        AND (role IN ('user', 'assistant')
             OR (role = 'system' AND (metadata->>'agentSessionEvent' IS NOT NULL
                                      OR metadata->>'ccOutput' IS NOT NULL)))
      ORDER BY id DESC
      LIMIT $2`,
    [agentSessionId, HISTORY_ROWS]
  );
  return rows.reverse();
}

// The conversation as the model reads it. What the platform did between
// turns — a change started, a card confirmed or dismissed, a change merged —
// is folded in as a labelled note on the Mayor's side, so it can say what
// happened without having been asked. The history must open with the user.
function historyToMessages(rows, buildMayorMessages) {
  const mapped = rows.map((row) => (
    row.role === 'system' && row.metadata && row.metadata.agentSessionEvent
      ? { ...row, role: 'assistant', content: `[HOMEROOM] ${row.content}`, metadata: {} }
      : row
  ));
  const messages = buildMayorMessages(mapped);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return messages;
}

function titleFromMessage(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= TITLE_MAX) return clean;
  const cut = clean.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function costOf(mayor, result, d) {
  if (!result || !result.usage) return 0;
  const served = result.servedModel || mayor.model;
  try {
    return mayor.provider === 'anthropic'
      ? d.llm.estimateCostCents(result.usage, served)
      : mayor.client.estimateCostCents(result.usage, served);
  } catch {
    return 0;
  }
}

// ── The turn ───────────────────────────────────────────────────────────

async function runAgentTurn({
  pool, config, user, agentSessionId, turnId, messageText, mayor, res, deps = {},
}) {
  const d = defaults(deps);
  const seqPrefix = String(turnId).slice(0, 8);
  let eventSeq = 0;
  const send = (type, data = {}) => {
    const event = { type, _seq: `${seqPrefix}-${++eventSeq}`, agentSessionId, ...data };
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* the client left; the bus still has it */ }
    d.sessionBus.publish(busKey(agentSessionId), event);
  };
  const stop = { abort: new AbortController(), stopped: false, stoppedBy: null, send };
  const prior = stopRegistry.get(agentSessionId);
  if (prior && prior !== stop) { try { prior.abort.abort(); } catch { /* already gone */ } }
  stopRegistry.set(agentSessionId, stop);

  let shim = null;
  let totalCost = 0;
  let visibleText = '';
  // What the current model call has streamed so far. A stop that aborts the
  // call mid-stream keeps it, because the user has already read it.
  let roundText = '';
  let persisted = false;
  const cards = [];
  const toolLog = [];

  const recordSpend = async (cents) => {
    if (!(cents > 0) || !mayor.spendRecorded) return;
    await d.limits.recordSpend(pool, user.id, cents, { byok: !!mayor.byok }).catch((err) => {
      log.warn('agent-mayor', 'Could not record Mayor spend', { agentSessionId, err: err.message });
    });
  };

  // The turn's reply, its cards and what its tools did, as one assistant row.
  // Written once, whether the turn finished, was stopped or failed part way,
  // so a card the user can still press is never missing from the transcript.
  const persistReply = async (flags = {}) => {
    if (persisted || (!visibleText && !cards.length)) return null;
    persisted = true;
    const after = await d.agentSessions.getAgentSession(pool, { userId: user.id, id: agentSessionId });
    const { rows } = await pool.query(
      `INSERT INTO chat_session_messages
         (session_id, agent_session_id, role, content, model, cost_cents, metadata)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        after && after.activeChange ? after.activeChange.id : null,
        agentSessionId,
        visibleText,
        mayor.model,
        totalCost,
        JSON.stringify({
          agentTurnId: turnId,
          ...(cards.length ? { confirmations: cards } : {}),
          ...(toolLog.length ? { tools: toolLog } : {}),
          ...flags,
        }),
      ]
    );
    return rows[0].id;
  };

  const keepStreamedText = () => {
    const partial = d.stripFakeCompletionMarker(roundText).trim();
    roundText = '';
    if (partial) visibleText = visibleText ? `${visibleText}\n\n${partial}` : partial;
  };

  // One tool call from the model, answered with the text the model reads.
  const resolveTool = async (use) => {
    const input = use.input && typeof use.input === 'object' ? use.input : {};
    try {
      if (use.name === SWITCH_ACTIVE_CHANGE_TOOL.name) {
        const switched = await d.agentSessions.switchActiveChange(pool, {
          agentSessionId, userId: user.id, changeId: input.changeId,
        });
        send('active_change', { changeId: switched.change.id });
        return { ok: true, text: JSON.stringify({ ok: true, activeChangeId: switched.change.id, changed: switched.changed }) };
      }
      if (use.name === SET_FOCUS_APP_TOOL.name) {
        const app = await d.agentSessions.setFocusApp(pool, { agentSessionId, user, slug: input.slug });
        send('focus_app', { slug: app.slug });
        return { ok: true, text: JSON.stringify({ ok: true, focusApp: app.slug }) };
      }
      if (d.actions.isConfirmedTool(use.name)) {
        const card = await d.actions.prepareAction(pool, {
          config, userId: user.id, agentSessionId, toolName: use.name, input,
        });
        cards.push(card);
        send('confirmation_required', { card });
        return {
          ok: true,
          text: JSON.stringify({
            status: 'pending_confirmation',
            actionId: card.id,
            note: 'Shown to the user as a confirmation card. Nothing has happened yet: it runs only if they press '
              + 'Confirm on the card. Tell them in one line what it will do.',
          }),
        };
      }
      if (IMMEDIATE_WRITE_TOOLS.has(use.name)) {
        const { READ_SCOPE, WRITE_SCOPE } = require('../mcp-connect-constants');
        const changeId = Number(input.changeId);
        const { rows } = await pool.query(
          'SELECT app_id FROM chat_sessions WHERE id = $1 AND user_id = $2',
          [Number.isSafeInteger(changeId) ? changeId : 0, user.id]
        );
        if (!rows.length) return { ok: false, text: 'no_access: that change is not one of the user\'s.' };
        const writer = await d.openMayorMcp({
          pool, config, userId: user.id, agentSessionId,
          scopes: [READ_SCOPE, WRITE_SCOPE], changeId, appId: rows[0].app_id, ttlSeconds: 60,
        });
        try {
          const result = await writer.call(use.name, input);
          return { ok: !result.isError, text: result.text };
        } finally {
          await writer.close('action_done');
        }
      }
      if (shim && shim.toolNames.includes(use.name)) {
        const result = await shim.call(use.name, input);
        return { ok: !result.isError, text: result.text };
      }
      return { ok: false, text: `unknown_tool: ${use.name} is not available in this conversation.` };
    } catch (err) {
      const message = err && typeof err.status === 'number' ? err.message : 'The tool could not run.';
      if (!(err && typeof err.status === 'number')) {
        log.warn('agent-mayor', 'Tool call failed', { agentSessionId, tool: use.name, err: err && err.message });
      }
      return { ok: false, text: `failed: ${message}` };
    }
  };

  try {
    const session = await d.agentSessions.getAgentSession(pool, { userId: user.id, id: agentSessionId });
    if (!session || session.status !== 'open') throw new Error('agent session is not open');

    // The user's message: on the active change's slice when there is one, so
    // the change page reads the conversation that shaped it, and on the
    // conversation always.
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata)
       VALUES ($1, $2, 'user', $3, $4::jsonb)`,
      [session.activeChange ? session.activeChange.id : null, agentSessionId, messageText,
        JSON.stringify({ agentTurnId: turnId })]
    );
    if (!session.title) {
      await pool.query(
        `UPDATE agent_sessions SET title = $1
          WHERE id = $2 AND title IS NULL AND title_source = 'auto'`,
        [titleFromMessage(messageText), agentSessionId]
      );
    }

    send('phase', { phase: 'mayor' });
    const history = await loadHistory(pool, agentSessionId);
    let convo = historyToMessages(history, d.buildMayorMessages);
    const systemPrompt = d.getAgentMayorPrompt({ username: user.username, session });
    shim = await d.openMayorMcp({ pool, config, userId: user.id, agentSessionId });
    const tools = [...shim.modelTools, SWITCH_ACTIVE_CHANGE_TOOL, SET_FOCUS_APP_TOOL];

    for (let round = 0; ; round += 1) {
      const lastRound = round >= MAX_TOOL_ROUNDS;
      roundText = '';
      const result = await mayor.client.streamChat({
        messages: convo,
        systemPrompt,
        model: mayor.model,
        tools,
        ...(lastRound ? { toolChoice: { type: 'none' } } : {}),
        signal: stop.abort.signal,
        onToken: (text) => { roundText += text; send('token', { text }); },
        apiKey: mayor.apiKey,
        telemetryContext: {
          pool, appId: null, sessionId: null, backend: 'mayor',
          component: round === 0 ? 'mayor_phase_1' : 'mayor_data_iteration',
        },
      });
      totalCost += costOf(mayor, result, d);
      roundText = '';
      const text = d.stripFakeCompletionMarker(result.text || '').trim();
      if (text) visibleText = visibleText ? `${visibleText}\n\n${text}` : text;
      const toolUses = Array.isArray(result.toolUses) ? result.toolUses : [];
      if (stop.stopped || !toolUses.length || lastRound) break;

      convo = [...convo, { role: 'assistant', content: result.rawContent }];
      const toolResults = [];
      for (const use of toolUses) {
        send('tool', { name: use.name, state: 'running' });
        // eslint-disable-next-line no-await-in-loop
        const answer = await resolveTool(use);
        toolLog.push({ name: use.name, ok: answer.ok });
        send('tool', { name: use.name, state: answer.ok ? 'done' : 'failed' });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: answer.text,
          ...(answer.ok ? {} : { is_error: true }),
        });
      }
      convo = [...convo, { role: 'user', content: toolResults }];
    }

    if (stop.stopped) send('stopped', { by: stop.stoppedBy });
    if (!visibleText && !cards.length && !stop.stopped) visibleText = EMPTY_REPLY_TEXT;

    const messageId = await persistReply(stop.stopped ? { stopped: true } : {});
    send('mayor_reasoning', { text: visibleText, messageId, cards });
    await recordSpend(totalCost);
    send('usage', { costCents: totalCost });
  } catch (err) {
    await recordSpend(totalCost);
    if (stop.stopped) keepStreamedText();
    const messageId = await persistReply(stop.stopped ? { stopped: true } : { failed: true }).catch((persistErr) => {
      log.warn('agent-mayor', 'Could not record a cut-short reply', { agentSessionId, err: persistErr.message });
      return null;
    });
    if (messageId) send('mayor_reasoning', { text: visibleText, messageId, cards });
    if (stop.stopped) {
      send('stopped', { by: stop.stoppedBy });
    } else {
      log.error('agent-mayor', 'Agent turn failed', { agentSessionId, err: err.message });
      send('error', { error: 'The Mayor could not finish this turn. Try again.' });
      await d.agentSessions.appendConversationEvent(pool, {
        agentSessionId,
        content: 'The last turn did not finish.',
        event: 'turn_failed',
        metadata: { agentTurnId: turnId },
      }).catch(() => {});
    }
  } finally {
    if (shim) await shim.close('turn_finished');
    if (stopRegistry.get(agentSessionId) === stop) stopRegistry.delete(agentSessionId);
    await d.agentSessions.releaseTurnLease(pool, { agentSessionId, turnId }).catch((err) => {
      log.warn('agent-mayor', 'Could not release the turn lease', { agentSessionId, err: err.message });
    });
    send('done', {});
    try { res.end(); } catch { /* already closed */ }
    setTimeout(() => d.sessionBus.clearSession(busKey(agentSessionId)), 30_000).unref?.();
  }
}

// POST /stop: the turn is in this process's registry or it is not running
// here. Stopping aborts the model call; the turn records what it had said,
// including what the aborted call had streamed, and any cards it prepared.
function stopAgentTurn(agentSessionId, { by = null } = {}) {
  const handle = stopRegistry.get(agentSessionId);
  if (!handle) return false;
  handle.stopped = true;
  handle.stoppedBy = by;
  try { handle.send('stopping', { by }); } catch { /* best effort */ }
  try { handle.abort.abort(); } catch { /* already aborted */ }
  return true;
}

function newTurnId() {
  return crypto.randomUUID();
}

module.exports = {
  MAX_TOOL_ROUNDS,
  HISTORY_ROWS,
  EMPTY_REPLY_TEXT,
  IMMEDIATE_WRITE_TOOLS,
  SWITCH_ACTIVE_CHANGE_TOOL,
  SET_FOCUS_APP_TOOL,
  busKey,
  resolveAgentMayor,
  loadHistory,
  historyToMessages,
  titleFromMessage,
  runAgentTurn,
  stopAgentTurn,
  newTurnId,
  _stopRegistry: stopRegistry,
};
