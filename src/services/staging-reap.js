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
 * ON KUBERNETES THE INVENTORY IS THE PREVIEW DEPLOYMENTS. The same reasoning
 * holds with `sv-preview-<appId>-s<sessionId>` Deployments in place of
 * containers (kubernetes.listPreviews), and their rows name them by
 * staging_runtime_name rather than by container id. Until this existed the
 * sweep simply stood down on Kubernetes, and in production (2026-10-02) 43 of
 * 98 previews were still running for sessions that had merged or no longer
 * existed: every merge whose teardown came back busy, or whose merge never
 * reached the teardown step, was "left for the stale-preview sweeper" that
 * never ran.
 *
 * SHAPE — mirrors services/app-rollover.js deliberately, so the two admin
 * sweeps read the same way:
 *
 *   - One job at a time across every process: the preview-reap clock
 *     (src/workflow/clock/services.ts), which runs only when an admin asks
 *     (start: its RunNow); a start while one runs returns the job under way
 *     and the route turns that into a 409. Each preview is a step of the
 *     run's work item (services/fleet-job.js), so a restart carries the job
 *     on, and its progress is that checkpoint, which any process reads
 *     (read). It was an object in the memory of the web process that
 *     started it, lost to a restart.
 *   - Per-preview failure isolation: every unit is individually caught and
 *     the drain continues.
 *   - Progress rides one aggregate `admin_staging_reap_status` broadcast to
 *     admin sockets only.
 *
 * AUTOMATIC PASS (#851, the follow-up this header used to defer). Previews are
 * now stamped at build time with a digest of the platform-owned env
 * (services/staging-env.js, label `usernode.env.fp`), so staleness IS
 * detectable: a label that does not match today's digest means an older
 * platform built that container. Two halves consume that:
 *
 *   - the preview-env clock (src/workflow/clock/services.ts), every 15
 *     minutes and acting only in the newest build, whose fingerprint is
 *     the current one, tells the preview machine about every preview built
 *     with another (tellStaleEnv): it rebuilds one that backs a vote and
 *     gives back the rest. An older Pod still running during a rollout
 *     never judges the new build's previews by its own fingerprint.
 *   - the preview-gc clock (src/workflow/clock/services.ts) takes the
 *     LEFTOVERS whatever their env (leftovers): a preview whose session
 *     merged, was archived or is gone, and one its row no longer names that
 *     the preview machine does not hold. Merge and archive retire their
 *     preview themselves, so a merge whose teardown failed had no other way
 *     out. A preview like that backs nothing, current env or not.
 *
 * The admin-triggered sweep takes the same selection (selectReapable), all of
 * it at once rather than a few at a time: what you want right after a
 * platform env change. It used to take every preview it could enumerate,
 * which made sense for the one-off cleanup after the RSA cutover (#850), when
 * every preview was broken. Once staleness had a fingerprint, that only added
 * downtime: Pass 3 rebuilds an out-of-date vote-backed preview in place, and
 * a live session's current preview has nothing wrong with it. An env change
 * the fingerprint cannot express is what FINGERPRINT_VERSION is for.
 */

const log = require('./logger');
const docker = require('./docker');
const dbManager = require('./db-manager');
const events = require('./events');
const stagingEnv = require('./staging-env');
const applicationRuntime = require('./application-runtime');
const kubernetes = require('./kubernetes');
const fleetJob = require('./fleet-job');
const { getPool } = require('../db/pool');

// Preview teardown is cheaper and less disruptive than a production
// container rollover (nothing user-facing goes offline — these previews are
// already broken), but keep the same politeness ceiling on docker churn.
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

// The clock that runs the admin's sweep (src/workflow/clock/services.ts).
const JOB = 'preview-reap';

// How often the AUTOMATIC stale pass may run, and how many previews it may
// tear down per pass. Long interval + small cap on purpose: a stale preview
// is a nuisance, not an outage, so the pass should be invisible in host load.
// 0 disables it entirely (the admin sweep still works).
const DEFAULT_STALE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_STALE_SWEEP_LIMIT = 10;

// The connection-pressure pass (#1771): a look every five minutes, and one
// preview given back at a time while the shared Postgres stays saturated
// (the preview-pressure clock looks again a minute after each). It tears
// down previews that are doing nothing WRONG, so it acts late and lightly.
// 0 disables it.
const DEFAULT_PRESSURE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Statuses whose preview backs a live merge vote. The automatic pass must NOT
// tear these down: stagingNeedsRebuild() now sees their staleness too, so
// server.js Pass 3 REBUILDS them (bounded to 5 per tick with a per-session
// cooldown) and a reviewer finds a working preview instead of a dead link.
const VOTE_BACKED_STATUSES = new Set(['promoted', 'merging']);

// Statuses whose preview backs nothing any more: the change is in production,
// or the proposal was withdrawn. A preview reopened after unarchive is built
// again on demand, as after any other teardown.
const FINISHED_STATUSES = new Set(['merged', 'archived']);

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
//   skipped_workflow — the preview machine holds the session (it retires
//                      what it built; a preview it is building has no row
//                      pointer yet)
//   failed           — stopAndRemove threw
const TORN_DOWN = 'torn_down';
const TORN_DOWN_NO_DB = 'torn_down_no_db';
const FAILED = 'failed';

function isStagingEnv() {
  return process.env.USERNODE_ENV === 'staging';
}

// The Kubernetes calls need the app namespace; fall back the same way
// staging.teardownStaging does when the caller's config does not carry one.
function kubernetesConfig(config) {
  return {
    ...(config || {}),
    appRuntime: 'kubernetes',
    kubernetes: {
      ...(config?.kubernetes || {}),
      appNamespace: config?.kubernetes?.appNamespace || process.env.APP_NAMESPACE || 'social-apps',
    },
  };
}

function concurrency() {
  const raw = parseInt(process.env.STAGING_REAP_CONCURRENCY || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONCURRENCY;
  return Math.min(raw, MAX_CONCURRENCY);
}

// A unit of the admin's sweep, as its run lists it once (small JSON: the
// session row is read again when its turn comes) and as the console shows
// it before it ran.
const SHAPE = {
  rowsField: 'previews',
  keyOf: (item) => item.name,
  rowOf: (item) => ({
    name: item.name,
    slug: item.slug,
    sessionId: item.sessionId,
    classification: item.classification,
    outOfDate: !!item.outOfDate,
  }),
};

// Lazily required so the module graph stays acyclic — same dodge
// app-rollover.js and app-deploy-status.js document.
function broadcast(job) {
  try {
    const { broadcastToAdmins } = require('./ws');
    broadcastToAdmins(fleetJob.frame('admin_staging_reap_status', job));
  } catch (err) {
    log.warn('staging-reap', 'broadcast failed', { err: err.message });
  }
}

/** The sweep under way, or the last one, as the console shows it. */
async function read(pool) {
  const run = await require('../workflow/platform.ts').clockRunOf(pool, JOB);
  return fleetJob.snapshotOf(run, { ...SHAPE, concurrency: concurrency() });
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
      // The env-fingerprint label comes back as a fourth column so the
      // automatic pass can classify the whole fleet from ONE docker call
      // instead of an inspect per preview (#851).
      '--format', `{{.Names}}\t{{.State}}\t{{.Image}}\t{{.Label "${stagingEnv.LABEL_ENV_FP}"}}`,
    ], { timeout: 10000 }));
  } catch (err) {
    log.warn('staging-reap', 'docker ps failed', { err: err.message });
    return [];
  }
  const out = [];
  for (const line of String(stdout || '').trim().split('\n').filter(Boolean)) {
    const [name, state, image, fingerprint] = line.split('\t');
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
      // null means "no label" OR "this docker does not support the .Label
      // format verb". Both read as stale, which is safe for a pre-#851
      // container (it genuinely is) but would sweep the fleet on a docker
      // too old to answer — hence the verify step in inventory() below.
      fingerprint: fingerprint || null,
      runtimeKind: 'docker',
    });
  }
  return out;
}

/**
 * Every preview Deployment in the app namespace, in the same item shape as
 * listStagingContainers. The slug is not part of a Deployment's name, so it
 * stays null until classify() reads it off the session's app.
 *
 * Same failure contract: [] when the API cannot be read, so an unreadable
 * cluster is a no-op sweep rather than a blind one.
 */
async function listKubernetesPreviews(config) {
  try {
    const previews = await kubernetes.listPreviews(kubernetesConfig(config));
    return previews.map((preview) => ({
      name: preview.name,
      slug: null,
      sessionId: preview.sessionId,
      state: preview.state || null,
      image: preview.image || null,
      // The label comes from the API object itself, so null here really does
      // mean the Deployment carries none.
      fingerprint: preview.labels?.[stagingEnv.LABEL_ENV_FP] || null,
      runtimeKind: 'kubernetes',
    }));
  } catch (err) {
    log.warn('staging-reap', 'Kubernetes preview list failed', { err: err.message });
    return [];
  }
}

// The complete preview inventory for the runtime this platform deploys to.
async function listPreviews(config) {
  return applicationRuntime.mode(config) === 'kubernetes'
    ? listKubernetesPreviews(config)
    : listStagingContainers();
}

/**
 * Which of these previews were built by an OLDER platform than the one
 * running now? Pure and synchronous so it can be unit-tested without docker.
 *
 * Selection = fingerprint mismatch, minus two exclusions:
 *   - vote-backed previews (promoted/merging) — Pass 3 rebuilds those, and
 *     tearing down a preview a group is actively voting on is the wrong move
 *     even when its env is stale;
 *   - sessions with a coding turn in flight — a rebuild/push is about to
 *     replace the preview anyway, and pulling the container out from under a
 *     live turn invites exactly the interleaving staging.js serialises against;
 *   - sessions with a checks run on the cluster (a check_runs row,
 *     classify's `check_run_open`): a live run, one waiting for its checks
 *     slot, or one whose process died and whose Jobs the harvest reads
 *     (services/check-harvest.js). Its capture runs against this preview,
 *     and a boot is both when this pass runs and when the harvest seats the
 *     old leader's runs. The row goes when the run settles, and the next
 *     pass takes the preview then.
 *
 * `isInFlight` is injected rather than required at module scope to keep the
 * module graph acyclic (worker.js reaches into staging paths) and the
 * function trivially testable.
 */
function selectStale(items, expectedFp, { isInFlight = null } = {}) {
  return (items || []).filter((item) => {
    if (item.fingerprint === expectedFp) return false;
    const status = item.session ? item.session.status : null;
    if (status && VOTE_BACKED_STATUSES.has(status)) return false;
    if (item.session && item.session.check_run_open) return false;
    if (isInFlight && isInFlight(item.sessionId)) return false;
    return true;
  });
}

/**
 * Which of these previews outlived their session? Selection = the session
 * merged or was archived, or its row is gone entirely. The env does not
 * matter: a merged change's preview is waste on today's platform too.
 *
 * Under the coordinated preview lifecycle neither status can even start a
 * preview run (its request accepts only active/paused/promoted/merging), so
 * nothing is building one of these back. The in-flight exclusion still
 * applies, for the same reason as in selectStale.
 */
function selectAbandoned(items, { isInFlight = null } = {}) {
  return (items || []).filter((item) => {
    const status = item.session ? item.session.status : null;
    if (status && !FINISHED_STATUSES.has(status)) return false;
    if (isInFlight && isInFlight(item.sessionId)) return false;
    return true;
  });
}

/**
 * Everything a sweep takes, in the order it takes it: abandoned previews
 * first (they back nothing at all), then out-of-date ones (one may still be
 * reopened). `abandoned` leaves out what `stale` already holds, so the two
 * counts add up to `selected`. Neither ever holds a vote-backed preview or a
 * session with a turn in flight.
 */
function selectReapable(items, expectedFp, { isInFlight = null } = {}) {
  const stale = selectStale(items, expectedFp, { isInFlight });
  const staleNames = new Set(stale.map((item) => item.name));
  const abandoned = selectAbandoned(items, { isInFlight })
    .filter((item) => !staleNames.has(item.name));
  return { stale, abandoned, selected: [...abandoned, ...stale] };
}

/**
 * Join the container inventory back to `chat_sessions`, attaching the row
 * (when there is one) plus a human-readable classification for the console.
 *
 * The classification is presentational: what a sweep takes is decided by
 * selectReapable. It exists so an admin can see WHY each preview was picked,
 * and so the tally distinguishes "merged proposal, expected leftover" from
 * "session row is gone entirely".
 */
async function classify(pool, containers) {
  if (!containers.length) return [];
  const ids = containers.map((c) => c.sessionId);
  // The runtime columns and staging_commit_sha are what teardownStaging
  // works from (and what the preview lifecycle compares) when the reap unit
  // hands it this row. `check_run_open`: a checks run of the session is on
  // the cluster, live or left for the harvest (selectStale).
  const { rows } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.status, cs.pr_number, cs.staging_container_id, cs.staging_url,
            cs.staging_runtime_kind, cs.staging_runtime_name, cs.staging_commit_sha,
            a.slug AS app_slug,
            EXISTS (SELECT 1 FROM check_runs cr WHERE cr.session_id = cs.id) AS check_run_open
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
    else if (!namesPreview(c, session)) classification = `${session.status}_unlinked`;
    else classification = session.status;
    return { ...c, slug: c.slug || session?.app_slug || null, session, classification };
  });
}

// Does the session row still point at this preview? A Docker row records the
// container id; a Kubernetes row records the Deployment name, which is the
// name the inventory lists.
function namesPreview(item, session) {
  if (!session) return false;
  if (item.runtimeKind === 'kubernetes') return session.staging_runtime_name === item.name;
  return !!session.staging_container_id;
}

// How many previews exist right now: the runtime's own listing, which is the
// whole inventory (see the header). What a sweep would take is
// previewCounts' `stale` + `abandoned`.
async function staleCount(config = {}) {
  const containers = await listPreviews(config);
  return containers.length;
}

/**
 * Counts for the admin console: how many previews exist, how many are out of
 * date, and how many more are abandoned. A sweep takes `stale` + `abandoned`.
 * All from one inventory call plus one DB round-trip. Never throws; returns
 * nulls when the counts cannot be computed so the console renders "—" rather
 * than a bogus zero.
 */
async function previewCounts(config) {
  try {
    const containers = await listPreviews(config);
    if (!containers.length) return { open: 0, stale: 0, abandoned: 0 };
    const items = await classify(getPool(config), containers);
    const { stale, abandoned } = selectReapable(items, stagingEnv.expectedStagingFingerprint(config));
    return { open: items.length, stale: stale.length, abandoned: abandoned.length };
  } catch (err) {
    log.warn('staging-reap', 'previewCounts failed', { err: err.message });
    return { open: null, stale: null, abandoned: null };
  }
}

// The preview-gc clock's interval; 0 switches it off (the admin sweep stays).
function staleSweepIntervalMs() {
  const raw = parseInt(process.env.STAGING_STALE_SWEEP_INTERVAL_MS || '', 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_STALE_SWEEP_INTERVAL_MS;
  return raw;   // 0 disables
}

/**
 * The inventory the automatic passes read: every preview the runtime lists,
 * joined to its row (classify). A docker whose `{{.Label}}` verb yielded
 * nothing for EVERY container looks identical to "the whole fleet was built
 * by another environment", so one container is verified with a real
 * inspect before such a reading is used. A Kubernetes label is read off the
 * API object itself, so there is nothing to verify.
 */
async function inventory(config) {
  const containers = await listPreviews(config);
  if (!containers.length) return [];
  if (containers[0].runtimeKind === 'docker' && containers.every((c) => c.fingerprint === null)) {
    const probe = await docker.inspectContainer(containers[0].name);
    const probed = probe && probe.labels ? probe.labels[stagingEnv.LABEL_ENV_FP] : undefined;
    if (probed) {
      log.warn('staging-reap', 'docker ps reported no labels but inspect found one — falling back to inspect', {
        sample: containers[0].name,
      });
      for (const c of containers) {
        const state = await docker.inspectContainer(c.name);
        c.fingerprint = (state && state.labels && state.labels[stagingEnv.LABEL_ENV_FP]) || null;
      }
    }
  }
  return classify(getPool(config), containers);
}

/**
 * What the preview-gc clock takes, each preview a target of its own
 * (reapLeftover), a page at a time: every preview whose session merged, was archived or is
 * gone (selectAbandoned), and every one its row no longer names that the
 * preview machine does not hold. Neither serves anybody. The env does not
 * matter, so an older build running this during a rollout decides nothing
 * differently. Never throws: an unreadable runtime is an empty inventory.
 */
async function leftovers(config, { after = null, limit = Infinity } = {}) {
  const out = { examined: 0, abandoned: 0, unlinked: 0, items: [], after: null };
  if (isStagingEnv()) return out;      // a preview manages no other previews
  try {
    const items = await inventory(config);
    out.examined = items.length;
    if (!items.length) return out;
    const { rows } = await getPool(config).query(MACHINE_HELD_SESSIONS_SQL);
    const held = new Set(rows.map((r) => Number(r.id)));
    const abandoned = selectAbandoned(items);
    const names = new Set(abandoned.map((i) => i.name));
    const unlinked = items.filter((i) => !names.has(i.name) && i.session
      && !namesPreview(i, i.session) && !held.has(Number(i.sessionId)));
    out.abandoned = abandoned.length;
    out.unlinked = unlinked.length;
    // A page at a time, by name (the clock takes at most `limit` targets a
    // run): the ones after `after`, and where the next page starts.
    const all = [...abandoned, ...unlinked].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    const rest = typeof after === 'string' && after ? all.filter((i) => i.name > after) : all;
    const taken = rest.slice(0, limit);
    out.after = rest.length > taken.length ? taken[taken.length - 1].name : null;
    out.items = taken.map((i) => ({
      target: i.name,
      input: { name: i.name, sessionId: i.sessionId, slug: i.slug || null, image: i.image || null, runtimeKind: i.runtimeKind },
    }));
  } catch (err) {
    log.warn('staging-reap', 'Leftover preview inventory failed', { err: err.message });
  }
  return out;
}

/**
 * One leftover, taken: its row is read again (minutes may have passed since
 * the inventory), then reapOne retires it through the preview machine when
 * the row still names it, or removes it by name. Resolves the outcome.
 */
async function reapLeftover(item, config = {}) {
  const [fresh] = await classify(getPool(config), [item]);
  const status = fresh.session ? fresh.session.status : null;
  // Its session opened again, and its row names it once more: it serves.
  if (status && !FINISHED_STATUSES.has(status) && namesPreview(fresh, fresh.session)) return { outcome: 'skipped_linked' };
  // An open session somebody works on (a turn about to replace its
  // preview): its leftover waits for the next run.
  if (status && !FINISHED_STATUSES.has(status)
      && await require('./active-workers').isSessionBusyAnywhere(Number(fresh.sessionId), { pool: getPool(config) })) {
    return { outcome: 'skipped_busy' };
  }
  return reapOne(fresh, config);
}

/**
 * The preview-env clock's run (src/workflow/clock/services.ts, acting only
 * in the newest build): each preview staleEnvTargets finds is handed to the
 * preview machine. One it holds is told (EnvStale, once per attempt and
 * environment: rebuilt if it backs a vote, else given back); one it does
 * not is retired from its row, which it refuses under review or while
 * somebody works on it.
 */
async function tellStaleEnv(config) {
  const { examined, stale } = await staleEnvTargets(config);
  const platform = require('../workflow/platform.ts');
  const fingerprint = stagingEnv.expectedStagingFingerprint(config);
  let told = 0;
  for (const t of stale) {
    const instance = await platform.previewInstance(t.sessionId);
    const held = instance && instance.state !== 'retired' && instance.state !== 'detached';
    const serving = held ? instance.data?.serving : null;
    if (serving && Number.isInteger(serving.n)) {
      if (serving.runtimeName && serving.runtimeName !== t.name && serving.containerId !== t.name) continue;
      await platform.previewEnvStale(t.sessionId, t.appId, serving.n, fingerprint);
      told += 1;
    } else if (!held && t.appId != null) {
      await require('./preview-workflow').retire({ session: { id: t.sessionId, app_id: t.appId }, reason: 'stale-env', terminal: false });
      told += 1;
    }
  }
  return { examined, stale: stale.length, told };
}

/**
 * Every preview built with another platform environment than this build's,
 * that its row still names (tellStaleEnv hands each to the preview
 * machine, which decides). Never throws.
 */
async function staleEnvTargets(config) {
  const out = { examined: 0, stale: [] };
  if (isStagingEnv()) return out;
  try {
    const items = await inventory(config);
    out.examined = items.length;
    const expected = stagingEnv.expectedStagingFingerprint(config);
    out.stale = items
      .filter((i) => i.fingerprint !== expected && i.session && namesPreview(i, i.session))
      .map((i) => ({ sessionId: Number(i.sessionId), appId: i.session.app_id ?? null, name: i.name }));
  } catch (err) {
    log.warn('staging-reap', 'Stale preview inventory failed', { err: err.message });
  }
  return out;
}

/**
 * Staging demo job — request-time injection per the "Staging mock data"
 * convention. A preview has no docker socket (SELF-HOSTING.md Phase 2g), so
 * this console section has nothing real to render there and would screenshot
 * empty. Never persisted; the route serves it only behind
 * IS_STAGING && ?demo=1, and POST stays refused in staging regardless.
 *
 * Covers one row of each kind a sweep takes (abandoned, out of date, leaked
 * past teardown, session gone) plus a `failed` one, so the error styling is
 * screenshot-covered too.
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
        classification: 'paused',
        outOfDate: true,
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
 * Staging demo counters + automatic-pass history to accompany demoJob(),
 * so the "To shut down" tile and the "last automatic sweep" line are
 * screenshot-covered in a preview too (#851). Same rules as demoJob: fixed
 * timestamps, obviously-fake values, never persisted, served only behind
 * IS_STAGING && ?demo=1.
 */
function demoCounts() {
  return {
    open: 9,
    stale: 4,
    abandoned: 2,
    expectedFingerprint: 'stagingdemofp0000',
    automatic: {
      lastRunAt: '2026-01-01T11:45:00.000Z',
      examined: 9,
      stale: 4,
      abandoned: 2,
      tornDown: 3,
      failed: 1,
      intervalMs: 900000,
      limit: DEFAULT_STALE_SWEEP_LIMIT,
    },
  };
}

/**
 * Ask for a sweep: the preview-reap clock's run, on whichever process runs
 * the workflow. Returns { started, job }, or { started: false, reason }:
 * `running` with the job under way when one runs (anywhere), `rollout` while
 * an older build's workflow process still serves, `not_armed` where it is
 * not armed.
 */
async function start(pool, admin) {
  const now = await read(pool);
  if (now && !now.finishedAt && !now.stale) return { started: false, reason: 'running', job: now };
  const asked = await require('../workflow/platform.ts').askClockRun(JOB, admin);
  if (asked !== 'asked' && asked !== 'pending') return { started: false, reason: asked, job: await read(pool) };
  // Not yet taken (pending): the job shown is the one before it, so none.
  const job = await read(pool);
  return { started: true, job: job && (!now || job.id !== now.id) ? job : null };
}

/**
 * The clock's run: the previews selectReapable takes, listed once, each torn
 * down as a step. What works on a session is read on every process
 * (session-work.ts workedOnSql), and again when its preview's turn comes.
 */
async function runJob(ctx, { config, pool }) {
  return fleetJob.run(ctx, {
    name: JOB,
    ...SHAPE,
    concurrency: concurrency(),
    list: async () => {
      const containers = await listPreviews(config);
      const classified = await classify(pool, containers);
      const busy = await require('./active-workers').busySessionsAnywhere(classified.map((item) => item.sessionId), { pool });
      const { stale, selected } = selectReapable(
        classified, stagingEnv.expectedStagingFingerprint(config), { isInFlight: (id) => busy.has(Number(id)) }
      );
      // The classification says what the session is doing; for a live
      // session's preview the reason it was taken is its env, so the row
      // says that too.
      const staleNames = new Set(stale.map((item) => item.name));
      log.info('staging-reap', 'Stale preview sweep listed', { examined: containers.length, total: selected.length });
      return selected.map(({ session: _session, ...item }) => ({ ...item, outOfDate: staleNames.has(item.name) }));
    },
    // What listing it decided, decided again now, from the runtime and the
    // row as they are: minutes (or a stopped run's restart) may have passed
    // since the list was taken, and the preview may have been rebuilt with
    // the current environment meanwhile (same name, its new fingerprint).
    unit: async (item) => {
      const now = (await listPreviews(config)).find((p) => p.name === item.name);
      // Not in the runtime's list (gone, or the list could not be read):
      // nothing is torn down blind.
      if (!now) return { outcome: 'skipped_unseen' };
      const [fresh] = await classify(pool, [now]);
      const status = fresh.session ? fresh.session.status : null;
      if (status && !FINISHED_STATUSES.has(status)) {
        // Put up for a vote since: the preview machine rebuilds it in place.
        if (VOTE_BACKED_STATUSES.has(status)) return { outcome: 'skipped_vote' };
        // A checks run started on it since.
        if (fresh.session.check_run_open) return { outcome: 'skipped_checks' };
        // Somebody started working on it since: a turn is about to replace it.
        if (await require('./active-workers').isSessionBusyAnywhere(Number(fresh.sessionId), { pool })) {
          return { outcome: 'skipped_busy' };
        }
      }
      // Still out of date or abandoned, by the rule the list was taken by.
      const { selected } = selectReapable([fresh], stagingEnv.expectedStagingFingerprint(config));
      if (!selected.length) return { outcome: 'skipped_current' };
      return reapOne(fresh, config);
    },
    publish: broadcast,
    finish: (job, { durationMs }) => {
      const tally = job.previews.reduce((acc, p) => { acc[p.state] = (acc[p.state] || 0) + 1; return acc; }, {});
      const byClassification = job.previews.reduce((acc, p) => {
        acc[p.classification] = (acc[p.classification] || 0) + 1;
        return acc;
      }, {});
      return events.record(pool, {
        type: events.EVENT_TYPES.STALE_PREVIEWS_REAPED,
        userId: ctx.input.asked?.userId ?? null,
        metadata: {
          jobId: job.id,
          startedBy: job.startedBy,
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
    },
  });
}

// ─── Orphaned staging-DATABASE sweep ────────────────────────────────────
//
// The container-driven passes above only drop a staging database while
// tearing down a matching CONTAINER. Historically, when the container was
// already gone the database was deliberately left behind ("a leaked staging
// DB is inert and cheap" — reapOne below). At scale that assumption failed:
// by 2026-07-30 production had accumulated 3,479 staging databases (198 GB,
// >1/3 of the disk) of which 8 were live. Every one bloats the cluster
// catalog, feeds autovacuum churn, and slows anything that enumerates
// pg_database.
//
// This pass reconciles the other direction: enumerate `%_staging_%`
// databases and drop the ones nothing can ever reach again. A database is
// ORPHANED iff ALL of:
//   - its name parses as a staging clone (app_<slug>_staging_s<id>_<tag>);
//   - the embedded session has no live preview (staging_url IS NULL, or the
//     session row is gone entirely);
//   - the preview machine does not hold the session (a build's clone exists
//     before staging_url points at it);
//   - no client backend is currently connected to it (belt-and-braces for
//     anything the checks above don't model; autovacuum workers don't
//     count or an orphan being vacuumed would be immortal).
//
// Deliberately NOT keyed on the staging_url-derived hash: a session with a
// live preview keeps ALL its clone DBs until the preview itself is torn
// down. Stale siblings of a live preview are rare and small; mis-dropping
// the live clone is not recoverable. Conservative wins.
const DEFAULT_ORPHAN_DB_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_ORPHAN_DB_SWEEP_LIMIT = 200;

// app_<slug>_staging_s<sessionId>_<tag>, where tag is a 6-hex commit prefix
// or the literal 'latest' (unpinned builds flow 'latest' into stagingDbName
// verbatim). Anchored parse; anything else is left alone.
const STAGING_DB_NAME_RE = /^app_[a-z0-9_]+_staging_s(\d+)_([0-9a-f]{6}|latest)$/;

function orphanDbSweepIntervalMs() {
  const raw = parseInt(process.env.STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS || '', 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_ORPHAN_DB_SWEEP_INTERVAL_MS;
  return raw;   // 0 disables
}

function orphanDbSweepLimit() {
  const raw = parseInt(process.env.STAGING_ORPHAN_DB_SWEEP_LIMIT || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ORPHAN_DB_SWEEP_LIMIT;
  return raw;
}

// The sessions the preview machine holds: their attempts' databases exist
// before staging_url points at them, and the machine retires them itself.
const MACHINE_HELD_SESSIONS_SQL = `SELECT substr(key, length('session:') + 1)::int AS id FROM wf_instances
   WHERE machine = 'preview' AND state NOT IN ('retired', 'detached', '(none)')`;

/**
 * Pure classification, extracted for testability. Returns the subset of
 * `dbNames` that are safe to drop.
 *
 * @param dbNames           all datnames to consider
 * @param liveSessionIds    Set<number> of sessions with staging_url set, or
 *                          held by the preview machine (a build under way)
 * @param connectedDbNames  Set<string> of datnames with client backends
 */
function selectOrphanDbs({ dbNames, liveSessionIds, connectedDbNames }) {
  const orphans = [];
  for (const name of dbNames) {
    const m = STAGING_DB_NAME_RE.exec(name);
    if (!m) continue;                                // not a staging clone — never touch
    const sessionId = Number(m[1]);
    if (liveSessionIds.has(sessionId)) continue;     // live preview, or one being built
    if (connectedDbNames.has(name)) continue;        // someone is using it
    orphans.push(name);
  }
  return orphans;
}

/**
 * The automatic orphan-DB pass, the preview-orphan-dbs clock's run. Drops
 * up to `limit` orphaned staging databases per pass. NEVER THROWS.
 */
async function sweepOrphanDbs(config, { limit = null } = {}) {
  const cap = limit || orphanDbSweepLimit();
  const summary = { examined: 0, orphaned: 0, dropped: 0, failed: 0 };
  try {
    // A staging preview's clone contains a (scrubbed, stale) copy of the
    // platform's chat_sessions table: computing "live" from it would be
    // fiction, and it has no docker socket to drop with anyway.
    if (isStagingEnv()) return summary;

    const pool = getPool(config);

    // Projects made inside previews that are gone (services/preview-projects.js):
    // their runtimes first, then their databases, which would otherwise be
    // this pass's orphans with a runtime still connected. Never throws.
    await require('./preview-projects').sweep(config, pool);

    const [dbs, live, connected] = await Promise.all([
      pool.query(`SELECT datname FROM pg_database WHERE datname LIKE '%\\_staging\\_%'`),
      // A session the preview machine holds keeps its databases: its attempts
      // exist before staging_url points at them, and it retires them itself.
      pool.query(`SELECT id FROM chat_sessions WHERE staging_url IS NOT NULL
                  UNION ${MACHINE_HELD_SESSIONS_SQL}`),
      pool.query(`SELECT DISTINCT datname FROM pg_stat_activity
                  WHERE backend_type = 'client backend' AND datname IS NOT NULL`),
    ]);
    summary.examined = dbs.rows.length;

    const liveSessionIds = new Set(live.rows.map((r) => Number(r.id)));
    const orphans = selectOrphanDbs({
      dbNames: dbs.rows.map((r) => r.datname),
      liveSessionIds,
      connectedDbNames: new Set(connected.rows.map((r) => r.datname)),
    });

    // The preview server, when there is one (STAGING_DB_ADMIN_URL): the same
    // classification over ITS databases and ITS connections. Each orphan
    // remembers the server it was found on and is dropped there only, so a
    // database of the same name that is in use on the other server is never
    // reached by this pass. A preview server that cannot be read contributes
    // nothing this time; the main server's pass goes on.
    const onPreviewServer = new Set();
    const previewServer = dbManager.previewServerConfigured?.() ? dbManager.PREVIEW_SERVER : null;
    if (previewServer) {
      try {
        const there = await dbManager.listPreviewServerStagingDatabases();
        summary.examined += there.dbNames.length;
        for (const name of selectOrphanDbs({
          dbNames: there.dbNames,
          liveSessionIds,
          connectedDbNames: there.connectedDbNames,
        })) onPreviewServer.add(name);
      } catch (err) {
        log.warn('staging-reap', 'Could not list the preview database server; skipping it this pass', { err: err.message });
      }
      // Templates of apps that have not built since previews moved.
      const retired = await dbManager.retireStrayTemplates();
      if (retired.dropped || retired.failed) log.info('staging-reap', 'Stray staging templates retired', retired);
    }
    // One entry per (database, server). With one server this is the list it
    // always was.
    const work = [
      ...[...onPreviewServer].map((dbName) => ({ dbName, server: previewServer })),
      ...orphans.map((dbName) => ({ dbName, server: previewServer ? dbManager.PRIMARY_SERVER : null })),
    ];
    summary.orphaned = work.length;
    if (!work.length) return summary;
    const dropOrphan = ({ dbName, server }) => (server
      ? dbManager.dropDatabase(dbName, { server })
      : dbManager.dropDatabase(dbName));
    // Is anything connected to it, on the server it is on?
    const hasSessions = async ({ dbName, server }) => {
      if (server && server === previewServer) return dbManager.previewServerDatabaseHasSessions(dbName);
      const { rows } = await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1', [dbName]);
      return rows.length > 0;
    };

    const batch = work.slice(0, cap);
    log.info('staging-reap', 'Orphan staging-DB pass started', {
      examined: summary.examined, orphaned: work.length,
      acting: batch.length, deferred: work.length - batch.length,
    });

    // Serial on purpose: DROP DATABASE forces WAL/checkpoint work, and this
    // pass must stay invisible in host I/O next to live staging restores.
    for (const item of batch) {
      const { dbName } = item;
      try {
        // The census is a few seconds old by now: a preview the machine
        // started building meanwhile, or a connection, keeps the database.
        const sessionId = Number(STAGING_DB_NAME_RE.exec(dbName)[1]);
        const { rows } = await pool.query(
          `SELECT 1 FROM chat_sessions WHERE id = $1 AND staging_url IS NOT NULL
           UNION ALL SELECT 1 FROM (${MACHINE_HELD_SESSIONS_SQL}) held WHERE held.id = $1`, [sessionId]);
        if (rows.length || await hasSessions(item)) continue;
        await dropOrphan(item);
        summary.dropped++;
      } catch (err) {
        summary.failed++;
        log.warn('staging-reap', 'Orphan staging-DB drop failed', {
          dbName, err: err.message,
        });
      }
    }
    log.info('staging-reap', 'Orphan staging-DB pass finished', summary);
    return summary;
  } catch (err) {
    log.warn('staging-reap', 'Orphan staging-DB pass errored', { err: err.message });
    return summary;
  }
}

// ─── What still depends on a preview server that is being drained ───────
//
// Draining (STAGING_DB_SERVER_DRAIN) is the step before a preview database
// server is removed, and "may it be removed yet" needs a real answer. Open
// connections are not one: a preview holds none between requests or once its
// pool's idle timeout passes, and it still breaks when its server goes. So
// this counts what depends on the server, erring towards "still in use":
//
//   - every preview runtime that EXISTS, in any state (running, starting,
//     restarting, stopped), whose labels say its database is there. A
//     runtime that is restarting today is serving again tomorrow;
//   - every session row that names a runtime it could not read;
//   - the builds it can see: sessions whose checks are pending in their
//     build phase (a row, so other platform replicas' builds of that kind
//     count), and this process's own builds. NOT every build: a rebuild
//     another replica starts from recovery while a checks commit is already
//     pinned leaves the phase empty and is in neither;
//   - every before & after shots run that has not finished, and every shots
//     database still on the server.
//
// What it CANNOT see: the rebuilds just named, and a platform replica that
// has not yet been restarted with the drain setting, which keeps making
// previews on the preview server; a build it starts a moment after this
// count is not in it. A replica that HAS the drain setting builds on the
// main server, so once the rollout is over an unseen build no longer adds a
// dependent, and one that finished shows up as a labelled runtime on the
// next pass: hence two passes. So the line this
// logs is "none found", not "safe to remove": the procedure in
// docs/kubernetes-operations.md also requires the rollout that set the
// drain to have finished, and the line to hold for two passes. Logged every
// ten minutes while draining: `lastAt` is when it was last logged (the
// preview-pressure clock carries it from run to run). Null when not
// draining, not due, or when something could not be read. Never throws.
const DRAIN_STATUS_INTERVAL_MS = 10 * 60 * 1000;

async function previewServerDrainStatus(config, { now = Date.now(), force = false, lastAt = 0 } = {}) {
  try {
    if (isStagingEnv()) return null;
    if (!dbManager.previewServerConfigured?.() || !dbManager.previewServerDraining?.()) return null;
    if (!force && now - (Number(lastAt) || 0) < DRAIN_STATUS_INTERVAL_MS) return null;
    const pool = getPool(config);
    const stagingRecovery = require('./staging-recovery');
    const { rows } = await pool.query(
      `SELECT id, staging_url, staging_runtime_kind, staging_runtime_name, staging_container_id,
              (check_state = 'pending' AND check_phase = 'building') AS building
         FROM chat_sessions
        WHERE staging_url IS NOT NULL OR staging_runtime_name IS NOT NULL OR staging_container_id IS NOT NULL
           OR (check_state = 'pending' AND check_phase = 'building')
        ORDER BY id`
    );
    const status = { previews: [], unread: 0, buildsInFlight: 0, shotsRuns: 0, shotsDatabases: 0 };
    for (const session of rows) {
      if (session.building) status.buildsInFlight += 1;
      if (!session.staging_runtime_name && !session.staging_container_id) continue;
      const state = await stagingRecovery.inspectPreviewRuntime(session, config);
      if (!state) { status.unread += 1; continue; }
      if (state.status === 'not_found') continue;
      if (dbManager.previewDatabaseServerOf(state.labels) === dbManager.PREVIEW_SERVER) status.previews.push(Number(session.id));
    }
    // A shots eval's trial (the shots-eval machine) uses the same
    // kind of copies on the same server.
    const runs = await pool.query(
      `SELECT ((SELECT count(*) FROM shot_runs
                 WHERE state IN ('planned','provisioning','exploring','replaying','reviewing'))
             + (SELECT count(*) FROM shots_eval_trials
                 WHERE state IN ('provisioning','exploring','reviewing')))::int AS n`
    );
    status.shotsRuns = Number(runs.rows[0]?.n) || 0;
    status.shotsDatabases = (await dbManager.previewServerShotsDatabases()).length;
    const clear = !status.previews.length && !status.unread && !status.buildsInFlight
      && !status.shotsRuns && !status.shotsDatabases;
    log.info('staging-reap', clear
      ? 'Preview database server drain: no dependent preview, build or shots run found'
      : 'Preview database server drain: still in use', {
      previews: status.previews.length, sessionIds: status.previews.slice(0, 50),
      previewsNotRead: status.unread, buildsInFlight: status.buildsInFlight,
      shotsRuns: status.shotsRuns, shotsDatabases: status.shotsDatabases,
    });
    return { ...status, clear, at: now };
  } catch (err) {
    log.warn('staging-reap', 'Preview database server drain status could not be read', { err: err.message });
    return null;
  }
}

function pressureSweepIntervalMs() {
  const raw = parseInt(process.env.STAGING_PRESSURE_SWEEP_INTERVAL_MS || '', 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_PRESSURE_SWEEP_INTERVAL_MS;
  return raw;   // 0 disables
}

/**
 * Pure selection, extracted for testability: which idle previews may be
 * reclaimed to free connections, idle-longest first.
 *
 * Everything excluded here is excluded because tearing it down would break
 * something a person is looking at: a session with a worker turn in flight,
 * and any preview backing a live merge vote (the same VOTE_BACKED_STATUSES
 * the stale pass respects — a reviewer arriving at a dead link is worse than
 * a tight connection budget). A preview the machine is building or checking
 * refuses the retirement itself (staging.teardownStaging reports it busy).
 *
 * @param rows              [{ id, status, last_activity_at }], any order
 * @param isBusy            (sessionId) => boolean
 */
function selectPressureVictims({ rows, isBusy = null }) {
  return rows
    .filter((r) => {
      if (VOTE_BACKED_STATUSES.has(String(r.status))) return false;
      if (isBusy && isBusy(Number(r.id))) return false;
      return true;
    })
    .sort((a, b) => new Date(a.last_activity_at || 0) - new Date(b.last_activity_at || 0));
}

/**
 * The automatic connection-pressure pass. NEVER THROWS.
 *
 * The other two passes reclaim previews that are stale or orphaned — facts
 * about the preview itself. This one reclaims previews that are perfectly
 * healthy, because of a fact about the SERVER: `max_connections` is shared
 * by the platform, every production app and every preview, and when it runs
 * out the casualty is whichever proposal's checks happen to run next.
 *
 * Two properties matter more than how much it frees:
 *
 *   - It does nothing until the census says the server is saturated, so on
 *     an ordinary day this is one cheap query every five minutes.
 *   - It asks the preview machine to give back ONE preview a pass, and asks
 *     for none while one it asked for (`asked`, from its last pass) is still
 *     being retired: a retirement is asynchronous, so a census taken right
 *     after the ask sees nothing freed, and asking again on that reading
 *     took the whole cap every saturated pass. Freeing the budget is the
 *     goal; tearing down previews is only the means.
 *
 * Deliberately NOT done here: terminating other databases' idle backends
 * with pg_terminate_backend. That is the fast way to free connections and
 * the wrong one — node-postgres surfaces a killed idle client as an error
 * event on the pool, and a pool with no 'error' listener takes the process
 * down with it. Generated apps frequently have no such listener, so the
 * platform would be crash-looping other people's production apps to make
 * room for a preview.
 *
 * `server` picks whose budget is read. The main server's is read through the
 * platform's pool, as always. With a preview database server
 * (STAGING_DB_ADMIN_URL) there are two budgets, and a preview only holds
 * connections on the server its database is on: each pass then considers
 * only the previews that live on the server it measured, since tearing down
 * one on the other server would free nothing here.
 */
async function sweepConnectionPressure(config, { server = null, asked = [] } = {}) {
  const summary = { saturated: false, candidates: 0, asked: [], waiting: 0, failed: 0 };
  try {
    // A preview has no docker socket and its cloned chat_sessions is a
    // stale copy: computing victims from it would be fiction.
    if (isStagingEnv()) return summary;

    const pool = getPool(config);
    const { connectionCensus } = require('../db/connection-census');
    const twoServers = !!dbManager.previewServerConfigured?.();
    const onPreviewServer = twoServers && server === 'preview';
    // Asked about a preview server there is not: nothing to read.
    if (server === 'preview' && !twoServers) return summary;
    const reader = onPreviewServer ? dbManager.previewServerQueryable() : pool;
    const before = await connectionCensus(reader);
    // A null census means the query itself could not run, which on this
    // path most likely means the server is ALREADY refusing connections.
    // Acting on a reading we do not have would be guessing, and the stale
    // and orphan passes still run either way.
    if (!before || !before.saturated) return summary;
    summary.saturated = true;

    const activeWorkers = require('./active-workers');
    const previewWorkflow = require('./preview-workflow');
    // A preview this pass asked for last time that is still being retired:
    // what it frees is not in the census yet.
    for (const id of asked || []) {
      if (await previewWorkflow.retiring(Number(id))) summary.asked.push(Number(id));
    }
    if (summary.asked.length) {
      summary.waiting = summary.asked.length;
      return summary;
    }

    const { rows } = await pool.query(
      `SELECT id, app_id, status, last_activity_at
         FROM chat_sessions
        WHERE staging_url IS NOT NULL
          AND (staging_runtime_name IS NOT NULL OR staging_container_id IS NOT NULL)
          AND status NOT IN ('merged')
        ORDER BY last_activity_at ASC
        LIMIT 50`
    );
    const where = twoServers ? { server: onPreviewServer ? 'preview' : 'main' } : {};
    // With two servers a preview only holds connections where its CURRENT
    // runtime's database is, which its labels say (staging.js writes them at
    // deploy). Not the session's number in some database name: a session can
    // keep an old clone on one server while its preview runs on the other.
    // A runtime without labels was built before the setting and is on the
    // main server. One that cannot be read is left alone.
    const holdsConnectionsHere = async (row) => {
      if (!twoServers) return true;
      const session = await pool.query(
        `SELECT id, staging_runtime_kind, staging_runtime_name, staging_container_id
           FROM chat_sessions WHERE id = $1`, [row.id]);
      const state = session.rows[0]
        ? await require('./staging-recovery').inspectPreviewRuntime(session.rows[0], config) : null;
      if (!state || state.status === 'not_found') return false;
      const labelled = dbManager.previewDatabaseServerOf(state.labels) || dbManager.PRIMARY_SERVER;
      return labelled === (onPreviewServer ? dbManager.PREVIEW_SERVER : dbManager.PRIMARY_SERVER);
    };
    // What works on each session, on any process, read once for the pass.
    const busy = await activeWorkers.busySessionsAnywhere(rows.map((r) => r.id), { pool });
    const eligible = selectPressureVictims({
      rows,
      isBusy: (id) => busy.has(Number(id)),
    });
    const victims = [];
    for (const row of eligible) {
      if (await holdsConnectionsHere(row)) victims.push(row);
    }
    summary.candidates = victims.length;
    if (!victims.length) {
      log.warn('staging-reap', 'Postgres near its connection limit, no reclaimable preview', {
        used: before.used, max: before.max, topDatabases: before.topDatabases, ...where,
      });
      return summary;
    }

    log.warn('staging-reap', 'Connection-pressure pass started', {
      used: before.used, max: before.max, free: before.free,
      candidates: victims.length,
      topDatabases: before.topDatabases, ...where,
    });

    // The idle-longest the machine takes: it refuses one under review,
    // worked on, building or checking, and the next is asked instead.
    for (const victim of victims) {
      try {
        const out = await previewWorkflow.retire({ session: { id: Number(victim.id), app_id: victim.app_id }, reason: 'pressure', terminal: false });
        // Given back now, or already being given back (the idle rule got
        // there first): either way it is what this pass waits for.
        if (out.status === 'accepted' || out.status === 'pending' || out.status === 'replayed' || out.reason === 'already_retiring') {
          summary.asked.push(Number(victim.id));
          break;
        }
      } catch (err) {
        summary.failed++;
        log.warn('staging-reap', 'Connection-pressure teardown failed', {
          sessionId: victim.id, err: err.message,
        });
      }
    }
    log.info('staging-reap', 'Connection-pressure pass finished', summary);
    return summary;
  } catch (err) {
    log.warn('staging-reap', 'Connection-pressure pass errored', { err: err.message });
    return summary;
  }
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
 *
 * A Kubernetes item takes the same two paths; "names it" means its row's
 * staging_runtime_name is this Deployment (see namesPreview).
 */
async function reapOne(item, config = {}) {
  const kube = item.runtimeKind === 'kubernetes';
  const exists = kube
    ? await kubernetesPreviewExists(config, item.name)
    : await docker.containerExists(item.name).catch(() => true);
  if (!exists) return { outcome: 'skipped_gone' };

  const linked = namesPreview(item, item.session);
  // A preview the machine holds is the machine's to retire, by identity.
  if (!linked && item.sessionId && await require('./preview-workflow').held(item.sessionId)) {
    return { outcome: 'skipped_workflow' };
  }

  if (linked) {
    try {
      const staging = require('./staging');
      const result = await staging.teardownStaging(
        item.session, { slug: item.session.app_slug || item.slug }
      );
      // #851: teardownStaging no longer lies about a removal it could not
      // perform. A leak is this unit FAILING — the container is still there,
      // so reporting success would hide it from the tally and the admin
      // console alike. The session row still names it, so the next pass
      // retries through this same branch.
      if (result && result.leaked) {
        return { outcome: FAILED, error: 'container survived teardown (still running)' };
      }
      return { outcome: TORN_DOWN };
    } catch (err) {
      log.warn('staging-reap', 'teardownStaging failed', {
        name: item.name, sessionId: item.sessionId, err: err.message,
      });
      return { outcome: FAILED, error: err.message };
    }
  }

  // By-name path. The container is the only thing we are sure about.
  if (kube) {
    try {
      await applicationRuntime.remove(kubernetesConfig(config), {
        runtimeKind: 'kubernetes', runtimeName: item.name,
      });
    } catch (err) {
      log.warn('staging-reap', 'Kubernetes preview removal failed', { name: item.name, err: err.message });
      return { outcome: FAILED, error: err.message };
    }
    // A Kubernetes image is addressed by digest, so nothing left here names
    // the commit this preview's staging database was cloned for. Its row no
    // longer points at a live preview, so the orphan-database pass
    // (sweepOrphanDbs) drops the clone once nothing is connected to it.
    return { outcome: TORN_DOWN_NO_DB };
  }

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

// Same stance as the Docker probe's catch: an unreadable API must not read as
// "already gone", or a preview would be reported reaped while still running.
async function kubernetesPreviewExists(config, name) {
  try {
    const found = await applicationRuntime.inspect(kubernetesConfig(config), {
      runtimeKind: 'kubernetes', runtimeName: name,
    });
    return found?.status !== 'not_found';
  } catch (_) {
    return true;
  }
}

module.exports = {
  start,
  read,
  runJob,
  JOB,
  demoJob,
  demoCounts,
  isStagingEnv,
  concurrency,
  staleCount,
  previewCounts,
  listStagingContainers,
  listPreviews,
  classify,
  selectStale,
  selectAbandoned,
  selectReapable,
  // The automatic passes, each a clock's (src/workflow/clock/services.ts)
  // or the release's (src/workflow/platform.ts).
  inventory,
  leftovers,
  reapLeftover,
  staleEnvTargets,
  tellStaleEnv,
  staleSweepIntervalMs,
  orphanDbSweepIntervalMs,
  sweepOrphanDbs,
  selectOrphanDbs,
  // Connection-pressure pass (#1771).
  sweepConnectionPressure,
  previewServerDrainStatus,
  selectPressureVictims,
  pressureSweepIntervalMs,
  STAGING_DB_NAME_RE,
  reapOne,
  CONTAINER_NAME_RE,
  VOTE_BACKED_STATUSES,
  FINISHED_STATUSES,
  TORN_DOWN,
  TORN_DOWN_NO_DB,
  FAILED,
};
