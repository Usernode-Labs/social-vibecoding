'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const budget = require('../src/services/worker-git-budget');
const processRunner = require('../src/services/worker-git-process');
const { createQueue, MAX_QUEUED } = require('../src/services/worker-git-queue');
const pusher = require('../src/services/worker-git-push');

const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C' };
const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

function objectHeader(type, size) {
  const bytes = [(type << 4) | (size & 15) | (size > 15 ? 128 : 0)];
  size = Math.floor(size / 16);
  while (size) { bytes.push((size & 127) | (size > 127 ? 128 : 0)); size = Math.floor(size / 128); }
  return Buffer.from(bytes);
}
function entry(type, data, base = Buffer.alloc(0)) {
  return Buffer.concat([objectHeader(type, data.length), base, zlib.deflateSync(data)]);
}
function pack(entries) {
  const header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
}
function varint(n) {
  const out = [];
  do { out.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while (n);
  return Buffer.from(out);
}

test('pack budget accepts normal objects and bounded offset/reference deltas', async () => {
  const base = entry(3, Buffer.from('0123456789'));
  const delta = Buffer.from([10, 11, 0x90, 10, 1, 120]);
  await budget.validatePackBudget(pack([base, entry(6, delta, Buffer.from([base.length]))]));
  await budget.validatePackBudget(pack([entry(7, delta, Buffer.alloc(20))]));
  await budget.validatePackBudget(pack([entry(3, Buffer.alloc(0))]));
});

test('pack budget rejects oversized declared objects before inflation', async () => {
  const encoded = pack([objectHeader(3, budget.MAX_OBJECT_BYTES + 1)]);
  await assert.rejects(budget.validatePackBudget(encoded), /decoded object budget/);
});

test('pack budget bounds actual inflation even when an object lies about its size', async () => {
  const encoded = pack([Buffer.concat([objectHeader(3, 1), zlib.deflateSync(Buffer.alloc(65536))])]);
  await assert.rejects(budget.validatePackBudget(encoded), /Invalid worker Git pack/);
});

test('pack budget counts all objects, including unreachable objects, toward the total', async () => {
  const data = Buffer.alloc(budget.MAX_OBJECT_BYTES);
  const entries = [];
  for (let i = 0; i < 5; i++) { data[data.length - 1] = i; entries.push(entry(3, data)); }
  await assert.rejects(budget.validatePackBudget(pack(entries)), /decoded object budget/);
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(budget.MAX_OBJECTS + 1, 8);
  await assert.rejects(budget.validatePackBudget(Buffer.concat([header, Buffer.alloc(20)])), /decoded object budget/);
});

test('tiny delta instructions cannot name an oversized base or result', async () => {
  for (const sizes of [[budget.MAX_OBJECT_BYTES + 1, 1], [1, budget.MAX_OBJECT_BYTES + 1]]) {
    const delta = Buffer.concat(sizes.map(varint));
    await assert.rejects(budget.validatePackBudget(pack([entry(7, delta, Buffer.alloc(20))])), /decoded object budget/);
  }
  const delta = Buffer.concat([varint(1), varint(budget.MAX_OBJECT_BYTES)]);
  const entries = Array.from({ length: 5 }, () => entry(7, delta, Buffer.alloc(20)));
  await assert.rejects(budget.validatePackBudget(pack(entries)), /decoded object budget/);
});

test('a valid highly compressed oversized blob is refused before any trusted Git process starts', async t => {
  const branchName = 'dev/resource-test';
  const hash = (type, data) => crypto.createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  const tree = Buffer.alloc(0);
  const commit = Buffer.from(`tree ${hash('tree', tree)}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nSafe root\n`);
  const sha = hash('commit', commit);
  const bytes = pack([entry(2, tree), entry(1, commit), entry(3, Buffer.alloc(budget.MAX_OBJECT_BYTES + 1))]);
  assert.ok(bytes.length < 32768, 'small compressed input must not bypass the decoded budget');
  const bundle = Buffer.concat([Buffer.from(`# v2 git bundle\n${sha} refs/heads/${branchName}\n\n`), bytes]);
  const run = t.mock.method(processRunner, 'run', async () => assert.fail('must reject before Git starts'));
  await assert.rejects(pusher.push({
    remoteUrl: '/unused-resource-test.git', branchName, token: 'fake-resource-test-token',
    exportWorker: async () => ({ stdout: `__USERNODE_GIT_EXPORT_V1__ ${sha}\n${bundle.toString('base64')}\n` }),
  }), /decoded object budget/);
  assert.equal(run.mock.callCount(), 0);
});

test('publication queue is FIFO, bounded, and releases capacity after success or failure', async () => {
  const queue = createQueue({ maxQueued: 2 });
  const gate = deferred(), started = [];
  const a = queue.run('a', async () => { started.push('a'); await gate.promise; throw new Error('failed job'); });
  const aRejected = assert.rejects(a, /failed job/);
  const b = queue.run('b', async () => { started.push('b'); return 'done'; });
  const c = queue.run('c', async () => { started.push('c'); });
  await assert.rejects(queue.run('d', () => assert.fail('overflow must not start')), { code: 'push_busy' });
  await assert.rejects(queue.run('a', () => assert.fail('duplicate must not start')), { code: 'push_busy' });
  await flush(); assert.deepEqual(started, ['a']);
  gate.resolve(); await aRejected; assert.equal(await b, 'done'); await c;
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(await queue.run('a', async () => 1), 1);
});

test('queued jobs expire without running and their keys/capacity can be reused', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createQueue({ maxQueued: 1, timeoutMs: 20 }), gate = deferred();
  const active = queue.run('active', () => gate.promise);
  const rejected = assert.rejects(queue.run('waiting', () => assert.fail('expired job ran')), { code: 'push_busy' });
  t.mock.timers.tick(20); await rejected;
  const next = queue.run('waiting', async () => 'replacement');
  gate.resolve(); await active; assert.equal(await next, 'replacement');
});

test('the real publication queue admits requests before worker export and rejects duplicate/overflow calls', async () => {
  const gate = deferred(); let exported = 0;
  const options = {
    remoteUrl: '/unused-queue-test.git', token: 'fake-queue-test-token',
    exportWorker: async () => { exported++; await gate.promise; throw new Error('test export stopped'); },
  };
  const active = pusher.push({ ...options, branchName: 'dev/active' });
  const pending = [active, ...Array.from({ length: MAX_QUEUED }, (_, i) => pusher.push({ ...options, branchName: `dev/queued-${i}` }))];
  const completed = Promise.allSettled(pending);
  await flush(); assert.equal(exported, 1);
  await assert.rejects(pusher.push({ ...options, branchName: 'dev/active' }), { code: 'push_busy' });
  await assert.rejects(pusher.push({ ...options, branchName: 'dev/overflow' }), { code: 'push_busy' });
  assert.equal(exported, 1, 'queued/overflow calls hold no exported bundles');
  gate.resolve();
  const results = await completed;
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(exported, MAX_QUEUED + 1);
});

test('limited process runner preserves UTF-8 stdout and stderr', async () => {
  assert.deepEqual(await processRunner.run('/bin/sh', ['-c', 'printf "café"; printf diagnostic >&2'], { env }), {
    stdout: 'café', stderr: 'diagnostic',
  });
});

test('Linux Git descendants inherit enforced hard memory/CPU limits and disabled core dumps', { skip: process.platform !== 'linux' }, async () => {
  const { stdout } = await processRunner.run('/bin/cat', ['/proc/self/limits'], { env });
  const bytes = processRunner.MEMORY_KIB * 1024;
  assert.match(stdout, new RegExp(`Max address space\\s+${bytes}\\s+${bytes}\\s+bytes`));
  assert.match(stdout, new RegExp(`Max cpu time\\s+${processRunner.CPU_SECONDS}\\s+${processRunner.CPU_SECONDS}\\s+seconds`));
  assert.match(stdout, /Max core file size\s+0\s+0\s+bytes/);
  await assert.rejects(processRunner.run('/bin/sh', ['-c', `ulimit -S -v ${processRunner.MEMORY_KIB + 1}`], { env }));
});

test('output limits terminate a noisy trusted command', async () => {
  await assert.rejects(processRunner.run('/bin/sh', ['-c', 'while :; do printf "%01024d" 0; done'], { env }), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  });
});

test('a deadline stops the complete command process group', async () => {
  let pid;
  await assert.rejects(processRunner.run('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { env, timeoutMs: 100 }), error => {
    assert.equal(error.code, 'ETIMEDOUT');
    pid = Number(error.stdout.trim());
    assert.ok(pid > 1);
    return true;
  });
  const running = () => {
    try {
      if (process.platform === 'linux') return !/^.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      return !execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().startsWith('Z');
    } catch (_) { return false; }
  };
  for (let i = 0; i < 30 && running(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(running(), false, 'helper must not outlive its queue slot');
});
