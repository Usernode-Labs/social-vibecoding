'use strict';

const { withSessionLock } = require('../db/session-locks');
const { WORKER_EVICTION_LOCK } = require('./advisory-locks');
const { eligible } = require('../workflow/worker-memory-copy/target.ts');
const { memoryCopyingSql } = require('../workflow/session-work.ts');

async function assertNotCopying(pool, sessionId) {
  const { rows } = await pool.query(`SELECT 1 WHERE ${memoryCopyingSql('$1::int')}`, [Number(sessionId)]);
  if (rows.length) throw Object.assign(new Error('Session memory is still being copied or cleaned up. Retry once it finishes.'),
    { code: 'memory_copy_pending', userMessage: 'Session memory is still being copied or cleaned up. Retry once it finishes.' });
}

async function perform(pool, { target, action }, { renew, signal }) {
  const role = require('./process-role');
  if (!role.runsWorkflow(role.processRole())) throw new Error('Worker memory copying requires a workflow process');
  const worker = require('./worker'); let lost = false;
  const checkpoint = async () => {
    if (lost || signal.aborted) throw new Error('Memory copy lost its claim or session lock');
    await renew();
    if (lost || signal.aborted) throw new Error('Memory copy lost its claim or session lock');
  };
  const ids = [target.sourceId, target.sessionId].sort((a, b) => a - b);
  return withSessionLock(pool, [WORKER_EVICTION_LOCK, ids[0]], () =>
    withSessionLock(pool, [WORKER_EVICTION_LOCK, ids[1]], async () => {
      await checkpoint();
      if (action === 'cleanup') {
        await worker.cleanupCcVolumeClone(target.sourceId, target.sessionId, { requestId: target.requestId, renew: checkpoint });
        await checkpoint(); return { cleaned: true };
      }
      if (action !== 'copy') throw new Error('Unknown memory-copy action');
      const proceed = async () => {
        await checkpoint();
        return Date.now() < target.expiresAt && await eligible(pool, target);
      };
      if (!(await proceed())) return { copied: false };
      await worker.cloneCcVolume(target.sourceId, target.sessionId, {
        requestId: target.requestId, renew: checkpoint, proceed, signal,
        timeoutMs: Math.max(1, target.expiresAt - Date.now()),
      });
      return { copied: await proceed() };
    }, { onLost: () => { lost = true; } }), { onLost: () => { lost = true; } });
}

module.exports = { assertNotCopying, perform };
