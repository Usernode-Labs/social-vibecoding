'use strict';

// When a linked GitHub or X account was created on its provider
// (user_social_identities.account_created_at), for Homeroom bot's
// "GitHub and X, both older than a minimum age" signal
// (services/homeroom-bot-verified.js 'github_x_age').
//
// Three ways a date arrives:
//
//   at link or re-verify   the provider reports it in the same call that
//                          proves the account (github-link.js /user
//                          created_at; x-link.js /2/users/me with
//                          user.fields=created_at). Source 'provider'.
//   GitHub, linked before  the clock below asks GitHub's public user API by
//                          the account's numeric id (GET /user/{id}), a few
//                          an hour and only while the background budget
//                          allows. Source 'provider'.
//   X, linked before       an X id is a snowflake: its top 42 bits are the
//                          milliseconds since X's epoch (1288834974657,
//                          4 Nov 2010), so (id >> 22) + epoch is when it was
//                          made. Source 'derived'.
//
// X gave user ids out in sequence before it moved them to snowflakes, and
// those ids carry no time. When that move happened is not documented: X
// said in 2013 that user ids were about to pass 32 bits, and ids issued in
// sequence after that. So a sequential id is LEFT UNKNOWN rather than given
// a guessed date: unknown never counts (the closed side), and verifying the
// account again in Settings records the date X reports. An id is taken as a
// snowflake only when it decodes to a moment from 2014 on, a range no
// sequential id reaches (those stayed in the billions; a 2014 snowflake is
// in the hundreds of quadrillions).
//
// A creation date is personal data: it is never logged and never shown on
// a public page.

const log = require('./logger');

const X_EPOCH_MS = 1288834974657;
// The earliest moment an X id is read as a snowflake (see above).
const X_SNOWFLAKE_FLOOR_MS = Date.UTC(2014, 0, 1);
const SOURCES = Object.freeze(['provider', 'derived']);
const SUBJECT_RE = /^[1-9][0-9]{0,39}$/;
// GitHub's first accounts are from 2007; X's from 2006. A date before
// either, or in the future, is not one a provider meant.
const EARLIEST_MS = Date.UTC(2006, 0, 1);
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** A provider's created_at as an ISO string, or null when it is not a plausible one. Pure. */
function parseProviderDate(value, { now = Date.now() } = {}) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < EARLIEST_MS || ms > now + FUTURE_SLACK_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * When an X account was made, from its id: an ISO string for a snowflake,
 * null for a sequential (pre-snowflake) id or anything that is not an id.
 * Pure.
 */
function xCreatedAtFromId(id, { now = Date.now() } = {}) {
  const text = String(id ?? '');
  if (!SUBJECT_RE.test(text) || text.length > 20) return null;
  let big;
  try { big = BigInt(text); } catch { return null; }
  if (big >= (1n << 64n)) return null;
  const ms = Number(big >> 22n) + X_EPOCH_MS;
  if (ms < X_SNOWFLAKE_FLOOR_MS || ms > now + FUTURE_SLACK_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * The accounts linked with no creation date, after `after` (the row id the
 * last run reached), at most `limit` of one provider.
 */
async function undated(pool, provider, { after = 0, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, provider_subject FROM user_social_identities
      WHERE provider = $1 AND account_created_at IS NULL AND id > $2
      ORDER BY id LIMIT $3`,
    [provider, Number(after) || 0, limit],
  );
  return rows;
}

// Only a row still undated is written: a link or re-verify that recorded the
// provider's own date since the read wins.
async function record(pool, id, at, source) {
  const { rowCount } = await pool.query(
    `UPDATE user_social_identities
        SET account_created_at = $2, account_created_source = $3
      WHERE id = $1 AND account_created_at IS NULL`,
    [id, at, source],
  );
  return rowCount > 0;
}

/** Every undated X account with a snowflake id, dated from it. No network. */
async function backfillX(pool, { limit = 500, now = Date.now() } = {}) {
  let after = 0;
  let dated = 0;
  let unknown = 0;
  for (;;) {
    const rows = await undated(pool, 'x', { after, limit });
    for (const row of rows) {
      const at = xCreatedAtFromId(row.provider_subject, { now });
      if (at && await record(pool, row.id, at, 'derived')) dated++;
      else if (!at) unknown++;
      after = Number(row.id);
    }
    if (rows.length < limit) break;
  }
  return { dated, unknown };
}

// The client the backfill reads GitHub with: the App installation on the
// platform repository's owner, as every background read is. Null when this
// deployment has no GitHub repository or App to read with.
async function defaultGithubReader() {
  const repoRef = require('./repo-ref');
  const repo = repoRef.parse(repoRef.platformRepoUrl());
  if (!repo || repo.host !== 'github' || !repo.owner) return null;
  const budget = require('./github-budget');
  const octokit = await require('./github').getReadOctokit(repo.owner);
  return {
    allows: () => budget.budgetAllows('background', { owner: repo.owner }),
    async createdAt(subject) {
      const { data } = await octokit.request('GET /user/{account_id}', { account_id: Number(subject) });
      return data && String(data.id) === String(subject) ? data.created_at : null;
    },
  };
}

/**
 * One page of undated GitHub accounts, asked of GitHub's public user API,
 * after `after`: at most `limit` requests, stopping as soon as the background
 * budget says hold. A deleted or unreadable account stays unknown and is
 * asked again when the pages come round. Returns where it reached.
 */
async function backfillGithub(pool, { after = 0, limit = 10, reader = null, now = Date.now() } = {}) {
  const rows = await undated(pool, 'github', { after, limit });
  if (!rows.length) return { dated: 0, asked: 0, after: null };
  let gh = reader;
  try {
    if (!gh) gh = await defaultGithubReader();
  } catch (err) {
    log.warn('social-account-age', 'No GitHub client for the account-age backfill', { err: err.message });
    gh = null;
  }
  if (!gh) return { dated: 0, asked: 0, after, skipped: 'no_github' };
  let dated = 0;
  let asked = 0;
  let reached = after;
  for (const row of rows) {
    if (gh.allows && !gh.allows()) return { dated, asked, after: reached, held: true };
    asked++;
    try {
      const at = parseProviderDate(await gh.createdAt(row.provider_subject), { now });
      if (at && await record(pool, row.id, at, 'provider')) dated++;
    } catch (err) {
      // No subject or date in the line: which account is not for the log.
      log.warn('social-account-age', 'GitHub did not answer an account-age read', { status: err.status || null });
      if (err.status === 403 || err.status === 429) return { dated, asked, after: reached, held: true };
    }
    reached = Number(row.id);
  }
  return { dated, asked, after: rows.length < limit ? null : reached };
}

/**
 * The clock's run (workflow/clock/services.ts 'social-account-age'): every
 * undated X account it can date, then a page of GitHub ones, carried on
 * from where the last run stopped.
 */
async function backfill(pool, { previous = null, githubLimit = 10, reader = null } = {}) {
  const x = await backfillX(pool);
  const github = await backfillGithub(pool, { after: previous?.after || 0, limit: githubLimit, reader });
  return { x, github: { dated: github.dated, asked: github.asked, held: !!github.held, skipped: github.skipped || null }, after: github.after ?? null };
}

module.exports = {
  X_EPOCH_MS,
  X_SNOWFLAKE_FLOOR_MS,
  SOURCES,
  parseProviderDate,
  xCreatedAtFromId,
  backfillX,
  backfillGithub,
  backfill,
};
