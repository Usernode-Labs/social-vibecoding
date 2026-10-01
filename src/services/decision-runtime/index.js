'use strict';

const { createHash } = require('node:crypto');
const { readSession } = require('./session');

function serializeData(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint'
        || (typeof item === 'number' && !Number.isFinite(item))) {
      throw new Error('Decision records and effects must contain only JSON data');
    }
    return item;
  });
}

function hashJson(value) {
  return createHash('sha256').update(serializeData(value)).digest('hex');
}

function freezeData(value) {
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new Error('Captured decision inputs and outputs must be plain JSON data');
    }
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

// This foundation intentionally supports one chat_session per transaction.
// Machines share its row lock; domain resource locks follow that aggregate.
// It owns no lifecycle policy, SQL patches, work queue or effect execution.
function createSessionDecisionRuntime(pool) {
  async function transact(run, { readOnly = false } = {}) {
    const client = await pool.connect();
    let aggregateId = null;
    let open = false;
    let failed = false;
    let operationFailure;

    async function operate(runOperation) {
      if (!open) throw new Error('Decision transaction is no longer open');
      if (failed) {
        throw Object.assign(new Error('Decision transaction failed and must roll back', {
          cause: operationFailure,
        }), { code: 'DECISION_TRANSACTION_FAILED' });
      }

      try {
        return await runOperation();
      } catch (error) {
        // A JavaScript failure does not abort PostgreSQL's transaction. Keep
        // it invalid even when the composition catches the operation's error.
        if (!failed) {
          failed = true;
          operationFailure = error;
        }
        throw error;
      }
    }

    function selectAggregate(sessionId) {
      if (!Number.isInteger(sessionId) || sessionId <= 0 || sessionId > 2147483647) {
        throw new Error('A session aggregate ID must be a positive PostgreSQL integer');
      }
      if (aggregateId !== null && aggregateId !== sessionId) {
        throw new Error('A decision transaction must target one session aggregate');
      }
      aggregateId = sessionId;
    }

    async function load(machine, sessionId, action, lock) {
      selectAggregate(sessionId);
      const session = await readSession(client, sessionId, { lock });
      return machine.load(client, session, { sessionId, action, lock });
    }

    async function applyValidated(machine, action) {
      if (readOnly) throw new Error('A read-only snapshot cannot accept actions');
      const state = await load(machine, action.sessionId, action, true);
      const actionHash = hashJson(action);
      const receipt = await machine.journal.findReceipt(client, action.sessionId, action.actionId);
      if (receipt) {
        if (receipt.action_hash !== actionHash) throw machine.actionConflict();
        return { decision: receipt.decision, current: state, replayed: true };
      }

      freezeData(state);
      freezeData(action);
      const facts = freezeData(await machine.facts(client, state, action));
      const decision = machine.reduce(state, action, facts);
      if (!decision || typeof decision.accepted !== 'boolean' || typeof decision.reason !== 'string'
          || !decision.reason || !Array.isArray(decision.effects)) {
        throw new Error('A reducer must synchronously return a decision with data-only effects');
      }
      freezeData(decision);
      const decisionJson = serializeData(decision);
      const traceValues = [
        action.sessionId,
        action.actionId,
        machine.version,
        serializeData(state),
        serializeData(action),
        serializeData(facts),
        decisionJson,
      ];
      if (decision.accepted) await machine.persist(client, { state, action, facts, decision });

      // Rejections receive the same receipt/trace contract. Domain writes,
      // original receipts and captured decision inputs commit or roll back as one.
      await machine.journal.saveReceipt(client, [action.sessionId, action.actionId, actionHash, decisionJson]);
      await machine.journal.saveTrace(client, traceValues);
      const current = await load(machine, action.sessionId, action, false);
      return { decision, current, replayed: false };
    }

    const transaction = {
      apply: (machine, input) => operate(() => applyValidated(machine, machine.parseAction(input))),
      read: (machine, sessionId) => operate(() => load(machine, sessionId, null, !readOnly)),
      withSession: (sessionId, map) => operate(async () => {
        if (readOnly) throw new Error('A read-only snapshot cannot map writes');
        selectAggregate(sessionId);
        const session = await readSession(client, sessionId, { lock: true });
        return map(client, session);
      }),
    };
    try {
      if (readOnly) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      else await client.query('BEGIN');
      open = true;
      const result = await run(transaction);
      if (failed) throw operationFailure;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      open = false;
      client.release();
    }
  }

  function apply(machine, input) {
    return transact(transaction => transaction.apply(machine, input));
  }

  function read(machine, sessionId) {
    return transact(transaction => transaction.read(machine, sessionId), { readOnly: true });
  }

  function trace(machine, sessionId) {
    return machine.journal.trace(pool, sessionId);
  }

  return { apply, transact, read, trace };
}

module.exports = { createSessionDecisionRuntime, hashJson };
