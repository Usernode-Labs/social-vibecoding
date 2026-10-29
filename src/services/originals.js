'use strict';

/**
 * The ready-made originals (docs/plans/versions.md, "Originals").
 *
 * Each starter directory with ready-made entries (app-templates/<dir>,
 * services/app-templates.js) is a real Homeroom project as well: Tier list,
 * Group poll, Grocery list and the rest, one per directory. A ready-made
 * somebody makes is then a VERSION of its directory's original: its first
 * commit is the original's main tree with the project's own words and name,
 * and the original's merged changes are offered down to it as ordinary
 * changes its own group votes on (services/upstream-offers.js).
 *
 * WHAT AN ORIGINAL IS. A project like any other, made through the normal
 * create path (an apps row in `creating`, which starts app-creation's setup:
 * its repository from its directory's first ready-made, its database, its
 * first deploy), with:
 *   - the slug `homeroom-<dir>` and its directory's name;
 *   - the platform's own account (usernode-platform) as its maker;
 *   - public, to look at and to build;
 *   - `original_of` = its directory, and `approvers_from_app_id` = the
 *     platform's own app, so the platform's approvers approve its changes
 *     (rules/electorate.ts getApproverSet), with "invited approvers, at
 *     least one" as its rule, in its dapp.json from the first commit;
 *   - the platform's approvers in its community (source 'auto'), so they can
 *     vote there.
 * ensure() makes the ones missing, from the 'originals' clock every ten
 * minutes, and only where versions can work: the git host configured
 * (every new repository is made there), versions on
 * (services/versions-setting.js), and not in a platform preview, which runs
 * on a copy of production's database. A slug some other project already
 * holds is left alone, and said.
 *
 * MAKING A VERSION (routes/apps.js POST /api/apps, app-creator.js
 * seedStarter): linkFor gives the new row its link; sourceFor gives its
 * setup the original's tree at the commit it copies, and versionFiles the
 * files of its first commit. starter-images builds each ready-made's image
 * from the same files (imageSources), so the image a new version deploys is
 * the one its own first commit would build. The commit it copies is the
 * newest of the original's last few whose image is built (readyCommit), so
 * a version is as quick to make as a ready-made always was, even in the
 * minutes after a change merges into its original.
 */

const { isUtf8 } = require('buffer');
const log = require('./logger');
const appTemplates = require('./app-templates');
const lineage = require('./upstream-lineage');

const SLUG_PREFIX = 'homeroom-';
// A directory whose name does not read as its title once its hyphens are
// spaces.
const NAMED = Object.freeze({ 'signup-sheet': 'Sign-up sheet' });
// The first session's card (services/app-sketch.js designFiles): a
// project's own, like the paths that never travel.
const CARD_PATH = 'design/sketch.json';
// What a version takes from its own making rather than its original's tree
// (dapp.json is merged, see versionManifest).
const OWN_PATHS = Object.freeze([...lineage.EXCLUDED_PATHS, CARD_PATH]);
const SHA_RE = /^[0-9a-f]{40}$/i;
// Blob reads at once, and trees kept, per process.
const READ_CONCURRENCY = 8;
const TREE_MEMO = 24;
// How many of an original's latest commits on main a new version may copy
// (readyCommit).
const RECENT_COMMITS = 5;
// The original's governance: the platform's approvers, one of them enough.
const APPROVALS_REQUIRED = 1;

function nameOf(dir) {
  if (NAMED[dir]) return NAMED[dir];
  const words = String(dir).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Every starter directory with ready-made entries, in TEMPLATES order: its
 * original's slug and name, and the first ready-made of it, which the
 * original is made from.
 */
function starters() {
  const seen = new Map();
  for (const id of appTemplates.READY_IDS) {
    const dir = appTemplates.dirOf(id);
    if (!seen.has(dir)) seen.set(dir, Object.freeze({ dir, slug: `${SLUG_PREFIX}${dir}`, name: nameOf(dir), template: id }));
  }
  return [...seen.values()];
}

// ── Whether versions work here ──────────────────────────────────────────

/** A platform preview: a copy of production's database, where nothing of this is made. */
function inPreview(env = process.env) {
  return env.USERNODE_ENV === 'staging';
}

function hostReady() {
  try {
    return require('./git-host').isConfigured();
  } catch {
    return false;
  }
}

// The Admin › Limits switch (services/versions-setting.js `enabled`), read
// lazily: a build without the module has versions on. A setting that cannot
// be read is off for this one decision, which then makes things as before.
let versionsOverride = null;
async function versionsOn(config, pool) {
  if (versionsOverride) return versionsOverride(config, pool);
  let setting;
  try {
    setting = require('./versions-setting');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /Cannot find module '\.\/versions-setting'/.test(String(err.message))) return true;
    log.warn('originals', 'The versions setting did not load; versions are off for now', { err: err && err.message });
    return false;
  }
  try {
    return (await setting.enabled(config, pool)) !== false;
  } catch (err) {
    log.warn('originals', 'The versions setting could not be read; versions are off for now', { err: err.message });
    return false;
  }
}

/** Whether originals are made, and versions made from them, in this process. */
async function available(config, pool, env = process.env) {
  if (!hostReady() || inPreview(env)) return false;
  return versionsOn(config, pool);
}

// ── Rows ────────────────────────────────────────────────────────────────

async function ofDir(db, dir) {
  const { rows } = await db.query(
    `SELECT id, slug, name, status, main_sha, repo_url, template, original_of
       FROM apps WHERE original_of = $1`,
    [dir]
  );
  return rows[0] || null;
}

/** Whether an original can be copied now: running, at a known main, with a repository. */
function runningWithMain(o) {
  return !!(o && o.status === 'running' && SHA_RE.test(String(o.main_sha || '')) && o.repo_url);
}

// ── Making the originals ────────────────────────────────────────────────

/**
 * Make each starter directory's original that is missing, and keep the
 * platform's approvers in every original's community. Idempotent; the
 * 'originals' clock runs it (src/workflow/clock/services.ts). Resolves what
 * it found and did, for the clock's record.
 */
async function ensure(config, pool, { env = process.env } = {}) {
  if (!hostReady()) return { off: 'no_git_host' };
  if (inPreview(env)) return { off: 'preview' };
  if (!(await versionsOn(config, pool))) return { off: 'versions_off' };
  const { rows: [platform] } = await pool.query(
    'SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1'
  );
  if (!platform) return { off: 'no_platform_app' };
  const ownerId = await require('./fleet-maintenance').ensurePlatformUser(pool);

  const { rows: existing } = await pool.query(
    'SELECT original_of FROM apps WHERE original_of IS NOT NULL'
  );
  const have = new Set(existing.map((r) => r.original_of));
  const made = [];
  const skipped = [];
  for (const s of starters()) {
    if (have.has(s.dir)) continue;
    const { rows: [taken] } = await pool.query('SELECT id FROM apps WHERE slug = $1', [s.slug]);
    if (taken) {
      log.warn('originals', 'Another project has this original\'s address; it is not made', { dir: s.dir, slug: s.slug, appId: taken.id });
      skipped.push(s.slug);
      continue;
    }
    try {
      // The way POST /api/apps makes a project: the row with its maker's
      // membership, in one statement, whose insert starts its making
      // (src/workflow/app-creation/, the apps_wf_enrol_creation trigger).
      // Its setup scaffolds the directory's first ready-made, with this
      // row's rule as its dapp.json's governance block.
      const { rows: [row] } = await pool.query(
        `WITH new_app AS (
           INSERT INTO apps (name, slug, repo_url, created_by, status, collab_visibility, view_visibility,
                             template, icon_emoji, original_of, approvers_from_app_id,
                             approver_policy, approvals_required)
           VALUES ($1, $2, NULL, $3, 'creating', 'public', 'public', $4, $5, $6, $7, 'invited', $8)
           ON CONFLICT DO NOTHING
           RETURNING id, slug
         ), membership AS (
           INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
           SELECT id, $3, 'member', NOW() FROM new_app
           ON CONFLICT (app_id, user_id) DO NOTHING
         )
         SELECT id, slug FROM new_app`,
        [s.name, s.slug, ownerId, s.template, appTemplates.get(s.template).icon || null, s.dir, platform.id, APPROVALS_REQUIRED]
      );
      if (row) {
        made.push(row.slug);
        log.info('originals', 'Original made', { dir: s.dir, slug: row.slug, appId: row.id });
      }
    } catch (err) {
      // A deleted project's purge still holding the name, or any other
      // refusal: tried again on the next run.
      log.warn('originals', 'Original not made', { dir: s.dir, slug: s.slug, err: err.message, code: err.code });
      skipped.push(s.slug);
    }
  }

  const joined = await joinApprovers(pool, platform.id);
  return { originals: have.size + made.length, made, skipped, joined };
}

/**
 * The platform's approvers (its app_approvers members, else the full
 * admins: the roster rules/electorate.ts counts) in every original's
 * community, source 'auto'. Resolves how many joined now.
 */
async function joinApprovers(pool, platformId) {
  try {
    const { ids } = await require('./governance').getApproverSet(pool, platformId);
    if (!ids.length) return 0;
    const { rowCount } = await pool.query(
      `INSERT INTO community_members (community_id, user_id, source)
       SELECT a.community_id, u.id, 'auto'
         FROM apps a CROSS JOIN unnest($1::int[]) AS u(id)
        WHERE a.original_of IS NOT NULL AND a.community_id IS NOT NULL
       ON CONFLICT (community_id, user_id) DO NOTHING`,
      [ids]
    );
    return rowCount || 0;
  } catch (err) {
    log.warn('originals', 'The platform\'s approvers were not joined to the originals', { err: err.message });
    return 0;
  }
}

// ── Making a version ────────────────────────────────────────────────────

/**
 * The link (apps.upstream) a project made from ready-made `templateId`
 * starts with, or null when its directory has no original. A version of a
 * running original, where versions are on, gets its updates
 * ({ appId, slug, following: true, since }; its setup adds the two commits);
 * otherwise it is made from app-templates as before and linked as a copy
 * made before versions ({ following: false, legacy: true }).
 */
async function linkFor(config, pool, templateId, { now = new Date(), env = process.env } = {}) {
  if (!appTemplates.isReadyMade(templateId)) return null;
  const original = await ofDir(pool, appTemplates.dirOf(templateId));
  if (!original) return null;
  const base = { appId: original.id, slug: original.slug, since: now.toISOString() };
  if (runningWithMain(original) && await available(config, pool, env)) return { ...base, following: true };
  return { ...base, following: false, legacy: true };
}

/**
 * What a new version's first commit is made from, for app-creator
 * seedStarter: { original, sha, tree, committed } for a ready-made made as a
 * version (its link gets updates and is not legacy), or null to make it
 * from app-templates as before. `sha` is the original's commit it copies
 * (its main when this setup began), `tree` that commit's files (mainTree),
 * and `committed` whether an earlier try of this setup already chose it
 * (the link's `syncedSha`).
 *
 * Until a try has chosen a commit, an original that is no longer running,
 * versions switched off, or a tree that cannot be read make the project
 * from app-templates instead, linked as a copy made before versions: making
 * it never waits on its original. Once one has, the setup keeps to that
 * commit (its `tree` null when it cannot be read now), so a try that resumes
 * never mixes one first commit with another's files.
 */
async function sourceFor(config, pool, row, { env = process.env } = {}) {
  const link = lineage.readUpstream(row);
  const template = row && row.template;
  if (!link || !link.following || link.legacy || !appTemplates.isReadyMade(template)) return null;
  const committed = !!link.syncedSha;
  const { rows: [original] } = await pool.query(
    `SELECT id, slug, name, status, main_sha, repo_url, template, original_of
       FROM apps WHERE id = $1`,
    [link.appId]
  );
  // Not one of the platform's originals: not this module's to make.
  if (original && original.original_of !== appTemplates.dirOf(template)) return null;
  const asBefore = async (why, extra = {}) => {
    log.warn('originals', 'Made from the ready-made as before, linked as an older copy', { appId: row.id, why, ...extra });
    await lineage.writeUpstream(pool, row.id, { following: false, legacy: true });
    return null;
  };
  if (!committed) {
    if (!original) return asBefore('original_gone');
    if (!runningWithMain(original)) return asBefore('original_not_running', { status: original.status });
    if (!(await available(config, pool, env))) return asBefore('versions_off');
  }
  if (!original) return { original: null, sha: link.syncedSha, tree: null, committed };
  const head = (link.syncedSha || String(original.main_sha)).toLowerCase();
  let sha = head;
  try {
    if (!committed) {
      sha = await readyCommit(config, pool, original, head, template);
      if (!sha) return asBefore('image_not_ready', { sha: head });
    }
    return { original, sha, tree: await mainTree(original, sha), committed };
  } catch (err) {
    if (!committed) return asBefore('tree_unreadable', { err: err.message });
    log.warn('originals', 'The original\'s tree could not be read', { appId: row.id, sha, err: err.message });
    return { original, sha, tree: null, committed };
  }
}

/**
 * The commit a new version copies (sourceFor): `head`, its original's main,
 * when the image built from it for this ready-made is ready
 * (starter-images.js readyFromOriginal), else the newest of the commits
 * before it on main whose image is. A change merged since then reaches the
 * version as its first update (services/upstream-offers.js). Null when none
 * of the last RECENT_COMMITS has one, as just after an original first comes
 * up: the project is then made as before.
 */
async function readyCommit(config, pool, original, head, template) {
  const images = require('./starter-images');
  if (await images.readyFromOriginal(config, pool, template, original, head)) return head;
  for (const sha of (await recentCommits(original, head)).slice(1)) {
    if (await images.readyFromOriginal(config, pool, template, original, sha)) return sha;
  }
  return null;
}

// `sha` and the commits before it on the original's main, newest first.
async function recentCommits(original, sha) {
  const ref = require('./repo-ref').ownerRepo(original.repo_url);
  if (!ref) throw new Error('The original has no repository to read');
  const dir = await require('./repo-mirror').ensureMirror(ref.owner, ref.repo, { refs: [sha] });
  const { stdout } = await require('./docker').execFileAsync('git',
    ['-C', dir, 'rev-list', '--first-parent', `--max-count=${RECENT_COMMITS}`, sha], { timeout: 60000 });
  return String(stdout).split('\n').map((l) => l.trim().toLowerCase()).filter((l) => SHA_RE.test(l));
}

/**
 * The files of a version's first commit: its original's tree, with what
 * makes it a different project its own. `tree` is mainTree's; `own` the
 * files this project would be made of from app-templates
 * (app-creator.starterFiles, template.js getTemplateFiles), of which it
 * takes the paths that never travel (its words.json, its name in README.md,
 * CLAUDE.md and LICENSE, its repository pointer) and its card; dapp.json is
 * versionManifest's. Sorted by path. Pure.
 */
function versionFiles(tree, own, { name, templateId, originalTemplate = null }) {
  const mine = new Map((own || []).map((f) => [f.path, f]));
  const out = [];
  let theirs = null;
  for (const f of tree || []) {
    if (f.path === lineage.MANIFEST_PATH) theirs = f;
    else if (!OWN_PATHS.includes(f.path)) out.push(f);
  }
  for (const p of OWN_PATHS) if (mine.has(p)) out.push(mine.get(p));
  const ownManifest = mine.get(lineage.MANIFEST_PATH);
  out.push({
    path: lineage.MANIFEST_PATH,
    content: versionManifest(theirs ? String(theirs.content) : null, ownManifest ? String(ownManifest.content) : null,
      { name, templateId, originalTemplate }),
  });
  return out.sort(byPath);
}

/**
 * A version's dapp.json: its original's, without the keys that make a
 * project a different one (upstream-lineage EXCLUDED_MANIFEST_KEYS), with
 * this project's own name, description, icon and approval rule, and
 * `followOriginal: true`. Its checks are its original's, unless the
 * ready-made it was made from has checks of its own (a sign-up sheet's
 * "Who's coming" against its volunteer shifts): those are written for its
 * mode of the same code, so they are this one's.
 */
function versionManifest(originalText, ownText, { name, templateId, originalTemplate = null }) {
  const theirs = parseObject(originalText) || {};
  const mine = parseObject(ownText) || {};
  const next = { name };
  if (typeof mine.description === 'string' && mine.description.trim()) next.description = mine.description;
  for (const [key, value] of Object.entries(theirs)) {
    if (!lineage.EXCLUDED_MANIFEST_KEYS.includes(key)) next[key] = value;
  }
  if (mine.icon) next.icon = mine.icon;
  const entry = appTemplates.get(templateId);
  const from = appTemplates.get(originalTemplate);
  if (entry && from && entry.id !== from.id && JSON.stringify(entry.tests) !== JSON.stringify(from.tests)) {
    next.tests = JSON.parse(JSON.stringify(entry.tests));
  }
  if (mine.governance) next.governance = mine.governance;
  next.followOriginal = true;
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** The commit message of a version's first commit, which a try that resumes knows it by. */
function versionMessage(name, original) {
  return `Initialize ${name} from ${(original && original.name) || 'its original'}`;
}

/**
 * The originals each ready-made's prebuilt image is made from now
 * (services/starter-images.js): starter directory -> { original, sha } for
 * each original running at a known main. Empty where versions are not on
 * here, the same gates a new version is made under.
 */
async function imageSources(config, pool, { env = process.env } = {}) {
  const out = new Map();
  if (!(await available(config, pool, env))) return out;
  const { rows } = await pool.query(
    `SELECT id, slug, name, status, main_sha, repo_url, template, original_of
       FROM apps WHERE original_of IS NOT NULL`
  );
  for (const o of rows) {
    if (runningWithMain(o)) out.set(o.original_of, { original: o, sha: String(o.main_sha).toLowerCase() });
  }
  return out;
}

// ── An original's tree ──────────────────────────────────────────────────

const trees = new Map();

/**
 * The original's files at `sha`: [{ path, content, mode }], sorted by path,
 * read from its repository's mirror (services/repo-mirror.js) exactly as
 * committed. `content` is text where the file is UTF-8 and a Buffer where it
 * is not; `mode` is git's (100644, 100755, 120000 for a link). A submodule
 * is left out. Kept per commit, which never changes, so each is read once.
 */
function mainTree(original, sha) {
  const at = String(sha || '').toLowerCase();
  if (!SHA_RE.test(at)) return Promise.reject(new Error('Not a commit to read'));
  const key = `${original.repo_url}@${at}`;
  if (trees.has(key)) return trees.get(key);
  const reading = readTree(original.repo_url, at);
  trees.set(key, reading);
  reading.catch(() => { if (trees.get(key) === reading) trees.delete(key); });
  while (trees.size > TREE_MEMO) trees.delete(trees.keys().next().value);
  return reading;
}

async function readTree(repoUrl, sha) {
  const ref = require('./repo-ref').ownerRepo(repoUrl);
  if (!ref) throw new Error('The original has no repository to read');
  const dir = await require('./repo-mirror').ensureMirror(ref.owner, ref.repo, { refs: [sha] });
  const docker = require('./docker');
  const git = (args) => docker.execFileAsync('git', ['-C', dir, ...args],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  const { stdout } = await git(['ls-tree', '-r', '-z', '--full-tree', sha]);
  const entries = [];
  for (const line of Buffer.from(stdout).toString('utf8').split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    if (type === 'blob') entries.push({ path: line.slice(tab + 1), mode, oid });
  }
  const files = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const { stdout: buf } = await git(['cat-file', 'blob', entries[i].oid]);
      const bytes = Buffer.from(buf);
      files[i] = Object.freeze({ path: entries[i].path, content: isUtf8(bytes) ? bytes.toString('utf8') : bytes, mode: entries[i].mode });
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, entries.length) }, worker));
  return Object.freeze(files.sort(byPath));
}

function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function parseObject(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

module.exports = {
  SLUG_PREFIX,
  APPROVALS_REQUIRED,
  OWN_PATHS,
  available,
  ensure,
  imageSources,
  inPreview,
  linkFor,
  mainTree,
  nameOf,
  runningWithMain,
  sourceFor,
  starters,
  versionFiles,
  versionManifest,
  versionMessage,
  _forTest: {
    RECENT_COMMITS,
    setVersions(fn) { versionsOverride = fn || null; },
    resetTrees() { trees.clear(); },
    joinApprovers,
  },
};
