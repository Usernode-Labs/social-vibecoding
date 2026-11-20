/* The AI allowance, as one state: the single source of truth for "here is
 * where you stand on this week's allowance".
 *
 * `creditState()` normalises either budget payload into one state, and
 * `resetSentence()` words when the allowance comes back. The header's
 * AI-credit row and Settings' usage line read both through
 * frontend/src/features/header/ai-credit.js, so the levels and the sentence
 * are told in the same words in both places (#593). The low-balance
 * threshold is NOT defined here: it arrives on the payload from
 * limits.LOW_BALANCE_PCT, and LOW_PCT below is only the fallback for a
 * payload that predates it.
 */
(function () {
  'use strict';

  // The words come from the language catalog (session.json), read when a
  // caller asks and never when this file is evaluated: the runtime that
  // defines PlatformI18n loads after it.
  function t(id, values) { return PlatformI18n.t(id, values); }

  // ── Where the user stands (#593) ────────────────────────────────────
  //
  // Fallback only: the live value rides on both budget payloads as
  // `lowBalancePct` (src/services/limits.js LOW_BALANCE_PCT is the
  // definition). This keeps a cached page from rendering NaN.
  var LOW_PCT = 80;

  // "3h 20m" / "45m" / "under a minute". null when there is nothing to
  // count down to, so callers can drop the clause instead of printing a
  // gap. `nowMs` is injectable for the tests.
  function resetIn(resetsAt, nowMs) {
    if (!resetsAt) return null;
    var at = Date.parse(resetsAt);
    if (!Number.isFinite(at)) return null;
    var ms = at - (nowMs == null ? Date.now() : nowMs);
    if (ms <= 0) return null;
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return t('session:credits.resetIn.underMinute');
    var hours = Math.floor(mins / 60);
    if (!hours) return t('session:credits.resetIn.minutes', { count: mins });
    var rem = mins % 60;
    return rem
      ? t('session:credits.resetIn.hoursMinutes', { hours: hours, minutes: rem })
      : t('session:credits.resetIn.hours', { count: hours });
  }

  // The one sentence every surface uses to answer "when do I get them
  // back?". The server's boundary is UTC (#2571: Monday 00:00 UTC, the
  // week the one account-wide allowance runs over), but almost nobody
  // reading it is on UTC, so #3230 names the reader's own moment instead
  // ("Free credits reset Sunday at 8:00 PM") through window.ResetTime,
  // which the bundle publishes (frontend/src/lib/reset-time.ts). Where
  // ResetTime is absent (a bare unit sandbox) the sentence keeps naming the
  // UTC boundary as the server states it.
  function resetTime() {
    return (typeof window !== 'undefined' && window.ResetTime) || null;
  }

  var RESET_SENTENCE_IDS = {
    daily: {
      plain: 'session:credits.reset.daily',
      left: 'session:credits.reset.dailyWithTimeLeft',
      plainUtc: 'session:credits.reset.dailyUtc',
      leftUtc: 'session:credits.reset.dailyWithTimeLeftUtc',
    },
    weekly: {
      plain: 'session:credits.reset.weekly',
      left: 'session:credits.reset.weeklyWithTimeLeft',
      plainUtc: 'session:credits.reset.weeklyUtc',
      leftUtc: 'session:credits.reset.weeklyWithTimeLeftUtc',
    },
  };
  function resetSentence(state, nowMs, options) {
    var s = state || {};
    if (s.level === 'locked') {
      return t('session:credits.reset.locked');
    }
    if (s.level === 'unavailable') {
      return t('session:credits.reset.unavailable');
    }
    var weekly = s.capWindow === 'weekly';
    var RT = resetTime();
    var at = s.resetsAt ? new Date(s.resetsAt) : null;
    if (at && !Number.isFinite(at.getTime())) at = null;
    var left = at ? resetIn(s.resetsAt, nowMs) : null;
    if (RT) {
      var resetOptions = { at: at, now: nowMs == null ? undefined : nowMs };
      var moment = RT.resetMoment(weekly ? 'weekly' : 'daily', resetOptions);
      // `withUtc`: the exact UTC instant in brackets, for a surface that is
      // itself a tooltip. One whole message per case, so nothing is added
      // to a finished sentence afterwards.
      var utc = options && options.withUtc
        ? RT.resetUtc(weekly ? 'weekly' : 'daily', { at: s.resetsAt || null, now: resetOptions.now }) : null;
      var ids = RESET_SENTENCE_IDS[weekly ? 'weekly' : 'daily'];
      return t(ids[(left ? 'left' : 'plain') + (utc ? 'Utc' : '')],
        { day: moment.day, time: moment.time, timeLeft: left || '', utc: utc || '' });
    }
    // The server's own name for the boundary, as it states it.
    var resetLabel = s.resetLabel || 'midnight UTC';
    if (weekly) {
      return left
        ? t('session:credits.reset.whenWithTimeLeft', { when: resetLabel, timeLeft: left })
        : t('session:credits.reset.when', { when: resetLabel });
    }
    return left
      ? t('session:credits.reset.atBoundaryWithTimeLeft', { boundary: resetLabel, timeLeft: left })
      : t('session:credits.reset.atBoundary', { boundary: resetLabel });
  }

  // Normalises either budget payload into one state: GET /api/budget
  // (spend + the shared cap + BYOK spillover) and GET /api/me/ai-budget (no
  // global figures — those are admin-only, see redact() in
  // services/status.js). Both describe the same allowance, so both collapse
  // to the same levels:
  //
  //   unknown   — nothing fetched yet, or malformed figures: say nothing
  //   locked    — identity tiers are active and no provider is verified
  //   unavailable — tier eligibility could not be read (fail closed)
  //   ok        — headroom
  //   low       — at or past lowBalancePct of the cap; warn proactively
  //   exhausted — the personal allowance or the shared one is spent
  //
  // `level` describes the ALLOWANCE. People's own Anthropic keys, which
  // once bypassed the cap (#119), went in task 2275, so an exhausted
  // allowance is exhausted.
  function creditState(snapshot) {
    var s = snapshot || null;
    var limitCents = s ? Number(s.limitCents) : NaN;
    var spentCents = s ? Number(s.spentCents) : NaN;
    if (!s || !Number.isFinite(limitCents) || !Number.isFinite(spentCents) || limitCents < 0) {
      return {
        level: 'unknown', limitCents: 0, spentCents: 0, remainingCents: 0,
        byokCents: 0, pctUsed: 0,
        globalOut: false, resetsAt: (s && s.resetsAt) || null,
        lowPct: (s && Number(s.lowBalancePct)) || LOW_PCT,
        capWindow: (s && s.capWindow) || 'daily',
        windowLabel: (s && s.windowLabel) || 'Today',
        resetLabel: (s && s.resetLabel) || 'midnight UTC',
      };
    }
    var verificationRequired = !!s.verificationRequired;
    var entitlementAvailable = s.entitlementAvailable !== false;
    var remainingCents = Number.isFinite(Number(s.remainingCents))
      ? Math.max(0, Number(s.remainingCents))
      : Math.max(0, limitCents - spentCents);
    // Both spellings: /api/budget calls it byokSpentCents, the other
    // payload calls it byokCents.
    var byokCents = Number(s.byokCents);
    if (!Number.isFinite(byokCents)) byokCents = Number(s.byokSpentCents);
    if (!Number.isFinite(byokCents)) byokCents = 0;
    var globalLimit = Number(s.globalLimitCents);
    var globalSpent = Number(s.globalSpentCents);
    var globalOut = Number.isFinite(globalLimit) && globalLimit > 0
      && Number.isFinite(globalSpent) && globalSpent >= globalLimit;
    var lowPct = Number(s.lowBalancePct);
    if (!Number.isFinite(lowPct) || lowPct <= 0 || lowPct >= 100) lowPct = LOW_PCT;
    var pctUsed = limitCents > 0
      ? Math.min(100, (spentCents / limitCents) * 100)
      : 0;
    var level = limitCents === 0 ? 'exhausted' : 'ok';
    if (!entitlementAvailable) level = 'unavailable';
    else if (verificationRequired && limitCents === 0) level = 'locked';
    else if (globalOut || spentCents >= limitCents) level = 'exhausted';
    else if (pctUsed >= lowPct) level = 'low';
    return {
      level: level,
      limitCents: limitCents,
      spentCents: spentCents,
      remainingCents: remainingCents,
      byokCents: byokCents,
      pctUsed: pctUsed,
      globalOut: globalOut,
      resetsAt: s.resetsAt || null,
      // #1788 gave the allowance two windows and reported whichever was
      // BINDING in the legacy limit/spent/remaining fields; #2571 leaves
      // one, and the server always names it. These three still say which
      // window the figures describe, so every sentence below names the
      // right boundary; the daily spellings survive only as the fallback
      // for a payload that carries no window at all.
      capWindow: s.capWindow || 'daily',
      windowLabel: s.windowLabel || 'Today',
      resetLabel: s.resetLabel || 'midnight UTC',
      lowPct: lowPct,
      verificationRequired: verificationRequired,
      entitlementAvailable: entitlementAvailable,
      creditPolicy: s.creditPolicy || null,
      tier: s.tier || null,
      tierLimitCents: Number.isFinite(Number(s.tierLimitCents))
        ? Number(s.tierLimitCents) : 1000,
    };
  }

  var CreditOptions = {
    resetSentence: resetSentence,
    creditState: creditState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CreditOptions;
  }
  if (typeof window !== 'undefined') {
    window.CreditOptions = CreditOptions;
  }
})();
