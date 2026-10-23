'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyDebugRole } = require('../src/services/debug-role-policy');
const schema = require('../src/services/debug-access-schema.json');
const { READABLE_COLUMNS } = require('../src/services/debug-access');

function fixture() {
  const state = {
    identity: { oid: '1234', rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, rolreplication: false, rolbypassrls: false },
    memberships: [], surfaces: [], defaults: [],
    columns: Object.entries(schema).map(([key, definition]) => {
      const [table, column] = key.split('.');
      return { schema: 'public', table, column, kind: 'r', ...structuredClone(definition), readable: true, writable: false };
    }),
  };
  const pool = { async query(sql) {
    if (sql.includes('FROM pg_roles WHERE')) return { rows: state.identity ? [state.identity] : [] };
    if (sql.includes('FROM pg_auth_members')) return { rows: state.memberships };
    if (sql.includes('has_column_privilege')) return { rows: state.columns };
    if (sql.includes("'schema' AS kind")) return { rows: state.surfaces };
    if (sql.includes('FROM pg_default_acl')) return { rows: state.defaults };
    throw new Error('unexpected catalog query');
  } };
  const verify = options => verifyDebugRole(pool, { role: 'fake_debug_role', readableColumns: READABLE_COLUMNS,
    requireAllColumns: true, ...options });
  return { state, verify };
}

test('debug role contract accepts the reviewed schema and denies unreviewed additions', async () => {
  const { state, verify } = fixture();
  state.columns.push({ schema: 'public', table: 'new_private_table', column: 'content', kind: 'r',
    type: 'text', checks: [], readable: false, writable: false });
  assert.equal((await verify()).columns, Object.keys(schema).length);
});

test('CHECK constraint order is independent of database collation and catalog order', async () => {
  const { state, verify } = fixture();
  let reordered = 0;
  for (const column of state.columns) {
    if (column.checks.length > 1) {
      column.checks.reverse();
      reordered++;
    }
  }
  assert.ok(reordered > 0, 'exercise columns with multiple CHECK constraints');
  assert.equal((await verify()).columns, Object.keys(schema).length);
});

test('debug role contract rejects privilege and schema drift', async t => {
  const scenarios = [
    ['role flags', state => { state.identity.rolsuper = true; }, /unsafe role attribute/],
    ['role membership', state => state.memberships.push({ role: 'synthetic_reader' }), /role membership/],
    ['PUBLIC or direct private grant', state => state.columns.push({ schema: 'public', table: 'private_table',
      column: 'content', kind: 'r', readable: true, writable: false }), /unexpected SELECT/],
    ['write authority', state => { state.columns[0].writable = true; }, /write privilege/],
    ['view substitution', state => { state.columns[0].kind = 'v'; }, /unexpected SELECT/],
    ['foreign-schema access', state => { state.columns[0].schema = 'other'; }, /unexpected SELECT/],
    ['type change', state => { state.columns[0].type = 'jsonb'; }, /review column type\/constraints/],
    ['lost enum constraint', state => { state.columns.find(c => c.table === 'wf_events' && c.column === 'result').checks = []; }, /review column type\/constraints/],
    ['missing field', state => state.columns.shift(), /missing reviewed column/],
    ['missing SELECT', state => { state.columns[0].readable = false; }, /missing SELECT/],
    ['callable privileged function', state => state.surfaces.push({ kind: 'privileged function', name: 'synthetic()' }), /privileged function authority/],
    ['default ACL expansion', state => state.defaults.push({ kind: 'r', schema: '*' }), /future object grant/],
  ];
  for (const [name, mutate, message] of scenarios) {
    await t.test(name, async () => {
      const { state, verify } = fixture();
      mutate(state);
      await assert.rejects(verify(), { code: 'DEBUG_POLICY_MISMATCH', message });
    });
  }
});

test('runtime tolerates missing columns without granting them; CI reports the drift', async () => {
  const { state, verify } = fixture();
  state.columns.shift();
  await verify({ requireAllColumns: false });
  await assert.rejects(verify(), /missing reviewed column/);
});

test('policy expansions require a reviewed schema contract and retired entries must be removed', async () => {
  const { verify } = fixture();
  await assert.rejects(verify({ readableColumns: { ...READABLE_COLUMNS, fake_table: ['id'] } }), /unreviewed column definition/);
  await assert.rejects(verify({ readableColumns: { ...READABLE_COLUMNS, users: [] } }), /retired column definition/);
});
