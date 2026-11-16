'use strict';

// A coding record nothing carries, as the turn machine's work item
// (src/workflow/turn/): a `recover` turn on its change, run whole, in
// whichever workflow process claims it.
//
// Every coding run belongs to the work that dispatched it (a build, a sync,
// a shots run, the Homeroom bot's reads and fixes), which carries it on
// when its process goes. What is left is a record whose work settled without
// letting it go: the turn-leftovers clock (services/turn-leftovers.js) asks
// a `recover` turn for it, which takes it through the adoption
// (services/turn-recovery.js).

const log = require('./logger');
const turnLifecycle = require('./turn-lifecycle');

// A coding run's recovery that could not read what it needs (the worker's
// state, who holds the session) throws `retryWorkerRecovery`: tried again
// here, this often and this many times, before the turn gives up on it.
const RECOVERY_RETRY = { ms: 10 * 1000, tries: 30 };

function pause(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function recoverChange(ctx, { config, pool }, sessionId) {
  for (let tried = 1; ; tried += 1) {
    try {
      return await require('./turn-recovery').recoverTurn({ config, pool, sessionId });
    } catch (err) {
      if (err && err.retryWorkerRecovery && tried >= RECOVERY_RETRY.tries) {
        require('./recovery-retry').recordGaveUp({ pool, key: `interactive:${Number(sessionId)}`, err, failures: tried });
      }
      if (!err || !err.retryWorkerRecovery || tried >= RECOVERY_RETRY.tries || ctx.signal?.aborted) throw err;
      log.warn('turns', 'A coding run\'s recovery will be tried again', { sessionId, tried, err: err.message });
      await pause(RECOVERY_RETRY.ms, ctx.signal);
      if (ctx.signal?.aborted) throw err;
    }
  }
}

// A coding run's record no work item holds (its item settled without
// releasing it): the adoption (a turn this process still follows is left
// alone there), tried again while it cannot read what it needs.
async function runRecover(ctx, { config, pool }, input) {
  const sessionId = Number(input.sessionId);
  try {
    await recoverChange(ctx, { config, pool }, sessionId);
  } catch (err) {
    if (!input.last || ctx.signal?.aborted) throw err;
    log.warn('turns', 'A record nothing carries could not be recovered on its last ask', { sessionId, err: err.message });
  }
  if (!input.last) return { ended: 'recovered' };
  // The last ask (turn-leftovers.js RECORD_RETRY): a record still there,
  // the same one, is ended as a forced Stop ends one nobody runs.
  const { rows: [left] } = await pool.query(
    `SELECT 1 FROM chat_sessions WHERE id = $1 AND active_turn IS NOT NULL
        AND COALESCE(active_turn->>'turnId', active_turn->>'logicalTurnId', active_turn->>'turnUuid', 'record') = $2`,
    [sessionId, String(input.identity)]);
  if (!left) return { ended: 'recovered' };
  log.error('turns', 'Ending a turn record no recovery could take to its end', { sessionId, identity: input.identity });
  const { stopTarget, snapshot } = require('../workflow/worker-stop/target.ts');
  const target = await stopTarget(pool, sessionId, null);
  if (!target || String(turnLifecycle.turnIdentity(target.turn) || 'record') !== String(input.identity)) return { ended: 'recovered' };
  await require('./worker-force-stop').run(pool, {
    ...snapshot(target), requestId: `recover:${ctx.workId}`, expiresAt: Date.now() + 30_000,
  }, { renew: () => ctx.checkpoint(ctx.resumeFrom ?? null), signal: ctx.signal });
  return { ended: 'ended' };
}

// A turn's item that loses its lease while this process runs on (the
// database out of reach for most of a lease, or this process stalled): the
// next claim carries the turn on from its record, and nothing here can stop
// the run part way (its coding run's journal is followed to its end), so two
// would follow one turn. Unless the item was settled (a cancel: nothing runs
// it again) or this process is stopping (its runtime's stop, or a shutdown:
// it exits by itself), this process
// ends here, as one that died would; the platform restarts it. A database it
// cannot read counts as not settled.
const LOST_LEASE = { exit: (code) => process.exit(code) };

function endOnLostLease(ctx, pool) {
  const signal = ctx.signal;
  if (!signal || signal.aborted) return () => {};
  let running = true;
  const onAbort = () => {
    if (signal.reason && signal.reason.stopping === true) return;
    void (async () => {
      if (require('./lifecycle').isShuttingDown()) return;
      let settled = false;
      try {
        const { rows: [w] } = await pool.query('SELECT status FROM wf_work WHERE id = $1', [ctx.workId]);
        settled = !!w && w.status === 'settled';
      } catch { /* out of reach: not known to be settled */ }
      if (settled || !running) return;
      log.error('turns', 'A turn lost its work item\'s lease while it ran here; ending this process so the next claim carries it on alone', {
        workId: ctx.workId, kind: ctx.input?.kind || null, instance: ctx.input?.instanceKey || null,
      });
      LOST_LEASE.exit(1);
    })();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { running = false; signal.removeEventListener('abort', onAbort); };
}

/** The turn machine's `turn.run` handler (src/workflow/turn/services.ts). */
async function run(ctx, deps) {
  const input = ctx.input || {};
  if (input.kind !== 'recover') throw Object.assign(new Error(`not a turn kind: ${input.kind}`), { permanent: true });
  const settledHere = endOnLostLease(ctx, deps.pool);
  try {
    return await runRecover(ctx, deps, input);
  } finally {
    settledHere();
  }
}

module.exports = { run, RECOVERY_RETRY, LOST_LEASE };
