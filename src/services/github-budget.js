'use strict';

// GitHub's REST budget, as GitHub itself reports it on every response.
//
// The platform talks to GitHub with a few credentials, and each one has its
// own hourly budget:
//
//   pat                    the bot's personal access token (GITHUB_BOT_TOKEN):
//                          5,000 requests an hour, shared by everything the
//                          platform does with it. On 2026-10-04 it ran out,
//                          and new proposals and before/after shots failed
//                          until the hour reset.
//   installation:<owner>   a GitHub App installation token: its own budget,
//                          5,000 an hour and more for a larger installation.
//   anonymous              an unauthenticated read: 60 an hour per IP.
//
// Every response, success or error, carries x-ratelimit-limit, -remaining,
// -reset, -used and -resource, and those headers are the only authoritative
// figure there is. Nothing here counts requests itself; record() keeps the
// newest figures per credential and resource.
//
// IN MEMORY, PER PROCESS, ON PURPOSE. The platform runs one replica by
// default. The headers report the credential's account-wide count, not this
// process's share, so another replica's requests still show up in the next
// response this one sees. A restart starts with nothing known, which reads as
// "allowed" below: the first response fills it in.
//
// Two questions are answered from it:
//
//   backgroundHold() / budgetAllows('background')
//       Timer-driven work (the drift poller, the merge follow-up sweep, the
//       Homeroom bot's passes, ...) asks before it spends any. While the known
//       core budget of the credential it would use is under RESERVE_RATIO of
//       the limit and the reset is still ahead, the answer is no, and one log
//       line per credential per window says so. What people start is never
//       held back: it does not ask, so it keeps the reserve.
//
//   rateLimitNotice(err)
//       The plain-words sentence for a request GitHub refused because the
//       hourly budget is used up, with when it resets. Local time is not known
//       server-side, so it says "in about N minutes".
//
// services/platform-limit-alerts.js reads alertFigures() to tell the full
// admins when a credential's core budget falls under a fifth and when it is
// used up, and GET /api/admin/github-budget serves snapshot() to Admin, Limits.

const log = require('./logger');

// Background work waits once less than this share of the limit is left.
const RESERVE_RATIO = 0.15;
// Two responses whose reset times are closer than this are the same window.
// A new window resets about an hour after the previous one, so a minute is
// a wide margin either way.
const SAME_WINDOW_MS = 60 * 1000;

// credential -> Map<resource, { limit, remaining, used, resetAt, observedAt }>
const state = new Map();
// Which credential answered the reads routed by services/github.js
// getReadOctokit (GITHUB_READS_VIA_APP), since this process started: the
// App installation, or the bot token, and why the bot token.
const reads = { installation: 0, pat: 0, patReasons: {} };
// "<credential>@<resetAt>" for the windows already logged as held.
const heldLogged = new Set();

function toInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

// Octokit hands headers over as a plain object with lowercase keys; fetch
// hands over a Headers instance.
function headerGetter(headers) {
  if (!headers || typeof headers !== 'object') return () => null;
  if (typeof headers.get === 'function') return (name) => headers.get(name);
  return (name) => {
    const v = headers[name];
    return v == null ? null : String(v);
  };
}

function normalizeCredential(credential) {
  const c = String(credential || '').trim();
  if (c === 'pat' || c === 'anonymous') return c;
  const m = /^installation:([A-Za-z0-9_.-]{1,100})$/.exec(c);
  return m ? `installation:${m[1].toLowerCase()}` : null;
}

function parse(headers) {
  const get = headerGetter(headers);
  const limit = toInt(get('x-ratelimit-limit'));
  const remaining = toInt(get('x-ratelimit-remaining'));
  const reset = toInt(get('x-ratelimit-reset'));
  if (limit == null || remaining == null || reset == null || limit <= 0) return null;
  const used = toInt(get('x-ratelimit-used'));
  const resource = String(get('x-ratelimit-resource') || 'core').trim().toLowerCase().slice(0, 32) || 'core';
  return {
    resource,
    limit,
    remaining: Math.max(0, remaining),
    used: used == null ? Math.max(0, limit - remaining) : Math.max(0, used),
    resetAt: reset * 1000,
  };
}

/**
 * Record one response's rate-limit headers for a credential. Accepts a fetch
 * Headers or an Octokit headers object, from a success or an error. Returns
 * the entry now held for that resource, or null when the response carried no
 * figures (a network error, a non-GitHub stub).
 *
 * Responses can land out of order. Within one window the remaining figure
 * only falls, so the lowest one wins; a response from an older window never
 * replaces a newer one.
 */
function record(credential, headers, { now = Date.now() } = {}) {
  const cred = normalizeCredential(credential);
  if (!cred) return null;
  const figures = parse(headers);
  if (!figures) return null;
  let byResource = state.get(cred);
  if (!byResource) {
    byResource = new Map();
    state.set(cred, byResource);
  }
  const prev = byResource.get(figures.resource);
  if (prev) {
    if (figures.resetAt <= prev.resetAt - SAME_WINDOW_MS) return prev;
    if (Math.abs(figures.resetAt - prev.resetAt) < SAME_WINDOW_MS && figures.remaining >= prev.remaining) {
      prev.limit = figures.limit;
      prev.observedAt = now;
      return prev;
    }
  }
  const entry = {
    limit: figures.limit,
    remaining: figures.remaining,
    used: figures.used,
    resetAt: figures.resetAt,
    observedAt: now,
  };
  byResource.set(figures.resource, entry);
  return entry;
}

/** The core figures for a credential, or null when nothing is known. */
function core(credential, { now = Date.now() } = {}) {
  const cred = normalizeCredential(credential);
  const entry = cred && state.get(cred) && state.get(cred).get('core');
  if (!entry) return null;
  // A window whose reset has passed is a full budget again, whatever the
  // last response in it said.
  const expired = entry.resetAt <= now;
  return {
    credential: cred,
    limit: entry.limit,
    remaining: expired ? entry.limit : entry.remaining,
    used: expired ? 0 : entry.used,
    resetAt: entry.resetAt,
    observedAt: entry.observedAt,
    expired,
  };
}

/**
 * Whether the credential's core budget is known to be used up for the
 * current window: nothing left and the reset still ahead.
 */
function isExhausted(credential, { now = Date.now() } = {}) {
  const c = core(credential, { now });
  return !!(c && !c.expired && c.remaining <= 0);
}

/**
 * Count one routed read: 'installation', or 'pat' with the reason the bot
 * token answered it (no_installation, budget_used_up, status_403, ...).
 */
function noteRead(source, reason = null) {
  if (source === 'installation') {
    reads.installation += 1;
    return;
  }
  reads.pat += 1;
  const why = String(reason || 'unknown').slice(0, 32);
  reads.patReasons[why] = (reads.patReasons[why] || 0) + 1;
}

function installationCredentials() {
  return [...state.keys()].filter((c) => c.startsWith('installation:'));
}

// The credential(s) background work spends: the bot token when one is
// configured (services/github.js getOctokit prefers it), else the App
// installation for `owner`, or every known installation when no owner is
// named.
function backgroundCredentials(owner) {
  if (process.env.GITHUB_BOT_TOKEN) return ['pat'];
  if (owner) return [normalizeCredential(`installation:${owner}`)].filter(Boolean);
  return installationCredentials();
}

function reserveFor(limit) {
  return Math.ceil(limit * RESERVE_RATIO);
}

/**
 * Null when background GitHub work may go ahead, else why not:
 * { credential, remaining, limit, reserve, resetAt, retryInMs }.
 * Logs once per credential per window when it first holds.
 */
function backgroundHold({ credential = null, owner = null, now = Date.now() } = {}) {
  const creds = credential ? [normalizeCredential(credential)].filter(Boolean) : backgroundCredentials(owner);
  for (const cred of creds) {
    const c = core(cred, { now });
    if (!c || c.expired) continue;
    const reserve = reserveFor(c.limit);
    if (c.remaining >= reserve) continue;
    const hold = {
      credential: cred,
      remaining: c.remaining,
      limit: c.limit,
      reserve,
      resetAt: c.resetAt,
      retryInMs: Math.max(0, c.resetAt - now),
    };
    const key = `${cred}@${c.resetAt}`;
    if (!heldLogged.has(key)) {
      heldLogged.add(key);
      if (heldLogged.size > 64) heldLogged.delete(heldLogged.values().next().value);
      log.warn('github-budget', 'Holding background GitHub work until the hourly budget resets', {
        credential: cred,
        remaining: c.remaining,
        limit: c.limit,
        reserve,
        resetInMinutes: Math.ceil(hold.retryInMs / 60000),
      });
    }
    return hold;
  }
  return null;
}

/**
 * Whether work of this kind may spend GitHub budget now. Only 'background'
 * is ever held back; anything else (a person's request) is always allowed.
 */
function budgetAllows(kind = 'background', opts = {}) {
  if (kind !== 'background') return true;
  return !backgroundHold(opts);
}

/**
 * The figures the platform-limit alert measures, for one credential class:
 * 'pat' for the bot token, 'installation' for the App (the most-used of its
 * installations). { used, cap } with both 0 when nothing is known.
 */
function alertFigures(kind, { now = Date.now() } = {}) {
  const creds = kind === 'installation' ? installationCredentials() : [normalizeCredential(kind)];
  let best = { used: 0, cap: 0 };
  let bestRatio = -1;
  for (const cred of creds) {
    const c = cred && core(cred, { now });
    if (!c) continue;
    const ratio = c.limit > 0 ? c.used / c.limit : 0;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = { used: Math.min(c.used, c.limit), cap: c.limit };
    }
  }
  return best;
}

/**
 * Everything recorded, for the admin read: one row per credential and
 * resource, the bot token first, core first within each.
 */
function snapshot({ now = Date.now() } = {}) {
  const rows = [];
  for (const [credential, byResource] of state) {
    for (const [resource, e] of byResource) {
      const expired = e.resetAt <= now;
      rows.push({
        credential,
        kind: credential === 'pat' ? 'pat' : (credential === 'anonymous' ? 'anonymous' : 'installation'),
        owner: credential.startsWith('installation:') ? credential.slice('installation:'.length) : null,
        resource,
        limit: e.limit,
        remaining: e.remaining,
        used: e.used,
        resetAt: new Date(e.resetAt).toISOString(),
        resetInSeconds: Math.max(0, Math.round((e.resetAt - now) / 1000)),
        observedAt: new Date(e.observedAt).toISOString(),
        expired,
        held: resource === 'core' && !expired && e.remaining < reserveFor(e.limit),
      });
    }
  }
  const order = { pat: 0, installation: 1, anonymous: 2 };
  rows.sort((a, b) => (order[a.kind] - order[b.kind])
    || a.credential.localeCompare(b.credential)
    || (a.resource === 'core' ? -1 : 0) - (b.resource === 'core' ? -1 : 0)
    || a.resource.localeCompare(b.resource));
  return {
    reservePercent: Math.round(RESERVE_RATIO * 100),
    credentials: rows,
    reads: { installation: reads.installation, pat: reads.pat, patReasons: { ...reads.patReasons } },
  };
}

/**
 * Fixed sample figures in snapshot()'s shape, for a platform preview, which
 * has no GitHub token and so never records any (routes/admin.js). One
 * credential under the reserve, so the preview shows the held state too.
 */
function demoSnapshot({ now = Date.now() } = {}) {
  const row = (credential, limit, remaining, resetMin) => {
    const resetAt = now + resetMin * 60 * 1000;
    return {
      credential,
      kind: credential === 'pat' ? 'pat' : 'installation',
      owner: credential.startsWith('installation:') ? credential.slice('installation:'.length) : null,
      resource: 'core',
      limit,
      remaining,
      used: limit - remaining,
      resetAt: new Date(resetAt).toISOString(),
      resetInSeconds: resetMin * 60,
      observedAt: new Date(now - 20 * 1000).toISOString(),
      expired: false,
      held: remaining < reserveFor(limit),
    };
  };
  return {
    reservePercent: Math.round(RESERVE_RATIO * 100),
    credentials: [
      row('pat', 5000, 612, 23),
      row('installation:usernode-labs', 12500, 11870, 41),
    ],
  };
}

// ── Saying what happened ──────────────────────────────────────────────

/**
 * Whether `err` is GitHub refusing a request because a primary (hourly)
 * budget is used up: a 403 or 429 that says x-ratelimit-remaining: 0, or
 * GitHub's own "API rate limit exceeded" wording when the headers are gone
 * (an error passed along as a message). A secondary (per-minute) limit keeps
 * remaining above zero and is not this.
 */
function isRateLimitError(err) {
  if (!err) return false;
  const status = Number(err.status || (err.response && err.response.status)) || 0;
  const get = headerGetter(err.response && err.response.headers);
  if ((status === 403 || status === 429) && get('x-ratelimit-remaining') === '0') return true;
  return /\bAPI rate limit exceeded\b/i.test(String(err.message || err));
}

// When the budget that refused `err` resets, in ms from now, or null when
// nothing says. The error's own header first, then the bot token's recorded
// window (the credential nearly every refusal comes from).
function resetInMs(err, { now = Date.now() } = {}) {
  const get = headerGetter(err && err.response && err.response.headers);
  const reset = toInt(get('x-ratelimit-reset'));
  if (reset != null && reset * 1000 > now) return reset * 1000 - now;
  for (const cred of [...backgroundCredentials(), 'pat']) {
    const c = core(cred, { now });
    if (c && !c.expired && c.remaining === 0) return c.resetAt - now;
  }
  return null;
}

function aboutMinutes(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m === 1 ? 'about a minute' : `about ${m} minutes`;
}

/**
 * "GitHub's hourly limit for Homeroom is used up. It resets in about 12
 * minutes." for a rate-limit refusal, else null.
 */
function rateLimitNotice(err, { now = Date.now() } = {}) {
  if (!isRateLimitError(err)) return null;
  const ms = resetInMs(err, { now });
  const when = ms == null ? 'It resets within the hour.' : `It resets in ${aboutMinutes(ms)}.`;
  return `GitHub's hourly limit for Homeroom is used up. ${when}`;
}

/** Seconds until the refusing budget resets, or null (for a Retry-After). */
function rateLimitRetryAfterSeconds(err, { now = Date.now() } = {}) {
  if (!isRateLimitError(err)) return null;
  const ms = resetInMs(err, { now });
  return ms == null ? null : Math.max(1, Math.ceil(ms / 1000));
}

/**
 * The body of a route's 503 `github_unavailable`: the bare code as before,
 * plus `message` (and `retryAfterSeconds`) when the refusal was the hourly
 * budget, so a CLI or connector can say what really happened.
 */
function githubUnavailableBody(err, { now = Date.now() } = {}) {
  const message = rateLimitNotice(err, { now });
  if (!message) return { error: 'github_unavailable' };
  const retryAfterSeconds = rateLimitRetryAfterSeconds(err, { now });
  return { error: 'github_unavailable', message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}

function _resetForTests() {
  state.clear();
  heldLogged.clear();
  reads.installation = 0;
  reads.pat = 0;
  reads.patReasons = {};
}

module.exports = {
  RESERVE_RATIO,
  record,
  core,
  isExhausted,
  noteRead,
  snapshot,
  demoSnapshot,
  alertFigures,
  backgroundHold,
  budgetAllows,
  isRateLimitError,
  rateLimitNotice,
  rateLimitRetryAfterSeconds,
  githubUnavailableBody,
  _resetForTests,
};
