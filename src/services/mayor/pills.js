'use strict';

// The quick-reply pill ladder (#1001): the Mayor's own pills, a forced
// re-ask, a generated set, then the static fallback.
//
// Moved verbatim out of routes/sessions.js (#2779) so the Mayor turn can run
// for a conversation that is not one change (see docs/agent-sessions.md).
// The classic dev-chat route, headless runs and interrupted-turn recovery
// import it from here; routes/sessions.js re-exports it for existing callers.

const limits = require('../limits');
const llm = require('../llm');
const log = require('../logger');
const { QUICK_REPLY_RULES_TEXT, fallbackKindForTurn, isGenericPillSet, turnFallbackQuickReplies } = require('../recovery-pills');
const { SUGGEST_REPLIES_TOOL, sanitizeQuickReplies } = require('./tools');

// ── #1001: the pill-resolution ladder ────────────────────────────────
//
// The requirement: the Mayor authors at least one pill ITSELF on every turn
// that renders the pill row. suggest_replies is optional and production
// turns skipped it on roughly two thirds of assistant rows, so the row was
// usually filled from a fixed, state-only list — the reported symptom
// ("a lot of them are generic").
//
// Forcing the tool on the FIRST call is not available:
//   - phase 1 shares its tools array with the dispatch tools, so a forced
//     tool_choice would make dispatching structurally impossible;
//   - phase 2 exposes only suggest_replies, so forcing WOULD work there —
//     but a forced tool_use suppresses the text block, and on phase 2 that
//     text IS the wrap-up message.
// So enforcement is a post-hoc forced continuation instead, on a compact
// context (see llm.buildQuickReplyContext for why compact, with the
// measured cost that rules out a full replay).
//
// Four rungs, in order, each falling through on failure:
//
//   'model'            the Mayor's own suggest_replies call. The common
//                      case, and the only rung that costs nothing extra.
//   'enforced'         a forced pills-only continuation on the turn's own
//                      model. Still the Mayor authoring its own pills.
//   'generated'        a cheap Haiku call, for when the forced call can't
//                      be made or fails. Different model on purpose.
//   'static'           the deterministic RECOVERY_PILLS set. Now genuinely
//                      exceptional rather than the normal outcome.
//
// Rungs 2 and 3 are mutually exclusive per turn (3 only runs when 2 threw
// or timed out), so the worst case adds ~8s — and only AFTER the reply text
// has streamed, so the user is never waiting on it.
const QR_ENFORCE = true;          // one-line revert if cost/latency surprises

const QR_ENFORCE_TIMEOUT_MS = 5000;

const QR_GENERATE_TIMEOUT_MS = 3000;

// Reject a promise after `ms`, so a slow provider can never hold a turn
// open. The underlying call is also passed an AbortSignal where the SDK
// supports one, so the losing request is actually cancelled rather than
// merely ignored.
function qrWithTimeout(makeCall, ms) {
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`quick-reply call exceeded ${ms}ms`));
    }, ms);
  });
  return Promise.race([makeCall(controller.signal), timeout])
    .finally(() => { if (timer) clearTimeout(timer); });
}

// Walk the ladder. Returns { replies, source, kind } — `kind` only on the
// static rung, so telemetry can tell WHICH fixed set was used.
//
//   modelPills      — already-sanitized output of the Mayor's own call, or
//                     null. An all-boilerplate set counts as "missing" and
//                     escalates (see isGenericPillSet).
//   outcome         — fallbackKindForTurn vocabulary, for the static rung.
//   allowModelCalls — false on paths with no reply to continue from, or
//                     where the model has already declined: those skip
//                     straight past rung 2. See the caller comments.
//   replyText/transcriptTail/state — the compact enforcement context.
//   staticFallback  — overrides rung 4 for call sites with their own fixed
//                     set (the clone and fork follow-ups), so the ladder
//                     degrades to the wording those paths already shipped
//                     rather than a state-derived approximation of it.
async function resolveTurnPills({
  pool, dataKey, session, userId, apiKey, model, modelPills, outcome,
  hasPr, hasSpec, replyText, transcriptTail, state, staticFallback = null,
  allowModelCalls = true, allowGenerate = true,
}) {
  const startedAt = Date.now();
  const staticRung = () => (staticFallback
    ? { replies: staticFallback, source: 'static' }
    : {
      replies: turnFallbackQuickReplies({ outcome, hasPr, hasSpec }),
      source: 'static',
      kind: fallbackKindForTurn({ outcome, hasPr, hasSpec }),
    });

  // Rung 1 — the Mayor's own set, unless it is entirely boilerplate.
  const modelSetIsGeneric = isGenericPillSet(modelPills);
  if (Array.isArray(modelPills) && modelPills.length && !modelSetIsGeneric) {
    return { replies: modelPills, source: 'model' };
  }

  // Built once, shared by both model rungs. Wrapped because this function's
  // whole contract is that it NEVER throws — every caller is on a turn-end
  // path where an exception would cost the user their reply, not just their
  // pills. A context we can't build simply means both model rungs are
  // unavailable and the static set stands in.
  let context = null;
  try {
    context = llm.buildQuickReplyContext({
      appName: session && session.app_name,
      state,
      transcriptTail,
      replyText,
    });
  } catch (err) {
    log.warn('sessions', 'Quick-reply context build failed', {
      sessionId: session && session.id, err: err.message,
    });
  }
  if (!context) return modelSetIsGeneric
    ? { replies: modelPills, source: 'model' }
    : staticRung();

  // Every extra model rung is a new paid call. Re-resolve immediately before
  // each one instead of inheriting the parent turn's payer decision: a build
  // or wrap-up may have consumed the last platform-funded cent meanwhile.
  // Test-only/no-database callers retain their supplied key.
  const resolvePayer = async (rung) => {
    if (!pool || !userId) return { apiKey };
    try {
      const billing = await limits.resolveBillingPath(pool, dataKey, userId);
      if (!billing.error) return { apiKey: billing.apiKey };
      log.info('sessions', 'Quick-reply model rung skipped: no payer available', {
        sessionId: session && session.id, rung, reason: billing.reason || null,
      });
    } catch (err) {
      log.warn('sessions', 'Quick-reply billing resolve failed', {
        sessionId: session && session.id, rung, err: err.message,
      });
    }
    return null;
  };

  const debit = async (usage, servedModel, payerApiKey) => {
    if (!usage || !pool || !userId) return;
    const costCents = llm.estimateCostCents(usage, servedModel);
    if (!costCents) return;
    await limits.recordSpend(pool, userId, costCents, { byok: !!payerApiKey })
      .catch((err) => log.warn('sessions', 'Quick-reply spend record failed', { err: err.message }));
  };

  // Rung 2 — the forced pills-only continuation on the turn's own model.
  if (QR_ENFORCE && allowModelCalls && llm.isEnabled()) {
    try {
      const payer = await resolvePayer('enforced');
      if (!payer) throw new Error('no payer available');
      const forced = await qrWithTimeout((signal) => llm.requireQuickReplies({
        rules: QUICK_REPLY_RULES_TEXT,
        context,
        model,
        tool: SUGGEST_REPLIES_TOOL,
        apiKey: payer.apiKey,
        signal,
        telemetryContext: {
          pool,
          appId: session && session.app_id,
          sessionId: session && session.id,
        },
      }), QR_ENFORCE_TIMEOUT_MS);
      await debit(forced.usage, forced.model, payer.apiKey);
      const replies = sanitizeQuickReplies(forced.replies);
      if (replies) {
        // An enforced set that is STILL all boilerplate is kept anyway —
        // it was at least freshly authored for this turn — and recorded
        // under its own source so the telemetry shows the prompt needs
        // work rather than the mechanism. There is no second retry.
        return {
          replies,
          source: isGenericPillSet(replies) ? 'enforced_generic' : 'enforced',
        };
      }
      log.warn('sessions', 'Forced suggest_replies produced nothing usable', {
        sessionId: session && session.id,
      });
    } catch (err) {
      log.warn('sessions', 'Forced suggest_replies failed', {
        sessionId: session && session.id, err: err.message,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  // Rung 3 — the cheap contextual backstop, on a different model.
  if (allowGenerate && llm.isEnabled()) {
    try {
      const payer = await resolvePayer('generated');
      if (!payer) throw new Error('no payer available');
      const gen = await qrWithTimeout(() => llm.generateQuickReplies({
        rules: QUICK_REPLY_RULES_TEXT,
        context,
        apiKey: payer.apiKey,
        telemetryContext: {
          pool,
          appId: session && session.app_id,
          sessionId: session && session.id,
        },
      }), QR_GENERATE_TIMEOUT_MS);
      await debit(gen.usage, gen.model, payer.apiKey);
      const replies = sanitizeQuickReplies(gen.replies);
      if (replies) {
        return { replies, source: 'generated' };
      }
    } catch (err) {
      log.warn('sessions', 'Contextual quick-reply generation failed', {
        sessionId: session && session.id, err: err.message,
      });
    }
  }

  // Rung 4 — the deterministic set. If the model DID produce something,
  // even all-boilerplate, prefer it over a fixed list: it is at least this
  // turn's own wording.
  if (modelSetIsGeneric) return { replies: modelPills, source: 'model' };
  const fallen = staticRung();
  log.warn('sessions', 'Quick replies fell through to the static set', {
    sessionId: session && session.id, kind: fallen.kind, outcome,
  });
  return fallen;
}

// Assemble the metadata keys that ride alongside metadata.quickReplies
// (#1001 telemetry). `source` is the acceptance instrument: 'model' +
// 'enforced' dominating is what "the assistant proposed at least one
// suggestion itself" looks like in SQL. `kind` narrows a static row to the
// exact fixed set; `preamble` marks a dispatch-preamble row so the
// acceptance query can exclude rows their own turn's wrap-up supersedes.
function quickReplyMeta(resolved, { preamble = false } = {}) {
  if (!resolved || !Array.isArray(resolved.replies) || !resolved.replies.length) return {};
  return {
    quickReplies: resolved.replies,
    ...(resolved.source ? { quickRepliesSource: resolved.source } : {}),
    ...(resolved.source === 'static' && resolved.kind ? { quickRepliesKind: resolved.kind } : {}),
    ...(preamble ? { quickRepliesPreamble: true } : {}),
  };
}

module.exports = {
  QR_ENFORCE,
  QR_ENFORCE_TIMEOUT_MS,
  QR_GENERATE_TIMEOUT_MS,
  qrWithTimeout,
  resolveTurnPills,
  quickReplyMeta,
};
