'use strict';

// Kubernetes worker state volumes: one PersistentVolumeClaim per change,
// mounted at the coding agent's ~/.claude so `--resume` survives worker
// eviction. The worker namespace's ResourceQuota caps how many can exist, and
// a change whose volume cannot be claimed never gets a coding agent.
//
// Losing a volume costs the next run its conversation memory and nothing
// else: a stale `--resume` falls back to the full prompt, and an unarchived
// change already starts fresh once `cc_purged` is set.
//
// Two callers:
//   - 'pressure' (ensureWorker, when the quota refuses a new claim): frees a
//     few volumes, merged changes' first, then archived changes', then the
//     open changes that have been idle longest.
//   - 'closed' (the hourly GC sweep): frees only merged changes' volumes. The
//     merge deletes its volume, but a later worker start (a visual-evidence
//     run, for one) could claim a new one.
//
// A volume is never taken while a worker Deployment mounts it or its change
// is busy, and never for a change the database does not know: the namespace
// may hold another deployment's workers.

const log = require('./logger');

const PRESSURE_BATCH = 3;
const OPEN_IDLE_MS = 60 * 60 * 1000;
const PRESSURE_ORDER = ['merged', 'archived', 'paused', 'promoted', 'active'];
const OPEN_STATUSES = new Set(['paused', 'promoted', 'active']);

function defaults(deps = {}) {
  return {
    worker: deps.worker || require('./worker'),
    activeWorkers: deps.activeWorkers || require('./active-workers'),
    now: deps.now || Date.now,
  };
}

function millis(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

// The time a change was last wanted: when it closed, or its last activity.
function lastWanted(row) {
  if (row.status === 'merged') return millis(row.merged_at) || millis(row.last_activity_at);
  if (row.status === 'archived') return millis(row.archived_at) || millis(row.last_activity_at);
  return millis(row.last_activity_at);
}

function pickVolumes(volumes, rows, { mode, excludeSessionId, limit, now, isBusy }) {
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const order = mode === 'closed' ? ['merged'] : PRESSURE_ORDER;
  const candidates = [];
  for (const volume of volumes) {
    if (volume.attached || volume.terminating || volume.sessionId === excludeSessionId) continue;
    const row = byId.get(volume.sessionId);
    if (!row) continue;
    const rank = order.indexOf(row.status);
    if (rank === -1 || isBusy(volume.sessionId)) continue;
    const wanted = lastWanted(row);
    if (OPEN_STATUSES.has(row.status) && now - wanted < OPEN_IDLE_MS) continue;
    candidates.push({ sessionId: volume.sessionId, name: volume.name, status: row.status, rank, wanted });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.wanted - b.wanted || a.sessionId - b.sessionId);
  return candidates.slice(0, limit);
}

// Resolves the volumes it deleted, as { sessionId, name, status }.
async function reclaimWorkerVolumes({
  pool, mode = 'pressure', excludeSessionId = null, limit = PRESSURE_BATCH, deps = {},
}) {
  const d = defaults(deps);
  const volumes = await d.worker.listWorkerVolumes();
  const exclude = excludeSessionId == null ? null : Number(excludeSessionId);
  const ids = [...new Set(volumes.map((volume) => volume.sessionId))].filter((id) => id !== exclude);
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT id, status, merged_at, archived_at, last_activity_at
       FROM chat_sessions WHERE id = ANY($1::int[])`,
    [ids]
  );
  const picked = pickVolumes(volumes, rows, {
    mode, excludeSessionId: exclude, limit, now: d.now(),
    isBusy: (id) => d.activeWorkers.isSessionBusy(id),
  });
  const freed = [];
  for (const pick of picked) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await d.worker.destroyCcVolume(pick.sessionId);
      if (pick.status === 'merged' || pick.status === 'archived') {
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE chat_sessions SET cc_purged = TRUE WHERE id = $1', [pick.sessionId]);
      }
      freed.push({ sessionId: pick.sessionId, name: pick.name, status: pick.status });
    } catch (err) {
      log.warn('worker-volumes', 'Could not free a worker volume', {
        sessionId: pick.sessionId, status: pick.status, err: err.message,
      });
    }
  }
  if (freed.length || mode === 'pressure') {
    log.info('worker-volumes', 'Worker volumes reclaimed', {
      mode, forSessionId: exclude, volumes: volumes.length,
      freed: freed.map((item) => `${item.sessionId}:${item.status}`),
    });
  }
  return freed;
}

module.exports = {
  PRESSURE_BATCH,
  OPEN_IDLE_MS,
  pickVolumes,
  reclaimWorkerVolumes,
};
