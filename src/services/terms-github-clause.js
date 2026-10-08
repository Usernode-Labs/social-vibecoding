'use strict';

// The terms' one-time GitHub clause (issue #4384): the make screen stopped
// saying, under Make it, that what you write and the app's code are public
// on GitHub. The fact now lives in Homeroom's terms, so the boot after the
// change publishes it as a NEW terms version — appending to the current
// body alone would go unnoticed, because the first-run gate only tells
// people the terms changed when a new version appears. People who accepted
// the earlier version get the "We updated our terms." toast once and can
// read the full text in Settings, About & legal; new people accept by
// continuing, as before (frontend/src/features/settings/terms-first-run.js).
//
// Production only: tests, local development and staging previews boot a
// fresh database whose terms are whatever the seeds publish, and there the
// change stays invisible. In one transaction, once, marked by
// `terms_github_public_clause` (so a later version an admin publishes by
// hand is never rewritten):
//
//   1. the latest published version (the same "current" rule
//      termsCurrentHandler uses, src/routes/topochain/mobile.js) is copied
//      — title, terms_link and body — and the body gains a blank line and
//      the clause, published as VERSION now;
//   2. nothing published yet (a fresh install): return WITHOUT marking, so
//      a later boot, once terms exist, still carries the clause.
//
// The version's UNIQUE constraint is the race arbiter when two replicas
// boot together (the same natural-key idiom the staging seeds use), and the
// clause being present in the current body already counts as done.

const log = require('./logger');

const CLAUSE = 'Projects you make here, including their description and code, are public on GitHub.';
const VERSION = '2026-10-github-public';
const MARKER = 'terms_github_public_clause';

function applies(env = process.env) {
  return env.NODE_ENV === 'production' && env.USERNODE_ENV !== 'staging';
}

async function applyTermsGithubClause(pool, { env = process.env, now = new Date() } = {}) {
  if (!applies(env)) return { applied: false, reason: 'not_production' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: latest } = await client.query(
      `SELECT version, title, body_markdown, terms_link FROM terms_versions
        WHERE published_at IS NOT NULL
        ORDER BY published_at DESC, id DESC LIMIT 1`
    );
    const base = latest[0];
    if (!base) {
      // No terms published at all: leave unmarked so the clause still
      // lands on a later boot, once a version exists to append to.
      await client.query('ROLLBACK');
      return { applied: false, reason: 'no_published_terms' };
    }
    if (base.body_markdown.includes(CLAUSE)) {
      // The current body already says it: mark done, publish nothing.
      await client.query(
        `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [MARKER, now.toISOString()]
      );
      await client.query('COMMIT');
      return { applied: false, reason: 'already_present' };
    }
    // The marker's own insert is the lock: a second replica booting at the
    // same moment waits on it, then finds it taken and changes nothing.
    const { rows: marked } = await client.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [MARKER, now.toISOString()]
    );
    if (!marked.length) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'done_before' };
    }
    const { rowCount } = await client.query(
      `INSERT INTO terms_versions
         (version, title, body_markdown, terms_link, published_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $5)
       ON CONFLICT (version) DO NOTHING`,
      [VERSION, base.title, `${base.body_markdown}\n\n${CLAUSE}`, base.terms_link, now]
    );
    await client.query('COMMIT');
    if (!rowCount) {
      // Another replica's boot won the version's UNIQUE arbiter and its row
      // is there; ours is the marker duplicate that changed nothing.
      return { applied: false, reason: 'row_exists' };
    }
    log.info('db', 'Terms: GitHub-public clause published as a new version', { version: VERSION });
    return { applied: true, version: VERSION };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the connection is going anyway */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyTermsGithubClause, applies, CLAUSE, VERSION, MARKER };