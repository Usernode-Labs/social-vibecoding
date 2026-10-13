'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const environment = require('../src/services/shots-environment');
const config = { appRuntime: 'kubernetes', kubernetes: { appNamespace: 'social-apps' } };
const runId = 'a'.repeat(32);
const createdAt = '2026-09-22T12:00:00Z';

function deployment(tag, side, overrides = {}) {
  const fixture = side === 'hosted-app';
  return { metadata: {
    name: fixture ? `sv-app-2147482999-homeroom-${tag}-aaaaaaaaaaaaaaaa`
      : `sv-${tag}-aaaaaaaaaaaaaaaa-${side === 'base' ? 'b' : 'h'}`,
    creationTimestamp: createdAt,
    labels: {
      'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
      'social.usernode.io/environment': fixture ? 'production' : 'staging',
      'social.usernode.io/app-id': fixture ? '2147482999' : '10',
      'social.usernode.io/session-id': '4707',
      [`social.usernode.io/${tag}-run`]: runId,
      [`social.usernode.io/${tag}-side`]: side,
      ...overrides,
    },
  } };
}

test('inventories current and legacy pairs and production-labeled hosted fixtures', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const items = ['shots', 'evidence'].flatMap((tag) => ['base', 'head', 'hosted-app'].map((side) => deployment(tag, side)));
  kubernetes._setClientsForTest({ apps: { listNamespacedDeployment: async (args) => {
    assert.equal(args.namespace, 'social-apps');
    assert.equal(args.labelSelector, 'app.kubernetes.io/managed-by=social-vibecoding-runtime');
    return { items };
  } } });
  const found = await kubernetes.listShotsRuntimes(config);
  assert.equal(found.length, 6);
  assert.ok(found.every((ref) => ref.runId === runId && ref.sessionId === 4707 && ref.createdAt === createdAt));
  const expected = ['base', 'head'].flatMap((side) => [
    environment.runtimeName(runId, side, 'kubernetes'), environment.legacyRuntimeName(runId, side, 'kubernetes'),
  ]).concat(environment.hostedFixtureRefs(config, runId).map((ref) => ref.runtimeName));
  assert.deepEqual(found.map((ref) => ref.runtimeName).sort(), expected.sort());
});

test('inventory rejects ordinary previews/apps and mismatched identities', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const preview = deployment('shots', 'base');
  preview.metadata.name = 'sv-preview-10-s4707';
  const app = deployment('shots', 'hosted-app');
  app.metadata.name = 'sv-app-10-homeroom';
  const items = [preview, app,
    deployment('shots', 'hosted-app', { 'social.usernode.io/app-id': '10' }),
    deployment('shots', 'base', { 'social.usernode.io/shots-run': 'b'.repeat(32) }),
    deployment('shots', 'base', { 'social.usernode.io/shots-run': 'a'.repeat(16) }),
    deployment('shots', 'base', { 'social.usernode.io/shots-side': 'head' }),
    deployment('shots', 'base', { 'social.usernode.io/evidence-run': 'b'.repeat(32) }),
    deployment('shots', 'base', { 'social.usernode.io/session-id': '' }),
    deployment('shots', 'base', { 'social.usernode.io/session-id': '9007199254740993' }),
    deployment('shots', 'base', { 'social.usernode.io/environment': 'production' }),
    deployment('shots', 'base', { 'app.kubernetes.io/managed-by': 'another-controller' }),
    { metadata: {} },
  ];
  kubernetes._setClientsForTest({ apps: { listNamespacedDeployment: async () => ({ items }) } });
  assert.deepEqual(await kubernetes.listShotsRuntimes(config), []);
});

test('empty inventory is harmless; API failure remains an error', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  kubernetes._setClientsForTest({ apps: { listNamespacedDeployment: async () => ({}) } });
  assert.deepEqual(await kubernetes.listShotsRuntimes(config), []);
  kubernetes._setClientsForTest({ apps: { listNamespacedDeployment: async () => { throw new Error('API unavailable'); } } });
  await assert.rejects(kubernetes.listShotsRuntimes(config), /API unavailable/);
});
