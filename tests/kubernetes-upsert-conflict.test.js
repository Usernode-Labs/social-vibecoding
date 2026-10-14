'use strict';

// Two callers writing one Kubernetes object at once (14 Oct 2026: two
// bootstraps of session 8499's worker; the read found no env Secret, the
// other bootstrap created it, and this create's 409 "already exists" failed
// the person's message). upsert reads again and replaces on a 409, a few
// times, and leaves every other error as it was.

const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

const upsert = kubernetes._upsertForTest;

function status(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function secret() {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'sv-worker-s8499-env', namespace: 'social-workers' },
    type: 'Opaque', stringData: { TOKEN: 'mine' } };
}

function fakeApi(script) {
  const calls = [];
  const api = {};
  for (const method of ['readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret']) {
    api[method] = async (args) => {
      calls.push({ method, resourceVersion: args.body?.metadata?.resourceVersion });
      const next = script[method].shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(args) : next;
    };
  }
  return { api, calls };
}

const run = (api, body) => upsert(api, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret',
  'social-workers', body);

test('a create that loses to another creator reads again and replaces what it made', async () => {
  const { api, calls } = fakeApi({
    readNamespacedSecret: [status(404, 'not found'), { metadata: { resourceVersion: '7' } }],
    createNamespacedSecret: [status(409, 'secrets "sv-worker-s8499-env" already exists')],
    replaceNamespacedSecret: [({ body }) => ({ ...body, replaced: true })],
  });
  const result = await run(api, secret());
  assert.equal(result.replaced, true);
  assert.equal(result.stringData.TOKEN, 'mine', 'this caller\'s values are written');
  assert.deepEqual(calls.map((c) => [c.method, c.resourceVersion]), [
    ['readNamespacedSecret', undefined],
    ['createNamespacedSecret', undefined],
    ['readNamespacedSecret', undefined],
    ['replaceNamespacedSecret', '7'],
  ]);
});

test('a replace that loses to another write retries with the newer resourceVersion', async () => {
  const { api, calls } = fakeApi({
    readNamespacedSecret: [{ metadata: { resourceVersion: '1' } }, { metadata: { resourceVersion: '2' } }],
    createNamespacedSecret: [],
    replaceNamespacedSecret: [status(409, 'the object has been modified'), ({ body }) => body],
  });
  const result = await run(api, secret());
  assert.equal(result.metadata.resourceVersion, '2');
  assert.deepEqual(calls.map((c) => [c.method, c.resourceVersion]),
    [['readNamespacedSecret', undefined], ['replaceNamespacedSecret', '1'], ['readNamespacedSecret', undefined], ['replaceNamespacedSecret', '2']]);
});

test('a conflict that keeps happening fails after three attempts with the 409', async () => {
  const conflict = () => status(409, 'the object has been modified');
  const { api, calls } = fakeApi({
    readNamespacedSecret: [{ metadata: { resourceVersion: '1' } }, { metadata: { resourceVersion: '2' } }, { metadata: { resourceVersion: '3' } }],
    createNamespacedSecret: [],
    replaceNamespacedSecret: [conflict(), conflict(), conflict()],
  });
  await assert.rejects(run(api, secret()), (err) => err.code === 409);
  assert.equal(calls.filter((c) => c.method === 'replaceNamespacedSecret').length, 3);
});

test('any other error is thrown at once, as before', async () => {
  for (const [where, script] of [
    ['read', { readNamespacedSecret: [status(500, 'boom')], createNamespacedSecret: [], replaceNamespacedSecret: [] }],
    ['create', { readNamespacedSecret: [status(404, 'nf')], createNamespacedSecret: [status(403, 'forbidden')], replaceNamespacedSecret: [] }],
    ['replace', { readNamespacedSecret: [{ metadata: { resourceVersion: '1' } }], createNamespacedSecret: [], replaceNamespacedSecret: [status(404, 'gone')] }],
  ]) {
    const { api, calls } = fakeApi(script);
    await assert.rejects(run(api, secret()), (err) => err.code !== 409, where);
    assert.ok(calls.length <= 2, `${where}: no retry`);
  }
});

test('a Service keeps its allocated fields on the retried replace', async () => {
  const calls = [];
  const api = {
    readNamespacedService: async () => ({ metadata: { resourceVersion: String(calls.length + 1) }, spec: { clusterIP: '10.0.0.9', clusterIPs: ['10.0.0.9'] } }),
    createNamespacedService: async () => { throw new Error('must not create'); },
    replaceNamespacedService: async ({ body }) => {
      calls.push(JSON.parse(JSON.stringify(body)));
      if (calls.length === 1) throw status(409, 'the object has been modified');
      return body;
    },
  };
  const body = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'sv-app-1', namespace: 'social-apps' }, spec: { ports: [{ port: 3000 }] } };
  const result = await upsert(api, 'readNamespacedService', 'createNamespacedService', 'replaceNamespacedService', 'social-apps', body);
  assert.equal(calls.length, 2);
  assert.equal(result.spec.clusterIP, '10.0.0.9');
  assert.deepEqual(result.spec.ports, [{ port: 3000 }]);
});
