'use strict';

// Quick-reply pill policy (#786 restart recovery, #894 per-turn fallback).
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
// #894 widened the same hole to ORDINARY turns: suggest_replies is an
// optional tool and production Mayor turns frequently skip it (a chat
// reply with `toolUses: 0`, a wrap-up that ends `end_turn`), and several
// turn-end paths — worker-busy, stop-during-run, refusal, turn error —
// never reach a pill-bearing persist at all. So this module now also
// holds the per-turn fallback policy the chat handler applies whenever a
// turn would otherwise end with no pills anywhere.
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
//
// #894 per-turn fallback kinds (see fallbackKindForTurn):
//
//   chat_generic   — a plain chat reply in a session with neither a spec
//                    nor a PR yet: nothing has happened to follow up on,
//                    so offer the ways in.
//   build_running  — the user sent a message while a worker was already
//                    busy; the only useful next messages are about the
//                    run in flight.
//   turn_failed    — the turn ended badly (dispatch error, user stop,
//                    model refusal, provider error). Same wording as
//                    push_failed, kept as its own key so the recovery
//                    caller's semantics stay readable at the call site.
const RECOVERY_PILLS = Object.freeze({
  code_done: Object.freeze(['Propose it to the group', 'Make a tweak', 'What did it change?']),
  spec_done: Object.freeze(['Build it', 'Revise the spec', 'What will this change?']),
  push_failed: Object.freeze(['Try that again', 'What went wrong?']),
  unrecoverable: Object.freeze(['Try that again', "What's the current state?"]),
  unanswered: Object.freeze(["What's the current state?"]),
  unknown_state: Object.freeze(["What's the current state?", 'Make a change']),
  chat_generic: Object.freeze(['Make a change', 'What issues are open right now?', "What's the current state?"]),
  build_running: Object.freeze(["How's it going?", 'Stop this build']),
  turn_failed: Object.freeze(['Try that again', 'What went wrong?']),
});

// The breadcrumb text for a Mayor turn that died before it could persist
// any reply. Exported so the backfill sweep and its tests agree on the
// exact string (the sweep also uses it to detect its own prior row).
//
// #896: the wording no longer names the restart. A restart is platform
// plumbing the user can do nothing about; what matters to them is that
// the message needs resending. The restart itself stays in the logs and
// in metadata.recovered on the row.
const UNANSWERED_BREADCRUMB =
  "I didn't get to reply to that — send your message again.";

// Earlier wordings of UNANSWERED_BREADCRUMB. The backfill sweep's
// idempotence check compares the session's newest system row against the
// breadcrumb it would post; without the historical strings a boot after
// this rename would post a second breadcrumb on top of a pre-rename one.
const LEGACY_UNANSWERED_BREADCRUMBS = Object.freeze([
  'The platform restarted before I could reply — send your message again.',
]);

// True when `content` is this breadcrumb under its current OR any earlier
// wording — the sweep's "did I already post this?" test.
function isUnansweredBreadcrumb(content) {
  if (typeof content !== 'string') return false;
  return content === UNANSWERED_BREADCRUMB
    || LEGACY_UNANSWERED_BREADCRUMBS.includes(content);
}

// The breadcrumb text for a recovered scout turn whose journal replay
// produced no spec text (previously emit-only, so it vanished on reload).
const SCOUT_NO_SPEC_BREADCRUMB =
  "The scout didn't produce a spec — please send your request again.";

// The breadcrumb text for a coding turn that could not be resumed at all.
// One string for every unresumable shape (worker gone, journal unreadable,
// mid-exec kill, watchdog reap) — the shapes differ only to an operator,
// and metadata.recoveredReason keeps them apart in SQL.
const TURN_UNFINISHED_BREADCRUMB =
  "That coding turn didn't finish — please send your request again.";

// The breadcrumb for a turn that couldn't be resumed BUT whose code
// already landed: the agent committed and the branch is on GitHub, only
// the platform-side wrap-up (preview, cards) was lost. Asking for a
// resend here — which TURN_UNFINISHED_BREADCRUMB does — tells the user to
// redo work that is already safely pushed, and invites a duplicate run
// (session 2954's "continue" cost a full second build turn that produced
// no new commit). So this wording reports what landed and what is being
// repaired instead.
//
// `prNumber` is optional: a tail can die after the push but before the PR
// exists, and naming a PR that isn't there would be worse than vague.
// Per #896 the platform restart itself stays out of the wording — the
// user can't act on it — and lives in metadata.recovered / the logs.
function buildCodeLandedBreadcrumb({ prNumber = null, rebuildingPreview = true } = {}) {
  const where = prNumber ? `pushed to PR #${prNumber}` : 'pushed to your branch';
  return rebuildingPreview
    ? `Your changes are committed and ${where} — rebuilding the preview now.`
    : `Your changes are committed and ${where}.`;
}

// Every wording buildCodeLandedBreadcrumb can produce, as a matcher —
// the boot backfill's "did I already post this?" test needs to recognise
// its own row, and it has no access to the prNumber that shaped it.
function isCodeLandedBreadcrumb(content) {
  if (typeof content !== 'string') return false;
  return /^Your changes are committed and pushed to (PR #\d+|your branch)( — rebuilding the preview now)?\.$/
    .test(content);
}

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

// #894: which pill set a LIVE turn should fall back to when the Mayor
// didn't emit suggest_replies (or the turn ended on a path that never
// reaches a model wrap-up at all).
//
//   outcome — how the turn ended:
//     'chat'        — a plain reply, no dispatch (phase-1 persist).
//     'build_done'  — a dispatch_claude_code wrap-up (phase-2 persist).
//     'spec_done'   — a dispatch_scout wrap-up (phase-2 persist).
//     'failed'      — the dispatched tool reported an error, the model
//                     refused, or the turn threw.
//     'stopped'     — the user stopped the run mid-flight.
//     'worker_busy' — the message arrived while a worker was running.
//   hasPr / hasSpec — session state, used only for the 'chat' outcome
//                     (the dispatch outcomes already know what landed).
//
// Returns a RECOVERY_PILLS key; unknown outcomes degrade to the same
// state-derived choice the boot backfill makes.
function fallbackKindForTurn({ outcome, hasPr, hasSpec } = {}) {
  switch (outcome) {
    case 'build_done': return 'code_done';
    case 'spec_done': return 'spec_done';
    case 'failed':
    case 'stopped': return 'turn_failed';
    case 'worker_busy': return 'build_running';
    case 'chat':
      if (hasPr) return 'code_done';
      if (hasSpec) return 'spec_done';
      return 'chat_generic';
    default:
      return backfillKindForSession({ hasPr, hasSpec });
  }
}

// Convenience wrapper for the chat handler: resolve the kind AND
// materialise the pills in one call, so every turn-end site is a
// one-liner. Returns a fresh array (never null for a known outcome —
// every set above is non-empty).
function turnFallbackQuickReplies(ctx = {}) {
  return buildRecoveryQuickReplies(fallbackKindForTurn(ctx));
}

module.exports = {
  QR_MAX_REPLIES,
  QR_MAX_REPLY_LEN,
  RECOVERY_PILLS,
  UNANSWERED_BREADCRUMB,
  LEGACY_UNANSWERED_BREADCRUMBS,
  isUnansweredBreadcrumb,
  SCOUT_NO_SPEC_BREADCRUMB,
  TURN_UNFINISHED_BREADCRUMB,
  buildCodeLandedBreadcrumb,
  isCodeLandedBreadcrumb,
  buildRecoveryQuickReplies,
  classifyMissingPills,
  backfillKindForSession,
  fallbackKindForTurn,
  turnFallbackQuickReplies,
};
