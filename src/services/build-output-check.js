// "No build output": does this change ADD a file that the build makes? One
// synthetic row in the proposal checks run.
//
// Why a check. On 20 Nov 2026 PR 6917 ("Draw the bot's comparisons and email
// previews in the one safe frame") committed 127 files under public/shell/:
// 128,219 lines, 23.7 MB. They were not part of the change. A Vite run whose
// working directory was the repository root took public/ as its default
// publicDir and copied it into public/shell/, the shell build's output folder,
// and the worker's `git add -A` staged the copy. Every shell build empties
// that folder, so on main anyone who builds sees the 127 files as deleted, and
// one `git add -A` commits either the deletions or a fresh set of copies. The
// copies of public/js/** are stale the moment the originals change, and they
// were served at /shell/js/....
//
// What it reads. The files a compare against main adds, from the code host.
// `compareFiles` returns each file's status even when the diff text is cut off,
// which matters because the offending change was 23.7 MB. A path is flagged
// when its status is `added`, or `renamed`/`copied` into it, and it is under
// `public/shell/` or is exactly `public/index.html` or
// `public/css/tailwind.css`. A DELETION under public/shell/ passes, so the
// cleanup change that removed the copies passes its own check.
//
// Scope: the platform's own repository only. Those paths mean nothing in an
// app (public/shell/ is Homeroom's shell output; an app has no such build),
// so any other app gets no row. This is the reverse of the outside-script row,
// which skips the platform and reads every app.
//
// Always blocking, with no off switch: build output in a proposal is never
// right, whatever setting a deploy carries.
//
// Fails OPEN. A code-host error yields a pass row that says it was not
// checked. This row must never turn checks red for infrastructure reasons.

'use strict';

const log = require('./logger');

const BUILD_OUTPUT_CHECK_NAME = 'No build output';
const BUILD_OUTPUT_CHECK_PATH = 'added files';
// Synthetic-row index namespace: -1 the missing-advisory rollup, -2 the
// over-ceiling guard (visuals.js), -3 the unit suite, -4 the asset route,
// -5 the Content rules review, -6 render health, -7 the sign-in token order,
// -8 the outside-script check.
const BUILD_OUTPUT_CHECK_INDEX = -9;
const REASON_MAX = 600;
const CACHE_MAX = 500;
// How many offending paths the reason names before it says "and N more".
const REASON_FILES = 10;

// The paths that are build output, never source.
const BUILD_OUTPUT_ROOTS = ['public/shell/'];
const BUILD_OUTPUT_FILES = new Set(['public/index.html', 'public/css/tailwind.css']);
// The statuses that PUT a file at its path. A `removed` status deletes it;
// `modified` leaves a file the change did not add.
const ADDING_STATUSES = new Set(['added', 'renamed', 'copied']);

function isBuildOutputPath(filename) {
  const p = String(filename || '');
  return BUILD_OUTPUT_FILES.has(p) || BUILD_OUTPUT_ROOTS.some((root) => p.startsWith(root));
}

/**
 * Pure: the files a change adds that are build output, as { file, previous }.
 * Pass the compare's `files` array (each { filename, status, previous }).
 */
function buildOutputFiles(files) {
  const found = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !ADDING_STATUSES.has(String(f.status || ''))) continue;
    const filename = f.filename || f.path;
    if (!isBuildOutputPath(filename)) continue;
    found.push({ file: filename, previous: f.previous_filename || f.previous || null });
  }
  return found;
}

function clip(text, n = REASON_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Pure: the row the checks pipeline consumes. `found` are the added build
// files; an empty list passes, with `note` saying why when it is not a plain
// pass.
function shapeRow({ found = [], note = '', checkedSha = null }) {
  const flagged = Array.isArray(found) && found.length > 0;
  let failureReason = '';
  if (flagged) {
    const named = found.slice(0, REASON_FILES).map((f) => f.file).join(', ');
    const more = found.length > REASON_FILES ? ` and ${found.length - REASON_FILES} more` : '';
    failureReason = clip(`Adds build output: ${named}${more}. These files are build output, made by the shell build: `
      + 'they are not source and must not be committed. Remove them from the change (git rm --cached) '
      + 'and leave them to the build.');
  }
  return {
    index: BUILD_OUTPUT_CHECK_INDEX,
    name: BUILD_OUTPUT_CHECK_NAME,
    path: BUILD_OUTPUT_CHECK_PATH,
    status: flagged ? 'fail' : 'pass',
    advisory: !flagged,
    consoleErrors: [],
    failureReason,
    summary: flagged ? '' : (note || 'Passes'),
    ...(checkedSha ? { checkedSha: String(checkedSha).toLowerCase() } : {}),
  };
}

const cache = new Map();
function cacheKey(sessionId, sha) { return `${sessionId}:${String(sha).toLowerCase()}`; }
function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function isSelfApp(config, appSlug) {
  const slug = String(config?.selfAppSlug || '');
  return !!slug && slug === String(appSlug || '');
}

/**
 * Check one proposal head. Returns { row } or null when the check cannot
 * apply. Never throws.
 *
 * deps are injectable for tests: { github }.
 */
async function maybeRunBuildOutputCheck({
  config = null, pool, sessionId, appSlug = null, repoOwner, repoName, commitHash,
  baseRef = 'main', deps = {},
} = {}) {
  try {
    if (!repoOwner || !repoName || !commitHash) return null;
    // Only the platform's own repository has these paths.
    if (!isSelfApp(config, appSlug)) return null;
    const github = deps.github || require('./github');
    if (typeof github.isEnabled === 'function' && !github.isEnabled()) return null;

    const key = cacheKey(sessionId, commitHash);
    if (cache.has(key)) return { row: cache.get(key) };

    let d;
    try {
      d = await github.compareFiles(repoOwner, repoName, `${baseRef}...${commitHash}`);
    } catch (err) {
      log.warn('build-output-check', 'Could not read the change (failing open)', { sessionId, err: err.message });
      return { row: shapeRow({ note: 'Passes (not checked: the change could not be read)' }) };
    }
    const found = buildOutputFiles(d?.files || []);
    // A compare's page holds at most 300 files; a pass on a full page says it
    // was read in part, so nobody reads it as proof of absence.
    const partial = d?.complete === false;
    const row = shapeRow({
      found, checkedSha: commitHash,
      note: partial ? 'Passes (read in part: the change has more files than one page holds)' : '',
    });
    remember(key, row);
    log.info('build-output-check', 'Build output checked', {
      sessionId, commit: String(commitHash).slice(0, 7), flagged: found.length,
    });
    return { row };
  } catch (err) {
    log.warn('build-output-check', 'Build output check failed (failing open)', { sessionId, err: err && err.message });
    return null;
  }
}

function _resetCache() { cache.clear(); }

module.exports = {
  BUILD_OUTPUT_CHECK_NAME, BUILD_OUTPUT_CHECK_PATH, BUILD_OUTPUT_CHECK_INDEX,
  isBuildOutputPath, buildOutputFiles, shapeRow, maybeRunBuildOutputCheck, _resetCache,
};
