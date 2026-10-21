'use strict';

// A change's worker evicted once nothing has used it for a while (the
// worker-eviction clock, src/workflow/clock/services.ts): read from
// session_workers, which every process writes as it ensures a worker or
// runs something in it (worker.js noteWorkerUsed), and never from a
// process's own registry. Before, each process evicted the workers its own
// registry kept warm, a worker kept warm by two was left to the last one, and
// a worker a process left behind was the leader's to adopt.
//
// A pass:
//   1. every running worker has its row (one an older release started, or
//      whose process went before it wrote one): counted as used now, so it is
//      evicted only after a full idle window from here;
//   2. a worker whose change is gone is destroyed;
//   3. a worker idle past the window, whose change nothing works on
//      (session-work.ts workedOnSql: a turn, a local agent's, a shots run, a
//      durable build, a sync, the bot's look, a recorded operation), is
//      evicted, under its session's WORKER_EVICTION_LOCK: its row is deleted
//      only if nobody used it since it was read (its time compared whole, as
//      text: a JavaScript Date drops the microseconds) and nothing works on
//      it still, and the eviction follows. A turn's ensureWorker notes its
//      use under the same lock (noteUsed): one that comes during an
//      eviction waits for it and then ensures the worker again; one that
//      comes before the claim makes the claim miss.

const log = require('./logger');
const { workedOnSql } = require('../workflow/session-work.ts');
const { withSessionLock } = require('../db/session-locks');
const { WORKER_EVICTION_LOCK } = require('./advisory-locks');

// How long a worker may sit unused (WORKER_IDLE_EVICTION_MS, default ten
// minutes).
const IDLE_MS = (() => {
  const v = parseInt(process.env.WORKER_IDLE_EVICTION_MS || String(10 * 60 * 1000), 10);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
})();

async function sweep(pool, { idleMs = IDLE_MS, deps = {} } = {}) {
  const worker = deps.worker || require('./worker');
  const running = (await worker.listOrphanWorkers())
    .filter((w) => Number.isInteger(Number(w.sessionId)) && Number(w.sessionId) > 0 && w.state === 'running');
  const listed = running.map((w) => Number(w.sessionId));
  const nameOf = new Map(running.map((w) => [Number(w.sessionId), w.name]));
  let destroyed = 0;
  if (listed.length) {
    const { rows: known } = await pool.query('SELECT id FROM chat_sessions WHERE id = ANY($1::int[])', [listed]);
    const live = new Set(known.map((r) => Number(r.id)));
    await pool.query(
      `INSERT INTO session_workers (session_id) SELECT unnest($1::int[]) ON CONFLICT (session_id) DO NOTHING`,
      [[...live]]);
    for (const id of listed) {
      if (live.has(id)) continue;
      try {
        await worker.destroyWorker(nameOf.get(id) || worker.workerContainerName(id));
        destroyed += 1;
        log.info('worker-eviction', 'A worker whose change is gone was destroyed', { sessionId: id });
      } catch (err) {
        log.warn('worker-eviction', 'Could not destroy a worker whose change is gone', { sessionId: id, err: err.message });
      }
    }
  }
  const { rows: idle } = await pool.query(
    `SELECT sw.session_id, sw.last_used_at::text AS last_used_at FROM session_workers sw JOIN chat_sessions cs ON cs.id = sw.session_id
      WHERE sw.last_used_at < NOW() - make_interval(secs => $1) AND NOT ${workedOnSql()}
      ORDER BY sw.last_used_at LIMIT 200`, [Math.round(idleMs / 1000)]);
  let evicted = 0;
  for (const r of idle) {
    try {
      const done = await withSessionLock(pool, [WORKER_EVICTION_LOCK, Number(r.session_id)], async () => {
        const { rows: [claimed] } = await pool.query(
          `DELETE FROM session_workers sw USING chat_sessions cs
            WHERE sw.session_id = $1 AND cs.id = sw.session_id AND sw.last_used_at = $2::timestamptz AND NOT ${workedOnSql()}
            RETURNING sw.session_id`, [r.session_id, r.last_used_at]);
        if (!claimed) return false;
        await worker.evictWorker(Number(r.session_id));
        return true;
      });
      if (!done) continue;
      evicted += 1;
      log.info('worker-eviction', 'Idle worker evicted', { sessionId: r.session_id, lastUsedAt: r.last_used_at });
    } catch (err) {
      log.warn('worker-eviction', 'Idle eviction failed', { sessionId: r.session_id, err: err.message });
    }
  }
  return { evicted, destroyed };
}

// A worker about to be used (worker.js ensureWorker), noted as used under
// its session's lock: an eviction under way is waited for, and one about to
// claim it finds it used. A lock that cannot be asked for notes it anyway.
async function noteUsed(pool, sessionId) {
  return withSessionLock(pool, [WORKER_EVICTION_LOCK, Number(sessionId)], () => pool.query(
    `INSERT INTO session_workers (session_id, last_used_at) SELECT id, NOW() FROM chat_sessions WHERE id = $1
     ON CONFLICT (session_id) DO UPDATE SET last_used_at = NOW()`, [Number(sessionId)]), { unlockedOnError: true });
}

module.exports = { sweep, noteUsed, IDLE_MS };
