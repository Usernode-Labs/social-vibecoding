'use strict';

/**
 * A production redeploy the platform owes an app, kept in the database so a
 * restart cannot lose it.
 *
 * A secret a vote changed reaches the running app only by a production
 * rebuild (routes/issues.js maybeApplySecretChangeProposal): the issue closes
 * and the value commits, the thread says "redeploying…", and the rebuild runs
 * on after the vote has answered. When the process died first, nothing ever
 * gave it: main_sha had not moved, so the drift poller saw nothing to do, and
 * the heal saw a healthy container, still running the old value. Now the
 * transaction that applies the change also owes the rebuild (owe), and the
 * rebuild that runs after it clears the mark (kick).
 *
 * WHO IS GIVING IT. The rebuild under way holds the row as creation does
 * (services/app-creation-owner.js): an owner token (apps.redeploy_owner) and
 * a heartbeat renewed every HEARTBEAT_MS. The leader's sweep runs again a
 * redeploy that is owed while nobody gives it: one whose owner has been quiet
 * for OWNER_LAPSE_SECONDS, or one nobody took within UNTAKEN_GRACE_SECONDS of
 * being owed (the process died between its commit and its kick). At most
 * MAX_KICKS runs a mark (redeploy_kicks); after that it is let go, loudly.
 *
 * WHAT CLEARS IT. A rebuild that ran: the mark it was taken under, and only
 * that one, since a change applied while it ran is owed again by its own mark
 * and its own rebuild. A rebuild that FAILED clears it too: it recorded its
 * own last_failure, and the next deploy carries the change, as before. Only a
 * rebuild that never finished is run again.
 *
 * The governance machine (WF_GOVERNANCE_ENABLED) owes its rebuild as durable
 * work of its own (src/workflow/governance-proposal, `app.rebuildProduction`)
 * and never writes these columns; with app delivery on
 * (WF_APP_DELIVERY_ENABLED), the vote asks that machine for the deploy and
 * owes nothing here, since nothing may deploy beside it. Never for the
 * self-hosted row, which a rebuild would treat as a child container. Not
 * swept in a staging preview, whose database is a clone of production's: an
 * owed mark there is production's, and a preview rebuilding production apps
 * is the last thing either wants.
 */

const crypto = require('crypto');
const log = require('./logger');
const lifecycle = require('./lifecycle');

const HEARTBEAT_MS = 20 * 1000;
const OWNER_LAPSE_SECONDS = 90;
// The request that owes a redeploy takes it a moment after its transaction
// commits. One nobody has taken this long after it was owed was owed by a
// process that died in between.
const UNTAKEN_GRACE_SECONDS = 60;
const SWEEP_INTERVAL_MS = 60 * 1000;
// Runs a mark gets, the first included. A rebuild that keeps dying with its
// process is not being interrupted; it is what is killing the process.
const MAX_KICKS = 3;
// Marks taken a pass. Each rebuild runs on in the background (different apps
// rebuild in parallel; one app's rebuilds queue, staging.serializeRebuild).
const SWEEP_BATCH = 5;

// What the logs have always called the rebuild a secret change kicks.
const LABELS = { secret_change: 'Post-secret-change redeploy' };

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

// The apps a rebuild in THIS process is giving: the sweep never runs a second
// one beside its own process's, whatever the heartbeat says.
// Each app is also this process's hold (services/processes.js): a draining
// process finishes the rebuild before it exits.
const giving = require('./processes').heldMap('redeploy'); // appId -> how many
const startGiving = (id) => giving.set(id, (giving.get(id) || 0) + 1);
const stopGiving = (id) => {
  const left = (giving.get(id) || 1) - 1;
  if (left > 0) giving.set(id, left); else giving.delete(id);
};

/**
 * Owe the app a production redeploy, inside the caller's transaction (`db`
 * is its client), so the mark commits with the change that needs it or not
 * at all. A newer mark replaces an older one: the one rebuild after it covers
 * both.
 */
async function owe(db, appId, reason) {
  await db.query(
    `UPDATE apps SET redeploy_owed_at = clock_timestamp(), redeploy_owed_reason = $2,
                     redeploy_kicks = 0
      WHERE id = $1 AND self_hosted IS NOT TRUE`,
    [appId, reason]
  );
}

/**
 * Give the app's owed redeploy: take it, rebuild production (`rebuild(app)`,
 * staging.rebuildProduction by default), record the new container as the
 * legacy path always did, and clear the mark it was taken under.
 *
 * `takeover`: the request that just owed it, which takes it whoever holds it
 * (a rebuild already under way may have read the app's secrets before this
 * change committed, so it must not be the one that clears this mark). The
 * sweep's takes it only from nobody, or from an owner gone quiet, and only
 * while it has runs left. Never rejects; resolves { taken, deployed }.
 */
async function kick(config, pool, appId, { takeover = false, rebuild = null, timing = {} } = {}) {
  const owner = crypto.randomUUID();
  let app;
  try {
    ({ rows: [app] } = await pool.query(
      `UPDATE apps SET redeploy_owner = $2, redeploy_heartbeat_at = NOW(),
                       redeploy_kicks = redeploy_kicks + 1
        WHERE id = $1 AND redeploy_owed_at IS NOT NULL AND self_hosted IS NOT TRUE
          AND ($3::boolean
               OR ((redeploy_owner IS NULL OR redeploy_heartbeat_at IS NULL
                    OR redeploy_heartbeat_at < NOW() - make_interval(secs => $4))
                   AND redeploy_kicks < $5))
        RETURNING *, redeploy_owed_at::text AS owed_mark`,
      [appId, owner, takeover, OWNER_LAPSE_SECONDS, MAX_KICKS]
    ));
  } catch (err) {
    log.warn('owed-redeploy', 'Owed redeploy not taken; the sweep runs it', { appId, err: err.message });
    return { taken: false, deployed: false };
  }
  if (!app) return { taken: false, deployed: false };
  const label = LABELS[app.redeploy_owed_reason] || 'Owed redeploy';
  startGiving(appId);

  let held = true;
  const heartbeat = setInterval(async () => {
    if (!held) return;
    try {
      const { rowCount } = await pool.query(
        `UPDATE apps SET redeploy_heartbeat_at = NOW() WHERE id = $1 AND redeploy_owner = $2`,
        [appId, owner]
      );
      // Taken over by a newer change's request: its rebuild says so now.
      if (!rowCount) { held = false; clearInterval(heartbeat); }
    } catch (err) {
      log.warn('owed-redeploy', 'Heartbeat failed', { appId, err: err.message });
    }
  }, timing.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  let deployed = false;
  try {
    const run = rebuild || ((row) => require('./staging').rebuildProduction(config, row));
    const result = await run(app);
    if (result) {
      await pool.query(
        `UPDATE apps SET container_id = $1, main_sha = $2, status = 'running',
                         last_deploy_at = NOW()
         WHERE id = $3`,
        [result.containerId, result.sha || null, appId]
      );
    }
    deployed = true;
  } catch (err) {
    // Including MissingSecretsError when the app still requires keys that
    // are unset: the deploy-status broadcast says so, and the vote that owed
    // it stands.
    log.warn('issues', `${label} failed`, { slug: app.slug, err: err.message });
  } finally {
    held = false;
    clearInterval(heartbeat);
    stopGiving(appId);
    // In SET every CASE reads the row as it was: the mark is cleared only if
    // it is still the one this run was taken under, the owner only if it is
    // still this run.
    await pool.query(
      `UPDATE apps
          SET redeploy_owed_at = CASE WHEN redeploy_owed_at = $3::timestamptz THEN NULL ELSE redeploy_owed_at END,
              redeploy_owed_reason = CASE WHEN redeploy_owed_at = $3::timestamptz THEN NULL ELSE redeploy_owed_reason END,
              redeploy_owner = CASE WHEN redeploy_owner = $2 THEN NULL ELSE redeploy_owner END,
              redeploy_heartbeat_at = CASE WHEN redeploy_owner = $2 THEN NULL ELSE redeploy_heartbeat_at END
        WHERE id = $1`,
      [appId, owner, app.owed_mark]
    ).catch((err) => log.warn('owed-redeploy', 'Owed redeploy not cleared; the sweep may run it again', {
      appId, err: err.message,
    }));
  }
  return { taken: true, deployed };
}

/**
 * One pass of the leader's sweep: let go of the marks that used up their
 * runs, and run the others nobody is giving, each in the background. In a
 * staging preview it does nothing (see the header). Resolves
 * { kicked: [appId], abandoned: [appId] }.
 */
async function sweep(config, pool, deps = {}) {
  const kicked = [];
  if (isStaging() && !deps.allowStaging) return { kicked, abandoned: [] };
  const lapse = deps.lapseSeconds ?? OWNER_LAPSE_SECONDS;
  const grace = deps.untakenGraceSeconds ?? UNTAKEN_GRACE_SECONDS;
  const { rows: abandoned } = await pool.query(
    `UPDATE apps SET redeploy_owed_at = NULL, redeploy_owed_reason = NULL,
                     redeploy_owner = NULL, redeploy_heartbeat_at = NULL
      WHERE redeploy_owed_at IS NOT NULL AND redeploy_kicks >= $3
        AND ((redeploy_owner IS NULL AND redeploy_owed_at < NOW() - make_interval(secs => $2))
             OR (redeploy_owner IS NOT NULL
                 AND (redeploy_heartbeat_at IS NULL
                      OR redeploy_heartbeat_at < NOW() - make_interval(secs => $1))))
      RETURNING id, slug`,
    [lapse, grace, MAX_KICKS]
  );
  if (abandoned.length) {
    log.error('owed-redeploy', 'Owed redeploys let go after every run died; the next deploy carries them', {
      apps: abandoned.map((r) => r.slug), runs: MAX_KICKS,
    });
  }
  const { rows } = await pool.query(
    `SELECT id FROM apps
      WHERE redeploy_owed_at IS NOT NULL AND redeploy_kicks < $3 AND self_hosted IS NOT TRUE
        AND ((redeploy_owner IS NULL AND redeploy_owed_at < NOW() - make_interval(secs => $2))
             OR (redeploy_owner IS NOT NULL
                 AND (redeploy_heartbeat_at IS NULL
                      OR redeploy_heartbeat_at < NOW() - make_interval(secs => $1))))
      ORDER BY redeploy_owed_at
      LIMIT $4`,
    [lapse, grace, MAX_KICKS, SWEEP_BATCH]
  );
  for (const { id } of rows) {
    if (giving.has(id)) continue;
    log.info('owed-redeploy', 'Running an owed redeploy nobody finished', { appId: id });
    kicked.push(id);
    void kick(config, pool, id, { rebuild: deps.rebuild || null, timing: deps.timing });
  }
  return { kicked, abandoned: abandoned.map((r) => r.id) };
}

let intervalHandle = null;
let sweeping = false;

// Not from a process on its way out: a rebuild it started would die with it.
async function runSweep(config, pool, deps) {
  if (sweeping || lifecycle.isShuttingDown?.()) return null;
  sweeping = true;
  try {
    return await sweep(config, pool, deps);
  } catch (err) {
    log.warn('owed-redeploy', 'Owed-redeploy sweep failed', { err: err.message });
    return null;
  } finally {
    sweeping = false;
  }
}

/** The leader's half (server.js becomeLeader): a pass now, then every SWEEP_INTERVAL_MS. */
function start(config, deps = {}) {
  if (intervalHandle) return;
  const pool = deps.pool || require('../db/pool').getPool(config);
  void runSweep(config, pool, deps);
  intervalHandle = setInterval(() => { void runSweep(config, pool, deps); }, SWEEP_INTERVAL_MS);
  intervalHandle.unref?.();
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

module.exports = {
  HEARTBEAT_MS,
  OWNER_LAPSE_SECONDS,
  UNTAKEN_GRACE_SECONDS,
  SWEEP_INTERVAL_MS,
  MAX_KICKS,
  owe,
  kick,
  sweep,
  start,
  stop,
};
