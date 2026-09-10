'use strict';

const { Client } = require('pg');
const crypto = require('crypto');
const { BUILD_RETENTION_LOCK } = require('./advisory-locks');
const log = require('./logger');

// One extra connection per process while any Kubernetes deployment is active,
// independent of the application pool: holding one pool client per build can
// deadlock deployments that still need that pool to persist their references.
// A database-wide shared lock also protects builds started by HTTP followers.
function createGuard({ makeClient = (config) => new Client({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5000,
  application_name: 'social-build-retention-guard',
}), onLockLost = () => process.exit(1), retryMs = 250 } = {}) {
  let current = null;
  let tail = Promise.resolve();
  const resourceTails = new Map();
  function serialize(fn) {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  }

  async function acquire(config) {
    return serialize(async () => {
      if (!current) {
        const state = { client: makeClient(config), users: 0, closing: false, lost: null };
        const lost = (err) => {
          if (state.closing || state.lost) return;
          state.lost = err || new Error('Build retention lock connection ended');
          // Like leader election, a lost session lock invalidates our right
          // to continue. Restart rather than deploy using an unprotected Build.
          if (state.users) {
            log.error('build-retention', 'Deployment lock lost; restarting', { err: state.lost.message });
            onLockLost();
          }
        };
        state.client.on('error', lost);
        state.client.on('end', () => lost());
        try {
          await state.client.connect();
          await state.client.query('SELECT pg_advisory_lock_shared($1, $2)', [BUILD_RETENTION_LOCK, 0]);
          if (state.lost) throw state.lost;
          current = state;
        } catch (err) {
          state.closing = true;
          await state.client.end().catch(() => {});
          throw err;
        }
      }
      if (current.lost) throw current.lost;
      const state = current;
      state.users++;
      return () => serialize(async () => {
        if (--state.users) return;
        current = null;
        state.closing = true;
        // Closing the dedicated session releases the advisory lock, including
        // on errors. A locked client is never returned to the ordinary pool.
        await state.client.end().catch((err) => {
          log.warn('build-retention', 'Deployment lock close failed', { err: err.message });
        });
      });
    });
  }

  async function withBuildUse(config, fn) {
    if ((config?.appRuntime || process.env.APP_RUNTIME || 'docker') !== 'kubernetes') return fn();
    const release = await acquire(config);
    const state = current;
    const check = () => { if (state.lost) throw state.lost; };
    try { check(); return await fn(state.client, check); } finally { await release(); }
  }

  // Multiplex nonblocking resource locks on the retention connection. A
  // blocking pg_advisory_lock would prevent that same connection unlocking
  // another resource; a client per build would consume the database budget.
  // Local serialization is still required because session locks are reentrant.
  function withResourceUse(config, classifier, resource, fn) {
    if ((config?.appRuntime || process.env.APP_RUNTIME || 'docker') !== 'kubernetes') return fn();
    const key = crypto.createHash('sha256').update(String(resource)).digest().readInt32BE(0);
    const localKey = `${classifier}:${key}`;
    const run = (resourceTails.get(localKey) || Promise.resolve()).then(() => withBuildUse(config, async (client, check) => {
      for (;;) {
        check();
        const result = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [classifier, key]);
        check();
        if (result.rows[0]?.acquired) break;
        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
      try { check(); return await fn(); } finally {
        try {
          check();
          const result = await client.query('SELECT pg_advisory_unlock($1, $2) AS released', [classifier, key]);
          if (!result.rows[0]?.released) throw new Error('Runtime resource lock was not held');
        } catch (err) {
          // Do not reuse a connection with uncertain lock ownership.
          if (!current?.lost) {
            current.lost = err;
            onLockLost();
          }
          throw err;
        }
      }
    }));
    const settled = run.then(() => {}, () => {});
    resourceTails.set(localKey, settled);
    settled.then(() => { if (resourceTails.get(localKey) === settled) resourceTails.delete(localKey); });
    return run;
  }
  return { withBuildUse, withResourceUse };
}

module.exports = { ...createGuard(), createGuard };
