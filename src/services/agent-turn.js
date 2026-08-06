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
  // IMPORTANT (review F9): the ledger row is the authoritative state
  // machine the relay checks on every request. If creating it fails we
  // MUST fail closed — the relay rejects requests for turns it cannot
  // find, so continuing with a missing ledger row would mint tokens that
  // can never be used (worse: silently turn the turn "unbillable").
  try {
    await pool.query(
      `INSERT INTO agent_turns
         (id, session_id, user_id, backend, provider, requested_model,
          reasoning_effort, credential_id, credential_revision,
          agent_thread_id, agent_config_version, status)
       VALUES ($1, $2, $3, 'codex_openrouter', 'openrouter', $4,
               $5, $6, $7, $8, $9, 'running')`,
      [turnId, session.id, userId, model || session.agent_model || null,
       reasoningEffort || session.agent_reasoning_effort || null,
       meta.id, meta.revision, resumeThreadId || session.agent_thread_id || null,
       session.agent_config_version || 1],
    );
  } catch (err) {
    log.error('agent-turn', 'agent_turns insert failed; refusing to start turn', { sessionId: session.id, err: err.message });
    throw err;
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

// Mark a Codex turn's ledger row terminal when the worker dispatch
// finishes (review P3). The relay intentionally does NOT close the turn on
// any single Responses stream (tool loops make many); completion belongs
// to the worker lifecycle. Call this once, when execInWorker resolves.
async function completeCodexTurn({ pool, turnUuid, status = 'completed', errorDetail = null, errorCode = null }) {
  if (!turnUuid) return;
  try {
    await pool.query(
      `UPDATE agent_turns SET
         status = $2,
         completed_at = COALESCE(completed_at, NOW()),
         error_detail = COALESCE($3, error_detail),
         error_code = COALESCE($4, error_code)
       WHERE id = $1 AND status = 'running'`,
      [turnUuid, status, errorDetail, errorCode],
    );
  } catch (err) {
    log.warn('agent-turn', 'completeCodexTurn failed', { turnUuid, err: err.message });
  }
}

module.exports = { backendForSession, resolveCodexTurn, completeCodexTurn };
