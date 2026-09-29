// The mirror's single-flight, and the one caller shape it gets wrong (#2619).
//
// `ensureMirror` coalesces one fetch per repository, which is right for the
// readers it was built for: several proposals on the same app are measured
// together and want the same refs. It is wrong for a caller that has just
// WRITTEN to the repository and is reading its own write back — joining a
// fetch that started before the push hands it a view that predates the push,
// and nothing in the result says so. That is what left a proposal's votes,
// checks verdict and preview describing the previous commit until a sweep
// noticed minutes later.
//
// These drive the real `ensureMirror` with `services/docker` stubbed, because
// what is under test is the PROMISE BOOKKEEPING, not git: the questions are
// how many fetches run, in what order, and which promise is left in the
// in-flight map afterwards. A real clone would answer none of those and would
// need the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stub(rel, exports) {
  const id = require.resolve(path.join(__dirname, '..', rel));
  const prev = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  return () => { if (prev) require.cache[id] = prev; else delete require.cache[id]; };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const EMPTY = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };

/**
 * A mirror module whose every git call is answered here.
 *
 * `rev-parse --git-dir` succeeds so the clone path stays out of the way; the
 * branch-fetch is the one call that matters, and each invocation is recorded
 * and parked on a deferred the test releases by hand. No refs are requested,
 * so there are no by-sha fetches either.
 */
function loadMirror() {
  const fetches = [];
  const restore = stub('src/services/docker.js', {
    async execFileAsync(cmd, args) {
      const a = args || [];
      if (a.includes('--git-dir')) return { stdout: Buffer.from('.'), stderr: Buffer.alloc(0) };
      if (a.includes('+refs/heads/*:refs/heads/*')) {
        const gate = deferred();
        fetches.push(gate);
        await gate.promise;
        return EMPTY;
      }
      return EMPTY;
    },
  });
  delete require.cache[require.resolve('../src/services/repo-mirror')];
  // eslint-disable-next-line global-require
  const mirror = require('../src/services/repo-mirror');
  return {
    mirror,
    fetches,
    restore() {
      restore();
      delete require.cache[require.resolve('../src/services/repo-mirror')];
    },
  };
}

/** Let every queued microtask run, so a chained `.then` actually fires. */
const settle = () => new Promise((r) => setImmediate(r));

test('an ordinary caller joins the fetch already in flight', async () => {
  const { mirror, fetches, restore } = loadMirror();
  try {
    const first = mirror.ensureMirror('acme', 'demo');
    await settle();
    assert.equal(fetches.length, 1);

    const second = mirror.ensureMirror('acme', 'demo');
    await settle();
    assert.equal(fetches.length, 1, 'still one fetch: the second call coalesced onto it');

    fetches[0].resolve();
    assert.equal(await first, await second, 'and both get the same mirror');
  } finally { restore(); }
});

test('a fresh caller declines to join, and chains behind the fetch in flight', async () => {
  const { mirror, fetches, restore } = loadMirror();
  try {
    const stale = mirror.ensureMirror('acme', 'demo');
    await settle();
    assert.equal(fetches.length, 1);

    // The push happens HERE, after that fetch began. A caller joining it
    // would be told the branch is where it was before the push.
    const afterPush = mirror.ensureMirror('acme', 'demo', { fresh: true });
    await settle();
    assert.equal(fetches.length, 1,
      'chained, not raced: two fetches into one bare repo contend for no gain');

    fetches[0].resolve();
    await settle();
    assert.equal(fetches.length, 2, 'the fresh caller runs its own fetch once the first is done');

    fetches[1].resolve();
    await afterPush;
    await stale;
  } finally { restore(); }
});

test('a fetch that fails ahead of a fresh caller does not cost it its own', async () => {
  const { mirror, fetches, restore } = loadMirror();
  try {
    const failing = mirror.ensureMirror('acme', 'demo');
    await settle();
    const afterPush = mirror.ensureMirror('acme', 'demo', { fresh: true });
    await settle();

    fetches[0].reject(new Error('network down'));
    await assert.rejects(failing, /network down/);
    await settle();
    assert.equal(fetches.length, 2, 'the failure was somebody else’s answer, not ours');

    fetches[1].resolve();
    assert.match(await afterPush, /acme/);
  } finally { restore(); }
});

test('the fresh fetch becomes the in-flight entry, and the one it superseded does not evict it', async () => {
  // The bookkeeping bug that comes free with chaining: the superseded promise
  // settles LAST-but-one and its cleanup would delete whatever is under the
  // key — which by then is the newer fetch. A third caller would then start a
  // third fetch instead of joining the one already running for it.
  const { mirror, fetches, restore } = loadMirror();
  try {
    const stale = mirror.ensureMirror('acme', 'demo');
    await settle();
    const afterPush = mirror.ensureMirror('acme', 'demo', { fresh: true });
    await settle();

    fetches[0].resolve();
    await stale;
    await settle();
    assert.equal(fetches.length, 2);

    const joiner = mirror.ensureMirror('acme', 'demo');
    await settle();
    assert.equal(fetches.length, 2, 'the third caller joined the fresh fetch');

    fetches[1].resolve();
    assert.equal(await joiner, await afterPush);
    await settle();

    // And once everything has settled the key is released, so the next
    // caller gets a real fetch rather than a resolved promise for a view
    // that is now old.
    mirror.ensureMirror('acme', 'demo');
    await settle();
    assert.equal(fetches.length, 3);
    fetches[2].resolve();
  } finally { restore(); }
});
