'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const io = require('../src/services/media-transaction-io');
const media = require('../src/services/media-store');
const { deferred } = require('./lib/wait-for');

test('storage wait keeps its transaction active without overlapping heartbeat queries', async () => {
  const tx = new EventEmitter();
  const queried = deferred(), queryDone = deferred(), remote = deferred();
  let calls = 0;
  tx.query = () => { calls++; queried.resolve(); return queryDone.promise; };
  let settled = false;
  const work = io.run(tx, () => remote.promise, { heartbeatMs: 5, timeoutMs: 2000 }).then(() => { settled = true; });
  await queried.promise;
  remote.resolve();
  await Promise.resolve();
  assert.equal(settled, false, 'the transaction cannot be returned while its heartbeat is running');
  assert.equal(calls, 1);
  queryDone.resolve();
  await work;
  assert.equal(tx.listenerCount('error'), 0);
});

test('a client lost during storage work rejects the operation and handles its later socket error', async () => {
  const tx = new EventEmitter(); tx.query = async () => {};
  const entered = deferred();
  const work = io.run(tx, async () => { entered.resolve(); await new Promise(() => {}); });
  const error = Object.assign(new Error('connection lost'), { code: '25P03' });
  const rejected = assert.rejects(work, (err) => err === error);
  await entered.promise;
  tx.emit('error', error);
  await rejected;
  assert.doesNotThrow(() => tx.emit('error', new Error('socket ended')));
  tx.emit('end');
  assert.equal(tx.listenerCount('error'), 0);
});

test('a failed heartbeat cannot turn a finished upload into a successful operation', async () => {
  const tx = new EventEmitter(), entered = deferred(), heartbeat = deferred(), upload = deferred();
  tx.query = () => { entered.resolve(); return heartbeat.promise; };
  const error = new Error('heartbeat failed');
  const work = io.run(tx, () => upload.promise, { heartbeatMs: 5 });
  const rejected = assert.rejects(work, (err) => err === error);
  await entered.promise;
  upload.resolve();
  heartbeat.reject(error);
  await rejected;
  tx.emit('end');
});

test('a completed or failed operation removes listeners and timers', async () => {
  for (const fail of [false, true]) {
    const tx = new EventEmitter(); let queries = 0;
    tx.query = async () => { queries++; };
    if (fail) await assert.rejects(io.run(tx, () => { throw new Error('storage refused'); }), /storage refused/);
    else assert.equal(await io.run(tx, () => 'key'), 'key');
    assert.equal(tx.listenerCount('error'), 0);
    assert.equal(queries, 0);
  }
});

for (const method of ['statObject', 'putObject']) {
  test(`the deadline aborts the actual MinIO ${method} request`, async (t) => {
    const entered = deferred(), closed = deferred();
    const server = http.createServer((req, res) => {
      if (req.method === 'HEAD' || req.method === 'PUT') {
        req.resume(); res.on('close', () => closed.resolve()); entered.resolve();
        return; // A storage peer that accepted the request but never replies.
      }
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const store = media.createMediaStore({ mediaStorageEndpoint: `http://127.0.0.1:${server.address().port}`,
      mediaStorageBucket: 'media-test', mediaStorageAccessKey: 'test-access', mediaStorageSecretKey: 'test-secret' });
    const tx = new EventEmitter(); tx.query = async () => {};
    const work = io.run(tx, () => method === 'putObject'
      ? store.putObject('key', Buffer.from('original'), 'image/png') : store.statObject('key'),
    { heartbeatMs: 20, timeoutMs: 500 });
    const rejected = assert.rejects(work, { code: 'media_storage_timeout' });
    await entered.promise;
    await rejected;
    await closed.promise;
    assert.equal(tx.listenerCount('error'), 0);
  });
}
