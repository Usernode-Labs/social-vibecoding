// Outbound-mail throttling, as a pure decision function.
//
// The two limits this exists for are different in kind:
//
//  - PER RECIPIENT. POST /api/v4/mobile/auth/otp/request is always-200 and
//    unauthenticated. Its express rate limiter is keyed by IP, so a
//    distributed caller can still aim an unbounded stream of mail at ONE
//    address — a mail-bomb with the platform as the amplifier. Capping per
//    recipient closes that regardless of where the requests come from.
//  - GLOBALLY. Every provider bills, and most suspend a sender that
//    spikes. A single global ceiling means the worst case for a runaway
//    loop or an abusive burst is a bounded bill and a bounded reputation
//    hit, not an unbounded one.
//
// Kept pure — no clock, no database — so the windows are testable without
// a Postgres or a timer. index.js reads the history and passes it in.
'use strict';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Per-kind recipient rules. `minGapMs` collapses a double-tap; `perHour`
// bounds a determined one.
const RULES = {
  // A user may legitimately re-request a code (typo'd address, mail
  // delayed), so the gap is short and the hourly ceiling is what actually
  // bounds abuse.
  otp: { minGapMs: 60 * 1000, perWindow: 5, windowMs: HOUR_MS },
  // Joining is idempotent by email: a second confirmation the same day
  // carries no new information, and the mail is the same words.
  waitlist_joined: { minGapMs: DAY_MS, perWindow: 1, windowMs: DAY_MS },
  // Released once per signup by construction (newly_released), so this is
  // a backstop against a stuck admin button, not a normal path.
  waitlist_released: { minGapMs: 60 * 1000, perWindow: 3, windowMs: DAY_MS },
};

const DEFAULT_MAX_PER_HOUR = 300;

// Only these statuses count toward a window. A `failed`,
// `suppressed_rate_limit` or `no_transport` row consumed no provider quota
// and delivered nothing, so counting it would let one broken send lock a
// recipient out of a working one. `skipped_staging` DOES count, so a
// staging preview exercises the identical throttle it will meet in
// production.
const COUNTED_STATUSES = new Set(['sent', 'skipped_staging']);

function counts(history) {
  return (Array.isArray(history) ? history : [])
    .filter((row) => row && COUNTED_STATUSES.has(row.status));
}

// decide({ kind, now, recipientHistory, globalCount, maxPerHour })
//   recipientHistory: rows for THIS recipient and kind, newest first, each
//     { status, created_at }
//   globalCount: counted sends across all recipients in the last hour
// Returns { allowed, reason, retryAfterMs }.
function decide({
  kind,
  now = 0,
  recipientHistory = [],
  globalCount = 0,
  maxPerHour = DEFAULT_MAX_PER_HOUR,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || 0;
  const cap = Number(maxPerHour) > 0 ? Number(maxPerHour) : DEFAULT_MAX_PER_HOUR;

  if (globalCount >= cap) {
    return {
      allowed: false,
      reason: `global cap of ${cap} mails/hour reached`,
      retryAfterMs: HOUR_MS,
    };
  }

  const rule = RULES[kind];
  // An unknown kind has no per-recipient rule yet; the global cap still
  // applies. Better to deliver a new kind of mail than to silently drop it
  // because nobody added a row here.
  if (!rule) return { allowed: true, reason: null, retryAfterMs: 0 };

  const relevant = counts(recipientHistory)
    .map((row) => ({
      ...row,
      at: row.created_at instanceof Date
        ? row.created_at.getTime()
        : new Date(row.created_at).getTime(),
    }))
    .filter((row) => Number.isFinite(row.at))
    .sort((a, b) => b.at - a.at);

  const last = relevant[0];
  if (last && nowMs - last.at < rule.minGapMs) {
    return {
      allowed: false,
      reason: `another ${kind} mail went to this address ${
        Math.round((nowMs - last.at) / 1000)}s ago`,
      retryAfterMs: rule.minGapMs - (nowMs - last.at),
    };
  }

  const inWindow = relevant.filter((row) => nowMs - row.at < rule.windowMs);
  if (inWindow.length >= rule.perWindow) {
    const oldest = inWindow[inWindow.length - 1];
    return {
      allowed: false,
      reason: `${inWindow.length} ${kind} mails already sent to this address in the window`,
      retryAfterMs: Math.max(0, rule.windowMs - (nowMs - oldest.at)),
    };
  }

  return { allowed: true, reason: null, retryAfterMs: 0 };
}

module.exports = {
  decide, RULES, DEFAULT_MAX_PER_HOUR, COUNTED_STATUSES, HOUR_MS, DAY_MS,
};
