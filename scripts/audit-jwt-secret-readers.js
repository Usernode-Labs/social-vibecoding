#!/usr/bin/env node
'use strict';

/**
 * Which app repos still read `process.env.JWT_SECRET`?
 *
 * WHY THIS EXISTS
 *
 * The RSA iframe cutover (#848) retired the shared HS256 secret, but every
 * child container still receives a `JWT_SECRET` env var — now carrying the
 * RSA PUBLIC PEM. That is a source-compatibility shim for apps generated
 * BEFORE the cutover, whose auth middleware is two lines long:
 *
 *     const JWT_SECRET = process.env.JWT_SECRET;
 *     try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
 *
 * `jwt.verify(token, pem)` verifies an RS256 token asymmetrically, so those
 * apps keep authenticating users verbatim while losing the ability to mint an
 * identity at all (tests/scaffold-token-compat.test.js pins both halves).
 *
 * The platform side of the retirement is done — the generated scaffold
 * (services/template.js) and the app-authoring conventions
 * (prompts/app-conventions.md) read only USERNODE_JWT_PUBLIC_KEY, so no NEW
 * app can acquire the dependency. What is left is app source the platform
 * cannot edit. Deleting the injected var while any app still reads it logs
 * every user out of that app, so the removal is gated on this audit
 * reporting zero — see the removal criterion in
 * services/app-identity-env.js.
 *
 * WHAT IT DOES
 *
 * Read-only. For every `apps` row with a repo_url, fetch the repo's server
 * source through the existing services/github.js helpers and report whether
 * it references `process.env.JWT_SECRET`. Nothing is written, no container is
 * touched, no PR is opened. The output is a plain report plus a machine
 * summary, so it can be pasted into the follow-up issue as the record of how
 * much work the retirement actually is.
 *
 * USAGE
 *
 *   node scripts/audit-jwt-secret-readers.js            # human report
 *   node scripts/audit-jwt-secret-readers.js --json     # machine-readable
 *
 * From the platform container (it needs DATABASE_URL and the GitHub App
 * credentials, i.e. the platform's own .env):
 *
 *   docker compose exec usernode-blue node scripts/audit-jwt-secret-readers.js  # (or -green, whichever is live)
 *
 * Exit codes: 0 when the audit completed (whether or not readers were
 * found — "12 apps still read it" is a successful audit), 1 when it could
 * not run at all (no DB, GitHub disabled). Deliberately NOT "1 if any
 * reader found": this is a report, not a gate, and wiring it into CI would
 * make an unrelated deploy fail for a pre-existing condition.
 */

const path = require('path');

// The files worth checking, in priority order. An app's auth middleware
// lives in its entrypoint in every scaffold generation; the others are where
// a hand-edited app tends to move it.
const CANDIDATE_FILES = [
  'server.js',
  'index.js',
  'app.js',
  'src/server.js',
  'src/index.js',
  'lib/dapp-server.js',
];

// `process.env.JWT_SECRET` in any of the shapes real code uses — direct
// member access, bracket access, or a destructure out of process.env.
const READER_PATTERNS = [
  /process\.env\.JWT_SECRET\b/,
  /process\.env\[\s*['"`]JWT_SECRET['"`]\s*\]/,
  /\{[^}]*\bJWT_SECRET\b[^}]*\}\s*=\s*process\.env/,
];

function findReader(source) {
  const lines = String(source || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of READER_PATTERNS) {
      if (re.test(lines[i])) return { line: i + 1, text: lines[i].trim().slice(0, 160) };
    }
  }
  return null;
}

function parseRepoUrl(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const say = (...a) => { if (!asJson) console.log(...a); };

  const config = require(path.join('..', 'src', 'config')).load();
  const github = require(path.join('..', 'src', 'services', 'github'));
  await github.init(config);
  if (!github.isEnabled()) {
    console.error('GitHub App is not configured — cannot read app repos.');
    process.exit(1);
  }

  const { getPool } = require(path.join('..', 'src', 'db', 'pool'));
  const pool = getPool(config);

  // self_hosted excluded: the platform's own repo is this one, and it does
  // not read the container-side alias (slice 1 removed platform-jwt.js's
  // last JWT_SECRET read).
  const { rows: apps } = await pool.query(
    `SELECT id, slug, name, repo_url, status
       FROM apps
      WHERE repo_url IS NOT NULL AND self_hosted IS NOT TRUE
      ORDER BY slug`
  );

  say(`Auditing ${apps.length} app repos for process.env.JWT_SECRET readers…\n`);

  const readers = [];
  const clean = [];
  const unreadable = [];

  for (const app of apps) {
    const parsed = parseRepoUrl(app.repo_url);
    if (!parsed) {
      unreadable.push({ slug: app.slug, reason: `unparseable repo_url: ${app.repo_url}` });
      continue;
    }
    let hit = null;
    let checked = 0;
    let lastErr = null;
    for (const file of CANDIDATE_FILES) {
      let source;
      try {
        source = await github.getFileContent(parsed.owner, parsed.repo, file);
      } catch (err) {
        lastErr = err.message;
        continue;
      }
      if (source == null) continue;   // 404 — this app doesn't have that file
      checked += 1;
      const found = findReader(source);
      if (found) { hit = { file, ...found }; break; }
    }

    if (hit) {
      readers.push({ slug: app.slug, status: app.status, repo: app.repo_url, ...hit });
      say(`  READS   ${app.slug}  →  ${hit.file}:${hit.line}`);
      say(`                       ${hit.text}`);
    } else if (checked === 0) {
      unreadable.push({
        slug: app.slug,
        reason: lastErr ? `fetch failed: ${lastErr}` : 'no candidate entrypoint file found',
      });
      say(`  ?       ${app.slug}  →  no readable entrypoint`);
    } else {
      clean.push({ slug: app.slug });
      say(`  clean   ${app.slug}`);
    }
  }

  const summary = {
    total: apps.length,
    readers: readers.length,
    clean: clean.length,
    unreadable: unreadable.length,
    // The gate for deleting the injected var. `unreadable` counts AGAINST
    // safety: an app whose source we could not read might still read the
    // alias, so it is not evidence of being clean.
    safeToRemoveAlias: readers.length === 0 && unreadable.length === 0,
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, readers, clean, unreadable }, null, 2));
  } else {
    say('');
    say(`  ${summary.readers} still read JWT_SECRET`);
    say(`  ${summary.clean} clean`);
    say(`  ${summary.unreadable} could not be checked`);
    say('');
    if (summary.safeToRemoveAlias) {
      say('All clear: the JWT_SECRET line in services/app-identity-env.js can be');
      say('deleted (see the removal criterion in that file).');
    } else {
      say('NOT yet safe to delete the JWT_SECRET line in');
      say('services/app-identity-env.js — doing so would log every user out of');
      say('the apps listed above. Each needs a PR switching it to');
      say('USERNODE_JWT_PUBLIC_KEY first.');
      if (summary.unreadable) {
        say('');
        say('Apps that could not be checked count against safety — an unread');
        say('repo is not evidence of a clean one.');
      }
    }
  }

  await pool.end().catch(() => {});
}

// Guarded so the detection helpers can be unit-tested without connecting to
// anything — the regexes are what gate the alias removal, so they get a test
// (tests/jwt-secret-audit.test.js) rather than being trusted by eye.
if (require.main === module) {
  main().catch((err) => {
    console.error(`audit failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = { findReader, parseRepoUrl, CANDIDATE_FILES, READER_PATTERNS };
