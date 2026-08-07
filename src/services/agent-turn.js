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
async function resolveCodexTurn({ pool, session, userId, model, reasoningEffort, resumeThreadId, config = {} }) {
  if (registry.resolveBackend(session?.agent_backend) !== 'codex_openrouter') return null;

  // Enforce availability at EXECUTION (review P3): the feature flag and
  // beta allowlist must gate dispatch too, not just Settings save. If
  // access was disabled after a user configured Codex, refuse the turn.
  if (!config.codexOpenrouterEnabled) return { error: 'backend_disabled' };
  if (config.openrouterBetaUserIds?.length
      && !config.openrouterBetaUserIds.includes(String(userId))) {
    return { error: 'backend_not_available' };
  }

  const meta = await credentialStore.readMetadata({
    pool, userId, provider: 'openrouter', purpose: 'coding_agent',
  });
  if (!meta || meta.status !== 'valid') {
    return { error: 'credential_required' };
  }

  // A model is REQUIRED and must be the session-pinned OpenRouter model
  // (review P3): never fall back to a Claude model (the caller's
  // selectedModel) and pin it into OpenRouter. Null → actionable error.
  // We deliberately ignore the `model` param here (it may already carry a
  // Claude fallback) and require session.agent_model to be the authority.
  const resolvedModel = session.agent_model || null;
  if (!resolvedModel) {
    return { error: 'model_required' };
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
      [turnId, session.id, userId, resolvedModel,
       reasoningEffort || session.agent_reasoning_effort || null,
       meta.id, meta.revision, resumeThreadId || session.agent_thread_id || null,
       session.agent_config_version || 1],
    );
  } catch (err) {
    log.error('agent-turn', 'agent_turns insert failed; refusing to start turn', { sessionId: session.id, err: err.message });
    throw err;
  }

  // Direct transport (review P0): there is no relay token. The user's
  // OpenRouter key is returned here and injected into the per-turn docker
  // exec as OPENROUTER_API_KEY; it is never placed in the warm container's
  // persistent environment or filesystem by the platform.
  let openrouterApiKey = null;
  try {
    openrouterApiKey = await credentialStore.readSecret({
      pool, userId, provider: 'openrouter', purpose: 'coding_agent',
      dataKey: config.dataEncryptionKey, expectedRevision: meta.revision,
    });
  } catch (err) {
    log.error('agent-turn', 'openrouter key decrypt failed; refusing to start turn', { sessionId: session.id, err: err.message });
    return { error: 'credential_required' };
  }
  if (!openrouterApiKey) {
    return { error: 'credential_required' };
  }

  return {
    agentBackend: 'codex_openrouter',
    agentModel: resolvedModel,
    agentReasoningEffort: reasoningEffort || session.agent_reasoning_effort || null,
    openrouterApiKey,
    turnUuid: turnId,
  };
}

module.exports = { backendForSession, resolveCodexTurn, completeCodexTurn };

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
    // Do NOT swallow (review P1): a terminalization failure would leave the
    // ledger row 'running' and produce wrong audit status / a token-backed
    // row that lingers until JWT expiry. Rethrow so callers surface it.
    log.error('agent-turn', 'completeCodexTurn failed', { turnUuid, err: err.message });
    throw err;
  }
}

module.exports = { backendForSession, resolveCodexTurn, completeCodexTurn };
