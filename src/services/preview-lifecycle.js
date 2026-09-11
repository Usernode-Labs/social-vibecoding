'use strict';

const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { getPool } = require('../db/pool');
const { withResourceUse } = require('./build-retention-guard');
const { PREVIEW_LIFECYCLE_LOCK } = require('./advisory-locks');
const log = require('./logger');

function createLifecycle({ poolFor = getPool, lock = withResourceUse, checks = () => require('./kubernetes'), pollMs = 500 } = {}) {
  const context = new AsyncLocalStorage();
  const active = new Map();
  const CANCELLED = 'PREVIEW_SUPERSEDED';
  function enabled(config) {
    return (config?.appRuntime || process.env.APP_RUNTIME) === 'kubernetes'
      && process.env.PREVIEW_LIFECYCLE_ENABLED === 'true';
  }
  function cancelled() {
    return Object.assign(new Error('Preview run cancelled because newer changes or teardown superseded it'), { code: CANCELLED });
  }
  function isCancelled(err) { return err?.code === CANCELLED; }
  function current() { return context.getStore(); }

  // Notify before waiting for ownership: the owner must be able to terminate
  // its Jobs while the successor waits for the same cross-Pod resource lock.
  async function request(pool, sessionId, revision) {
    const result = await pool.query(`
      INSERT INTO preview_operations (session_id, desired_revision)
      SELECT id, $2::text FROM chat_sessions
        WHERE id = $1 AND status IN ('active', 'paused', 'promoted', 'merging')
          AND (checks_commit_sha IS NULL OR checks_commit_sha = $2::text)
          AND (imported_pr_head_sha IS NULL OR imported_pr_head_sha = $2::text)
      FOR UPDATE
      ON CONFLICT (session_id) DO UPDATE SET desired_revision = EXCLUDED.desired_revision,
        updated_at = NOW()
      RETURNING desired_revision, updated_at`, [sessionId, revision]);
    if (!result.rows.length) throw cancelled();
    const owner = active.get(Number(sessionId));
    if (owner && owner.revision !== revision) owner.abort();
    return result.rows[0].updated_at;
  }

  async function readSession(pool, sessionId) {
    return (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [sessionId])).rows[0];
  }

  // Each query/transaction holds a row lock while checking ownership and writing.
  // In particular, DELETE+INSERT of screenshots must be guarded as one transaction.
  function guardedPool(pool, operation) {
    async function connect() {
      const client = await pool.connect();
      let transaction = false;
      return {
        async query(sql, args) {
          const text = typeof sql === 'string' ? sql : sql.text;
          if (/^BEGIN\b/i.test(text)) {
            const result = await client.query(sql, args);
            transaction = true;
            await operation.check(client, true);
            return result;
          }
          if (/^(COMMIT|ROLLBACK)\b/i.test(text)) {
            const result = await client.query(sql, args);
            transaction = false;
            return result;
          }
          if (transaction) return client.query(sql, args);
          await client.query('BEGIN');
          try {
            await operation.check(client, true);
            const result = await client.query(sql, args);
            await client.query('COMMIT');
            return result;
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          }
        },
        release() { client.release(transaction ? new Error('Unfinished preview transaction') : undefined); },
      };
    }
    return {
      connect,
      async query(sql, args) {
        const client = await connect();
        try { return await client.query(sql, args); } finally { client.release(); }
      },
    };
  }

  async function run(config, session, revision, phase, fn, { force = false, onError = null, resolveRevision = null } = {}) {
    if (!enabled(config)) return fn(null, session);
    const inherited = current();
    if (inherited?.sessionId === Number(session.id)) return fn(inherited, session);
    const pool = poolFor(config);
    // Run transitions also take the session row lock. A detached progress
    // transaction from the old owner must finish before its run is replaced.
    const statePool = guardedPool(pool, { check: client => client.query(
      'SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE', [session.id]) });
    if (!revision || revision === 'latest') {
      const fresh = await readSession(pool, session.id);
      revision = fresh?.imported_pr_head_sha || fresh?.checks_commit_sha
        || (resolveRevision && await resolveRevision(fresh));
      if (!revision) throw new Error('A coordinated preview requires an exact revision');
    }
    const requestedAt = await request(pool, session.id, revision);
    return lock(config, PREVIEW_LIFECYCLE_LOCK, session.id, async () => {
      const fresh = await readSession(pool, session.id);
      const { rows } = await pool.query('SELECT * FROM preview_operations WHERE session_id = $1', [session.id]);
      const previous = rows[0];
      if (!fresh || previous?.desired_revision !== revision
          || (fresh.checks_commit_sha && fresh.checks_commit_sha !== revision)
          || (fresh.imported_pr_head_sha && fresh.imported_pr_head_sha !== revision)
          || !['active', 'paused', 'promoted', 'merging'].includes(fresh.status)) throw cancelled();
      // A duplicate arriving during the same phase joins its durable completion.
      if (!force && previous.phase === phase && previous.state === 'completed'
          && previous.revision === revision && new Date(previous.finished_at) >= requestedAt) return previous.result;

      // An owner can die while its Kubernetes Jobs keep running. Owning this
      // lock is necessary but insufficient until those consumers have stopped.
      await checks().cancelPreviewChecks(config, session.id);
      const controller = new AbortController();
      const operation = {
        sessionId: Number(session.id), revision, runId: randomUUID(), signal: controller.signal,
        abort(reason = cancelled()) { if (!controller.signal.aborted) controller.abort(reason); },
        async check(client = pool, lock = false, ignoreAbort = false) {
          if (!ignoreAbort) controller.signal.throwIfAborted();
          // Acquire first, then read ownership in a fresh READ COMMITTED
          // snapshot. A joined SELECT FOR UPDATE could retain an old operation
          // row snapshot while waiting for another run to release the session.
          if (lock) await client.query('SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE', [session.id]);
          if (!ignoreAbort) controller.signal.throwIfAborted();
          const { rows: state } = await client.query(`SELECT o.run_id
            FROM preview_operations o JOIN chat_sessions s ON s.id = o.session_id
            WHERE o.session_id = $1 AND o.run_id = $2 AND o.desired_revision = $3
              AND o.state = 'running'
              AND s.status IN ('active', 'paused', 'promoted', 'merging')
              AND (s.checks_commit_sha IS NULL OR s.checks_commit_sha = $3)
              AND (s.imported_pr_head_sha IS NULL OR s.imported_pr_head_sha = $3)`, [session.id, operation.runId, revision]);
          if (!state.length) { operation.abort(); throw cancelled(); }
        },
      };
      await statePool.query(`UPDATE preview_operations SET run_id = $2, revision = $3,
        phase = $4, state = 'running', result = NULL, finished_at = NULL, updated_at = NOW()
        WHERE session_id = $1 AND desired_revision = $3`, [session.id, operation.runId, revision, phase]);
      operation.pool = guardedPool(pool, operation);
      operation.cleanupPool = pool;
      operation.tasks = new Set();
      operation.track = task => {
        operation.tasks.add(task);
        task.then(() => operation.tasks.delete(task), () => operation.tasks.delete(task));
        return task;
      };
      active.set(operation.sessionId, operation);
      let polling = false;
      const timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try { await operation.check(); } catch (err) { operation.abort(err); }
        finally { polling = false; }
      }, pollMs);
      timer.unref();
      try {
        await operation.check();
        const result = await context.run(operation, () => fn(operation, { ...session, ...fresh }));
        await Promise.all([...operation.tasks]);
        await checks().cancelPreviewChecks(config, session.id);
        await operation.check();
        await operation.pool.query(`UPDATE preview_operations SET state = 'completed', result = $3,
          finished_at = NOW(), updated_at = NOW() WHERE session_id = $1 AND run_id = $2`,
        [session.id, operation.runId, result == null ? null : JSON.stringify(result)]);
        return result;
      } catch (err) {
        operation.abort(err);
        await Promise.allSettled([...operation.tasks]);
        // Confirm termination before releasing the lifecycle lock, including
        // when only one member of the concurrent capture/unit pair failed.
        await checks().cancelPreviewChecks(config, session.id);
        if (!isCancelled(err) && onError) {
          // The signal has stopped consumers. Error publication still needs a
          // current run/revision check under the session row lock; a successor
          // (including a retry of the same SHA) must never receive our error.
          const failurePool = guardedPool(pool, {
            check: (client, locked) => operation.check(client, locked, true),
          });
          try { await onError(err, failurePool, operation); }
          catch (publicationError) {
            if (!isCancelled(publicationError)) throw publicationError;
          }
        }
        await statePool.query(`UPDATE preview_operations SET state = $3, finished_at = NOW(), updated_at = NOW()
          WHERE session_id = $1 AND run_id = $2`,
        [session.id, operation.runId, isCancelled(err) ? 'superseded' : 'error']);
        log.info('preview-lifecycle', isCancelled(err) ? 'Preview run superseded' : 'Preview run failed', {
          sessionId: session.id, runId: operation.runId, revision, phase,
        });
        throw err;
      } finally {
        clearInterval(timer);
        active.delete(operation.sessionId);
      }
    });
  }

  async function teardown(config, session, fn) {
    if (!enabled(config)) return fn(session);
    const pool = poolFor(config);
    const before = (await pool.query('SELECT * FROM preview_operations WHERE session_id = $1', [session.id])).rows[0];
    const terminal = ['archived', 'merged'].includes(session.status);
    if (before?.state === 'running' && !terminal) return { removed: false, leaked: true, busy: true };
    if (terminal) active.get(Number(session.id))?.abort();
    return lock(config, PREVIEW_LIFECYCLE_LOCK, session.id, async () => {
      const fresh = await readSession(pool, session.id);
      const now = (await pool.query('SELECT * FROM preview_operations WHERE session_id = $1', [session.id])).rows[0];
      if (!fresh || (terminal && !['archived', 'merged'].includes(fresh.status))
          || (!terminal && (now?.run_id !== before?.run_id || fresh.staging_commit_sha !== session.staging_commit_sha))) {
        return { removed: false, leaked: true, busy: true };
      }
      await checks().cancelPreviewChecks(config, session.id);
      return fn({ ...session, ...fresh });
    });
  }

  return { enabled, run, request, current, guardedPool, cancelled, isCancelled, teardown };
}

module.exports = { ...createLifecycle(), createLifecycle };
