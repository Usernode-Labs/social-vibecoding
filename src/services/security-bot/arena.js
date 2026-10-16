'use strict';

// The security bot's arena: the throwaway, isolated target a campaign probes
// (#4678). An arena is NEVER a real app. It is a dedicated instance with:
//
//   * a FRESH, empty database of its own (the runtime boundary provisions it;
//     this module never points a probe at a production or staging database).
//   * INDEPENDENT auth secrets generated here, unrelated to the platform's own
//     signing keys, so a token minted for the arena is worthless anywhere else
//     and a platform token is worthless inside the arena.
//   * SYNTHETIC fixtures only: fabricated accounts and fabricated "protected"
//     data across two separate owners, so the cross-account probe has a real
//     boundary to test without ever touching a real person's data.
//
// Lifecycle — provision, health, stop, destroy, reconcile — runs THROUGH the
// existing runtime boundary (services/application-runtime.js) rather than
// reimplementing deploys. This module owns the secrets, the fixtures, the
// fenced persistence of arena state on the run row, and an idempotent destroy
// bound to the run and its cleanup generation. It starts nothing on its own.

const crypto = require('node:crypto');
const runsModule = require('./runs');

class ArenaError extends Error {
  constructor(code) {
    super(`Security bot arena: ${code}`);
    this.name = 'SecurityBotArenaError';
    this.code = code;
  }
}

const STATUS = Object.freeze({
  provisioning: 'provisioning', ready: 'ready', unhealthy: 'unhealthy',
  stopping: 'stopping', stopped: 'stopped', destroyed: 'destroyed', failed: 'failed',
});

// arena_ref is persisted through runs.setPhase, which validates it against the
// run-identifier regex, so keep it a plain opaque token the runtime ref can be
// rebuilt from.
function arenaRef(runId, generation) {
  runsModule.identifier(String(runId));
  return `secbot-arena-r${runId}-g${generation}`;
}

// Independent RS256 signing material for the arena's own auth, generated fresh
// per provision. The platform's keys are never reused, and the private half is
// handed to the runtime to inject as the arena target's own env; only the
// public half and a short revision are kept for reference.
function generateArenaSecrets() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const revision = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
  return {
    jwtPublicKey: publicKey,
    jwtPrivateKey: privateKey,
    // A distinct per-arena app id, so an arena token's audience can never match
    // a real app's audience.
    appAudience: `usernode:app:secbot-arena-${crypto.randomUUID()}`,
    revision,
  };
}

// Two fabricated owners in the arena, each with a secret only they should be
// able to read. The cross-account probe tries to read owner B's secret while
// authenticated as owner A; owner A's own secret is the authorized positive
// control that proves the probe's read path works at all.
function buildSyntheticFixtures() {
  const owner = (label) => ({
    identityRef: `arena-${label}-${crypto.randomUUID()}`,
    username: `arena_${label}_${crypto.randomBytes(3).toString('hex')}`,
    secret: `arena-secret-${crypto.randomBytes(16).toString('hex')}`,
  });
  return { ownerA: owner('a'), ownerB: owner('b') };
}

// Persist arena_status on the run under the live execution lease. Fenced: a
// controller that lost its lease cannot write arena state.
async function setStatus(pool, lease, status, { runs = runsModule } = {}) {
  if (!Object.values(STATUS).includes(status)) throw new ArenaError('invalid_status');
  return runs.withLease(pool, lease, async (client, run) => (await client.query(
    'UPDATE security_bot_runs SET arena_status = $3 WHERE id = $1 AND lease_generation = $2 RETURNING *',
    [run.id, lease.generation, status],
  )).rows[0]);
}

/**
 * Provision an arena for the run, through the runtime boundary.
 *
 *   runtime   an injected boundary adapter: { provision(spec) -> ref,
 *             origin(ref) -> url, health(ref) -> bool, stop(ref), destroy(ref) }.
 *             The default (buildRuntimeAdapter) composes application-runtime.
 *
 * Returns a handle { ref, origin, audience, revision, fixtures } whose secrets
 * (beyond the public reference material) are never returned to the caller.
 */
async function provision(pool, lease, { runtime, deploySpec = {}, runs = runsModule } = {}) {
  if (!runtime || typeof runtime.provision !== 'function') throw new ArenaError('runtime_required');
  const ref = arenaRef(lease.runId, lease.generation);
  const secrets = generateArenaSecrets();
  const fixtures = buildSyntheticFixtures();

  // Record the ref and move the run into preparing BEFORE the deploy, so a
  // crash mid-provision still has a ref to tear down. arena_status tracks the
  // in-flight state.
  await runs.setPhase(pool, lease, 'preparing', { arenaRef: ref });
  await setStatus(pool, lease, STATUS.provisioning, { runs });

  let provisioned;
  try {
    provisioned = await runtime.provision({
      ref,
      // A fresh database is the boundary's job; we only require one.
      freshDatabase: true,
      secrets: {
        jwtPublicKey: secrets.jwtPublicKey,
        jwtPrivateKey: secrets.jwtPrivateKey,
        appAudience: secrets.appAudience,
      },
      fixtures,
      ...deploySpec,
    });
  } catch (err) {
    await setStatus(pool, lease, STATUS.failed, { runs }).catch(() => {});
    throw err;
  }

  const origin = typeof runtime.origin === 'function'
    ? runtime.origin(provisioned) : provisioned?.origin;
  if (typeof origin !== 'string' || !origin) {
    await setStatus(pool, lease, STATUS.failed, { runs }).catch(() => {});
    throw new ArenaError('origin_unavailable');
  }

  await setStatus(pool, lease, STATUS.ready, { runs });
  return {
    ref,
    runtimeRef: provisioned,
    origin,
    audience: secrets.appAudience,
    revision: secrets.revision,
    // Public reference material only; the private key stays with the runtime.
    jwtPublicKey: secrets.jwtPublicKey,
    fixtures,
  };
}

// Health through the boundary, recording unhealthy without failing the run.
async function health(pool, lease, handle, { runtime, runs = runsModule } = {}) {
  if (!runtime || typeof runtime.health !== 'function') throw new ArenaError('runtime_required');
  let ok = false;
  try { ok = await runtime.health(handle.runtimeRef); }
  catch { ok = false; }
  await setStatus(pool, lease, ok ? STATUS.ready : STATUS.unhealthy, { runs }).catch(() => {});
  return ok;
}

async function stop(pool, lease, handle, { runtime, runs = runsModule } = {}) {
  if (!runtime || typeof runtime.stop !== 'function') throw new ArenaError('runtime_required');
  await setStatus(pool, lease, STATUS.stopping, { runs }).catch(() => {});
  await runtime.stop(handle.runtimeRef);
  await setStatus(pool, lease, STATUS.stopped, { runs }).catch(() => {});
}

/**
 * Idempotent teardown, run from runs.runCleanup's destroyArena adapter. Bound
 * to the run and its cleanup_target_generation: it must NOT destroy an arena
 * belonging to a newer execution generation. Tolerates a run whose arena_ref
 * was never saved (a crash before provision persisted it). Never throws for an
 * already-destroyed or missing arena.
 */
async function destroy(pool, claim, { runtime, runs = runsModule } = {}) {
  if (!runtime || typeof runtime.destroy !== 'function') throw new ArenaError('runtime_required');
  const run = claim && claim.id != null ? await runs.getRun(pool, claim.id) : null;
  if (!run) return { destroyed: false, reason: 'run_missing' };
  // Only tear down the generation this cleanup was fenced for.
  if (claim.cleanup_target_generation != null
      && run.cleanup_target_generation != null
      && run.cleanup_target_generation !== claim.cleanup_target_generation) {
    throw new ArenaError('cleanup_generation_mismatch');
  }
  if (run.arena_status === STATUS.destroyed) return { destroyed: true, reason: 'already' };
  const ref = run.arena_ref || arenaRef(run.id, claim.cleanup_target_generation ?? run.lease_generation);
  // Idempotent: a destroy with no live target still records the terminal state.
  await runtime.destroy({ ref, runtimeRef: run.arena_ref ? { ref } : null });
  await pool.query(
    "UPDATE security_bot_runs SET arena_status = 'destroyed' WHERE id = $1", [run.id],
  );
  return { destroyed: true, ref };
}

/**
 * Restart reconciliation for an arena. Trusts only the persisted arena_status:
 * it never assumes another live worker is gone because this process restarted.
 * An arena left mid-provision or ready on a run that is no longer active is
 * reported as needing cleanup, not revived.
 */
function reconcile(run) {
  if (!run) return { action: 'none' };
  const stale = [STATUS.provisioning, STATUS.ready, STATUS.unhealthy, STATUS.stopping, STATUS.stopped];
  if (stale.includes(run.arena_status) && run.cleanup_status !== 'completed') {
    return { action: 'cleanup', ref: run.arena_ref || null };
  }
  return { action: 'none' };
}

// The default boundary adapter, composed from application-runtime. A `provision`
// effect (fresh DB + target deploy) is the remaining release wiring and is
// supplied by the caller; health/stop/destroy reuse the boundary directly.
function buildRuntimeAdapter(appRuntime, config, { provision: provisionTarget } = {}) {
  return {
    provision: provisionTarget,
    origin: (ref) => appRuntime.appOrigin(config, ref),
    health: (ref) => appRuntime.probeHealth(config, ref),
    stop: (ref) => appRuntime.remove(config, ref),
    destroy: ({ runtimeRef }) => (runtimeRef ? appRuntime.remove(config, runtimeRef, { deleteBuilds: true }) : undefined),
  };
}

module.exports = {
  ArenaError, STATUS, arenaRef, generateArenaSecrets, buildSyntheticFixtures,
  setStatus, provision, health, stop, destroy, reconcile, buildRuntimeAdapter,
};
