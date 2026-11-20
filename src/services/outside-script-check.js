// "No script from another site": does this proposal ADD a <script> that loads
// its code from another site? One synthetic row in the proposal checks run.
//
// Why a check and not a hold. The platform's data rules (conventions, rule
// 12) forbid a `<script>` from another origin: the group votes on the code in
// the repository, and a script served from somewhere else can change after
// the vote, so the app would run code nobody voted on or can see. Until 20 Nov
// 2026 a change that added one was HELD for an admin's yes (release-holds.js,
// the `script` rule), which put a vote in front of something no vote may
// allow. Now it fails the checks like any failing check, with the file and
// line and what to do instead.
//
// What it reads. The lines the change adds, in the compare against main, the
// same reading the rule made: files that are not tests, fixtures or specs,
// and here not prose either (a README's example cannot load anything). A tag
// is flagged when its `src` names another origin: `https://…`, `http://…` or
// protocol-relative `//…`.
//
//   - A relative path passes, the centrally hosted `/usernode-bridge/v1/…`,
//     `/usernode-native/v1/…` and `/usernode-tailwind/v1/…` included: they
//     are served on the app's own address.
//   - The hosted files behind a hostname are flagged, with the relative path
//     to use instead (a hostname breaks the next time the platform moves).
//   - Introduced only. A tag already in the app is in no added line, so a
//     legacy `cdn.tailwindcss.com` tag never fails; a newly added one does,
//     as the conventions say ("do not add one"). A tag the change moves or
//     re-indents shows as removed and added again; an added `src` the same
//     change also removes is that tag, already in the app, and passes.
//
// A project's first version is checked too: it is the app's own code. The
// platform's own repository is not: it is no app, and its shell loads no
// cross-origin asset by its own rule (AGENTS.md, with tests of its own).
//
// Deterministic: no model, one compare, cached per (session, head) like the
// Content rules row.
//
// Mode (OUTSIDE_SCRIPT_CHECK_MODE, declared in the root dapp.json
// platform_env):
//   off       no row at all;
//   advisory  a flag shows on the checks but never closes the gate;
//   blocking  (default) a flag fails the checks, so the proposal cannot merge.
//
// Fails OPEN. A code-host error yields an advisory pass row that says it was
// not checked. This row must never turn checks red for infrastructure
// reasons.

'use strict';

const log = require('./logger');

const OUTSIDE_SCRIPT_CHECK_NAME = 'No script from another site';
const OUTSIDE_SCRIPT_CHECK_PATH = 'added lines';
// Synthetic-row index namespace: -1 the missing-advisory rollup, -2 the
// over-ceiling guard (visuals.js), -3 the unit suite, -4 the asset route,
// -5 the Content rules review, -6 render health, -7 the sign-in token order.
const OUTSIDE_SCRIPT_CHECK_INDEX = -8;
// The same budget release-holds.js reads a change with.
const DIFF_CHAR_BUDGET = 120000;
const REASON_MAX = 600;
const CACHE_MAX = 500;

const MODES = new Set(['off', 'advisory', 'blocking']);

function mode() {
  const v = String(process.env.OUTSIDE_SCRIPT_CHECK_MODE ?? '').trim().toLowerCase();
  return MODES.has(v) ? v : 'blocking';
}

// Files that never ship to a person: tests, fixtures and specs, as
// release-holds.js reads past them, and prose, which cannot load a script.
const TEST_FILE = /(^|\/)(tests?|__tests__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const PROSE_FILE = /\.(md|mdx|markdown|txt|rst)$/i;
// The tag the data rules forbid: a <script> whose src names another origin.
const OUTSIDE_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/i;
// The centrally hosted platform files, behind a hostname.
const HOSTED_PATH = /\/(usernode-(?:bridge|native|tailwind)\/v\d+\/[^"'\s>?#]*)/;

/**
 * Pure: every line a unified diff ADDS, as { path, line, text }, with the
 * line's number in the new file (from the hunk headers).
 */
function addedLines(diff) {
  const out = [];
  let path = null;
  let line = 0;
  let inHunk = false;
  for (const raw of String(diff || '').split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (head) { path = head[2]; inHunk = false; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); inHunk = true; continue; }
    if (!path || !inHunk) continue;
    if (raw.startsWith('+')) { out.push({ path, line, text: raw.slice(1) }); line += 1; continue; }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue;
    line += 1;
  }
  return out;
}

/** Pure: the outside script `src`s a diff removes, from any file. */
function removedSources(diff) {
  const out = new Set();
  let inHunk = false;
  for (const raw of String(diff || '').split('\n')) {
    if (/^diff --git /.test(raw)) { inHunk = false; continue; }
    if (/^@@ /.test(raw)) { inHunk = true; continue; }
    if (!inHunk || !raw.startsWith('-')) continue;
    const m = OUTSIDE_SCRIPT.exec(raw.slice(1));
    if (m) out.add(m[1]);
  }
  return out;
}

/** Pure: the outside scripts a diff adds, as { file, line, src, hosted }. */
function outsideScripts(diff) {
  const found = [];
  const removed = removedSources(diff);
  for (const added of addedLines(diff)) {
    if (TEST_FILE.test(added.path) || PROSE_FILE.test(added.path)) continue;
    const m = OUTSIDE_SCRIPT.exec(added.text);
    if (!m) continue;
    // Moved or re-indented: the same tag was already in the app.
    if (removed.has(m[1])) continue;
    const hosted = HOSTED_PATH.exec(m[1]);
    found.push({ file: added.path, line: added.line, src: m[1], hosted: hosted ? `/${hosted[1]}` : null });
  }
  return found;
}

function clip(text, n = REASON_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Pure: the row the checks pipeline consumes. `found` are the added outside
// scripts; an empty list passes, with `note` saying why when it is not a
// plain pass.
function shapeRow({ found = [], checkMode, note = '', checkedSha = null }) {
  const flagged = Array.isArray(found) && found.length > 0;
  let failureReason = '';
  if (flagged) {
    const first = found[0];
    const more = found.length > 1 ? ` (and ${found.length - 1} more)` : '';
    failureReason = clip(first.hosted
      ? `Loads Homeroom's hosted ${first.hosted} from a hostname: ${first.file} line ${first.line}${more}. `
        + `Load it by its relative path, src="${first.hosted}", which the platform serves on the app's own address.`
      : `Loads a script from another site: ${first.file} line ${first.line}, ${first.src}${more}. `
        + 'The platform\'s data rules forbid it: the group votes on the code in the repository, and a script '
        + 'from another site can change after the vote. Install it from npm and serve it from the app\'s own origin.');
  }
  return {
    index: OUTSIDE_SCRIPT_CHECK_INDEX,
    name: OUTSIDE_SCRIPT_CHECK_NAME,
    path: OUTSIDE_SCRIPT_CHECK_PATH,
    status: flagged ? 'fail' : 'pass',
    advisory: flagged ? checkMode !== 'blocking' : true,
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

async function storedVerdict(pool, sessionId, sha) {
  if (!pool || !sessionId || !sha) return null;
  try {
    const { rows } = await pool.query('SELECT test_results FROM chat_sessions WHERE id = $1', [sessionId]);
    const results = Array.isArray(rows[0]?.test_results) ? rows[0].test_results : [];
    return results.find((r) => r && r.name === OUTSIDE_SCRIPT_CHECK_NAME
      && r.checkedSha && String(r.checkedSha).toLowerCase() === String(sha).toLowerCase()) || null;
  } catch {
    return null;
  }
}

// The row with the CURRENT mode applied, so a cached flag follows a change
// of setting.
function withMode(row, checkMode) {
  if (row.status !== 'fail') return row;
  return { ...row, advisory: checkMode !== 'blocking' };
}

function isSelfApp(config, appSlug) {
  const slug = String(config?.selfAppSlug || '');
  return !!slug && slug === String(appSlug || '');
}

/**
 * Check one proposal head. Returns { row } or null when the check is off or
 * cannot apply. Never throws.
 *
 * deps are injectable for tests: { github }.
 */
async function maybeRunOutsideScriptCheck({
  config = null, pool, sessionId, appSlug = null, repoOwner, repoName, commitHash,
  baseRef = 'main', deps = {},
} = {}) {
  try {
    const checkMode = mode();
    if (checkMode === 'off') return null;
    if (!repoOwner || !repoName || !commitHash) return null;
    if (isSelfApp(config, appSlug)) return null;
    const github = deps.github || require('./github');
    if (typeof github.isEnabled === 'function' && !github.isEnabled()) return null;

    const key = cacheKey(sessionId, commitHash);
    if (cache.has(key)) return { row: withMode(cache.get(key), checkMode) };
    const stored = await storedVerdict(pool, sessionId, commitHash);
    if (stored) {
      remember(key, stored);
      return { row: withMode(stored, checkMode) };
    }

    let d;
    try {
      d = await github.getProposalDiff(repoOwner, repoName, `${baseRef}...${commitHash}`, DIFF_CHAR_BUDGET);
    } catch (err) {
      log.warn('outside-script-check', 'Could not load the diff (failing open)', { sessionId, err: err.message });
      return { row: shapeRow({ checkMode, note: 'Passes (not checked: the change could not be read)' }) };
    }
    const found = outsideScripts(d?.diff || '');
    // Cut off at the budget: what was read still counts, and a pass says so.
    const partial = !!d?.truncated || d?.filesComplete === false;
    const row = shapeRow({
      found, checkMode, checkedSha: commitHash,
      note: partial ? 'Passes (read in part: the change is too large to read in full)' : '',
    });
    remember(key, row);
    log.info('outside-script-check', 'Outside scripts checked', {
      sessionId, commit: String(commitHash).slice(0, 7), flagged: found.length, mode: checkMode,
    });
    return { row };
  } catch (err) {
    log.warn('outside-script-check', 'Outside script check failed (failing open)', { sessionId, err: err && err.message });
    return null;
  }
}

function _resetCache() { cache.clear(); }

module.exports = {
  OUTSIDE_SCRIPT_CHECK_NAME, OUTSIDE_SCRIPT_CHECK_PATH, OUTSIDE_SCRIPT_CHECK_INDEX,
  addedLines, outsideScripts, shapeRow, mode, maybeRunOutsideScriptCheck, _resetCache,
};
