'use strict';

/**
 * Stale staging-preview sweep — shut down preview containers whose
 * environment was assembled by an older platform build.
 *
 * WHY THIS EXISTS
 *
 * A staging preview's env is built by the platform that is CURRENTLY
 * DEPLOYED, not by the code in the branch being previewed, and docker has no
 * "set env on a live container" primitive. So a platform-side env change
 * reaches a preview only when its container is rebuilt — and previews are
 * long-lived: at the time this module landed, production carried 109 of them
 * ranging from a day to four weeks old.
 *
 * The RSA iframe cutover (#848) is the case that forced the issue. Every
 * preview built before it holds the old shared HS256 secret with no
 * IFRAME_JWT_PUBLIC_KEY and no USERNODE_APP_ID, while the now-post-cutover
 * parent shell mints RS256 tokens. The preview loads fine and then cannot
 * recognise the signed-in user, so a reviewer clicking Preview lands on the
 * app's login screen — including on the three previews backing live merge
 * votes. services/app-rollover.js fixed exactly this for production app
 * containers and deliberately does not touch previews (its predicate is
 * `apps.status='running' AND self_hosted IS NOT TRUE`); this is the preview
 * half of the same job.
 *
 * THE STALENESS IS INVISIBLE TO THE EXISTING HEAL PATH.
 * stagingRecovery.stagingNeedsRebuild() returns false whenever
 * staging_container_id resolves to a RUNNING container — it is looking for a
 * dead preview, not a stale one. So these previews never self-heal: the
 * on-demand route answers `{status:'ready'}` and opens the broken page. That
 * is why a sweep has to exist at all rather than waiting for the sweeper.
 *
 * TEAR DOWN, DON'T REBUILD. Teardown flips stagingNeedsRebuild() to true, so
 * the existing on-demand path (POST /api/sessions/:id/ensure-staging →
 * stagingRecovery.rebuildSessionStaging) rebuilds any preview someone
 * actually wants, with correct env, behind the "spinning back up" loader the
 * front end already renders. Rebuilding all of them up front would mean one
 * docker build each plus a re-run of every proposal's checks capture, and in
 * production 101 of 104 mapped previews back proposals that were already
 * merged or abandoned — nobody will ever open them. Teardown is also the
 * safer failure mode: a torn-down preview link refuses cleanly at Caddy's
 * `ask` gate instead of serving a login screen that reads as a bug.
 *
 * ENUMERATE DOCKER, NOT THE DATABASE. `chat_sessions.staging_container_id`
 * finds only part of the fleet — in production it covered 94 of 109. Ten
 * more had the column nulled by a teardown whose stopAndRemove failed (the
 * container survived), and five belonged to sessions that no longer exist at
 * all (app deleted, FK cascade). The container list is the only complete
 * inventory, so this sweep starts from `docker ps` and joins BACK to the DB.
 *
 * SHAPE — mirrors services/app-rollover.js deliberately, so the two admin
 * sweeps read the same way:
 *
 *   - One job at a time (module-level singleton); a second start() returns
 *     the in-flight job and the route turns that into a 409.
 *   - In-memory, not persisted, with a 30-min stale guard.
 *   - Per-preview failure isolation: every unit is individually caught and
 *     the drain continues.
 *   - Progress rides one aggregate `admin_staging_reap_status` broadcast to
 *     admin sockets only.
 *
 * FOLLOW-UP (deliberately not solved here): nothing detects env staleness
 * automatically. The durable fix is to stamp the platform build SHA (or an
 * env fingerprint) into a container label at build time and have
 * stagingNeedsRebuild() treat a mismatch as needing a rebuild — turning this
 * one-off sweep into a sweeper pass. Until then this is an admin-triggered
 * tool, run after a platform env change.
 */

const log = require('./logger');
const docker = require('./docker');
const dbManager = require('./db-manager');
const events = require('./events');
const { getPool } = require('../db/pool');

// Preview teardown is cheaper and less disruptive than a production
// container rollover (nothing user-facing goes offline — these previews are
// already broken), but keep the same politeness ceiling on docker churn.
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

// Same TTL as app-rollover / app-deploy-status: anything claiming to be in
// flight for >30min is an orphaned record, not a genuinely slow sweep.
const JOB_STALE_AFTER_MS = 30 * 60 * 1000;

// `usernode-staging-<slug>--<sessionId>`, built by staging.js
// buildAndDeployStagingInner. The slug itself contains hyphens (and for the
// self-app starts with `usernode-`), so anchor on the DOUBLE hyphen before a
// trailing all-digits session id and let the slug group be greedy —
// `usernode-staging-usernode-2d5619--2795` must yield slug
// `usernode-2d5619`, session 2795.
const CONTAINER_NAME_RE = /^usernode-staging-(.+)--(\d+)$/;

// `usernode-staging-<slug>-<sessionId>:<6-hex>` — the image tag carries the
// commit hash that the staging DB name was derived from. For a preview whose
// session row no longer names it, this tag is the only surviving source of
// that hash.
const IMAGE_TAG_RE = /:([0-9a-f]{6})$/;

// Per-preview outcomes:
//   torn_down        — container removed; staging DB dropped too
//   torn_down_no_db  — container removed, but the staging DB name could not
//                      be derived, so it was deliberately left alone
//   skipped_gone     — container vanished between listing and teardown
//   failed           — stopAndRemove threw
const TORN_DOWN = 'torn_down';
const TORN_DOWN_NO_DB = 'torn_down_no_db';
const FAILED = 'failed';

let _job = null;
let _seq = 0;

function isStagingEnv() {
  return process.env.USERNODE_ENV === 'staging';
}

function concurrency() {
  const raw = parseInt(process.env.STAGING_REAP_CONCURRENCY || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONCURRENCY;
  return Math.min(raw, MAX_CONCURRENCY);
}

function isActive(job) {
  if (!job || job.finishedAt) return false;
  const age = Date.now() - new Date(job.startedAt).getTime();
  return age <= JOB_STALE_AFTER_MS;
}

function snapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    startedAt: job.startedAt,
    startedBy: job.startedBy || null,
    finishedAt: job.finishedAt || null,
    concurrency: job.concurrency,
    total: job.total,
    done: job.done,
    failed: job.failed,
    stale: !job.finishedAt && !isActive(job),
    previews: job.previews.map((p) => ({
      name: p.name,
      slug: p.slug,
      sessionId: p.sessionId,
      classification: p.classification,
      state: p.state,
      ms: p.ms,
      error: p.error,
    })),
  };
}

// Lazily required so the module graph stays acyclic — same dodge
// app-rollover.js and app-deploy-status.js document.
function broadcast(job) {
  try {
    const { broadcastToAdmins } = require('./ws');
    broadcastToAdmins({ type: 'admin_staging_reap_status', job: snapshot(job) });
  } catch (err) {
    log.warn('staging-reap', 'broadcast failed', { err: err.message });
  }
}

function read() {
  return snapshot(_job);
}

/**
 * Every `usernode-staging-*` container on the host, parsed. Includes exited
 * ones (`-a`): a stopped preview still holds its image, its staging database
 * and its name, and is exactly as much of a leak as a running one.
 *
 * Returns [] on any docker failure rather than throwing — the caller turns
 * an empty inventory into a no-op sweep, which is the right answer when we
 * cannot see the host.
 */
async function listStagingContainers() {
  let stdout;
  try {
    ({ stdout } = await docker.execFileAsync('docker', [
      'ps', '-a',
      '--filter', 'name=^/usernode-staging-',
      '--format', '{{.Names}}\t{{.State}}\t{{.Image}}',
    ], { timeout: 10000 }));
  } catch (err) {
    log.warn('staging-reap', 'docker ps failed', { err: err.message });
    return [];
  }
  const out = [];
  for (const line of String(stdout || '').trim().split('\n').filter(Boolean)) {
    const [name, state, image] = line.split('\t');
    const m = name && name.match(CONTAINER_NAME_RE);
    // A name the pattern does not recognise is left strictly alone. Better
    // to under-reap than to stop something we cannot identify.
    if (!m) {
      log.warn('staging-reap', 'Unrecognised staging container name — skipping', { name });
      continue;
    }
    out.push({
      name,
      slug: m[1],
      sessionId: parseInt(m[2], 10),
      state: state || null,
      image: image || null,
    });
  }
  return out;
}

/**
 * Join the container inventory back to `chat_sessions`, attaching the row
 * (when there is one) plus a human-readable classification for the console.
 *
 * The classification is presentational: this sweep tears down everything it
 * enumerates. It exists so an admin can see WHY each preview was picked, and
 * so the tally distinguishes "merged proposal, expected leftover" from
 * "session row is gone entirely".
 */
async function classify(pool, containers) {
  if (!containers.length) return [];
  const ids = containers.map((c) => c.sessionId);
  const { rows } = await pool.query(
    `SELECT cs.id, cs.status, cs.pr_number, cs.staging_container_id, cs.staging_url,
            a.slug AS app_slug
       FROM chat_sessions cs
       LEFT JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = ANY($1::int[])`,
    [ids]
  );
  const bySession = new Map(rows.map((r) => [r.id, r]));
  return containers.map((c) => {
    const session = bySession.get(c.sessionId) || null;
    let classification;
    if (!session) classification = 'no_session_row';
    else if (!session.staging_container_id) classification = `${session.status}_unlinked`;
    else classification = session.status;
    return { ...c, session, classification };
  });
}

// How many previews the sweep would act on right now. Docker is the whole
// inventory (see the header), so this is just the parsed container count.
async function staleCount() {
  const containers = await listStagingContainers();
  return containers.length;
}

/**
 * Staging demo job — request-time injection per the "Staging mock data"
 * convention. A preview has no docker socket (SELF-HOSTING.md Phase 2g), so
 * this console section has nothing real to render there and would screenshot
 * empty. Never persisted; the route serves it only behind
 * IS_STAGING && ?demo=1, and POST stays refused in staging regardless.
 *
 * Covers one row of each classification plus a `failed` one, so the error
 * styling is screenshot-covered too.
 */
function demoJob() {
  return {
    id: 1,
    startedAt: '2026-01-01T12:00:00.000Z',
    startedBy: 'staging-demo-admin',
    finishedAt: '2026-01-01T12:00:18.000Z',
    concurrency: DEFAULT_CONCURRENCY,
    total: 6,
    done: 6,
    failed: 1,
    stale: false,
    demo: true,
    previews: [
      {
        name: 'usernode-staging-staging-demo-tier-lists--900101',
        slug: 'staging-demo-tier-lists',
        sessionId: 900101,
        classification: 'merged',
        state: TORN_DOWN,
        ms: 2400,
        error: null,
      },
      {
        name: 'usernode-staging-staging-demo-whiteboard--900102',
        slug: 'staging-demo-whiteboard',
        sessionId: 900102,
        classification: 'merged_unlinked',
        state: TORN_DOWN_NO_DB,
        ms: 1900,
        error: null,
      },
      {
        name: 'usernode-staging-staging-demo-guardian--900103',
        slug: 'staging-demo-guardian',
        sessionId: 900103,
        classification: 'archived',
        state: TORN_DOWN,
        ms: 2100,
        error: null,
      },
      {
        name: 'usernode-staging-staging-demo-recipebot--900104',
        slug: 'staging-demo-recipebot',
        sessionId: 900104,
        classification: 'promoted',
        state: TORN_DOWN,
        ms: 2600,
        error: null,
      },
      {
        name: 'usernode-staging-staging-demo-goalio--900105',
        slug: 'staging-demo-goalio',
        sessionId: 900105,
        classification: 'no_session_row',
        state: TORN_DOWN_NO_DB,
        ms: 1500,
        error: null,
      },
      {
        name: 'usernode-staging-staging-demo-puzzlechain--900106',
        slug: 'staging-demo-puzzlechain',
        sessionId: 900106,
        classification: 'merged',
        state: FAILED,
        ms: 5200,
        error: 'stop timeout exceeded: container did not exit',
      },
    ],
  };
}

/**
 * Kick off a sweep. Synchronous by design: creates and returns the job
 * record, then runs the docker work on a detached promise so the route can
 * answer immediately — same fire-and-forget shape as app-rollover.start.
 *
 * Returns { started, job }. `started: false` means a job was already in
 * flight and `job` is that one.
 */
function start(config, { userId = null, username = null } = {}) {
  if (isActive(_job)) return { started: false, job: snapshot(_job) };

  const job = {
    id: ++_seq,
    startedAt: new Date().toISOString(),
    startedBy: username,
    startedByUserId: userId,
    finishedAt: null,
    concurrency: concurrency(),
    total: 0,
    done: 0,
    failed: 0,
    previews: [],
  };
  _job = job;

  // Detached: errors are contained here so an unhandled rejection can never
  // escape into the request that started the sweep.
  run(config, job).catch((err) => {
    log.error('staging-reap', 'Sweep crashed', { jobId: job.id, err: err.message });
    if (!job.finishedAt) {
      job.finishedAt = new Date().toISOString();
      broadcast(job);
    }
  });

  return { started: true, job: snapshot(job) };
}

async function run(config, job) {
  const pool = getPool(config);
  const startedMs = Date.now();

  const containers = await listStagingContainers();
  const items = await classify(pool, containers);
  job.total = items.length;
  job.previews = items.map((item) => ({
    name: item.name,
    slug: item.slug,
    sessionId: item.sessionId,
    classification: item.classification,
    state: 'pending',
    ms: null,
    error: null,
  }));
  log.info('staging-reap', 'Stale preview sweep started', {
    jobId: job.id, total: job.total, concurrency: job.concurrency,
    by: job.startedBy || null,
  });
  broadcast(job);

  await drain(items, job.concurrency, async (item, idx) => {
    const entry = job.previews[idx];
    entry.state = 'running';
    broadcast(job);
    const unitStarted = Date.now();
    let outcome = FAILED;
    let error = null;
    try {
      const result = await reapOne(item);
      outcome = result.outcome;
      error = result.error || null;
    } catch (err) {
      // Belt-and-braces: reapOne already catches, so reaching here means a
      // bug rather than a docker failure. Still isolated per preview.
      outcome = FAILED;
      error = err && err.message ? err.message : 'teardown failed';
      log.error('staging-reap', 'Unit threw outside its own guard', {
        name: item.name, err: error,
      });
    }
    entry.state = outcome;
    entry.error = error;
    entry.ms = Date.now() - unitStarted;
    job.done += 1;
    if (outcome === FAILED) job.failed += 1;
    broadcast(job);
  });

  job.finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  const tally = job.previews.reduce((acc, p) => {
    acc[p.state] = (acc[p.state] || 0) + 1;
    return acc;
  }, {});
  const byClassification = job.previews.reduce((acc, p) => {
    acc[p.classification] = (acc[p.classification] || 0) + 1;
    return acc;
  }, {});
  log.info('staging-reap', 'Stale preview sweep finished', {
    jobId: job.id, total: job.total, failed: job.failed, durationMs,
    tally, byClassification,
  });
  broadcast(job);

  // The only durable trace — the job object is in-memory, so an interrupted
  // sweep leaves no row. Best-effort, like every events.record.
  events.record(pool, {
    type: events.EVENT_TYPES.STALE_PREVIEWS_REAPED,
    userId: job.startedByUserId || null,
    metadata: {
      jobId: job.id,
      total: job.total,
      tornDown: (tally[TORN_DOWN] || 0) + (tally[TORN_DOWN_NO_DB] || 0),
      dbsDropped: tally[TORN_DOWN] || 0,
      skipped: Object.keys(tally)
        .filter((k) => k.startsWith('skipped_'))
        .reduce((n, k) => n + tally[k], 0),
      failed: job.failed,
      failedNames: job.previews.filter((p) => p.state === FAILED).map((p) => p.name),
      byClassification,
      durationMs,
    },
  });
}

/**
 * One preview's unit of work. Never throws — every path resolves to an
 * outcome string so a single stuck container can't take the sweep down.
 *
 * Two teardown paths, and which one applies is decided by the DB, not by the
 * container:
 *
 *   - The session row still NAMES this container → staging.teardownStaging.
 *     That is the single chokepoint every other teardown caller (merge,
 *     archive, idle-reclaim) funnels through: it stops the container, drops
 *     the staging database derived from staging_url, and nulls staging_url +
 *     staging_container_id so Caddy's on-demand `ask` gate stops vouching
 *     for the dead hostname and stale links refuse cleanly.
 *   - No session row, or the row no longer names it → by-name teardown,
 *     because teardownStaging would derive the wrong database name from a
 *     NULL staging_url (its regex falls back to the literal '000000').
 */
async function reapOne(item) {
  const exists = await docker.containerExists(item.name).catch(() => true);
  if (!exists) return { outcome: 'skipped_gone' };

  const linked = !!(item.session && item.session.staging_container_id);

  if (linked) {
    try {
      const staging = require('./staging');
      await staging.teardownStaging(item.session, { slug: item.session.app_slug || item.slug });
      return { outcome: TORN_DOWN };
    } catch (err) {
      log.warn('staging-reap', 'teardownStaging failed', {
        name: item.name, sessionId: item.sessionId, err: err.message,
      });
      return { outcome: FAILED, error: err.message };
    }
  }

  // By-name path. The container is the only thing we are sure about.
  try {
    await docker.stopAndRemove(item.name, {
      stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
    });
  } catch (err) {
    log.warn('staging-reap', 'stopAndRemove failed', { name: item.name, err: err.message });
    return { outcome: FAILED, error: err.message };
  }

  // The staging DB name embeds the 6-hex commit the preview was built from,
  // which for an unlinked container survives only in the image tag. If it
  // will not parse, LEAVE THE DATABASE and say so: a leaked staging DB is
  // inert and cheap, and dropping the wrong one is not recoverable.
  const hash = (item.image || '').match(IMAGE_TAG_RE);
  if (!hash) {
    log.warn('staging-reap', 'No parseable commit hash — leaving the staging database', {
      name: item.name, image: item.image || null,
    });
    return { outcome: TORN_DOWN_NO_DB };
  }
  const dbName = dbManager.stagingDbName(item.slug, `s${item.sessionId}`, hash[1]);
  try {
    await dbManager.dropDatabase(dbName);
    return { outcome: TORN_DOWN };
  } catch (err) {
    // The container is already gone, which is the part that matters. A DB
    // that refuses to drop is a leak to chase separately, not a failed unit.
    log.warn('staging-reap', 'dropDatabase failed — container is still gone', {
      name: item.name, dbName, err: err.message,
    });
    return { outcome: TORN_DOWN_NO_DB };
  }
}

// Fixed-width worker drain. No barrier between items: a slow container never
// holds up the next one, and at most `limit` docker operations are in
// flight. Copied in shape from app-rollover.drain.
async function drain(items, limit, worker) {
  if (!items.length) return;
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let i = 0; i < width; i++) {
    runners.push((async () => {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) return;
        await worker(items[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
}

// Test seam only: drop the singleton so each case starts clean.
function _reset() {
  _job = null;
  _seq = 0;
}

module.exports = {
  start,
  read,
  demoJob,
  isStagingEnv,
  concurrency,
  staleCount,
  listStagingContainers,
  classify,
  reapOne,
  CONTAINER_NAME_RE,
  TORN_DOWN,
  TORN_DOWN_NO_DB,
  FAILED,
  _reset,
};
