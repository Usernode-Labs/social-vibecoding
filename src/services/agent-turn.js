'use strict';

// Per-turn agent context resolution (plan.md §11). Given a session, this
// resolves which backend runs the turn and, for codex_openrouter, creates
// the agent_turns ledger row and returns the per-turn OpenRouter key
// (direct transport). Claude turns return null context (unchanged path);
// the raw OpenRouter key is returned ONLY for the codex_openrouter turn.

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

// For a codex_openrouter turn, resolve the credential + create an
// agent_turns row, returning the direct-transport execInWorker params
// (including the per-exec OpenRouter key). Returns null for Claude turns
// (caller uses the legacy path). Never throws on a missing/invalid
// credential — returns a structured error the caller surfaces as an
// actionable UI state.
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

  // A model is REQUIRED and must be an OpenRouter model (review P3):
  // never fall back to a Claude model (the caller's selectedModel) and
  // pin it into OpenRouter. The session-pinned model is authoritative; if
  // the session has none, fall back to the operator-configured
  // OPENROUTER_DEFAULT_CODEX_MODEL. We deliberately ignore the `model`
  // param here (it may already carry a Claude fallback). Null → error.
  const resolvedModel = session.agent_model || config.openrouterDefaultCodexModel || null;
  if (!resolvedModel) {
    return { error: 'model_required' };
  }

  // The OpenRouter base URL (review #8): the operator-configured value must
  // reach Codex, or key-validation/catalog would hit one origin while
  // generation silently used the public default. Only accepted as an HTTPS
  // origin unless an explicit insecure-dev escape hatch is enabled.
  const configuredBase = String(config.openrouterApiBase || 'https://openrouter.ai/api/v1')
    .replace(/\/+$/, '');
  let openrouterApiBase = configuredBase;
  if (!/^https:\/\//.test(configuredBase) && !config.openrouterAllowInsecureBase) {
    return { error: 'invalid_base_url' };
  }

  // Direct transport (review P0): the user's OpenRouter key is returned
  // here and injected into the per-turn docker exec as OPENROUTER_API_KEY;
  // it is never placed in the warm container's persistent environment or
  // filesystem by the platform. DECRYPT + revision-check BEFORE creating
  // the ledger row (review #9): if decryption fails we return an error with
  // no `running` agent_turns row left behind, so the caller has nothing to
  // leak or clean up.
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

  const turnId = crypto.randomUUID();
  // IMPORTANT (review F9): the ledger row is the authoritative state
  // machine drives the Codex dispatch lifecycle. If creating it fails we
  // MUST fail closed, so continuing with a missing ledger row would leave
  // the turn never terminalized (worse: silently turn it "unbillable").
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

  return {
    agentBackend: 'codex_openrouter',
    agentModel: resolvedModel,
    agentReasoningEffort: reasoningEffort || session.agent_reasoning_effort || null,
    openrouterApiKey,
    openrouterApiBase,
    turnUuid: turnId,
  };
}


module.exports = { backendForSession, resolveCodexTurn, completeCodexTurn };

// Mark a Codex turn's ledger row terminal when the worker dispatch
// finishes (review P3). The single Responses stream must NOT close the
// turn (tool loops make many); completion belongs to the worker lifecycle.
// Call this once, when execInWorker resolves.
async function completeCodexTurn({ pool, turnUuid, status = 'completed', errorDetail = null, errorCode = null, usage = null }) {
  if (!turnUuid) return;
  try {
    // Backend-aware settlement (review #3): Codex spend is billed to the
    // user's OpenRouter account directly, so it must never be written into
    // the Anthropic `llm_usage` ledger. Instead we persist the turn's own
    // usage/cost into the agent_turns ledger with an explicit source.
    const u = usage || {};
    const hasUsage = Number.isFinite(u.inputTokens)
      || Number.isFinite(u.outputTokens)
      || (u.cost != null && Number.isFinite(u.cost));
    let costSource = null;
    if (hasUsage) costSource = (u.cost != null && Number.isFinite(u.cost)) ? 'openrouter_exact' : 'openrouter_estimated';
    await pool.query(
      `UPDATE agent_turns SET
         status = $2,
         completed_at = COALESCE(completed_at, NOW()),
         error_detail = COALESCE($3, error_detail),
         error_code = COALESCE($4, error_code),
         routed_model = COALESCE($6, routed_model),
         input_tokens = input_tokens + COALESCE($7, 0),
         cached_input_tokens = cached_input_tokens + COALESCE($8, 0),
         output_tokens = output_tokens + COALESCE($9, 0),
         reasoning_output_tokens = reasoning_output_tokens + COALESCE($10, 0),
         actual_cost_usd = actual_cost_usd + COALESCE($11, 0),
         cost_source = COALESCE($12, cost_source),
         billed_by = 'user_openrouter'
       WHERE id = $1 AND status = 'running'`,
      [turnUuid, status, errorDetail, errorCode, null,
       Number.isFinite(u.inputTokens) || Number.isFinite(u.outputTokens) || (u.cost != null) ? (u.model || null) : null,
       Number.isFinite(u.inputTokens) ? u.inputTokens : null,
       Number.isFinite(u.cachedInputTokens) ? u.cachedInputTokens : null,
       Number.isFinite(u.outputTokens) ? u.outputTokens : null,
       Number.isFinite(u.reasoningOutputTokens) ? u.reasoningOutputTokens : null,
       (u.cost != null && Number.isFinite(u.cost)) ? u.cost : null,
       costSource],
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
