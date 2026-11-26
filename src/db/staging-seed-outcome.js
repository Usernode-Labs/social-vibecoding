'use strict';

// What a staging seed (src/db/migrate.js) actually did.
//
// A seed used to fail quietly: it caught its own error and logged a warning,
// or returned early when a project or fixture user it needs was missing, and
// nothing a screenshot run showed said so. A claim that named a row a seed
// writes then failed with "does not exist", which reads like randomised data
// (#7172).
//
// Every seed now runs through `runSeedWithOutcome`, which returns
// `{ name, outcome, reason }`:
//
//   wrote    it changed at least one row
//   nothing  it changed no rows and gave no reason
//   skipped  it called `seedSkipped('no project …')`
//   failed   a statement it ran threw, even if the seed caught it
//
// Row changes are counted on INSERT/UPDATE/DELETE statements, on both
// `pool.query` and the client `pool.connect()` hands a seed. The seed's own
// context (whether it skipped, and a statement that failed) travels in an
// AsyncLocalStorage, so `seedSkipped` needs no argument threaded through the
// 170 seed entries.

const { AsyncLocalStorage } = require('node:async_hooks');

const REASON_MAX = 200;
const storage = new AsyncLocalStorage();

function clipReason(reason) {
  return String(reason || '').trim().slice(0, REASON_MAX) || 'a precondition is missing';
}

/**
 * Called by a seed that cannot write because something it needs is missing:
 * `return seedSkipped('no project staging-demo-pin-1')`. A no-op outside the
 * outcome runner.
 */
function seedSkipped(reason) {
  const state = storage.getStore();
  if (state && !state.skipped) state.skipped = clipReason(reason);
  return undefined;
}

// GitHub's write statements (the only ones whose row count matters), on the
// text form a seed always passes. A parameterised object form is counted by
// the driver's own `rowCount` when it carries a text.
function changesRows(text) {
  return typeof text === 'string' && /\b(?:INSERT|UPDATE|DELETE)\b/i.test(text);
}

function countResult(state, text, result) {
  if (!changesRows(text)) return;
  state.changed += Number(result?.rowCount) || 0;
}

function wrapQuery(run, state) {
  return async (text, params) => {
    try {
      const result = await run(text, params);
      countResult(state, typeof text === 'string' ? text : text?.text, result);
      return result;
    } catch (error) {
      state.failure = state.failure || error;
      throw error;
    }
  };
}

function wrappingPool(pool, state) {
  const query = wrapQuery((text, params) => pool.query(text, params), state);
  const connect = typeof pool.connect === 'function'
    ? async () => {
      const client = await pool.connect();
      return {
        query: wrapQuery((text, params) => client.query(text, params), state),
        release: (...args) => client.release?.(...args),
      };
    }
    : null;
  return {
    query,
    ...(connect ? { connect } : {}),
  };
}

function outcomeOf(name, state) {
  if (state.failure) {
    return { name, outcome: 'failed', reason: clipReason(state.failure.message || state.failure) };
  }
  if (state.skipped) return { name, outcome: 'skipped', reason: state.skipped };
  if (state.changed === 0) return { name, outcome: 'nothing', reason: 'changed no rows' };
  return { name, outcome: 'wrote', reason: null };
}

/**
 * Run one staging seed `entry` ({ name, run }) against `pool`, and say what
 * it did. Never throws: a seed's failure is its outcome (`failed`, with the
 * error's message), so the boot and the before-copy runner both carry on.
 */
async function runSeedWithOutcome(entry, pool, config, { onError = null } = {}) {
  const state = { changed: 0, failure: null, skipped: null };
  try {
    await storage.run(state, () => entry.run(wrappingPool(pool, state), config));
  } catch (error) {
    state.failure = state.failure || error;
  }
  if (state.failure) onError?.(state.failure);
  return outcomeOf(entry.name, state);
}

module.exports = { runSeedWithOutcome, seedSkipped, REASON_MAX };
