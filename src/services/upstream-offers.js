'use strict';

// Updates down: an original's merged changes, offered to each version that
// follows it as an ordinary change its own group votes on
// (docs/plans/versions.md, "Updates down"). People see it as "Update from
// Tier list"; a group that does not want it presses "Skip this update".
//
// One row of `upstream_offers` per version holds where its update stands
// (available, open, needs_fit, skipped, merged, failed). The link it is
// planned from is the version's `apps.upstream` (services/upstream-lineage.js):
// `syncedSha`, the original's commit this version last took, and `baseSha`,
// a commit IN THE VERSION'S repository whose tree is the original at
// `syncedSha` as it looks in this version.
//
// ── Planning, in a scratch repository ───────────────────────────────────
//
//   1. Fetch the original at `syncedSha` and `from_sha` (its main), and the
//      version's main and `baseSha`.
//   2. THEIRS: `baseSha`'s tree plus the original's own diff
//      syncedSha..from_sha, the paths that never travel left out
//      (lineage.diffPathspec), applied onto an index read from `baseSha`
//      (`git apply --cached --3way`). dapp.json goes through
//      lineage.mergeManifest: the original's changed keys carried onto the
//      version's dapp.json, its name, audience and approval rule kept.
//      Commit T = (theirs tree, parent `baseSha`).
//   3. A three-way merge with an explicit base. git 2.39 has no
//      `merge-tree --merge-base`, so the base is made the merge base: the
//      synthetic O = (version main's tree, parent `baseSha`) and T share
//      exactly that parent, and `merge-tree --write-tree O T` merges the
//      two changes made since it (services/hosted-git.js revertOnto is the
//      same trick).
//   4. Clean: the update's head is the merged tree with parent = the
//      version's main, so the change's diff is exactly what the original
//      brings. A conflict: `needs_fit`, with the paths.
//
// Every commit made here is dated by the original's commit, so the same
// inputs make the same commits: a retried open pushes the refs it pushed
// before, and finds the pull request it opened.
//
// T is kept in the version's repository under refs/homeroom/offer while the
// update waits; once it merges or is skipped it becomes the new `baseSha`
// and refs/homeroom/upstream keeps it reachable (no branch points at it:
// the merge is a squash, so T is never an ancestor of main).
//
// ── What it says, computed ───────────────────────────────────────────────
//
// `facts` come from the original's diff, never from a model's words
// (factsOf): tables it adds, statements that change data already stored,
// outside sites its code starts to talk to, keys it needs, and whether it
// starts using AI or file storage. `brings` are the original's change
// titles between the two commits; `keeps` the version's own changes since
// `baseSha` (update merges aside), counted, with the newest three titles.
//
// ── Who acts ─────────────────────────────────────────────────────────────
//
// The proposal is the platform's (`source = 'maintenance'`, the
// usernode-platform user, as a maintenance campaign's are: it holds no one's
// slot) and is promoted at once, so it reaches the members' Needs you. The
// clock job `upstream-offers` (workflow/clock/services.ts) marks, opens,
// refreshes and settles; routes/upstream.js lets members open, skip, or ask
// Homeroom bot to fit one. Nothing here runs while versions are off
// (services/versions-setting.js), in a platform preview, or without the git
// host.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const log = require('./logger');
const lineage = require('./upstream-lineage');

const SHA_RE = /^[0-9a-f]{40}$/i;
const OPEN_STATUSES = Object.freeze(['active', 'promoted', 'merging']);
const OFFER_STATES = Object.freeze(['available', 'open', 'needs_fit', 'skipped', 'merged', 'failed']);
const BRANCH_PREFIX = 'homeroom/update-';
// How many versions one clock run opens an update for, and how many rows of
// each kind it looks at.
const OPEN_PER_RUN = 10;
const SCAN_LIMIT = 50;
// How many of the original's change titles an update carries, and how many
// of the version's own it names.
const MAX_BRINGS = 50;
const MAX_KEEPS_TITLES = 3;
// The name the promote line gives ("Homeroom promoted ... for voting").
const PROPOSER_NAME = 'Homeroom';
// The platform's proposals are bound by no person's promoted cap (the
// campaign machine's NO_CAP).
const NO_CAP = 1_000_000;
// How much of the conflicting files' diff a fit request quotes.
const MAX_FIT_DIFF_CHARS = 30_000;
// How long one fact line or list may be.
const MAX_FACT_TEXT = 200;
const MAX_FACT_ITEMS = 20;
// The scratch ref the version's main is fetched to.
const SCRATCH_MAIN = 'refs/homeroom-scratch/main';
const SCRATCH_BRANCH = 'refs/homeroom-scratch/branch';

const EMPTY_FACTS = Object.freeze({
  tablesAdded: [], destructive: [], hostsAdded: [], secretsAdded: [], ai: false, storage: false,
});

// What people read. Plain words, no em dashes (tests/no-em-dash-in-copy).
const MESSAGES = Object.freeze({
  off: 'Updates from originals are switched off right now.',
  unavailable: 'Updates can’t be brought in here right now.',
  notAVersion: 'This project was not made from another one.',
  originalGone: 'The project this version was made from no longer exists.',
  originalNotReady: (name) => `${name} has nothing to bring in yet.`,
  upToDate: (name) => `This version already has everything from ${name}.`,
  cannotPlan: 'This version was made before Homeroom kept track of where it came from, '
    + 'so its updates can’t be brought in from here.',
  planFailed: 'Homeroom could not prepare this update just now. Try again shortly.',
  busy: 'Homeroom is busy right now. Try again in a few minutes.',
  nothingToSkip: 'There is no update waiting here to skip.',
  merging: 'This update is going in right now, so it can’t be skipped.',
  nothingToFit: 'This update doesn’t need fitting.',
  fitFailed: 'Homeroom could not file the request just now. Try again shortly.',
});

// Every statement here is static text with parameters (sql-dynamic-baseline).
const SQL = Object.freeze({
  version: `SELECT id, slug, name, repo_url, main_sha, upstream, community_id, created_by,
                   view_visibility, collab_visibility, self_hosted
              FROM apps WHERE id = $1`,
  original: `SELECT id, slug, name, icon_emoji, icon_image_id, repo_url, main_sha, view_visibility,
                    collab_visibility, created_by, self_hosted, moderation_suspended_at
               FROM apps WHERE id = $1`,
  offer: `SELECT uo.app_id, uo.from_app_id, uo.from_sha, uo.state, uo.theirs_sha, uo.session_id,
                 uo.facts, uo.brings, uo.keeps, uo.conflicts, uo.error, uo.updated_at,
                 cs.status AS session_status, cs.pr_number, cs.branch_name, cs.reviewed_head_sha
            FROM upstream_offers uo
            LEFT JOIN chat_sessions cs ON cs.id = uo.session_id
           WHERE uo.app_id = $1`,
  saveOffer: `INSERT INTO upstream_offers
                (app_id, from_app_id, from_sha, state, theirs_sha, session_id, facts, brings, keeps,
                 conflicts, error, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, NOW())
              ON CONFLICT (app_id) DO UPDATE
                SET from_app_id = EXCLUDED.from_app_id, from_sha = EXCLUDED.from_sha,
                    state = EXCLUDED.state, theirs_sha = EXCLUDED.theirs_sha,
                    session_id = EXCLUDED.session_id, facts = EXCLUDED.facts,
                    brings = EXCLUDED.brings, keeps = EXCLUDED.keeps,
                    conflicts = EXCLUDED.conflicts, error = EXCLUDED.error, updated_at = NOW()`,
  setState: `UPDATE upstream_offers SET state = $2, error = $3, updated_at = NOW() WHERE app_id = $1`,
  setError: `UPDATE upstream_offers SET error = $2, updated_at = NOW() WHERE app_id = $1`,
  clearAvailable: `DELETE FROM upstream_offers WHERE app_id = $1 AND state = 'available'`,
  openSession: `SELECT id, pr_number, status, branch_name
                  FROM chat_sessions
                 WHERE app_id = $1 AND upstream_from_app_id IS NOT NULL
                   AND status IN ('active', 'promoted', 'merging')
                 ORDER BY id DESC LIMIT 1`,
  session: `SELECT cs.*, a.repo_url, a.slug AS app_slug, a.name AS app_name
              FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
             WHERE cs.id = $1`,
  insertSession: `INSERT INTO chat_sessions
                    (app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_body, status,
                     source, upstream_from_app_id, shared_at, created_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'maintenance', $8, NOW(), NOW())
                  RETURNING id`,
  sessionBody: `UPDATE chat_sessions SET pr_body = $2 WHERE id = $1`,
  epoch: `SELECT approval_epoch FROM chat_sessions WHERE id = $1`,
  // The squash commits of this version's own update proposals: not its own
  // changes, so `keeps` leaves them out.
  updateMerges: `SELECT np.merge_commit_sha
                   FROM chat_sessions cs
                   JOIN native_pulls np ON np.app_id = cs.app_id AND np.number = cs.pr_number
                  WHERE cs.app_id = $1 AND cs.upstream_from_app_id IS NOT NULL
                    AND np.merged AND np.merge_commit_sha IS NOT NULL`,
  members: `SELECT cm.user_id
              FROM apps a
              JOIN community_members cm ON cm.community_id = a.community_id
              JOIN users u ON u.id = cm.user_id
             WHERE a.id = $1 AND NOT COALESCE(u.is_synthetic, FALSE)`,
  // The fit request filed for this update (its marker), newest first.
  fitRequest: `SELECT number, state, state_reason
                 FROM requests
                WHERE app_id = $1 AND strpos(body, $2) > 0
                ORDER BY number DESC LIMIT 1`,
  insertIssue: `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
                VALUES ($1, $2, $3, $4, 'general', '{}', $5)
                RETURNING id`,
  // ── The clock's reads ──
  //
  // Mark: a following version whose original moved past what it last took
  // gets an `available` row. A row it already has stands unless it is
  // settled (skipped, merged), or failed for an earlier commit of the
  // original. `open` and `needs_fit` wait for their own outcome.
  mark: `INSERT INTO upstream_offers (app_id, from_app_id, from_sha, state)
         SELECT v.id, o.id, o.main_sha, 'available'
           FROM apps v
           JOIN apps o ON o.id = (v.upstream->>'appId')::int
          WHERE v.upstream IS NOT NULL
            AND v.upstream->>'following' = 'true'
            AND v.id <> o.id
            AND v.repo_url IS NOT NULL
            AND o.main_sha IS NOT NULL
            AND o.main_sha IS DISTINCT FROM (v.upstream->>'syncedSha')
         ON CONFLICT (app_id) DO UPDATE
           SET state = 'available', from_app_id = EXCLUDED.from_app_id, from_sha = EXCLUDED.from_sha,
               theirs_sha = NULL, session_id = NULL, facts = '{}'::jsonb, brings = '[]'::jsonb,
               keeps = '{}'::jsonb, conflicts = '[]'::jsonb, error = NULL, updated_at = NOW()
           WHERE upstream_offers.state IN ('skipped', 'merged')
              OR (upstream_offers.state = 'failed'
                  AND upstream_offers.from_sha IS DISTINCT FROM EXCLUDED.from_sha)`,
  dueSettle: `SELECT uo.app_id, uo.session_id, cs.status
                FROM upstream_offers uo
                JOIN chat_sessions cs ON cs.id = uo.session_id
               WHERE uo.state = 'open' AND cs.status IN ('merged', 'archived')
               ORDER BY uo.updated_at
               LIMIT $1`,
  dueFit: `SELECT uo.app_id, uo.from_sha
             FROM upstream_offers uo
            WHERE uo.state = 'needs_fit'
            ORDER BY uo.updated_at
            LIMIT $1`,
  dueRefresh: `SELECT uo.app_id, o.main_sha
                 FROM upstream_offers uo
                 JOIN chat_sessions cs ON cs.id = uo.session_id
                 JOIN apps o ON o.id = uo.from_app_id
                WHERE uo.state = 'open' AND cs.status IN ('active', 'promoted')
                  AND o.main_sha IS NOT NULL AND o.main_sha <> uo.from_sha
                ORDER BY uo.updated_at
                LIMIT $1`,
  dueOpen: `SELECT uo.app_id, uo.from_sha
              FROM upstream_offers uo
             WHERE uo.state = 'available'
             ORDER BY uo.updated_at
             LIMIT $1`,
  // The change page's block (routes/votes.js, routes/sessions.js).
  changeView: `SELECT cs.id, cs.status, o.slug AS from_slug, o.name AS from_name, o.icon_emoji AS from_emoji,
                      uo.state, uo.brings, uo.facts, uo.keeps, uo.conflicts
                 FROM chat_sessions cs
                 JOIN apps o ON o.id = cs.upstream_from_app_id
                 LEFT JOIN upstream_offers uo ON uo.app_id = cs.app_id AND uo.session_id = cs.id
                WHERE cs.id = $1`,
});

// ── Small helpers ────────────────────────────────────────────────────────

function sha(value) {
  return typeof value === 'string' && SHA_RE.test(value) ? value.toLowerCase() : null;
}

function clip(text, n) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function refusal(status, code, error, extra = {}) {
  return { ok: false, status, body: { error, code, ...extra } };
}

/** A change title without the " (#N)" a squash merge gives it. */
function titleOf(subject) {
  return clip(String(subject || '').replace(/\s*\(#\d+\)\s*$/, ''), 200);
}

function branchFor(fromSha) {
  return `${BRANCH_PREFIX}${String(fromSha).slice(0, 12)}`;
}

/** The marker a fit request carries, so a second press finds it. */
function fitMarker(appId, fromSha) {
  return `<!-- homeroom-update-fit:app-${Number(appId)}:${String(fromSha || '').slice(0, 12)} -->`;
}

function changeHref(slug, sessionId, prNumber) {
  return require('./change-destination').changeHref(slug, sessionId, prNumber);
}

function requestHref(slug, number) {
  return `#app/${encodeURIComponent(String(slug || ''))}/dev/issues/${Number(number)}`;
}

function appRef(app) {
  return app ? { slug: app.slug, name: app.name || app.slug } : null;
}

// ── Facts ────────────────────────────────────────────────────────────────

// Files whose words are not code: a URL or a DROP TABLE in a README or a
// lockfile's registry addresses says nothing about what the app does.
const NOT_CODE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(md|markdown|txt|rst)$/i;
// A line that is only a comment.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--|<!--)/;

const CREATE_TABLE = /\bcreate\s+(?:(?:global\s+|local\s+)?(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi;
const DESTRUCTIVE = Object.freeze([
  /\bdrop\s+table\b/i,
  /\bdrop\s+column\b/i,
  // ALTER TABLE t DROP c, COLUMN being optional in Postgres; not a dropped
  // constraint, default, NOT NULL, identity or expression.
  /\balter\s+table\b.*\bdrop\s+(?!constraint\b|default\b|not\s+null\b|identity\b|expression\b|column\b|index\b)(?:if\s+exists\s+)?(?:"[^"]+"|[A-Za-z_])/i,
  /\balter\s+(?:table|index|sequence|view)\b.*\brename\b/i,
  /^\s*rename\s+(?:column\s+|constraint\s+)?(?:"[^"]+"|[A-Za-z_][\w$]*)\s+to\b/i,
  /^\s*rename\s+to\b/i,
  /\balter\s+(?:column\s+)?(?:"[^"]+"|[A-Za-z_][\w$]*)\s+(?:set\s+data\s+)?type\b/i,
  /\bTRUNCATE\b/,
  /\btruncate\s+table\b/i,
]);
const URL_HOST = /\bhttps?:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)/g;
const AI_ENV = 'USERNODE_LLM_PROXY_URL';
const STORAGE_ENV = 'USERNODE_STORAGE_URL';

// Hosts that are not somewhere outside: this machine, documentation and
// test names, Homeroom's own, and XML namespaces.
function insideHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.')) return true;
  if (/^(127\.|0\.0\.0\.0$|10\.|192\.168\.)/.test(h)) return true;
  const labels = h.split('.');
  const tld = labels[labels.length - 1];
  if (['localhost', 'test', 'invalid', 'local', 'example', 'internal'].includes(tld)) return true;
  const domain = labels.slice(-2).join('.');
  if (['example.com', 'example.org', 'example.net', 'onhomeroom.com', 'w3.org'].includes(domain)) return true;
  if (labels.some((l) => l.startsWith('usernode'))) return true;
  return false;
}

function tableName(raw) {
  const quoted = /"/.test(raw);
  const name = String(raw).replace(/"/g, '');
  return quoted ? name : name.toLowerCase();
}

function manifestOf(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function secretKeys(manifest) {
  const s = manifest && manifest.secrets;
  const out = new Set();
  if (Array.isArray(s)) {
    for (const entry of s) {
      if (typeof entry === 'string' && entry.trim()) out.add(entry.trim());
      else if (entry && typeof entry.key === 'string' && entry.key.trim()) out.add(entry.key.trim());
    }
  } else if (s && typeof s === 'object') {
    for (const key of Object.keys(s)) if (key.trim()) out.add(key.trim());
  }
  return out;
}

/**
 * Split a unified diff (`git diff`, binary-safe) into the code lines it
 * adds and removes, by file. Header lines and binary patches are skipped:
 * only hunk lines count, so a removed `-- comment` is never read as a file
 * header.
 */
function diffLines(diffText) {
  const added = [];
  const removed = [];
  let file = null;
  let inHunk = false;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      file = m ? m[1] : null;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
        if (m && m[1] !== '/dev/null') file = m[1];
      }
      if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) added.push({ file, text: line.slice(1) });
    else if (line.startsWith('-')) removed.push({ file, text: line.slice(1) });
  }
  return { added, removed };
}

/**
 * What an update does, from the original's diff and its dapp.json before and
 * after, never from anybody's description of it. Pure.
 *
 *   tablesAdded   CREATE TABLE names it adds (not ones it only moves)
 *   destructive   the lines it adds that change data already stored:
 *                 DROP TABLE or COLUMN, RENAME, ALTER ... TYPE, TRUNCATE
 *   hostsAdded    outside hosts its code starts to name (not ones it
 *                 already named, nor this machine, Homeroom's own or a
 *                 documentation name)
 *   secretsAdded  keys dapp.json's `secrets` gains
 *   ai, storage   whether it starts using the AI proxy or file storage
 *                 (`opts.alreadyAi` / `alreadyStorage`: the original used it
 *                 before, so referring to it again starts nothing)
 *
 * Comment-only lines, prose files and lockfiles say nothing here.
 */
function factsOf(diffText, baseManifest, headManifest, { alreadyAi = false, alreadyStorage = false } = {}) {
  const { added, removed } = diffLines(diffText);
  const code = (l) => !(l.file && NOT_CODE.test(l.file)) && !COMMENT_LINE.test(l.text);
  const addedCode = added.filter(code);
  const removedCode = removed.filter(code);

  const tables = (lines) => {
    const out = new Set();
    for (const l of lines) {
      CREATE_TABLE.lastIndex = 0;
      let m;
      while ((m = CREATE_TABLE.exec(l.text))) out.add(tableName(m[1]));
    }
    return out;
  };
  const removedTables = tables(removedCode);
  const tablesAdded = [...tables(addedCode)].filter((t) => !removedTables.has(t)).sort();

  const removedText = new Set(removedCode.map((l) => l.text.trim()));
  const destructive = [];
  for (const l of addedCode) {
    const text = l.text.trim();
    if (!text || removedText.has(text)) continue;
    if (DESTRUCTIVE.some((re) => re.test(text))) {
      const line = clip(text, MAX_FACT_TEXT);
      if (!destructive.includes(line)) destructive.push(line);
    }
  }

  const hosts = (lines) => {
    const out = new Set();
    for (const l of lines) {
      URL_HOST.lastIndex = 0;
      let m;
      while ((m = URL_HOST.exec(l.text))) {
        const host = m[1].toLowerCase();
        if (!insideHost(host)) out.add(host);
      }
    }
    return out;
  };
  const removedHosts = hosts(removedCode);
  const hostsAdded = [...hosts(addedCode)].filter((h) => !removedHosts.has(h)).sort();

  const base = manifestOf(baseManifest);
  const head = manifestOf(headManifest);
  const baseSecrets = secretKeys(base);
  const secretsAdded = [...secretKeys(head)].filter((k) => !baseSecrets.has(k)).sort();

  const mentions = (lines, word) => lines.some((l) => l.text.includes(word));
  const ai = !alreadyAi && ((mentions(addedCode, AI_ENV) && !mentions(removedCode, AI_ENV))
    || (!!head.llm && !base.llm));
  const storage = !alreadyStorage && mentions(addedCode, STORAGE_ENV) && !mentions(removedCode, STORAGE_ENV);

  return {
    tablesAdded: tablesAdded.slice(0, MAX_FACT_ITEMS),
    destructive: destructive.slice(0, MAX_FACT_ITEMS),
    hostsAdded: hostsAdded.slice(0, MAX_FACT_ITEMS),
    secretsAdded: secretsAdded.slice(0, MAX_FACT_ITEMS),
    ai,
    storage,
  };
}

/** A stored `facts` value with every field present. */
function readFacts(value) {
  const f = json(value, {}) || {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    tablesAdded: list(f.tablesAdded),
    destructive: list(f.destructive),
    hostsAdded: list(f.hostsAdded),
    secretsAdded: list(f.secretsAdded),
    ai: f.ai === true,
    storage: f.storage === true,
  };
}

function readBrings(value) {
  const b = json(value, []);
  return (Array.isArray(b) ? b : [])
    .map((x) => (x && typeof x.title === 'string' ? { title: x.title } : null))
    .filter(Boolean);
}

function readKeeps(value) {
  const k = json(value, {}) || {};
  const titles = Array.isArray(k.titles) ? k.titles.filter((t) => typeof t === 'string') : [];
  return { count: Number.isInteger(k.count) && k.count >= 0 ? k.count : titles.length, titles };
}

function readConflicts(value) {
  const c = json(value, []);
  return Array.isArray(c) ? c.filter((p) => typeof p === 'string') : [];
}

// ── The words on the change ──────────────────────────────────────────────

function listWords(items) {
  return items.join(', ');
}

/** The pull request's title and body: what it brings and what it does here. */
function describe({ originalName, versionName, brings, facts, keeps }) {
  const title = `Update from ${originalName}`.slice(0, 256);
  const lines = [`${originalName} has changed since ${versionName} last took its updates. This brings those changes in:`, ''];
  const shown = brings.slice(-20);
  for (const b of shown) lines.push(`- ${b.title}`);
  if (brings.length > shown.length) lines.push(`- and ${brings.length - shown.length} more`);
  if (!brings.length) lines.push(`- ${originalName}'s latest version`);
  const does = [];
  if (facts.tablesAdded.length) does.push(`Adds data tables: ${listWords(facts.tablesAdded)}.`);
  if (facts.destructive.length) does.push(`Changes data already stored: ${listWords(facts.destructive)}`);
  if (facts.hostsAdded.length) does.push(`Talks to sites outside Homeroom: ${listWords(facts.hostsAdded)}.`);
  if (facts.secretsAdded.length) does.push(`Needs keys set: ${listWords(facts.secretsAdded)}.`);
  if (facts.ai) does.push('Starts using AI.');
  if (facts.storage) does.push('Starts storing files.');
  if (does.length) {
    lines.push('', 'What it does here:', '');
    for (const d of does) lines.push(`- ${d}`);
  }
  lines.push('', keeps.count
    ? `${versionName}'s own changes stay as they are.`
    : `${versionName} has no changes of its own yet.`);
  return { title, body: `${lines.join('\n')}\n` };
}

// ── Git, in a scratch repository ─────────────────────────────────────────

function defaultDeps() {
  return {
    gitHost: require('./git-host'),
    github: require('./github'),
    enabled: (config, pool) => require('./versions-setting').enabled(config, pool),
    resolveLegacy: (config, pool, app) => lineage.resolveLegacy(config, pool, app),
    platformUserId: (pool) => require('./fleet-maintenance').ensurePlatformUser(pool),
    // The proposal machine's moves, each naming the status its caller read.
    promote: (p) => require('../workflow/platform.ts').promoteProposal({ ...p, from: p.from }),
    close: (p) => require('../workflow/platform.ts').closeProposal({ ...p, from: p.from }),
    reconcileHead: (args) => require('../routes/votes').reconcileNativeReviewedHead(args),
    activeUserIds: (pool, appId) => require('./active-users').listActiveUserIds(pool, appId),
    canManage: (pool, app, user) => require('./app-admins').canManageApp(pool, app, user),
    canView: (pool, app, user) => require('./app-access').checkAppAccess(pool, app, user, 'view'),
    // Whether the platform has room for another proposal: under the line
    // the admins' capacity alert warns at (`soft`), or under the session
    // limit itself (a person's own press).
    room: async (config, pool, { soft = true } = {}) => {
      const limit = await require('./session-limit').effective(pool, config);
      const used = await require('./session-caps').countGlobalSessions(pool);
      const ceiling = soft ? Math.floor(limit * require('./platform-limit-alerts').warnPercent() / 100) : limit;
      return used < ceiling;
    },
    notifyReady: async (pool, args) => {
      const notifications = require('./notifications');
      const rows = await notifications.createChangeReadyNotifications(pool, args);
      for (const row of rows) await notifications.hydrateAndPush(pool, row).catch(() => {});
      return rows;
    },
    askBot: (pool, args) => require('./homeroom-bot-dm').askBotToBuild(pool, args),
    noteIssue: (args) => require('./homeroom-bot').noteIssueActivity(args),
    ws: require('./ws'),
  };
}

function withDefaults(deps) {
  return deps ? { ...defaultDeps(), ...deps } : defaultDeps();
}

/** Whether this process may write to app repositories at all. */
function canWrite(deps) {
  return process.env.USERNODE_ENV !== 'staging' && !!(deps.gitHost && deps.gitHost.isConfigured());
}

async function withScratch(label, deps, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `usernode-update-${String(label).replace(/[^0-9a-z-]/gi, '')}-`));
  try {
    await deps.gitHost.git(['init', '-q', dir]);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runner(deps, dir) {
  const run = async (args, opts = {}) => String((await deps.gitHost.git(['-C', dir, ...args], opts)).stdout || '');
  // A command whose non-zero exit is an answer (merge-tree's 1, grep's 1).
  run.status = async (args, opts = {}) => {
    try {
      return { code: 0, stdout: await run(args, opts) };
    } catch (err) {
      if (err && typeof err.exitCode === 'number') return { code: err.exitCode, stdout: String(err.stdout || '') };
      throw err;
    }
  };
  return run;
}

async function hasCommit(run, rev) {
  return (await run.status(['cat-file', '-e', `${rev}^{commit}`])).code === 0;
}

async function showFile(run, rev, file) {
  const r = await run.status(['show', `${rev}:${file}`]);
  return r.code === 0 ? r.stdout : null;
}

function commitEnv(deps, epoch) {
  const author = deps.gitHost.defaultAuthor();
  const date = `@${Number(epoch) || 0} +0000`;
  return {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_COMMITTER_DATE: date,
  };
}

// merge-tree under -z --name-only: the tree, then the conflicted paths up to
// an empty field, then informational messages that name the same paths
// again (services/repo-mirror.js parseConflictPaths).
function parseMergeTree(stdout) {
  const fields = String(stdout || '').split('\0');
  const tree = (fields[0] || '').trim().toLowerCase();
  const conflicts = [];
  for (const field of fields.slice(1)) {
    if (field === '') break;
    const p = field.trim();
    if (p && !conflicts.includes(p)) conflicts.push(p);
  }
  return { tree, conflicts: conflicts.sort() };
}

class PlanError extends Error {
  constructor(message, code = 'plan_failed') {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

/**
 * Plan an update in the scratch repository `dir` (see the header). Pushes
 * nothing. Resolves
 *   { clean, empty, conflicts, theirsSha, headSha, mainSha, mainTree,
 *     brings, keeps, facts, manifestKeys, epoch, message }
 * where `headSha` is set only for a clean merge that changes something.
 */
async function planIn(dir, {
  deps, versionRemote, originalRemote, syncedSha, baseSha, fromSha,
  originalName = 'The original', versionName = 'This version', updateMergeShas = [],
}) {
  const run = runner(deps, dir);
  const auth = { auth: true };
  const env = (epoch, extra = {}) => ({ env: { ...commitEnv(deps, epoch), ...extra } });

  // 1. The commits.
  await run(['fetch', '--no-tags', '-q', originalRemote, syncedSha, fromSha], auth);
  await run(['fetch', '--no-tags', '-q', versionRemote, `+refs/heads/main:${SCRATCH_MAIN}`], auth);
  if (!(await hasCommit(run, baseSha))) await run(['fetch', '--no-tags', '-q', versionRemote, baseSha], auth);
  const mainSha = (await run(['rev-parse', `${SCRATCH_MAIN}^{commit}`])).trim().toLowerCase();
  const epoch = parseInt((await run(['log', '-1', '--format=%ct', fromSha])).trim(), 10) || 0;

  // 2. Theirs: the base, plus the original's own diff.
  const spec = lineage.diffPathspec();
  const patch = await run(['diff', '--binary', '--full-index', '--no-renames', syncedSha, fromSha, '--', ...spec]);
  const index = path.join(dir, '.git', 'homeroom-theirs-index');
  const withIndex = { env: { GIT_INDEX_FILE: index } };
  await run(['read-tree', baseSha], withIndex);
  if (patch.trim()) {
    const file = path.join(dir, '.git', 'homeroom-update.patch');
    await fs.writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`);
    const applied = await run.status(['apply', '--cached', '--3way', '--whitespace=nowarn', file], withIndex);
    if (applied.code !== 0) {
      throw new PlanError('The original\'s changes do not apply to this version\'s base', 'base_mismatch');
    }
  }
  const syncedManifest = await showFile(run, syncedSha, lineage.MANIFEST_PATH);
  const fromManifest = await showFile(run, fromSha, lineage.MANIFEST_PATH);
  const baseManifest = await showFile(run, baseSha, lineage.MANIFEST_PATH);
  const merged = lineage.mergeManifest(syncedManifest, fromManifest, baseManifest);
  let manifestKeys = [];
  if (merged.changed) {
    const blob = (await run(['hash-object', '-w', '--stdin'], { input: merged.text })).trim();
    await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${lineage.MANIFEST_PATH}`], withIndex);
    manifestKeys = merged.keys;
  }
  const theirsTree = (await run(['write-tree'], withIndex)).trim();
  const theirsSha = (await run(['commit-tree', theirsTree, '-p', baseSha, '-m', `${originalName} at ${fromSha.slice(0, 12)}`],
    env(epoch))).trim().toLowerCase();

  // 3. The merge, with `baseSha` as its base.
  const mainTree = (await run(['rev-parse', `${mainSha}^{tree}`])).trim().toLowerCase();
  const ours = (await run(['commit-tree', mainTree, '-p', baseSha, '-m', `${versionName} as it is`], env(epoch))).trim();
  const result = await run.status(['merge-tree', '--write-tree', '--name-only', '-z', ours, theirsSha]);
  if (result.code !== 0 && result.code !== 1) throw new PlanError('git merge-tree could not run');
  const mergedTree = parseMergeTree(result.stdout);
  const clean = result.code === 0;

  // What it brings and what this version keeps.
  const brings = (await run(['log', '--no-merges', '--format=%s%x1e', `${syncedSha}..${fromSha}`]))
    .split('\x1e').map((s) => s.trim()).filter(Boolean).reverse()
    .map((s) => ({ title: titleOf(s) })).filter((b) => b.title).slice(-MAX_BRINGS);
  const skip = new Set((updateMergeShas || []).map((s) => String(s).toLowerCase()));
  const own = (await run(['log', '--format=%H%x1f%s%x1e', `${baseSha}..${mainSha}`]))
    .split('\x1e').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [h, subject] = s.split('\x1f'); return { sha: String(h).toLowerCase(), title: titleOf(subject) }; })
    .filter((c) => !skip.has(c.sha));
  const keeps = { count: own.length, titles: own.slice(0, MAX_KEEPS_TITLES).map((c) => c.title).filter(Boolean) };

  const uses = async (word) => (await run.status(['grep', '-q', '-F', '-e', word, syncedSha, '--'])).code === 0;
  const facts = factsOf(patch, syncedManifest, fromManifest, {
    alreadyAi: await uses(AI_ENV), alreadyStorage: await uses(STORAGE_ENV),
  });

  const words = describe({ originalName, versionName, brings, facts, keeps });
  const empty = clean && mergedTree.tree === mainTree;
  let headSha = null;
  if (clean && !empty) {
    headSha = (await run(['commit-tree', mergedTree.tree, '-p', mainSha, '-F', '-'],
      { ...env(epoch), input: `${words.title}\n\n${words.body}` })).trim().toLowerCase();
  }
  return {
    clean, empty, conflicts: clean ? [] : mergedTree.conflicts, theirsSha, headSha, mainSha, mainTree,
    brings, keeps, facts, manifestKeys, epoch, words,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────

async function readVersion(pool, appId) {
  const { rows: [row] } = await pool.query(SQL.version, [appId]);
  return row || null;
}

async function readOriginal(pool, appId) {
  const { rows: [row] } = await pool.query(SQL.original, [appId]);
  return row || null;
}

async function readOffer(pool, appId) {
  const { rows: [row] } = await pool.query(SQL.offer, [appId]);
  return row || null;
}

async function updateMergeShas(pool, appId) {
  const { rows } = await pool.query(SQL.updateMerges, [appId]);
  return rows.map((r) => String(r.merge_commit_sha).toLowerCase());
}

async function saveOffer(pool, row) {
  await pool.query(SQL.saveOffer, [
    row.appId, row.fromAppId, row.fromSha, row.state, row.theirsSha || null, row.sessionId || null,
    JSON.stringify(row.facts || EMPTY_FACTS), JSON.stringify(row.brings || []),
    JSON.stringify(row.keeps || { count: 0, titles: [] }), JSON.stringify(row.conflicts || []),
    row.error ? clip(row.error, 500) : null,
  ]);
}

function hostedRepo(deps, app) {
  return app && app.repo_url ? deps.gitHost.parseRepoUrl(app.repo_url) : null;
}

/**
 * The version, its link, its original and the commits an update is planned
 * from, or a refusal. A legacy link is resolved here, the first time it is
 * needed (lineage.resolveLegacy); one that cannot be is refused.
 */
async function context({ config, pool, versionId, deps }) {
  const version = await readVersion(pool, versionId);
  let link = version ? lineage.readUpstream(version) : null;
  if (!version || !link) return refusal(409, 'not_a_version', MESSAGES.notAVersion);
  const original = await readOriginal(pool, link.appId);
  if (!original) return refusal(409, 'original_gone', MESSAGES.originalGone);
  // Refused with the two rows, so the caller can record why on the offer.
  const unplannable = (code, message) => ({ ...refusal(409, code, message), version, original });
  if (!lineage.planned(link)) {
    const resolved = link.legacy ? await deps.resolveLegacy(config, pool, version) : null;
    if (!resolved || !lineage.planned(resolved)) return unplannable('cannot_plan', MESSAGES.cannotPlan);
    link = resolved;
  }
  const versionRepo = hostedRepo(deps, version);
  const originalRepo = hostedRepo(deps, original);
  if (!versionRepo || !originalRepo) return unplannable('unavailable', MESSAGES.unavailable);
  return { ok: true, version, original, link, versionRepo, originalRepo };
}

function remotes(deps, ctx) {
  return {
    versionRemote: deps.gitHost.cloneUrl(ctx.versionRepo),
    originalRemote: deps.gitHost.cloneUrl(ctx.originalRepo),
  };
}

// ── Moving the lineage ───────────────────────────────────────────────────

/**
 * The update at `fromSha`, whose theirs commit is `theirsSha`, is behind
 * this version (it merged, or the group skipped it): refs/homeroom/upstream
 * moves to T, the link records it, and the row says how it ended. Safe to
 * run twice.
 */
async function advance({ pool, deps, version, versionRepo, fromSha, theirsSha, state }) {
  await withScratch(`advance-${version.id}`, deps, async (dir) => {
    const run = runner(deps, dir);
    const remote = deps.gitHost.cloneUrl(versionRepo);
    await run(['fetch', '--no-tags', '-q', remote, theirsSha], { auth: true });
    await deps.gitHost.pushRefs(versionRepo, dir, [`${theirsSha}:${lineage.UPSTREAM_REF}`], { force: true });
  });
  await lineage.writeUpstream(pool, version.id, { syncedSha: fromSha, baseSha: theirsSha });
  await pool.query(SQL.setState, [version.id, state, null]);
  log.info('upstream-offers', 'Lineage moved past an update', { app: version.slug, fromSha, theirsSha, state });
}

// ── Opening ──────────────────────────────────────────────────────────────

async function openPullRequest(deps, repo, { branch, title, body }) {
  try {
    return { pr: await deps.github.createPR(repo.owner, repo.name, { branch, title, body }), created: true };
  } catch (err) {
    if (err && err.code === 'pr_exists') {
      const pr = await deps.github.findOpenPrByBranch(repo.owner, repo.name, branch);
      if (pr) return { pr, created: false };
    }
    throw err;
  }
}

async function tellMembers({ pool, deps, versionId, sessionId, platformId }) {
  try {
    const { rows } = await pool.query(SQL.members, [versionId]);
    const ids = rows.map((r) => Number(r.user_id)).filter((id) => id !== Number(platformId));
    if (!ids.length) return 0;
    const { rows: [e] } = await pool.query(SQL.epoch, [sessionId]);
    const made = await deps.notifyReady(pool, {
      appId: versionId, sessionId, sourceUserId: null, recipientIds: ids, epoch: Number(e && e.approval_epoch) || 0,
    });
    return Array.isArray(made) ? made.length : 0;
  } catch (err) {
    log.warn('upstream-offers', 'Could not tell the members an update is ready', { versionId, sessionId, err: err.message });
    return 0;
  }
}

/**
 * Open the update a version is owed: plan it, and either put it up for a
 * vote, record that it needs fitting, or (when it changes nothing here)
 * move the lineage past it. `soft`: the clock's call, which waits for room
 * under the admins' warning line; a person's press waits only for the limit.
 * Resolves { ok: true, state, sessionId?, prNumber? } or a refusal.
 */
async function openUpdate({ config, pool, versionId, soft = false, deps: given } = {}) {
  const deps = withDefaults(given);
  if (!(await deps.enabled(config, pool))) return refusal(409, 'versions_off', MESSAGES.off);
  if (!canWrite(deps)) return refusal(409, 'unavailable', MESSAGES.unavailable);
  const ctx = await context({ config, pool, versionId, deps });
  if (!ctx.ok) {
    // One that cannot be planned says so on its row, and is not tried again
    // until its original moves.
    if (ctx.version && ctx.original && sha(ctx.original.main_sha)) {
      await saveOffer(pool, {
        appId: ctx.version.id, fromAppId: ctx.original.id, fromSha: sha(ctx.original.main_sha),
        state: 'failed', error: ctx.body.code,
      });
    }
    return refusal(ctx.status, ctx.body.code, ctx.body.error);
  }
  const { version, original, link } = ctx;
  const name = original.name || original.slug;
  const fromSha = sha(original.main_sha);
  if (!fromSha) return refusal(409, 'original_not_ready', MESSAGES.originalNotReady(name));
  if (fromSha === link.syncedSha) {
    await pool.query(SQL.clearAvailable, [version.id]);
    return refusal(409, 'up_to_date', MESSAGES.upToDate(name));
  }
  const { rows: [already] } = await pool.query(SQL.openSession, [version.id]);
  if (already) return { ok: true, state: 'open', sessionId: already.id, prNumber: already.pr_number || null, already: true };
  if (!(await deps.room(config, pool, { soft }))) return refusal(503, 'busy', MESSAGES.busy);

  const base = { appId: version.id, fromAppId: original.id, fromSha };
  let plan;
  try {
    const mergesShas = await updateMergeShas(pool, version.id);
    plan = await withScratch(`open-${version.id}`, deps, async (dir) => {
      const p = await planIn(dir, {
        deps, ...remotes(deps, ctx), syncedSha: link.syncedSha, baseSha: link.baseSha, fromSha,
        originalName: name, versionName: version.name || version.slug, updateMergeShas: mergesShas,
      });
      if (!p.clean) {
        await deps.gitHost.pushRefs(ctx.versionRepo, dir, [`${p.theirsSha}:${lineage.OFFER_REF}`], { force: true });
      } else if (p.empty) {
        await deps.gitHost.pushRefs(ctx.versionRepo, dir, [`${p.theirsSha}:${lineage.UPSTREAM_REF}`], { force: true });
      } else {
        await deps.gitHost.pushRefs(ctx.versionRepo, dir, [
          `${p.headSha}:refs/heads/${branchFor(fromSha)}`, `${p.theirsSha}:${lineage.OFFER_REF}`,
        ], { force: true });
      }
      return p;
    });
  } catch (err) {
    const message = deps.gitHost.redact ? deps.gitHost.redact(err && (err.message || String(err))) : String(err && err.message);
    log.warn('upstream-offers', 'Planning an update failed', { app: version.slug, fromSha, err: message });
    await saveOffer(pool, { ...base, state: 'failed', error: message || 'plan_failed' });
    return refusal(503, 'plan_failed', MESSAGES.planFailed);
  }
  const shared = { ...base, theirsSha: plan.theirsSha, facts: plan.facts, brings: plan.brings, keeps: plan.keeps };

  if (!plan.clean) {
    await saveOffer(pool, { ...shared, state: 'needs_fit', conflicts: plan.conflicts });
    log.info('upstream-offers', 'An update needs fitting', { app: version.slug, fromSha, conflicts: plan.conflicts.length });
    return { ok: true, state: 'needs_fit' };
  }
  if (plan.empty) {
    await lineage.writeUpstream(pool, version.id, { syncedSha: fromSha, baseSha: plan.theirsSha });
    await saveOffer(pool, { ...shared, state: 'merged' });
    log.info('upstream-offers', 'An update changed nothing here; the lineage moved past it', { app: version.slug, fromSha });
    return { ok: true, state: 'merged', empty: true };
  }

  // The proposal: its pull request, its row, its promote.
  const branch = branchFor(fromSha);
  let platformId;
  let opened;
  try {
    platformId = await deps.platformUserId(pool);
    opened = await openPullRequest(deps, ctx.versionRepo, { branch, title: plan.words.title, body: plan.words.body });
  } catch (err) {
    log.warn('upstream-offers', 'Opening the update\'s pull request failed', { app: version.slug, err: err.message });
    await saveOffer(pool, { ...shared, state: 'failed', error: err.message || 'pr_failed' });
    return refusal(503, 'plan_failed', MESSAGES.planFailed);
  }
  const { pr } = opened;
  let sessionId;
  try {
    const { rows: [row] } = await pool.query(SQL.insertSession, [
      version.id, platformId, branch, pr.number, pr.html_url || null, plan.words.title, plan.words.body, original.id,
    ]);
    sessionId = row.id;
  } catch (err) {
    // Another open raced past the read above and met the one-open index:
    // the pull request this call opened has no proposal.
    if (err && err.code === '23505') {
      if (opened.created) await deps.github.closePR(ctx.versionRepo.owner, ctx.versionRepo.name, pr.number).catch(() => {});
      const { rows: [won] } = await pool.query(SQL.openSession, [version.id]);
      if (won) return { ok: true, state: 'open', sessionId: won.id, prNumber: won.pr_number || null, already: true };
    }
    throw err;
  }
  await saveOffer(pool, { ...shared, state: 'open', sessionId });

  const answer = await deps.promote({
    sessionId, appId: version.id, userId: platformId, username: PROPOSER_NAME, from: 'active', cap: NO_CAP,
    pr: { state: 'open', draft: false, merged: false, head: plan.headSha }, expectedHead: plan.headSha,
    source: { kind: 'system', name: 'upstream-offers' },
  }).catch((err) => ({ status: 500, body: { error: err.message } }));
  if (!answer || answer.status >= 400) {
    // Nobody can put the platform's underway change up for a vote: it is
    // closed, and the update is tried again when its original moves or a
    // member presses for it.
    const why = clip((answer && answer.body && (answer.body.error || answer.body.message)) || 'promote refused', 300);
    log.warn('upstream-offers', 'The update could not go up for a vote', { app: version.slug, sessionId, why });
    await deps.close({ sessionId, appId: version.id, reason: 'update-refused', from: 'active', userId: null,
      username: PROPOSER_NAME, source: { kind: 'system', name: 'upstream-offers' } }).catch(() => {});
    await saveOffer(pool, { ...shared, state: 'failed', sessionId, error: why });
    return refusal(503, 'plan_failed', MESSAGES.planFailed);
  }
  const told = await tellMembers({ pool, deps, versionId: version.id, sessionId, platformId });
  log.info('upstream-offers', 'An update is up for a vote', {
    app: version.slug, original: original.slug, sessionId, prNumber: pr.number, brings: plan.brings.length, told,
  });
  return { ok: true, state: 'open', sessionId, prNumber: pr.number };
}

// ── Refreshing ───────────────────────────────────────────────────────────

/**
 * An open update whose original moved on is planned again from the same
 * lineage, and its branch moved with a lease to the new head: the proposal's
 * head moves the way any proposal's does (votes.reconcileNativeReviewedHead),
 * which clears its votes and checks it again. One that now conflicts is
 * closed and waits to be fitted.
 */
async function refreshUpdate({ config, pool, versionId, deps: given } = {}) {
  const deps = withDefaults(given);
  if (!(await deps.enabled(config, pool)) || !canWrite(deps)) return { skipped: 'off' };
  const row = await readOffer(pool, versionId);
  if (!row || row.state !== 'open' || !row.session_id || !['active', 'promoted'].includes(row.session_status)) {
    return { skipped: 'not_open' };
  }
  const ctx = await context({ config, pool, versionId, deps });
  if (!ctx.ok) return { skipped: ctx.body.code };
  const { version, original, link } = ctx;
  const fromSha = sha(original.main_sha);
  if (!fromSha || fromSha === sha(row.from_sha)) return { skipped: 'current' };
  const name = original.name || original.slug;
  const branch = row.branch_name || branchFor(row.from_sha);

  const mergesShas = await updateMergeShas(pool, version.id);
  const plan = await withScratch(`refresh-${version.id}`, deps, async (dir) => {
    const run = runner(deps, dir);
    const p = await planIn(dir, {
      deps, ...remotes(deps, ctx), syncedSha: link.syncedSha, baseSha: link.baseSha, fromSha,
      originalName: name, versionName: version.name || version.slug, updateMergeShas: mergesShas,
    });
    await deps.gitHost.pushRefs(ctx.versionRepo, dir, [`${p.theirsSha}:${lineage.OFFER_REF}`], { force: true });
    if (p.clean && !p.empty) {
      await run(['fetch', '--no-tags', '-q', remotes(deps, ctx).versionRemote, `+refs/heads/${branch}:${SCRATCH_BRANCH}`], { auth: true });
      const old = (await run(['rev-parse', `${SCRATCH_BRANCH}^{commit}`])).trim().toLowerCase();
      p.previousHead = old;
      if (old !== p.headSha) await deps.gitHost.casUpdateRef(ctx.versionRepo, dir, branch, old, p.headSha);
    }
    return p;
  });
  const shared = { appId: version.id, fromAppId: original.id, fromSha, theirsSha: plan.theirsSha,
    facts: plan.facts, brings: plan.brings, keeps: plan.keeps };

  if (!plan.clean || plan.empty) {
    // Recorded first: a close the sweep later reads without its row would
    // be taken for a skip.
    if (!plan.clean) await saveOffer(pool, { ...shared, state: 'needs_fit', conflicts: plan.conflicts });
    await deps.close({ sessionId: row.session_id, appId: version.id, reason: 'update-replaced', from: row.session_status,
      userId: null, username: PROPOSER_NAME, source: { kind: 'system', name: 'upstream-offers' } }).catch((err) =>
      log.warn('upstream-offers', 'Closing a replaced update failed', { app: version.slug, err: err.message }));
    if (plan.empty) {
      await lineage.writeUpstream(pool, version.id, { syncedSha: fromSha, baseSha: plan.theirsSha });
      await saveOffer(pool, { ...shared, state: 'merged' });
    }
    log.info('upstream-offers', 'An open update was replaced', { app: version.slug, fromSha, state: plan.clean ? 'merged' : 'needs_fit' });
    return { state: plan.clean ? 'merged' : 'needs_fit' };
  }

  if (row.pr_number) {
    await deps.github.updatePR(ctx.versionRepo.owner, ctx.versionRepo.name, row.pr_number, { body: plan.words.body })
      .catch((err) => log.warn('upstream-offers', 'Updating the description failed', { app: version.slug, err: err.message }));
  }
  await pool.query(SQL.sessionBody, [row.session_id, plan.words.body]);
  await saveOffer(pool, { ...shared, state: 'open', sessionId: row.session_id });
  const { rows: [session] } = await pool.query(SQL.session, [row.session_id]);
  if (session) {
    await deps.reconcileHead({ config, pool, session, fresh: true }).catch((err) =>
      log.warn('upstream-offers', 'The refreshed head was not reconciled; the next sweep does it', {
        app: version.slug, sessionId: row.session_id, err: err.message,
      }));
  }
  log.info('upstream-offers', 'An open update was refreshed', { app: version.slug, sessionId: row.session_id, fromSha });
  return { state: 'open', sessionId: row.session_id };
}

// ── Settling ─────────────────────────────────────────────────────────────

async function fitRequestOf(pool, appId, fromSha) {
  const { rows: [r] } = await pool.query(SQL.fitRequest, [appId, fitMarker(appId, fromSha)]);
  return r || null;
}

/**
 * An update whose proposal merged moves the lineage to it (`merged`); one
 * closed without merging was not taken (`skipped`), and the lineage moves
 * past it so it is not offered again. A needs_fit update whose fit request
 * was done counts as merged. Throws on a failed write, to be tried again.
 */
async function settleUpdate({ config, pool, versionId, deps: given } = {}) {
  const deps = withDefaults(given);
  if (!(await deps.enabled(config, pool)) || !canWrite(deps)) return { skipped: 'off' };
  const row = await readOffer(pool, versionId);
  if (!row || !sha(row.theirs_sha)) return { skipped: 'nothing' };
  let state = null;
  if (row.state === 'open' && row.session_status === 'merged') state = 'merged';
  else if (row.state === 'open' && row.session_status === 'archived') state = 'skipped';
  else if (row.state === 'needs_fit') {
    const fit = await fitRequestOf(pool, versionId, row.from_sha);
    if (fit && fit.state === 'closed' && fit.state_reason === 'completed') state = 'merged';
  }
  if (!state) return { skipped: 'unsettled' };
  const version = await readVersion(pool, versionId);
  const versionRepo = hostedRepo(deps, version);
  if (!version || !versionRepo) return { skipped: 'no_repo' };
  await advance({ pool, deps, version, versionRepo, fromSha: sha(row.from_sha), theirsSha: sha(row.theirs_sha), state });
  return { state };
}

// ── Skipping ─────────────────────────────────────────────────────────────

/**
 * "Skip this update": its proposal closed, and the lineage moved past it
 * without changing any code. Allowed on `open` and `needs_fit`.
 */
async function skipUpdate({ config, pool, versionId, user, deps: given } = {}) {
  const deps = withDefaults(given);
  if (!(await deps.enabled(config, pool))) return refusal(409, 'versions_off', MESSAGES.off);
  if (!canWrite(deps)) return refusal(409, 'unavailable', MESSAGES.unavailable);
  const row = await readOffer(pool, versionId);
  if (!row || !['open', 'needs_fit'].includes(row.state)) return refusal(409, 'nothing_to_skip', MESSAGES.nothingToSkip);
  const version = await readVersion(pool, versionId);
  const versionRepo = hostedRepo(deps, version);
  if (!version || !versionRepo) return refusal(409, 'unavailable', MESSAGES.unavailable);

  if (row.state === 'open' && row.session_id) {
    if (row.session_status === 'merged') {
      await advance({ pool, deps, version, versionRepo, fromSha: sha(row.from_sha), theirsSha: sha(row.theirs_sha), state: 'merged' });
      return { ok: true, state: 'merged' };
    }
    if (OPEN_STATUSES.includes(row.session_status)) {
      const closed = await deps.close({
        sessionId: row.session_id, appId: version.id, reason: 'update-skipped', from: row.session_status,
        userId: null, username: (user && user.username) || null, source: { kind: 'route', name: 'upstream-skip' },
      });
      // Accepted, or appended and not yet decided (`pending`: the proposal
      // machine closes it in a moment): either way it is going.
      const status = closed && typeof closed === 'object' ? closed.status : null;
      if (status !== 'accepted' && status !== 'replayed' && status !== 'pending') {
        const reason = closed && closed.reason;
        if (reason === 'merging' || reason === 'merged') return refusal(409, 'merging', MESSAGES.merging);
        if (reason !== 'already_closed') return refusal(409, 'nothing_to_skip', MESSAGES.nothingToSkip);
      }
    }
  }

  let theirs = sha(row.theirs_sha);
  if (!theirs) {
    // A needs_fit update recorded before its theirs commit was: planned
    // again for it, nothing else.
    const ctx = await context({ config, pool, versionId, deps });
    if (!ctx.ok) return refusal(ctx.status, ctx.body.code, ctx.body.error);
    const mergesShas = await updateMergeShas(pool, version.id);
    theirs = await withScratch(`skip-${version.id}`, deps, async (dir) => {
      const p = await planIn(dir, {
        deps, ...remotes(deps, ctx), syncedSha: ctx.link.syncedSha, baseSha: ctx.link.baseSha, fromSha: sha(row.from_sha),
        originalName: ctx.original.name || ctx.original.slug, versionName: version.name || version.slug, updateMergeShas: mergesShas,
      });
      await deps.gitHost.pushRefs(versionRepo, dir, [`${p.theirsSha}:${lineage.UPSTREAM_REF}`], { force: true });
      return p.theirsSha;
    });
  }
  await advance({ pool, deps, version, versionRepo, fromSha: sha(row.from_sha), theirsSha: theirs, state: 'skipped' });
  log.info('upstream-offers', 'An update was skipped', { app: version.slug, by: user && user.username, fromSha: row.from_sha });
  return { ok: true, state: 'skipped' };
}

// ── Fitting ──────────────────────────────────────────────────────────────

function fitBody({ originalName, versionName, brings, conflicts, diff, marker }) {
  const lines = [
    `${originalName} has changed since ${versionName} last took its updates, and its changes overlap with ${versionName}'s own.`,
    '',
    `What ${originalName} changed:`,
    '',
    ...(brings.length ? brings.slice(-20).map((b) => `- ${b.title}`) : [`- ${originalName}'s latest version`]),
    '',
    'The files both changed:',
    '',
    ...conflicts.slice(0, 50).map((p) => `- ${p}`),
    '',
    `To fit it, fetch \`${lineage.OFFER_REF}\` from this project's repository and merge it into main. `
      + `Keep what ${versionName} does, and bring ${originalName}'s changes in around it.`,
  ];
  if (diff) lines.push('', `${originalName}'s changes to those files:`, '', '```diff', diff, '```');
  lines.push('', marker);
  return lines.join('\n');
}

/**
 * "Ask Homeroom bot to fit it": a request on the version that describes the
 * update and the files it overlaps in, and Homeroom bot asked to build it as
 * the member who pressed (its normal path and costs). A second press finds
 * the first request. Resolves { ok: true, requestNumber, href, asked,
 * message } (`asked`: whether the bot took it; `message` says why not) or a
 * refusal.
 */
async function fitUpdate({ config, pool, versionId, user, deps: given } = {}) {
  const deps = withDefaults(given);
  if (!(await deps.enabled(config, pool))) return refusal(409, 'versions_off', MESSAGES.off);
  const row = await readOffer(pool, versionId);
  if (!row || row.state !== 'needs_fit') return refusal(409, 'nothing_to_fit', MESSAGES.nothingToFit);
  const version = await readVersion(pool, versionId);
  const original = row.from_app_id ? await readOriginal(pool, row.from_app_id) : null;
  const versionRepo = hostedRepo(deps, version);
  if (!version || !original || !versionRepo) return refusal(409, 'unavailable', MESSAGES.unavailable);
  const originalName = original.name || original.slug;
  const versionName = version.name || version.slug;
  const marker = fitMarker(version.id, row.from_sha);

  let number = null;
  const existing = await fitRequestOf(pool, version.id, row.from_sha);
  if (existing && existing.state === 'open') number = Number(existing.number);
  if (!number) {
    const conflicts = readConflicts(row.conflicts);
    let diff = '';
    const theirs = sha(row.theirs_sha);
    if (theirs && conflicts.length && canWrite(deps)) {
      diff = await withScratch(`fit-${version.id}`, deps, async (dir) => {
        const run = runner(deps, dir);
        await run(['fetch', '--no-tags', '-q', deps.gitHost.cloneUrl(versionRepo), theirs], { auth: true });
        return run(['diff', '--no-renames', `${theirs}^`, theirs, '--', ...conflicts]);
      }).catch(() => '');
      if (diff.length > MAX_FIT_DIFF_CHARS) diff = `${diff.slice(0, MAX_FIT_DIFF_CHARS)}\n... (the rest is in ${lineage.OFFER_REF})`;
    }
    const title = `Fit the update from ${originalName}`.slice(0, 256);
    const body = fitBody({ originalName, versionName, brings: readBrings(row.brings), conflicts, diff: diff.trimEnd(), marker });
    try {
      const created = await deps.github.createIssue(versionRepo.owner, versionRepo.name, { title, body, createdBy: user.id });
      number = Number(created && created.number);
      if (!Number.isInteger(number) || number <= 0) throw new Error('invalid request number');
    } catch (err) {
      log.warn('upstream-offers', 'Filing the fit request failed', { app: version.slug, err: err.message });
      return refusal(503, 'fit_failed', MESSAGES.fitFailed);
    }
    let issueId = null;
    try {
      const { rows: [issue] } = await pool.query(SQL.insertIssue, [version.id, number, title, body, user.id]);
      issueId = issue ? issue.id : null;
    } catch (err) {
      log.warn('upstream-offers', 'Recording the fit request failed', { app: version.slug, number, err: err.message });
    }
    await Promise.resolve(deps.ws.sendSystemMessage(pool, version.id, `${user.username} created issue: "${title}" (#${number})`,
      'system', null, { type: 'issue', ref: number })).catch(() => {});
    try { deps.ws.pushIssueUpdate({ action: 'created', appSlug: version.slug, appId: version.id, issueId, kind: 'general' }); } catch { /* repaired by the next read */ }
  }

  let asked = { ok: false, error: null };
  try {
    asked = await deps.askBot(pool, { app: version, user, issueNumber: number });
  } catch (err) {
    asked = { ok: false, error: err.message };
  }
  if (!asked || !asked.ok) {
    // The request stands whatever the bot answered; the usual triage reads it.
    try { deps.noteIssue({ appId: version.id, issueNumber: number, reason: 'created' }); } catch { /* best effort */ }
  }
  log.info('upstream-offers', 'Asked for an update to be fitted', { app: version.slug, number, asked: !!(asked && asked.ok) });
  return {
    ok: true,
    requestNumber: number,
    href: requestHref(version.slug, number),
    asked: !!(asked && asked.ok),
    message: asked && asked.ok ? null : ((asked && asked.error) || null),
  };
}

// ── Reads for the screens ────────────────────────────────────────────────

function offerView(row, slug) {
  if (!row) return null;
  return {
    state: OFFER_STATES.includes(row.state) ? row.state : 'failed',
    sessionId: row.session_id || null,
    href: row.session_id ? changeHref(slug, row.session_id, row.pr_number) : null,
    fromSha: sha(row.from_sha),
    brings: readBrings(row.brings),
    facts: readFacts(row.facts),
    keeps: readKeeps(row.keeps),
    conflicts: readConflicts(row.conflicts),
  };
}

/**
 * The hub card's and the menu's read, the version's side
 * (GET /api/apps/:slug/upstream). `app` is the version's full row, already
 * visible to `user`.
 */
async function view({ config, pool, app, user, deps: given } = {}) {
  const deps = withDefaults(given);
  const enabled = await deps.enabled(config, pool);
  const link = lineage.readUpstream(app);
  const canManage = !!(user && await deps.canManage(pool, app, user));
  const isPrivate = app.view_visibility !== 'public';
  if (!link) {
    return { enabled, original: null, following: false, share: false, canManage, private: isPrivate, behind: false, offer: null };
  }
  const original = await readOriginal(pool, link.appId);
  const visible = !!(original && await deps.canView(pool, original, user));
  const behind = !!(original && link.syncedSha && sha(original.main_sha) && sha(original.main_sha) !== link.syncedSha);
  const row = enabled ? await readOffer(pool, app.id) : null;
  return {
    enabled,
    original: visible ? {
      slug: original.slug,
      name: original.name || original.slug,
      emoji: original.icon_emoji || null,
      iconUrl: original.icon_image_id ? `/app-icons/${original.icon_image_id}` : null,
    } : null,
    following: link.following,
    share: link.share,
    canManage,
    private: isPrivate,
    behind,
    offer: offerView(row, app.slug),
  };
}

/** Managers set whether a private version shares its change titles with its original. */
async function setShare({ pool, app, share }) {
  return lineage.writeUpstream(pool, app.id, { share: !!share });
}

/**
 * The change page's block for an update proposal (the proposal read and the
 * session details), or null for any other change. Never throws.
 */
async function changeView(pool, sessionId) {
  try {
    const { rows: [r] } = await pool.query(SQL.changeView, [sessionId]);
    if (!r) return null;
    const state = r.state && OFFER_STATES.includes(r.state)
      ? r.state
      : (r.status === 'merged' ? 'merged' : r.status === 'archived' ? 'skipped' : 'open');
    return {
      from: { slug: r.from_slug, name: r.from_name || r.from_slug, emoji: r.from_emoji || null },
      brings: readBrings(r.brings),
      facts: readFacts(r.facts),
      keeps: readKeeps(r.keeps),
      state,
      conflicts: readConflicts(r.conflicts),
    };
  } catch (err) {
    log.warn('upstream-offers', 'Could not read an update\'s block', { sessionId, err: err.message });
    return null;
  }
}

// ── The clock ────────────────────────────────────────────────────────────

/**
 * One run of the clock job `upstream-offers`: mark what is owed (a database
 * write), and hand back as targets what needs git (settle merged and closed
 * updates, refresh the ones whose original moved, open up to OPEN_PER_RUN
 * for versions where someone was active lately while the platform has
 * room). One target per version at a time. A no-op while versions are off.
 */
async function sweep(config, pool, { deps: given } = {}) {
  const deps = withDefaults(given);
  if (!(await deps.enabled(config, pool))) return { off: true };
  if (!canWrite(deps)) return { off: 'unavailable' };
  const marked = (await pool.query(SQL.mark)).rowCount || 0;
  const items = [];
  const seen = new Set();
  const add = (appId, op, gen) => {
    const id = Number(appId);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return false;
    seen.add(id);
    items.push({ target: `v${id}`, ...(gen ? { gen } : {}), input: { op, appId: id } });
    return true;
  };

  // Settled: retried each run until done (it is safe twice).
  const { rows: settle } = await pool.query(SQL.dueSettle, [SCAN_LIMIT]);
  for (const r of settle) add(r.app_id, 'settle', null);
  const { rows: fits } = await pool.query(SQL.dueFit, [SCAN_LIMIT]);
  for (const r of fits) {
    const fit = await fitRequestOf(pool, r.app_id, r.from_sha).catch(() => null);
    if (fit && fit.state === 'closed' && fit.state_reason === 'completed') add(r.app_id, 'settle', null);
  }
  // Refreshed once per commit of the original (a failure waits for the next).
  const { rows: refresh } = await pool.query(SQL.dueRefresh, [SCAN_LIMIT]);
  for (const r of refresh) add(r.app_id, 'refresh', `refresh-${String(r.main_sha).slice(0, 12)}`);
  // Opened once per commit of the original, for versions in use, with room.
  let opened = 0;
  let room = false;
  const { rows: available } = await pool.query(SQL.dueOpen, [SCAN_LIMIT]);
  if (available.length) room = await deps.room(config, pool, { soft: true }).catch(() => false);
  if (room) {
    for (const r of available) {
      if (opened >= OPEN_PER_RUN) break;
      if (seen.has(Number(r.app_id))) continue;
      const active = await deps.activeUserIds(pool, Number(r.app_id)).catch(() => []);
      if (!active.length) continue;
      if (add(r.app_id, 'open', `open-${String(r.from_sha).slice(0, 12)}`)) opened += 1;
    }
  }
  return { marked, settle: settle.length, refresh: refresh.length, available: available.length, opened, room, items };
}

/**
 * One target of the clock job: `input` is { op, appId }. Opening and
 * refreshing record a failure on the row and move on; settling throws, to be
 * tried again.
 */
async function work(config, pool, input, { deps } = {}) {
  const op = input && input.op;
  const versionId = Number(input && input.appId);
  if (!Number.isInteger(versionId) || versionId <= 0) return { skipped: 'bad_input' };
  if (op === 'settle') return settleUpdate({ config, pool, versionId, deps });
  if (op === 'open') {
    try {
      const r = await openUpdate({ config, pool, versionId, soft: true, deps });
      return r.ok ? { op, state: r.state, sessionId: r.sessionId || null } : { op, refused: r.body.code };
    } catch (err) {
      log.error('upstream-offers', 'Opening an update failed', { versionId, err: err.message });
      await pool.query(SQL.setState, [versionId, 'failed', clip(err.message, 500)]).catch(() => {});
      return { op, failed: clip(err.message, 200) };
    }
  }
  if (op === 'refresh') {
    try {
      return { op, ...(await refreshUpdate({ config, pool, versionId, deps })) };
    } catch (err) {
      // The update stays up as it was; the next commit of its original
      // tries again.
      log.error('upstream-offers', 'Refreshing an update failed', { versionId, err: err.message });
      await pool.query(SQL.setError, [versionId, clip(err.message, 500)]).catch(() => {});
      return { op, failed: clip(err.message, 200) };
    }
  }
  return { skipped: 'unknown_op' };
}

module.exports = {
  BRANCH_PREFIX,
  EMPTY_FACTS,
  MESSAGES,
  OPEN_PER_RUN,
  SQL,
  advance,
  branchFor,
  canWrite,
  changeView,
  describe,
  factsOf,
  fitMarker,
  fitUpdate,
  insideHost,
  openUpdate,
  parseMergeTree,
  planIn,
  refreshUpdate,
  settleUpdate,
  setShare,
  skipUpdate,
  sweep,
  titleOf,
  updateMergeShas,
  view,
  work,
  withScratch,
};
