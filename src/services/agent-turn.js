'use strict';

// Per-turn agent context resolution (plan.md §11). Given a session, this
// resolves which backend runs the turn and, for codex_openrouter, mints
// the scoped relay token + creates the agent_turns ledger row. Claude
// turns return null context (unchanged dispatch path).
//
// The raw OpenRouter key is never returned here — only the scoped token
// the worker presents to the relay.

const crypto = require('crypto');
const platformJwt = require('./platform-jwt');
const credentialStore = require('./credential-store');
const registry = require('../agents/registry');
const log = require('./logger');

// Resolve the backend for a turn from the session row (pinned at session
// creation). Falls back to claude_code for legacy sessions.
function backendForSession(session) {
  return registry.resolveBackend(session?.agent_backend || 'claude_code');
}

// For a codex_openrouter turn, resolve the credential + mint the scoped
// relay token + create an agent_turns row. Returns the Codex-specific
// execInWorker params, or null for Claude turns (caller uses the legacy
// path). Never throws on a missing/invalid credential — returns a
// structured error the caller surfaces as an actionable UI state.
async function resolveCodexTurn({ pool, session, userId, model, reasoningEffort, resumeThreadId }) {
  if (registry.resolveBackend(session?.agent_backend) !== 'codex_openrouter') return null;

  const meta = await credentialStore.readMetadata({
    pool, userId, provider: 'openrouter', purpose: 'coding_agent',
  });
  if (!meta || meta.status !== 'valid') {
    return { error: 'credential_required' };
  }

  const turnId = crypto.randomUUID();
  try {
    await pool.query(
      `INSERT INTO agent_turns
         (id, session_id, user_id, backend, provider, requested_model,
          reasoning_effort, credential_id, credential_revision,
          agent_thread_id, status)
       VALUES ($1, $2, $3, 'codex_openrouter', 'openrouter', $4,
               $5, $6, $7, $8, 'running')`,
      [turnId, session.id, userId, model || session.agent_model || null,
       reasoningEffort || session.agent_reasoning_effort || null,
       meta.id, meta.revision, resumeThreadId || session.agent_thread_id || null],
    );
  } catch (err) {
    log.warn('agent-turn', 'agent_turns insert failed', { sessionId: session.id, err: err.message });
  }

  const token = platformJwt.signAgentProxyToken({
    sessionId: session.id,
    userId,
    turnId,
    backend: 'codex_openrouter',
    model: model || session.agent_model,
    credentialRevision: meta.revision,
    agentConfigVersion: session.agent_config_version || 1,
  });

  return {
    agentBackend: 'codex_openrouter',
    agentModel: model || session.agent_model,
    agentReasoningEffort: reasoningEffort || session.agent_reasoning_effort || null,
    agentProxyToken: token,
    turnUuid: turnId,
  };
}

module.exports = { backendForSession, resolveCodexTurn };
