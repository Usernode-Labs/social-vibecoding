'use strict';

// Restart-recovery quick-reply pill policy (#786).
//
// Background: the dev-chat pill bar above the composer renders from the
// newest message that carries metadata.quickReplies. Those pills are
// produced by the Mayor's suggest_replies tool — and on a dispatch turn
// they come ONLY from the phase-2 post-build wrap-up (resolveQuickReplies
// in routes/sessions.js deliberately drops a phase-1 call when a dispatch
// co-occurs). A platform restart mid-turn recovers the coding work but
// never re-runs that wrap-up, so the turn ends with recovery breadcrumbs
// (role 'system') and no pills anywhere: the bar goes empty and stays
// empty until the user types something themselves.
//
// This module holds the deterministic replacement — no LLM call on the
// boot path (no request context, no user key selection, no billing
// attribution; see the resumeDetachedTurnInner comment about phase-2
// narration deliberately not being resumed). Same precedent as the static
// buildHeadlessFollowUpQuickReplies sets in routes/sessions.js.
//
// Pure by design (no docker, no pg) so the policy is unit-testable —
// same pattern as turn-watchdog.js. It deliberately does NOT require
// routes/sessions.js for sanitizeQuickReplies (that would be a
// services → routes cycle); instead every set below already satisfies
// the sanitizer's contract (<= 3 entries, <= 80 chars, no dupes) and
// tests assert that by round-tripping through it.

// Mirror of QR_MAX_REPLIES / QR_MAX_REPLY_LEN in routes/sessions.js.
const QR_MAX_REPLIES = 3;
const QR_MAX_REPLY_LEN = 80;

// Pills per recovery kind. Wording is first-person and sendable because
// tapping a pill PREFILLS the composer (it never triggers an action).
//
//   code_done      — a build turn was recovered: commit pushed, PR opened,
//                    staging rebuilt. Mirrors the 'code' set in
//                    buildHeadlessFollowUpQuickReplies.
//   spec_done      — a scout turn was recovered and left a spec.
//   push_failed    — the recovered build committed but the push failed.
//   unrecoverable  — the turn could not be resumed at all (worker gone,
//                    journal unreadable, watchdog reap).
//   unanswered     — the Mayor turn died before persisting any reply; the
//                    user's own message is prepended as a resend pill by
//                    buildRecoveryQuickReplies.
//   unknown_state  — backfill fallback when the session's state doesn't
//                    identify a PR or a spec.
const RECOVERY_PILLS = Object.freeze({
  code_done: Object.freeze(['Propose it to the group', 'Make a tweak', 'What did it change?']),
  spec_done: Object.freeze(['Build it', 'Revise the spec', 'What will this change?']),
  push_failed: Object.freeze(['Try that again', 'What went wrong?']),
  unrecoverable: Object.freeze(['Try that again', "What's the current state?"]),
  unanswered: Object.freeze(["What's the current state?"]),
  unknown_state: Object.freeze(["What's the current state?", 'Make a change']),
});

// The breadcrumb text for a Mayor turn that died before it could persist
// any reply. Exported so the backfill sweep and its tests agree on the
// exact string (the sweep also uses it to detect its own prior row).
const UNANSWERED_BREADCRUMB =
  'The platform restarted before I could reply — send your message again.';

// The breadcrumb text for a recovered scout turn whose journal replay
// produced no spec text (previously emit-only, so it vanished on reload).
const SCOUT_NO_SPEC_BREADCRUMB =
  'Scout finished after restart but produced no spec — please retry your request.';

// Build the pill list for one recovery kind.
//
//   kind — a RECOVERY_PILLS key.
//   ctx  — { lastUserText } for the 'unanswered' kind: the text of the
//          user message that never got a reply. Prepended verbatim as a
//          resend pill ONLY when it fits a pill (<= QR_MAX_REPLY_LEN
//          after trimming) — a clipped message would be a misleading
//          thing to hand back for one-tap resending.
//
// Returns a fresh mutable array, or null for an unknown kind (callers
// skip persistence on null, degrading to today's "no pills").
function buildRecoveryQuickReplies(kind, ctx = {}) {
  const base = RECOVERY_PILLS[kind];
  if (!base) return null;
  const out = [];
  if (kind === 'unanswered') {
    const raw = ctx && typeof ctx.lastUserText === 'string' ? ctx.lastUserText.trim() : '';
    if (raw && raw.length <= QR_MAX_REPLY_LEN) out.push(raw);
  }
  for (const pill of base) {
    if (out.length >= QR_MAX_REPLIES) break;
    // Case-insensitive dedupe against the resend pill, mirroring
    // sanitizeQuickReplies so the result is already sanitizer-clean.
    if (out.some((p) => p.toLowerCase() === pill.toLowerCase())) continue;
    out.push(pill);
  }
  return out.length ? out : null;
}

// Decide what the boot-time backfill sweep should do for one session,
// given the newest message row whose role is 'user' or 'assistant'
// (system breadcrumbs are transparent to the client's pill resolution,
// so they are not the deciding row).
//
//   lastRow — { role, metadata } or null (session with no such row).
//
// Returns:
//   'skip'                   — nothing to repair.
//   'attach_assistant'       — attach derived pills to that assistant row.
//   'breadcrumb_unanswered'  — the turn died before replying; post the
//                              breadcrumb + resend pills.
function classifyMissingPills({ lastRow } = {}) {
  if (!lastRow || !lastRow.role) return 'skip';
  const meta = lastRow.metadata || {};
  const pills = meta.quickReplies;
  if (Array.isArray(pills) && pills.length) return 'skip';
  if (lastRow.role === 'assistant') {
    // The #32 inline answer chips take precedence over the above-box
    // pills — same rule resolveQuickReplies enforces server-side.
    if (Array.isArray(meta.suggestions) && meta.suggestions.length) return 'skip';
    return 'attach_assistant';
  }
  if (lastRow.role === 'user') return 'breadcrumb_unanswered';
  return 'skip';
}

// Which pill set a backfilled assistant row should get, from the
// session's own state: a PR means the build landed, otherwise a spec
// means scout work landed, otherwise we don't know what happened.
function backfillKindForSession({ hasPr, hasSpec } = {}) {
  if (hasPr) return 'code_done';
  if (hasSpec) return 'spec_done';
  return 'unknown_state';
}

module.exports = {
  QR_MAX_REPLIES,
  QR_MAX_REPLY_LEN,
  RECOVERY_PILLS,
  UNANSWERED_BREADCRUMB,
  SCOUT_NO_SPEC_BREADCRUMB,
  buildRecoveryQuickReplies,
  classifyMissingPills,
  backfillKindForSession,
};
