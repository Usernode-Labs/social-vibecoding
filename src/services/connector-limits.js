'use strict';

// Hosted MCP connector — the caps that only exist for connector traffic.
//
// The connector deliberately does its work through the platform's own
// routes, so every cap those routes already enforce (daily credit budget,
// active-session cap, the global worker cap) applies to it for free. This
// module holds the ones that do NOT come for free:
//
//   1. The promoted-session cap. POST /api/sessions/:id/promote enforces it;
//      POST /api/apps/:slug/pr-import does not, because an import was
//      previously something a human did by hand, one at a time, from a
//      picker. submit_work reaches pr-import from a loop that a model can
//      run, so it has to apply the same bound the browser's promote path
//      applies — otherwise the connector becomes the way around it.
//   2. Rate bounds on prepare_work itself. It no longer writes anything to
//      GitHub — the user's own coding agent makes the fork and the branch —
//      but a confused model retrying it still mints task rows, each of which
//      is a work order somebody may act on, so a loop must not turn into an
//      unbounded pile of dead reservations (or of forks, one step
//      downstream). The key keeps its old name to avoid churn.
//   3. Bounds on the platform-build fallback, which spends the platform's
//      own credits (the primary path spends the user's coding-agent
//      subscription instead).
//
// Every check returns null when the request may proceed, or a plain
// { code, message } that the caller turns into a tool error. The wording is
// user-facing: it is read aloud by an assistant to somebody who cannot see
// the platform UI, so it says what to do next.

const log = require('./logger');
const { effectiveSessionCaps } = require('./session-caps');

// Deliberately small. These are not throughput knobs — they are the point
// at which "the model is looping" becomes more likely than "the user is
// working".
const LIMITS = Object.freeze({
  proposalsPerDay: 5,      // connector-authored proposals per user per 24h
  forksPerHour: 3,         // prepare_work work orders per user per hour
  openTasks: 10,           // un-submitted work orders held at once
  fallbackInFlight: 2,     // platform builds running at once
  fallbackPerDay: 10,      // platform builds started per user per 24h
});

function limitError(code, message) {
  return { code, message };
}

// A limiter that cannot run does not wave the request through: these bound
// writes to GitHub and to the vote queue, so an unavailable database is a
// reason to stop, not a reason to proceed.
async function countOr(pool, sql, params, label) {
  try {
    const { rows } = await pool.query(sql, params);
    return parseInt(rows[0].cnt, 10) || 0;
  } catch (err) {
    log.warn('connector-limits', 'cap query failed', { label, err: err.message });
    return null;
  }
}

const UNAVAILABLE = limitError(
  'platform_unavailable',
  'Usernode could not check your limits just now. Try again shortly.'
);

// ── 1. The promoted-session cap ────────────────────────────────────────
//
// Mirrors routes/votes.js's promote handler exactly, including the wording,
// so a user hits one bound with one explanation regardless of which surface
// they came in through. Headless rows are excluded there and here.
async function checkPromotedCap(pool, config, user) {
  const caps = effectiveSessionCaps(config, user);
  const count = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM chat_sessions
      WHERE user_id = $1 AND status IN ('promoted', 'merging') AND is_headless = FALSE`,
    [user.id],
    'promoted-cap'
  );
  if (count === null) return UNAVAILABLE;
  if (count >= caps.promotedSessions) {
    return limitError(
      'at_capacity',
      `You already have ${caps.promotedSessions} PRs up for vote. `
      + 'Wait for one to merge, or archive one first.'
    );
  }
  return null;
}

// ── 2. Connector-authored proposals per day ────────────────────────────
async function checkProposalRate(pool, userId) {
  const count = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM chat_sessions
      WHERE user_id = $1 AND external_agent IS NOT NULL
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId],
    'proposal-rate'
  );
  if (count === null) return UNAVAILABLE;
  if (count >= LIMITS.proposalsPerDay) {
    return limitError(
      'at_capacity',
      `You have opened ${LIMITS.proposalsPerDay} proposals from a connected coding agent in the last 24 hours, `
      + 'which is the daily limit. The proposals already up for a vote are unaffected.'
    );
  }
  return null;
}

// ── 2b. prepare_work reservations ──────────────────────────────────────
//
// Two separate bounds because they fail for different reasons and deserve
// different advice: too many too fast (slow down) versus too many at once
// (finish or drop some).
async function checkPrepareRate(pool, userId) {
  const recent = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM external_agent_tasks
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId],
    'prepare-rate'
  );
  if (recent === null) return UNAVAILABLE;
  if (recent >= LIMITS.forksPerHour) {
    return limitError(
      'at_capacity',
      `You have started ${LIMITS.forksPerHour} pieces of work in the last hour, which is the limit. `
      + 'Finish or submit one before starting another.'
    );
  }

  const open = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM external_agent_tasks
      WHERE user_id = $1 AND status = 'open' AND expires_at > NOW()`,
    [userId],
    'open-tasks'
  );
  if (open === null) return UNAVAILABLE;
  if (open >= LIMITS.openTasks) {
    return limitError(
      'at_capacity',
      `You have ${LIMITS.openTasks} pieces of work started and not yet submitted, which is the limit. `
      + 'Submit one, or abandon one, before starting another.'
    );
  }
  return null;
}

// ── 3. The platform-build fallback ─────────────────────────────────────
//
// This path spends the platform's credits rather than the user's own
// coding-agent subscription, so it is bounded more tightly than the primary
// path. The daily credit budget still applies underneath (the platform
// route consults limits.resolveBillingPath itself); these two bounds stop a
// model from queueing builds faster than a human would ever read them.
async function checkFallbackStart(pool, userId) {
  const inFlight = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM chat_sessions
      WHERE user_id = $1 AND is_headless = TRUE AND headless_status = 'generating'`,
    [userId],
    'fallback-in-flight'
  );
  if (inFlight === null) return UNAVAILABLE;
  if (inFlight >= LIMITS.fallbackInFlight) {
    return limitError(
      'at_capacity',
      `You already have ${LIMITS.fallbackInFlight} Usernode builds running. `
      + 'Wait for one to finish before starting another.'
    );
  }

  const today = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM chat_sessions
      WHERE user_id = $1 AND is_headless = TRUE
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId],
    'fallback-daily'
  );
  if (today === null) return UNAVAILABLE;
  if (today >= LIMITS.fallbackPerDay) {
    return limitError(
      'at_capacity',
      `You have started ${LIMITS.fallbackPerDay} Usernode builds in the last 24 hours, which is the daily limit.`
    );
  }
  return null;
}

module.exports = {
  LIMITS,
  checkPromotedCap,
  checkProposalRate,
  checkPrepareRate,
  checkFallbackStart,
};
