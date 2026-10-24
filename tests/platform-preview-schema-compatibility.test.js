'use strict';
// test:changed: when src/services/platform-preview-schema.json (temporary runtime compatibility)
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/services/platform-preview-data-policy');

function catalog() {
  return { schemas: ['public'], largeObjects: 0, sequences: [],
    relations: Object.entries(policy.policy.tables).map(([name, table]) => ({
      name, kind: 'r', rls: false, forceRls: false, inherits: false, constraints: [],
      columns: Object.fromEntries(Object.keys(table.columns).map(name => [name, ['text', false, null, '', '']])),
    })) };
}
const execute = value => async () => JSON.stringify(value);
function permitFixture(t, value) {
  const saved = [...policy.schema.temporaryRuntimeFingerprints];
  policy.schema.temporaryRuntimeFingerprints.push(policy.schemaFingerprint(value));
  t.after(() => { policy.schema.temporaryRuntimeFingerprints = saved; });
}

test('temporary compatibility applies only to runtime inspection; CI stays strict', async t => {
  const value = catalog();
  permitFixture(t, value);
  assert.throws(() => policy.verifyCatalog(value), /review schema fingerprint/);
  const result = await policy.inspect('synthetic-preview', execute(value));
  assert.equal(result.digest, policy.DIGEST);
  value.sequences.push({ name: 'public.unreviewed_sequence' });
  await assert.rejects(policy.inspect('synthetic-preview', execute(value)), { noFallback: true });
});

test('an accepted fingerprint cannot approve an unlisted retained column or unsupported relation', async t => {
  const value = catalog();
  value.relations[0].columns.private_new_field = ['text', false, null, '', ''];
  permitFixture(t, value);
  await assert.rejects(policy.inspect('synthetic-preview', execute(value)), /missing column policy/);
  delete value.relations[0].columns.private_new_field;
  value.relations[0].rls = true;
  policy.schema.temporaryRuntimeFingerprints.push(policy.schemaFingerprint(value));
  await assert.rejects(policy.inspect('synthetic-preview', execute(value)), /unsupported relation/);
});

test('temporary compatibility preserves default-empty exclusions', async t => {
  const value = catalog();
  value.relations.push({ name: 'public.private_data', kind: 'r', rls: false,
    forceRls: false, inherits: false, columns: {}, constraints: [] });
  permitFixture(t, value);
  const result = await policy.inspect('synthetic-preview', execute(value));
  assert.ok(policy.exclusions(result.catalog).includes('public.private_data'));
  assert.equal(policy.retainedTables().includes('public.private_data'), false);
});
