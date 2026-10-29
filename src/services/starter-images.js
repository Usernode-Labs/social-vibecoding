'use strict';

/**
 * Ready-made apps' prebuilt images.
 *
 * A ready-made app (services/app-templates.js, `ready`) is a project that
 * needs nothing built by Homeroom bot, and yet each one built its own image
 * as it was made: City Tier List (newcomer run, 20 Oct 2026) took 32.2 s
 * from Make it to live, 19.1 s of it the image build, for code every city
 * tier list shares. Now each ready-made app's image is built once, here,
 * and a new project made from it deploys that image instead (its first
 * deploy, services/staging.js deployProduction `starter`).
 *
 * THE SAME CODE. services/template.js writes nothing of one project's into
 * what its image is built from: the page's name is filled in at runtime
 * from USERNODE_APP_NAME, the slug read from USERNODE_APP_SLUG, and the
 * files that name the project (README, CLAUDE.md, LICENSE, dapp.json, the
 * first session's card) are in .dockerignore. contextKey hashes exactly
 * what the image is built from (every generated file .dockerignore keeps)
 * and how (buildRecipe). A new project computes the key of its own files,
 * as it committed them, and uses an image only under that same key, so the
 * image it runs is the one its own commit would build. Its first change
 * builds from its repository as every change does.
 *
 * BUILT AHEAD, NEVER ON A PERSON'S FIRST PROJECT (Evan, 20 Oct 2026). The
 * starter-images clock (src/workflow/clock/) builds every ready-made app
 * whose current key has no image yet, each key a target of its own (one
 * build of it at a time, under the workflow's lease): its first run after a
 * release (a release that changes a starter or the generator changes the
 * keys), and every minute after, which also retries a failed build
 * (MAX_ATTEMPTS, RETRY_AFTER_SECONDS apart) and one whose process went away
 * mid-build. Only the newest build runs it: the keys are its own. Admin >
 * Templates lists them and queues a Rebuild.
 * A project made while its image is still building waits for it, up to
 * WAIT_MS; one with no image (queued, failed, prebuilds off) builds its own
 * as before, so nobody waits on a build that has not started.
 *
 * THE SOURCE. A Kubernetes build fetches a commit from GitHub, so each build
 * commits its files to the bot's `homeroom-starter-images` repository, as a
 * commit with no parent on the branch `prebuild/<template>`, and builds that
 * commit as the app `starter-<template>` (its image repository
 * `homeroom-starter-<template>`; app slugs end in a random suffix, so none
 * reads like it). The build writes the starter's shared layer cache, which a
 * new app's first build used to (services/kubernetes-buildkit.js "The
 * starter's shared cache"). On Docker the files are built where they are
 * written, and a project tags the image as its own (app-respawn.js runs
 * `usernode-app-<slug>:latest`).
 *
 * NOT IN A STAGING PREVIEW, which runs against a clone of production's
 * database (and arms no clock), and not with STARTER_PREBUILDS=off. A preview still uses an image production
 * built under the same key.
 *
 * FROM THE ORIGINALS (docs/plans/versions.md). Where versions are on and a
 * ready-made's starter directory has its original running at a known main
 * (services/originals.js), a new project made from it is a version of that
 * original, whose first commit is the original's main tree with its own
 * words (app-creator.js seedVersion). So that ready-made's image is built
 * from the same files (originals.versionFiles over the original's tree and
 * this ready-made's words.json, plus the per-project files, which are in
 * .dockerignore anyway), and its key is the one such a version computes.
 * Each changes when the original's main does; the tree is read again only
 * then. Without an original, or with versions off, the ready-made is
 * rendered from app-templates as before.
 *
 * The platform never deletes a registry image (docs/app-data-retention.md),
 * so a project keeps running the image it was made with. A registry cleanup
 * policy of the cluster's own must keep `homeroom-starter-*`.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('./logger');
const appTemplates = require('./app-templates');

// Bump to rebuild every ready-made app's image, for a change to how they are
// built that neither the files nor the recipe show.
const VERSION = 'v1';
const SOURCE_REPO = 'homeroom-starter-images';
const MAX_ATTEMPTS = 3;
// After the n-th failed attempt, the next waits n times this.
const RETRY_AFTER_SECONDS = 5 * 60;
// Builds run at once: a release that changes the generator changes every key.
const CONCURRENCY = 3;
// The clock's targets, as the workflow keeps them (src/workflow/clock/).
const CLOCK_KEY = 'clock:starter-images';
const ITEM_KIND = 'clock.starter-images.item';
const WAIT_MS = 60 * 1000;
const WAIT_POLL_MS = 2000;
const ERROR_CHARS = 2000;

const STATUSES = Object.freeze(['queued', 'building', 'ready', 'failed']);

/** The app a template's image is built as (see THE SOURCE). */
const buildSlug = (id) => `homeroom-starter-${id}`;
const buildAppId = (id) => `starter-${id}`;
const branchOf = (id) => `prebuild/${id}`;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const escapeRe = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * The generated files that go into the image: every file the tree's own
 * .dockerignore keeps. Null for a .dockerignore this cannot read the way
 * Docker does (a `!` exception, `**`, a character class, an escape): such a
 * tree is not shared.
 */
function imageFiles(files) {
  const ignore = (files || []).find((f) => f.path === '.dockerignore');
  const patterns = [];
  for (const raw of (ignore ? String(ignore.content) : '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^!|\*\*|[[\]\\]/.test(line)) return null;
    const clean = line.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (!clean) continue;
    const re = clean.split('/')
      .map((part) => part.split('*').map((piece) => piece.split('?').map(escapeRe).join('[^/]')).join('[^/]*'))
      .join('/');
    patterns.push(new RegExp(`^${re}(?:/|$)`));
  }
  return (files || []).filter((f) => !patterns.some((re) => re.test(f.path)));
}

/**
 * The key of what an image is built from: `recipe` (buildRecipe) and every
 * file imageFiles keeps, by path. SHA-256, hex. Null when the tree is not
 * shared (imageFiles).
 */
function contextKey(files, recipe) {
  const kept = imageFiles(files);
  if (!kept) return null;
  const hash = crypto.createHash('sha256');
  hash.update(`${VERSION}\0${recipe}\0`);
  for (const f of [...kept].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${f.path}\0${f.content}\0`);
  }
  return hash.digest('hex');
}

/**
 * How this platform builds an image, for the key: the runtime, and on
 * Kubernetes the build settings an image's layers depend on.
 */
function buildRecipe(config) {
  const mode = require('./application-runtime').mode(config);
  if (mode !== 'kubernetes') return mode;
  const k = (config && config.kubernetes) || {};
  return `kubernetes-${sha256(JSON.stringify({
    engine: k.buildEngine || 'kpack',
    image: k.buildkitImage || null,
    mode: k.buildkitMode || 'rootless',
    node: k.nodeVersion || null,
  })).slice(0, 12)}`;
}

/**
 * Every ready-made app as this build of the platform generates it: its id,
 * title, files and key. Memoised by recipe: the starters are files shipped
 * with the platform, so they change only with a release.
 */
const trees = new Map();
function currentTrees(config) {
  const recipe = buildRecipe(config);
  if (trees.has(recipe)) return trees.get(recipe);
  const { getTemplateFiles } = require('./template');
  const list = appTemplates.READY_IDS.map((id) => {
    const t = appTemplates.get(id);
    try {
      const files = getTemplateFiles(t.title, buildSlug(id), null, null, { template: id });
      return { id, title: t.title, files, key: contextKey(files, recipe) };
    } catch (err) {
      log.warn('starter-images', 'Starter not generated; no prebuilt image for it', { template: id, err: err.message });
      return { id, title: t.title, files: null, key: null };
    }
  });
  trees.set(recipe, list);
  return list;
}

/**
 * currentTrees, with each ready-made whose directory's original is running
 * at a known main built from that original instead (see FROM THE
 * ORIGINALS): what the clock builds, Admin > Templates lists and a Rebuild
 * queues. An entry keeps its rendered tree when the original's cannot be
 * read. Memoised per entry by the original's commit, so a run reads only
 * the originals' rows unless one has moved.
 */
const fromOriginals = new Map();
async function currentTreesFor(config, pool) {
  const rendered = currentTrees(config);
  let sources;
  try {
    sources = await require('./originals').imageSources(config, pool);
  } catch (err) {
    log.warn('starter-images', 'Could not read the originals; ready-mades are built from app-templates', { err: err.message });
    return rendered;
  }
  if (!sources.size) return rendered;
  const recipe = buildRecipe(config);
  const out = [];
  for (const t of rendered) {
    const source = sources.get(appTemplates.dirOf(t.id));
    if (!source) { out.push(t); continue; }
    const memoKey = `${recipe}\0${t.id}`;
    const hit = fromOriginals.get(memoKey);
    if (hit && hit.appId === source.original.id && hit.sha === source.sha) { out.push(hit.tree); continue; }
    try {
      const entry = await originalEntry(config, t, source.original, source.sha);
      fromOriginals.set(memoKey, { appId: source.original.id, sha: source.sha, tree: entry });
      out.push(entry);
    } catch (err) {
      log.warn('starter-images', 'Could not read an original; this ready-made is built from app-templates', {
        template: t.id, original: source.original.slug, err: err.message,
      });
      out.push(t);
    }
  }
  return out;
}

/**
 * Ready-made `t` (a currentTrees entry) as built from its original at
 * `sha`: its files and key, as a version made from that commit computes
 * them (app-creator.js seedVersion).
 */
async function originalEntry(config, t, original, sha) {
  const originals = require('./originals');
  const { getTemplateFiles } = require('./template');
  const tree = await originals.mainTree(original, sha);
  const files = originals.versionFiles(tree, getTemplateFiles(t.title, buildSlug(t.id), null, null, { template: t.id }), {
    name: t.title, templateId: t.id, originalTemplate: original.template,
  });
  return { id: t.id, title: t.title, files, key: contextKey(files, buildRecipe(config)), original: { slug: original.slug, sha } };
}

/**
 * Whether a version of `original` made from ready-made `templateId` at
 * `sha` would deploy a prebuilt image: the one built from that commit is
 * ready. Each merge into an original changes the image its ready-mades are
 * built from, and building the new one takes minutes, so a version made
 * meanwhile copies an earlier commit (services/originals.js sourceFor).
 * True where nothing is prebuilt (prebuildsOn, a tree that is not shared),
 * since no commit is faster to make there.
 */
async function readyFromOriginal(config, pool, templateId, original, sha) {
  if (!prebuildsOn()) return true;
  const t = currentTrees(config).find((x) => x.id === templateId);
  if (!t || !t.key) return true;
  const { key } = await originalEntry(config, t, original, sha);
  if (!key) return true;
  return !!(await readyRow(pool, key));
}

/** Whether this process builds images at all (see NOT IN A STAGING PREVIEW). */
function prebuildsOn(env = process.env) {
  return env.USERNODE_ENV !== 'staging' && String(env.STARTER_PREBUILDS || '').toLowerCase() !== 'off';
}

// ── The table ─────────────────────────────────────────────────────────────

async function ensureRows(pool, list) {
  for (const t of list) {
    if (!t.key) continue;
    await pool.query(
      `INSERT INTO starter_images (template, context_key) VALUES ($1, $2)
       ON CONFLICT (template, context_key) DO NOTHING`,
      [t.id, t.key]
    );
  }
}

// The keys a build of runs for now: an item of the clock's, queued or
// running (src/workflow/clock/).
async function liveKeys(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT input->'input'->>'key' AS key FROM wf_work
      WHERE machine = 'clock' AND key = $1 AND kind = $2 AND status IN ('queued', 'running')`,
    [CLOCK_KEY, ITEM_KIND]);
  return new Set(rows.map((r) => r.key).filter(Boolean));
}

// The rows owed a build now: queued (a new key, an admin's Rebuild), a
// failure whose wait is over, or one marked building whose build stopped
// with its process. The clock gives a target with a build still running no
// second one.
async function dueRows(pool, list) {
  if (!list.length) return [];
  const { rows } = await pool.query(
    `SELECT template, context_key FROM starter_images
      WHERE (template, context_key) IN (SELECT * FROM unnest($1::text[], $2::text[]))
        AND (status IN ('queued', 'building')
             OR (status = 'failed' AND attempts < $3
                 AND updated_at < NOW() - make_interval(secs => attempts * $4)))`,
    [list.map((t) => t.id), list.map((t) => t.key), MAX_ATTEMPTS, RETRY_AFTER_SECONDS]
  );
  const due = new Set(rows.map((r) => `${r.template}\0${r.context_key}`));
  return list.filter((t) => due.has(`${t.id}\0${t.key}`));
}

/** The ready image for a key, as a row, or null. */
async function readyRow(pool, key) {
  const { rows } = await pool.query(
    `SELECT template, context_key, image_ref, build_ref, engine
       FROM starter_images
      WHERE context_key = $1 AND image_ref IS NOT NULL
      ORDER BY built_at DESC NULLS LAST
      LIMIT 1`,
    [key]
  );
  return rows[0] || null;
}

async function buildingNow(pool, key) {
  return (await liveKeys(pool)).has(key);
}

// ── Building ──────────────────────────────────────────────────────────────

// A tree an original gave carries git's modes (services/originals.js
// mainTree): an executable stays one, and a link is made a link.
function writeTree(dir, files) {
  for (const f of files) {
    const filePath = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (f.mode === '120000') {
      fs.symlinkSync(String(f.content), filePath);
      continue;
    }
    fs.writeFileSync(filePath, f.content);
    if (f.mode === '100755') fs.chmodSync(filePath, 0o755);
  }
}

let sourceRepo = null;
// The commit a Kubernetes build fetches (see THE SOURCE).
async function pushSource(t) {
  const github = require('./github');
  if (!github.isEnabled()) throw new Error('GitHub is not configured, and a Kubernetes build fetches its source from GitHub');
  const owner = await github.getBotUsername();
  if (!sourceRepo || sourceRepo.owner !== owner) {
    const repo = await github.createRepo(owner, SOURCE_REPO, {
      description: 'Homeroom ready-made apps, as their images are built',
      adoptExisting: true,
    });
    sourceRepo = { owner, url: repo.html_url };
  }
  const sha = await github.createRootCommit(owner, SOURCE_REPO, t.files, {
    message: `Prebuild ${t.id} (${t.key.slice(0, 12)})`,
  });
  try {
    await github.forceBranchToSha(owner, SOURCE_REPO, branchOf(t.id), sha);
  } catch (err) {
    if (err.status !== 404) throw err;
    await github.ensureBranchAtSha(owner, SOURCE_REPO, branchOf(t.id), sha);
  }
  return { repoUrl: sourceRepo.url, sha: String(sha).toLowerCase() };
}

/**
 * Build one template's image under its key: a target of the clock's
 * (`input`: its template and key). Its row says building while it runs,
 * then ready or failed (the clock asks again after the failure's wait).
 * Resolves what it did; never throws for a failed build.
 */
async function buildTarget(config, pool, input) {
  const t = (await currentTreesFor(config, pool)).find((x) => x.id === input?.template && x.key === input?.key && x.files);
  // Not a key of this build: an older one asked for it, or the starter
  // changed since. Nothing to build.
  if (!t) return { skipped: 'not_current' };
  // Taken unless it is ready: the clock's target for its key is the one
  // builder of it.
  const { rows } = await pool.query(
    `UPDATE starter_images
        SET status = 'building', started_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE template = $1 AND context_key = $2 AND status <> 'ready'
      RETURNING template`,
    [t.id, t.key]);
  if (!rows.length) return { skipped: 'ready_or_building' };
  const applicationRuntime = require('./application-runtime');
  const startedAt = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `usernode-starter-${t.id}-`));
  try {
    writeTree(dir, t.files);
    const kubernetes = applicationRuntime.mode(config) === 'kubernetes';
    const source = kubernetes ? await pushSource(t) : null;
    const app = { id: buildAppId(t.id), slug: buildSlug(t.id), template: t.id, repo_url: source ? source.repoUrl : null };
    const build = await require('./build-retention-guard').withBuildUse(config, () => applicationRuntime.build(config, {
      app,
      revision: source ? source.sha : null,
      environment: 'production',
      sourceDir: dir,
      dockerImage: `usernode-starter-${t.id}:${t.key.slice(0, 12)}`,
      // The starter exactly as generated: this build writes its shared cache.
      starterTree: true,
    }));
    const engine = kubernetes ? (build.engine || 'kpack') : 'docker';
    await pool.query(
      `UPDATE starter_images
          SET status = 'ready', image_ref = $3, build_ref = $4, engine = $5, source_sha = $6,
              build_ms = $7, error = NULL, built_at = NOW(), updated_at = NOW()
        WHERE template = $1 AND context_key = $2`,
      [t.id, t.key, build.imageRef, build.buildRef || null, engine,
        source ? source.sha : null, Date.now() - startedAt]
    );
    log.info('starter-images', 'Prebuilt image ready', {
      template: t.id, key: t.key.slice(0, 12), imageRef: build.imageRef, engine, ms: Date.now() - startedAt,
    });
    return { ready: t.id, ms: Date.now() - startedAt };
  } catch (err) {
    const message = String((err && (err.buildLog || err.message)) || err).slice(-ERROR_CHARS);
    log.warn('starter-images', 'Prebuilt image failed', { template: t.id, key: t.key.slice(0, 12), err: err && err.message });
    await pool.query(
      `UPDATE starter_images SET status = 'failed', error = $3, updated_at = NOW()
        WHERE template = $1 AND context_key = $2 AND status = 'building'`,
      [t.id, t.key, message]
    ).catch((dbErr) => log.warn('starter-images', 'Prebuild failure not recorded', { template: t.id, err: dbErr.message }));
    return { failed: t.id };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The clock's run: a row for every current key, and each key owed a build
 * as a target. Off in a staging preview and with STARTER_PREBUILDS=off.
 */
async function targets(config, pool) {
  if (!prebuildsOn()) return { off: true };
  const list = (await currentTreesFor(config, pool)).filter((t) => t.key && t.files);
  await ensureRows(pool, list);
  const due = await dueRows(pool, list);
  return {
    templates: list.length,
    items: due.map((t) => ({ target: `${t.id}:${t.key}`, input: { template: t.id, key: t.key } })),
  };
}

// ── A new project ─────────────────────────────────────────────────────────

/**
 * The image a new project made from a ready-made app deploys instead of
 * building, as a build result (application-runtime.build's shape, with
 * `prebuilt`), or null to build as before. `key` is contextKey of the files
 * it committed. Waits up to WAIT_MS while that key's image is being built;
 * a lookup that fails is a build, never a failed creation.
 */
async function imageFor(config, pool, { key, slug }, { waitMs = WAIT_MS, pollMs = WAIT_POLL_MS, now = Date.now } = {}) {
  if (!key) return null;
  const startedAt = now();
  try {
    let row = await readyRow(pool, key);
    while (!row && now() - startedAt < waitMs && await buildingNow(pool, key)) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      row = await readyRow(pool, key);
    }
    if (!row) return null;
    let imageRef = row.image_ref;
    if (require('./application-runtime').mode(config) !== 'kubernetes') {
      // app-respawn.js runs `usernode-app-<slug>:latest` on Docker.
      imageRef = `usernode-app-${slug}:latest`;
      await require('./docker').execFileAsync('docker', ['tag', row.image_ref, imageRef]);
    }
    return {
      imageRef,
      buildRef: row.build_ref || null,
      engine: row.engine || null,
      reused: true,
      prebuilt: { template: row.template, key: key.slice(0, 12), waitedMs: now() - startedAt },
    };
  } catch (err) {
    log.warn('starter-images', 'Prebuilt image lookup failed; building instead', { slug, err: err.message });
    return null;
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────

/**
 * Admin > Templates: every ready-made app, its current key and that key's
 * row (status `missing` before the first sweep has made one), with the
 * image it last had under any key.
 */
async function list(config, pool) {
  const current = await currentTreesFor(config, pool);
  const { rows } = await pool.query(
    `SELECT template, context_key, status, image_ref, build_ref, engine, source_sha, build_ms,
            error, attempts, started_at, built_at, updated_at
       FROM starter_images
      ORDER BY updated_at DESC`
  );
  const live = await liveKeys(pool);
  return {
    prebuilds: prebuildsOn(),
    templates: current.map((t) => {
      const mine = rows.filter((r) => r.template === t.id);
      const row = t.key ? mine.find((r) => r.context_key === t.key) || null : null;
      // Building, with no build running: its process went; the clock asks
      // again.
      const stale = row && row.status === 'building' && !live.has(row.context_key);
      const previous = mine.find((r) => r.context_key !== t.key && r.image_ref) || null;
      return {
        id: t.id,
        title: t.title,
        key: t.key,
        status: !t.key ? 'unshared' : row ? (stale ? 'queued' : row.status) : 'missing',
        imageRef: row ? row.image_ref : null,
        engine: row ? row.engine : null,
        buildMs: row ? row.build_ms : null,
        builtAt: row ? row.built_at : null,
        startedAt: row ? row.started_at : null,
        attempts: row ? row.attempts : 0,
        error: row && row.status === 'failed' ? row.error : null,
        previousBuiltAt: previous ? previous.built_at : null,
      };
    }),
  };
}

/**
 * Admin > Templates in a staging preview's screenshots (routes/admin.js,
 * ?demo=1 there only): the real templates, with made-up states, since a
 * preview builds nothing. Never written anywhere.
 */
function demoList(config, now = Date.now()) {
  const at = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
  const states = ['ready', 'ready', 'building', 'ready', 'failed', 'ready', 'queued'];
  return {
    prebuilds: true,
    demo: true,
    templates: currentTrees(config).map((t, i) => {
      const status = t.key ? states[i % states.length] : 'unshared';
      const ready = status === 'ready';
      return {
        id: t.id,
        title: t.title,
        key: t.key,
        status,
        imageRef: ready ? `registry.example.invalid/${buildSlug(t.id)}@sha256:${sha256(t.id).slice(0, 64)}` : null,
        engine: ready ? 'buildkit' : null,
        buildMs: ready ? 18000 + (i * 1373) % 9000 : null,
        builtAt: ready ? at(40 + i * 3) : null,
        startedAt: status === 'building' ? at(1) : null,
        attempts: status === 'failed' ? 1 : 0,
        error: status === 'failed' ? 'Staging demo: the build stopped at npm ci (network unreachable).' : null,
        previousBuiltAt: status === 'building' || status === 'queued' ? at(60 * 26) : null,
      };
    }),
  };
}

/**
 * Queue a template's image to be built again under its current key: the
 * clock's next run builds it, and its ready image stays in use until the
 * new one replaces it. Answers false for a template that is not a
 * ready-made app or has no key, or whose build is under way.
 */
async function requestRebuild(config, pool, id) {
  const t = (await currentTreesFor(config, pool)).find((x) => x.id === id);
  if (!t || !t.key) return false;
  if ((await liveKeys(pool)).has(t.key)) return false;
  await ensureRows(pool, [t]);
  const { rows } = await pool.query(
    `UPDATE starter_images
        SET status = 'queued', attempts = 0, error = NULL, updated_at = NOW()
      WHERE template = $1 AND context_key = $2
      RETURNING template`,
    [t.id, t.key]
  );
  return rows.length > 0;
}

module.exports = {
  STATUSES,
  SOURCE_REPO,
  CONCURRENCY,
  WAIT_MS,
  MAX_ATTEMPTS,
  buildRecipe,
  buildSlug,
  contextKey,
  currentTrees,
  currentTreesFor,
  demoList,
  imageFiles,
  imageFor,
  originalEntry,
  list,
  prebuildsOn,
  readyFromOriginal,
  requestRebuild,
  targets,
  buildTarget,
  _forTest: { pushSource, resetTrees: () => { trees.clear(); fromOriginals.clear(); }, resetSource: () => { sourceRepo = null; } },
};
