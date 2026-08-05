// Shared Topochain delegation state-machine tests.
//
// Run with: node --test tests/topochain-delegations.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setDelegationState } = require('../src/services/topochain/delegations');

const LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const ROW_SQL = 'SELECT id, started_at, ended_at FROM account_delegation_periods WHERE account = $1 FOR UPDATE';

test('setDelegationState takes the account transaction lock before reading state', async () => {
  const calls = [];
  const startedAt = new Date('2026-08-05T00:00:00.000Z');
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === LOCK_SQL) return { rows: [{ pg_advisory_xact_lock: null }] };
      if (sql === ROW_SQL) return { rows: [{ id: 7, started_at: startedAt, ended_at: null }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await setDelegationState(client, 'ut1account', true);

  assert.deepEqual(result, { delegated: true, changed: false, delegatedSince: startedAt });
  assert.deepEqual(calls, [
    { sql: LOCK_SQL, params: ['ut1account'] },
    { sql: ROW_SQL, params: ['ut1account'] },
  ]);
});

test('concurrent first-time enables serialize into one insert and one idempotent no-op', async () => {
  const account = 'ut1firstdelegation';
  const rows = new Map();
  let nextId = 1;
  let inserts = 0;
  let lockOwner = null;
  const waiters = [];

  function makeClient(name) {
    let ownsLock = false;
    return {
      async query(rawSql, params = []) {
        const sql = rawSql.replace(/\s+/g, ' ').trim();
        if (sql === LOCK_SQL) {
          if (lockOwner === null) {
            lockOwner = name;
            ownsLock = true;
          } else {
            await new Promise((resolve) => waiters.push(resolve));
            lockOwner = name;
            ownsLock = true;
          }
          return { rows: [{ pg_advisory_xact_lock: null }] };
        }
        if (sql === ROW_SQL) {
          assert.equal(ownsLock, true, 'state read must hold the account lock');
          const row = rows.get(params[0]);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (sql.startsWith('INSERT INTO account_delegation_periods')) {
          assert.equal(ownsLock, true, 'insert must hold the account lock');
          if (rows.has(params[0])) throw new Error('duplicate account insert');
          const startedAt = new Date('2026-08-05T00:00:00.000Z');
          rows.set(params[0], { id: nextId++, started_at: startedAt, ended_at: null });
          inserts += 1;
          return { rows: [{ started_at: startedAt }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      releaseTransaction() {
        assert.equal(ownsLock, true);
        ownsLock = false;
        lockOwner = null;
        const next = waiters.shift();
        if (next) next();
      },
    };
  }

  async function enable(client) {
    const result = await setDelegationState(client, account, true);
    client.releaseTransaction();
    return result;
  }

  const firstClient = makeClient('first');
  const secondClient = makeClient('second');
  const [first, second] = await Promise.all([enable(firstClient), enable(secondClient)]);

  assert.equal(inserts, 1);
  assert.equal(rows.size, 1);
  assert.deepEqual([first.changed, second.changed].sort(), [false, true]);
  assert.equal(first.delegated, true);
  assert.equal(second.delegated, true);
  assert.equal(first.delegatedSince.getTime(), second.delegatedSince.getTime());
});
