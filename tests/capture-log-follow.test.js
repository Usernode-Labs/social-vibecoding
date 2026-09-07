'use strict';

// The kubernetes capture run FOLLOWS its pod log so per-check frames reach
// the progress observer as they are printed, instead of in the ~6s steps a
// polled re-read gives (50-100 checks at once on a fast document group).
//
//   - with a log client, the follow starts once the pod exists and the
//     polled read is not used for progress;
//   - a follow that starts after a poll skips the bytes the poll already
//     delivered (no replayed frames);
//   - without a log client (typed API clients only), the polled read stays
//     in charge — the pre-existing behaviour, still pinned by
//     tests/checks-progress-live.test.js;
//   - the follow is aborted when the run ends.
//
// Run with: node --test tests/capture-log-follow.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const kubernetes = require('../src/services/kubernetes');

const frame = (i) => `__USERNODE_TEST__ index=${i} status=pass loadStatus=200\ne30=\n__USERNODE_TEST_END__\n`;

function fakeClients({ withLogs = true, podReadyAt = 1 } = {}) {
  let reads = 0;
  let jobReads = 0;
  let aborted = 0;
  const sinks = [];
  const core = {
    createNamespacedSecret: async () => ({}),
    deleteNamespacedSecret: async () => ({}),
    listNamespacedPod: async () => (jobReads >= podReadyAt ? { items: [{ metadata: { name: 'cap-pod' } }] } : { items: [] }),
    readNamespacedPodLog: async () => { reads += 1; return frame(0) + frame(1); },
  };
  const batch = {
    createNamespacedJob: async () => ({}),
    readNamespacedJob: async () => { jobReads += 1; return jobReads >= 4 ? { status: { succeeded: 1 } } : { status: {} }; },
  };
  const logs = withLogs ? {
    log: async (_ns, pod, container, sink) => {
      assert.equal(pod, 'cap-pod'); assert.equal(container, 'capture');
      sinks.push(sink);
      return { abort() { aborted += 1; } };
    },
  } : undefined;
  return { clients: { core, batch, ...(logs ? { logs } : {}) }, sinks, counters: () => ({ reads, aborted }) };
}

const config = { kubernetes: { captureImage: 'img@sha256:abc', workerNamespace: 'w', workerServiceAccount: 'sa' } };

test('with a log client the follow delivers frames as they stream and the poll is not used for progress', async () => {
  const { clients, sinks, counters } = fakeClients();
  kubernetes._setClientsForTest(clients);
  const seen = [];
  const t = setTimeout;
  // Speed the 2s poll up.
  global.setTimeout = (fn, ms, ...rest) => t(fn, ms === 2000 ? 5 : ms, ...rest);
  try {
    const run = kubernetes.runCaptureJob(config, { sessionId: 1, env: {}, timeoutMs: 5000, onStdoutLine: (l) => seen.push(l) });
    // Let the follow attach, then stream two frames through it.
    await new Promise((r) => t(r, 30));
    assert.equal(sinks.length, 1, 'one follow');
    sinks[0].write(frame(0));
    sinks[0].write(frame(1).slice(0, 10));
    sinks[0].write(frame(1).slice(10));
    await run;
    assert.deepEqual(seen.filter((l) => l.startsWith('__USERNODE_TEST__ ')).map((l) => /index=(\d+)/.exec(l)[1]), ['0', '1']);
    const c = counters();
    assert.equal(c.reads, 1, 'the one pod-log read is the final buffered result, not progress');
    assert.equal(c.aborted, 1, 'the follow is closed when the run ends');
  } finally {
    global.setTimeout = t;
    kubernetes._setClientsForTest(undefined);
  }
});

test('the byte-skip splitter drops what a poll already delivered and re-assembles lines', async () => {
  const ended = (stream) => new Promise((resolve) => stream.on('end', resolve));
  const out = [];
  const s = new PassThrough();
  // The skip is in characters, matching what the polled read counts; the
  // multi-byte glyph is split across chunks and must still come out whole.
  const already = 'first line \u2026\n';
  kubernetes._attachLineObserverForTest(s, (l) => out.push(l), { skipBytes: already.length });
  const sDone = ended(s);
  const bytes = Buffer.from(already + 'sec', 'utf8');
  s.write(bytes.subarray(0, 12));
  s.write(bytes.subarray(12));
  s.write(Buffer.from('ond\nth\u00e9', 'utf8').subarray(0, 6));
  s.write(Buffer.from('ond\nth\u00e9', 'utf8').subarray(6));
  s.end();
  await sDone;
  assert.deepEqual(out, ['second', 'th\u00e9'], 'the trailing partial is flushed at end');
  const plain = [];
  const p = new PassThrough();
  kubernetes._attachLineObserverForTest(p, (l) => { if (l === 'boom') throw new Error('x'); plain.push(l); });
  const pDone = ended(p);
  p.write('boom\nok\n');
  p.end();
  await pDone;
  assert.deepEqual(plain, ['ok'], 'a throwing observer cannot break the stream');
});

test('without a log client the polled read stays in charge', async () => {
  const { clients, counters } = fakeClients({ withLogs: false });
  kubernetes._setClientsForTest(clients);
  const seen = [];
  const t = setTimeout;
  global.setTimeout = (fn, ms, ...rest) => t(fn, ms === 2000 ? 5 : ms, ...rest);
  try {
    await kubernetes.runCaptureJob(config, { sessionId: 2, env: {}, timeoutMs: 5000, onStdoutLine: (l) => seen.push(l) });
    assert.ok(counters().reads >= 2, 'progress came from re-reading the log');
    assert.ok(seen.some((l) => l.startsWith('__USERNODE_TEST__ index=0')));
  } finally {
    global.setTimeout = t;
    kubernetes._setClientsForTest(undefined);
  }
});
