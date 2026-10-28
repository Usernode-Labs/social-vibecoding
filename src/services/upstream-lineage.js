'use strict';

// A version's link to its original: what `apps.upstream` holds, what never
// travels between the two, and the dapp.json merge both directions use
// (docs/plans/versions.md).
//
//   { appId, slug, following, syncedSha, baseSha, share, legacy, since }
//
// `syncedSha` is the original's commit this version last took; `baseSha` is
// a commit in the VERSION's repository whose tree is the original at
// `syncedSha` as it looks in this version. Updates down are planned from
// the two (services/upstream-offers.js); suggestions up send the version's
// own commits since `baseSha` (services/suggest-back.js).
//
// What makes a version a different project rather than a change to its
// original never travels in either direction: its words (words.json), its
// own repository pointer, the files that carry its name, and the dapp.json
// keys that name it, say who it is for, who approves it and whether it
// follows.

const SHA_RE = /^[0-9a-f]{40}$/i;

const MANIFEST_PATH = 'dapp.json';
const WORDS_PATH = 'words.json';
const EXCLUDED_PATHS = Object.freeze([
  WORDS_PATH,
  '.claude/homeroom-canonical-repo',
  'README.md',
  'CLAUDE.md',
  'LICENSE',
]);
const EXCLUDED_MANIFEST_KEYS = Object.freeze([
  'name', 'visibility', 'admins', 'governance', 'description', 'followOriginal',
]);

// The ref in a version's repository that keeps `baseSha` reachable once it
// is a synthetic commit no branch points at, and the one an open update's
// "theirs" commit waits under until the update merges or is skipped.
const UPSTREAM_REF = 'refs/homeroom/upstream';
const OFFER_REF = 'refs/homeroom/offer';

function sha(value) {
  return typeof value === 'string' && SHA_RE.test(value) ? value.toLowerCase() : null;
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The link an app row carries, normalised, or null for a project that is
 * not a version. `row.upstream` may be the JSONB object or its text.
 */
function readUpstream(row) {
  let ref = row ? row.upstream : null;
  if (typeof ref === 'string') {
    try { ref = JSON.parse(ref); } catch { ref = null; }
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const appId = Number.isInteger(ref.appId) && ref.appId > 0 ? ref.appId : null;
  if (!appId) return null;
  return {
    appId,
    slug: typeof ref.slug === 'string' && ref.slug ? ref.slug : null,
    following: ref.following === true,
    syncedSha: sha(ref.syncedSha),
    baseSha: sha(ref.baseSha),
    share: ref.share === true,
    legacy: ref.legacy === true,
    since: typeof ref.since === 'string' ? ref.since : null,
  };
}

/** Whether both commits an update or a suggestion is planned from are known. */
function planned(link) {
  return !!(link && link.syncedSha && link.baseSha);
}

/**
 * Merge `patch` into an app's link (top-level keys; null removes nothing,
 * it is written as null). Creates the link when there was none.
 */
async function writeUpstream(pool, appId, patch) {
  const { rows } = await pool.query(
    `UPDATE apps SET upstream = COALESCE(upstream, '{}'::jsonb) || $2::jsonb
      WHERE id = $1 RETURNING upstream`,
    [appId, JSON.stringify(patch || {})]
  );
  return rows[0] ? readUpstream({ upstream: rows[0].upstream }) : null;
}

/**
 * The target's dapp.json with what changed between `baseText` and
 * `headText` carried over, minus the keys that make a project a different
 * one (EXCLUDED_MANIFEST_KEYS). Each top-level key added, changed or
 * removed is applied to the target; key order is the target's, new keys
 * after it. Returns { changed: false } when nothing applies, and
 * { changed: true, text, keys } otherwise; a dapp.json that does not parse
 * is left alone (`unreadable: true`). Pure.
 */
function mergeManifest(baseText, headText, targetText, excluded = EXCLUDED_MANIFEST_KEYS) {
  if (baseText === headText) return { changed: false };
  const base = baseText == null ? {} : parseJsonObject(baseText);
  const head = headText == null ? {} : parseJsonObject(headText);
  if (!base || !head) return { changed: false, unreadable: true };
  const keys = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (excluded.includes(key)) continue;
    if (!sameJson(base[key], head[key])) keys.push(key);
  }
  if (!keys.length) return { changed: false };
  const target = targetText == null ? {} : parseJsonObject(targetText);
  if (!target) return { changed: false, unreadable: true };
  const next = { ...target };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(head, key)) next[key] = head[key];
    else delete next[key];
  }
  if (sameJson(next, target)) return { changed: false };
  return { changed: true, text: `${JSON.stringify(next, null, 2)}\n`, keys };
}

/** The git pathspec for everything but dapp.json and the paths that never travel. */
function diffPathspec() {
  return ['.', `:(exclude)${MANIFEST_PATH}`, ...EXCLUDED_PATHS.map((p) => `:(exclude)${p}`)];
}

/** Whether a repository path is one that never travels. */
function isExcludedPath(file) {
  const p = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return EXCLUDED_PATHS.includes(p);
}

/**
 * A legacy version's two commits, found the first time they are needed:
 * for a copy made before versions existed, `syncedSha` and `baseSha` were
 * never recorded. Resolves to the updated link, or null when they cannot be
 * found (the copy then cannot be planned, and says so).
 *
 * Filled in by the lineage work (docs/plans/versions.md, "Remixes and
 * lineage"); until then a legacy link cannot be planned.
 */
async function resolveLegacy(_config, _pool, _app) {
  return null;
}

module.exports = {
  EXCLUDED_MANIFEST_KEYS,
  EXCLUDED_PATHS,
  MANIFEST_PATH,
  OFFER_REF,
  UPSTREAM_REF,
  WORDS_PATH,
  diffPathspec,
  isExcludedPath,
  mergeManifest,
  planned,
  readUpstream,
  resolveLegacy,
  writeUpstream,
};
