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
 * Read-only. For every `apps` row with a repo_url, enumerate the repository's
 * complete source tree through the existing services/github.js helpers and
 * report whether it references `process.env.JWT_SECRET`. Nothing is written,
 * no container is touched, no PR is opened. The output is a plain report plus
 * a machine summary, so it can be pasted into the follow-up issue as the
 * record of how much work the retirement actually is.
 *
 * USAGE
 *
 *   node scripts/audit-jwt-secret-readers.js            # human report
 *   node scripts/audit-jwt-secret-readers.js --json     # machine-readable
 *
 * From the platform container (it needs DATABASE_URL and the GitHub App
 * credentials, i.e. the platform's own .env):
 *
 *   docker compose exec usernode node scripts/audit-jwt-secret-readers.js
 *
 * Exit codes: 0 when the audit completed (whether or not readers were
 * found — "12 apps still read it" is a successful audit), 1 when it could
 * not run at all (no DB, GitHub disabled). Deliberately NOT "1 if any
 * reader found": this is a report, not a gate, and wiring it into CI would
 * make an unrelated deploy fail for a pre-existing condition.
 */

const path = require('path');
const { TextDecoder } = require('util');
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

// Likely files first so reader-positive repos usually need only one blob
// request. This is ordering only: every eligible source blob is scanned before
// a repo is allowed to report clean.
const CANDIDATE_FILES = [
  'server.js',
  'index.js',
  'app.js',
  'src/server.js',
  'src/index.js',
  'lib/dapp-server.js',
];

const SOURCE_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx',
  '.coffee', '.vue', '.svelte',
]);
const EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'coverage', '.cache', 'public', 'assets', 'static',
  'fixtures', '__fixtures__', 'test', 'tests', '__tests__',
]);
const AMBIGUOUS_GENERATED_SEGMENTS = new Set([
  'vendor', 'dist', 'build', '.next', '.nuxt', '.output',
]);
const MAX_TREE_ENTRIES = 5000;
// 35 repos × 120 blobs plus tree/commit lookups stays below a standard
// installation-token request budget even in the all-at-the-cap worst case.
const MAX_SOURCE_FILES = 120;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;

// `process.env.JWT_SECRET` in any of the shapes real code uses — direct
// member access, bracket access, or a destructure out of process.env.
const READER_PATTERNS = [
  /process\.env\.JWT_SECRET\b/,
  /process\.env\[\s*['"`]JWT_SECRET['"`]\s*\]/,
  /\{[^}]*\bJWT_SECRET\b[^}]*\}\s*=\s*process\.env/,
];

function findReader(source) {
  const full = String(source || '');
  const lines = full.split('\n');
  for (const re of READER_PATTERNS) {
    const match = re.exec(full);
    if (!match) continue;
    // For a multi-line destructure, point at JWT_SECRET itself rather than
    // the opening `const {`, so the report remains immediately actionable.
    const within = match[0].indexOf('JWT_SECRET');
    const offset = match.index + (within >= 0 ? within : 0);
    const line = full.slice(0, offset).split('\n').length;
    return { line, text: (lines[line - 1] || '').trim().slice(0, 160) };
  }
  return null;
}

function parseRepoUrl(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function auditError(message) {
  const err = new Error(message);
  err.code = 'incomplete_audit';
  return err;
}

function isEligibleSource(filePath) {
  if (!isSafeRepoPath(filePath)) return false;
  const segments = filePath.split('/');
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase())
      || AMBIGUOUS_GENERATED_SEGMENTS.has(segment.toLowerCase()))) return false;
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.min.js') || lower.endsWith('.map')) return false;
  return SOURCE_EXTENSIONS.has(path.posix.extname(lower));
}

function isSafeRepoPath(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\\')
      || filePath.includes('\0') || filePath.startsWith('/')) return false;
  return filePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function isAmbiguousGeneratedSource(filePath) {
  if (!isSafeRepoPath(filePath)) return false;
  const lower = filePath.toLowerCase();
  const extension = path.posix.extname(lower);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  return lower.endsWith('.min.js')
    || filePath.split('/').some(
      (segment) => AMBIGUOUS_GENERATED_SEGMENTS.has(segment.toLowerCase())
    );
}

function orderSourceEntries(entries) {
  const rank = new Map(CANDIDATE_FILES.map((file, index) => [file, index]));
  return entries.slice().sort((a, b) => {
    const ar = rank.has(a.path) ? rank.get(a.path) : CANDIDATE_FILES.length;
    const br = rank.has(b.path) ? rank.get(b.path) : CANDIDATE_FILES.length;
    return ar - br || a.path.localeCompare(b.path);
  });
}

function decodeBlob(blob, filePath, maxFileBytes = MAX_FILE_BYTES) {
  if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw auditError(`${filePath}: unsupported or missing blob encoding`);
  }
  const encoded = blob.content.replace(/\s/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw auditError(`${filePath}: malformed base64 blob`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw auditError(`${filePath}: malformed base64 blob`);
  }
  if (bytes.length > maxFileBytes) {
    throw auditError(`${filePath}: source blob exceeds ${maxFileBytes} bytes`);
  }
  if (Number.isFinite(blob.size)
      && (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size !== bytes.length)) {
    throw auditError(`${filePath}: blob size metadata does not match content`);
  }
  if (bytes.includes(0)) throw auditError(`${filePath}: source blob is not text`);
  try {
    UTF8_DECODER.decode(bytes);
  } catch {
    throw auditError(`${filePath}: source blob is not valid UTF-8`);
  }
  return bytes;
}

async function scanRepository(github, owner, repo, limits = {}) {
  const maxTreeEntries = limits.maxTreeEntries || MAX_TREE_ENTRIES;
  const maxSourceFiles = limits.maxSourceFiles || MAX_SOURCE_FILES;
  const maxFileBytes = limits.maxFileBytes || MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes || MAX_TOTAL_BYTES;
  const concurrency = limits.concurrency || FETCH_CONCURRENCY;

  let tree;
  try {
    tree = await github.getRepoTree(owner, repo);
  } catch (err) {
    return { state: 'unreadable', reason: `tree fetch failed: ${err.message}` };
  }
  if (!tree || tree.truncated || !Array.isArray(tree.entries)) {
    return { state: 'unreadable', reason: 'repository tree is missing or truncated' };
  }
  if (tree.entries.length > maxTreeEntries) {
    return { state: 'unreadable', reason: `repository tree exceeds ${maxTreeEntries} entries` };
  }

  const sourceEntries = [];
  for (const entry of tree.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.type !== 'string') {
      return { state: 'unreadable', reason: 'repository tree contains a malformed entry' };
    }
    if (!isSafeRepoPath(entry.path)) {
      return { state: 'unreadable', reason: 'repository tree contains an unsafe path' };
    }
    if (entry.type === 'blob' && isAmbiguousGeneratedSource(entry.path)) {
      return {
        state: 'unreadable',
        reason: `${entry.path}: generated or vendored source requires manual corroboration`,
      };
    }
    if (entry.type !== 'blob' || !isEligibleSource(entry.path)) continue;
    if (typeof entry.sha !== 'string' || !entry.sha) {
      return { state: 'unreadable', reason: `${entry.path}: source entry has no blob id` };
    }
    if (entry.size !== undefined
        && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
      return { state: 'unreadable', reason: `${entry.path}: source entry has invalid size metadata` };
    }
    if (Number.isFinite(entry.size) && entry.size > maxFileBytes) {
      return { state: 'unreadable', reason: `${entry.path}: source blob exceeds ${maxFileBytes} bytes` };
    }
    sourceEntries.push(entry);
  }
  if (!sourceEntries.length) {
    return { state: 'unreadable', reason: 'no eligible source files found' };
  }
  if (sourceEntries.length > maxSourceFiles) {
    return { state: 'unreadable', reason: `repository has more than ${maxSourceFiles} source files` };
  }
  const knownBytes = sourceEntries.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.size) ? entry.size : 0), 0
  );
  if (knownBytes > maxTotalBytes) {
    return { state: 'unreadable', reason: `source inventory exceeds ${maxTotalBytes} bytes` };
  }

  const ordered = orderSourceEntries(sourceEntries);
  const hits = new Array(ordered.length);
  let nextIndex = 0;
  let totalBytes = 0;
  let failure = null;
  let readerFound = false;
  const worker = async () => {
    while (!failure && !readerFound) {
      const index = nextIndex++;
      if (index >= ordered.length) return;
      const entry = ordered[index];
      try {
        const blob = await github.getRepoBlob(owner, repo, entry.sha);
        const bytes = decodeBlob(blob, entry.path, maxFileBytes);
        totalBytes += bytes.length;
        if (totalBytes > maxTotalBytes) {
          failure = auditError(`decoded source exceeds ${maxTotalBytes} bytes`);
          return;
        }
        const found = findReader(bytes.toString('utf8'));
        if (found) {
          hits[index] = { file: entry.path, ...found };
          readerFound = true;
          return;
        }
      } catch (err) {
        failure = err;
        return;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), ordered.length) }, () => worker()
  ));

  // A positive hit is safe even if a concurrent fetch failed: either result
  // keeps the alias. Prefer the actionable file/line over a generic error.
  const hit = hits.find(Boolean);
  if (hit) return { state: 'reader', hit, checked: ordered.length };
  if (failure) return { state: 'unreadable', reason: `source fetch failed: ${failure.message}` };
  return { state: 'clean', checked: ordered.length };
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
    const result = await scanRepository(github, parsed.owner, parsed.repo);
    if (result.state === 'reader') {
      const hit = result.hit;
      readers.push({ slug: app.slug, status: app.status, repo: app.repo_url, ...hit });
      say(`  READS   ${app.slug}  →  ${hit.file}:${hit.line}`);
      say(`                       ${hit.text}`);
    } else if (result.state === 'unreadable') {
      unreadable.push({ slug: app.slug, reason: result.reason });
      say(`  ?       ${app.slug}  →  ${result.reason}`);
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

module.exports = {
  findReader,
  parseRepoUrl,
  isEligibleSource,
  isSafeRepoPath,
  isAmbiguousGeneratedSource,
  orderSourceEntries,
  decodeBlob,
  scanRepository,
  CANDIDATE_FILES,
  READER_PATTERNS,
  SOURCE_EXTENSIONS,
  EXCLUDED_SEGMENTS,
  AMBIGUOUS_GENERATED_SEGMENTS,
  MAX_TREE_ENTRIES,
  MAX_SOURCE_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  FETCH_CONCURRENCY,
};
