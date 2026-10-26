'use strict';

// Whether the platform may talk to GitHub at all.
//
// On 25 Oct 2026 GitHub suspended the machine account behind
// GITHUB_BOT_TOKEN. Nothing recognised it: every clock and the Homeroom
// bot's refreshes kept calling the dead token, about 2,000 requests an
// hour, and the token was then also the account Homeroom had promised
// GitHub it would stop using. App code, requests and merges have since
// moved off GitHub (services/git-host.js, services/requests.js, native
// merges); what still talks to GitHub is the platform's own repository,
// which Homeroom acts on as the GitHub App, never the bot
// (services/github.js "Who Homeroom is on GitHub"). This is the switch for
// all of it.
//
// Paused, for every process, when either is true:
//
//   - the `github_paused` platform setting is on (Admin › Limits). It is
//     read here every 10 seconds, the cadence of the other platform
//     settings (services/limits.js), so turning it on or off needs no env
//     change and no restart;
//   - this process has seen the bot token refused as dead: a 401, or a 403
//     whose message says the account was suspended. That holds until the
//     process restarts. The token is no longer sent at all, so this can
//     only come from an old process. Nothing ever probes the token to see
//     whether it came back: a reinstated account is to be emptied and
//     closed, not used again, and the token is to be revoked (docs/plans/
//     github-independence-handoff.md §4).
//
// A call about any GitHub owner but the platform repository's is refused
// the same way, whether or not this is on (services/github.js
// assertActingOwner): the reason is then 'owner'.
//
// While paused, every GitHub request the platform would send through
// services/github.js is refused here before it leaves the process
// (GithubPausedError, a 503 the routes already turn into "GitHub is
// unavailable"), and background work is held (github-budget.js
// backgroundHold). A person's own GitHub sign-in (account linking, the
// waitlist) uses their own token and is not affected.

const log = require('./logger');

const SETTING_KEY = 'github_paused';
const REFRESH_MS = 10_000;
const ON = new Set(['1', 'true', 'on', 'yes']);

let pool = null;
let timer = null;
let setting = { on: false, since: null };
let dead = null;
let refreshing = null;
let loggedRefusal = false;

const PAUSED_MESSAGES = {
  suspended: 'GitHub is paused: the bot token was refused as suspended',
  owner: 'GitHub is paused for this repository: Homeroom acts on GitHub only for its own repository',
};

class GithubPausedError extends Error {
  constructor(reason) {
    super(PAUSED_MESSAGES[reason] || 'GitHub is paused');
    this.name = 'GithubPausedError';
    this.code = 'github_paused';
    this.githubPaused = true;
    this.status = 503;
  }
}

function reason() {
  if (dead) return 'suspended';
  if (setting.on) return 'setting';
  return null;
}

function isPaused() {
  return reason() !== null;
}

/** What Admin and the status payload show: { paused, reason, since, detail }. */
function state() {
  const why = reason();
  return {
    paused: why !== null,
    reason: why,
    since: why === 'suspended' ? dead.at : why === 'setting' ? setting.since : null,
    detail: why === 'suspended' ? { status: dead.status } : null,
  };
}

function pausedError(why = reason()) {
  return new GithubPausedError(why);
}

/**
 * Whether code changes to the repository at `repoUrl` are held: it is on
 * GitHub, and either GitHub is paused or Homeroom cannot act on it there
 * (services/github.js canActOn: only the platform's own repository, through
 * the GitHub App's installation, once that is found). Nothing can then be
 * proposed, pushed or merged to it from Homeroom (the worker push and the
 * merge refuse). The project page says so (GET /api/apps/:slug
 * `codeChangesPaused`); requests and discussions are Homeroom's own and
 * carry on. A repository on Homeroom's git host is never held.
 */
function codeChangesPaused(repoUrl) {
  const parsed = require('./repo-ref').parse(repoUrl);
  if (!parsed || parsed.host !== 'github') return false;
  return isPaused() || !require('./github').canActOn(parsed.owner);
}

/** Throws GithubPausedError when paused. Logs the first refusal per process. */
function assertNotPaused(context = null) {
  if (!isPaused()) return;
  if (!loggedRefusal) {
    loggedRefusal = true;
    log.warn('github-pause', 'GitHub is paused; refusing GitHub requests from this process', {
      reason: reason(), ...(context || {}),
    });
  }
  throw pausedError();
}

function isPausedError(err) {
  return !!(err && (err.githubPaused || err.code === 'github_paused'));
}

// A refusal that means the token itself is gone, not a refusal of one
// request: 401 Bad credentials (a revoked or placeholder token), or GitHub's
// "Sorry. Your account was suspended." A 403 for a rate limit or a missing
// permission is not this.
function isDeadCredential(status, message) {
  const s = Number(status) || 0;
  if (s === 401) return true;
  return s === 403 && /\baccount (was|has been) suspended\b/i.test(String(message || ''));
}

/**
 * Record a GitHub refusal seen on `credential`. Only the bot token ('pat')
 * can mark the process dead: an installation token or a person's own token
 * failing says nothing about the account the platform runs as.
 */
function noteRefusal(credential, { status = 0, message = '' } = {}) {
  if (credential !== 'pat' || dead || !isDeadCredential(status, message)) return false;
  dead = { at: new Date().toISOString(), status: Number(status) || 0 };
  log.error('github-pause', 'The GitHub bot token was refused as dead; GitHub is paused in this process until it restarts', {
    status: dead.status, message: String(message || '').slice(0, 200),
  });
  return true;
}

/** noteRefusal for an Octokit error. */
function noteError(credential, err) {
  if (!err || isPausedError(err)) return false;
  return noteRefusal(credential, {
    status: err.status || (err.response && err.response.status),
    message: (err.response && err.response.data && err.response.data.message) || err.message,
  });
}

/**
 * noteRefusal for a raw fetch Response. A 403's body is read from a clone
 * so the caller's own read of it is untouched.
 */
async function noteResponse(credential, resp) {
  if (!resp || credential !== 'pat' || dead) return false;
  if (resp.status === 401) return noteRefusal(credential, { status: 401 });
  if (resp.status !== 403 || typeof resp.clone !== 'function') return false;
  try {
    const text = await resp.clone().text();
    return noteRefusal(credential, { status: 403, message: text });
  } catch (_) {
    return false;
  }
}

async function refresh(p = pool) {
  if (!p) return state();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const { rows } = await p.query(
        'SELECT value, updated_at FROM platform_settings WHERE key = $1', [SETTING_KEY]);
      const on = ON.has(String(rows[0]?.value || '').trim().toLowerCase());
      const since = on ? (rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null) : null;
      if (on !== setting.on) {
        log.info('github-pause', on ? 'GitHub paused by the platform setting' : 'GitHub pause setting turned off', { since });
        if (!on) loggedRefusal = false;
      }
      setting = { on, since };
    } catch (err) {
      // Before migrate() has made the table, or a database blip: keep the
      // last value read rather than flipping on a read error.
      log.debug('github-pause', 'github_paused read failed; keeping the last value', { err: err.message });
    } finally {
      refreshing = null;
    }
    return state();
  })();
  return refreshing;
}

/** Start reading the setting for this process. Safe to call twice. */
function start(p) {
  pool = p;
  if (timer) return refresh();
  timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return refresh();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Write the setting (Admin › Limits) and apply it here at once. */
async function setPaused(p, on, { userId = null } = {}) {
  await p.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [SETTING_KEY, on ? 'true' : 'false', userId]
  );
  return refresh(p);
}

function _resetForTests() {
  stop();
  pool = null;
  setting = { on: false, since: null };
  dead = null;
  refreshing = null;
  loggedRefusal = false;
}

function _setForTests({ on = setting.on, deadStatus } = {}) {
  setting = { on, since: on ? new Date().toISOString() : null };
  if (deadStatus !== undefined) dead = deadStatus ? { at: new Date().toISOString(), status: deadStatus } : null;
}

module.exports = {
  SETTING_KEY,
  GithubPausedError,
  isPaused,
  state,
  pausedError,
  codeChangesPaused,
  assertNotPaused,
  isPausedError,
  isDeadCredential,
  noteRefusal,
  noteError,
  noteResponse,
  refresh,
  start,
  stop,
  setPaused,
  _resetForTests,
  _setForTests,
};
