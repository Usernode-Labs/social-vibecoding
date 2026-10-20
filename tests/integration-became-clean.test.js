'use strict';

// services/integration — the one transition that starts work.
//
// A promoted head that conflicts with main gets its preview and no verdict
// (services/check-admission.js). When a sibling merge later makes that SAME
// head merge cleanly, its held-back checks can run — and the only place that
// knows the head flipped is measure(), which reads the stored answer in the
// same statement as its write. These pin the flip detection, and the
// pre-approval resolution stamp the conflict lane spends per authored head.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

require.cache[require.resolve('../src/services/ws')] = {
  id: 'ws', filename: 'ws', loaded: true,
  exports: { pushSessionUpdate: () => {}, sendSystemMessage: async () => {} },
};

const mirror = require('../src/services/repo-mirror');
const integration = require('../src/services/integration');

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

// The mirror, answering as a repo where `head` merges into main the way the
// test says. Every function measure() calls is stubbed on the module object,
// which is how integration reads them.
function stubMirror({ clean, head = HEAD }) {
  const real = {};
  const fns = {
    ensureMirror: async () => '/tmp/not-a-real-mirror',
    defaultBranchSha: async () => MAIN,
    resolveBranch: async () => head,
    mergeBase: async () => BASE,
    behindBy: async () => 3,
    aheadBy: async () => 1,
    mergeTree: async () => (clean
      ? { clean: true, conflicts: [], tree: 'e'.repeat(40) }
      : { clean: false, conflicts: ['dapp.json'], tree: null }),
    hasCommit: async () => true,
    isAncestor: async () => true,
  };
  for (const [k, v] of Object.entries(fns)) { real[k] = mirror[k]; mirror[k] = v; }
  return () => { for (const [k, v] of Object.entries(real)) mirror[k] = v; };
}

// A pool whose UPDATE ... RETURNING answers with what the row said BEFORE,
// and the block reasons it holds after the write.
function fakePool({ wasClean, wasHead, blockReasons = [] }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/UPDATE chat_sessions/.test(sql) && /RETURNING/.test(sql)) {
        return { rows: [{ was_clean: wasClean, was_head: wasHead, block_reasons: blockReasons }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

const session = {
  id: 9, status: 'promoted', repo_url: 'https://github.com/org/app', branch_name: 'feat',
  app_slug: 'app', integration_block_reasons: ['awaiting_approval'],
};

function hook() {
  const calls = [];
  integration.onBecameClean((s) => { calls.push(s); });
  return { calls, off: () => integration.onBecameClean(null) };
}

const tick = () => new Promise((r) => setImmediate(r));

test('conflicting → clean on the SAME head fires the hook with the head named', async () => {
  const restore = stubMirror({ clean: true });
  const h = hook();
  try {
    const pool = fakePool({ wasClean: false, wasHead: HEAD });
    const out = await integration.measure({ pool, session }, { force: true });
    assert.equal(out.mergesClean, true);
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].id, 9);
    assert.equal(h.calls[0].integration_head_sha, HEAD);
    // The comparison is against the STORED answer, read in the write itself.
    const write = pool.calls.find((c) => /RETURNING/.test(c.sql));
    assert.match(write.sql, /WITH prev AS/);
    assert.match(write.sql, /SELECT was_clean FROM prev/);
  } finally { h.off(); restore(); }
});

test('a NEW head measuring clean does not fire: its push already started its checks', async () => {
  const restore = stubMirror({ clean: true, head: 'f'.repeat(40) });
  const h = hook();
  try {
    const pool = fakePool({ wasClean: false, wasHead: HEAD });
    await integration.measure({ pool, session }, { force: true });
    await tick();
    assert.equal(h.calls.length, 0, 'a hook here would run the new head\'s checks twice');
  } finally { h.off(); restore(); }
});

test('clean → clean, conflict → conflict, and a first measurement all stay quiet', async () => {
  const h = hook();
  try {
    for (const [clean, wasClean] of [[true, true], [false, false], [true, null], [false, null]]) {
      const restore = stubMirror({ clean });
      try {
        await integration.measure({ pool: fakePool({ wasClean, wasHead: HEAD }), session }, { force: true });
        await tick();
      } finally { restore(); }
    }
    assert.equal(h.calls.length, 0);
  } finally { h.off(); }
});

test('a hook that throws is logged, not propagated into the measurement', async () => {
  const restore = stubMirror({ clean: true });
  integration.onBecameClean(() => { throw new Error('recheck exploded'); });
  try {
    const out = await integration.measure({ pool: fakePool({ wasClean: false, wasHead: HEAD }), session }, { force: true });
    await tick();
    assert.equal(out.mergesClean, true);
    assert.equal(out.error, null);
  } finally { integration.onBecameClean(null); restore(); }
});

// The merge gate writes the block reasons. A measurement that copied the
// caller's row back (a row the measure pass read minutes before) wrote a
// stale copy over the gate's newer answer: without `blockReasons` the
// column keeps what is stored, and the answer reads it back.
test('the block reasons written are the caller\'s when given; otherwise the stored ones stay and are returned', async () => {
  const restore = stubMirror({ clean: true });
  try {
    const kept = fakePool({ wasClean: true, wasHead: HEAD, blockReasons: ['behind_main'] });
    const out = await integration.measure({ pool: kept, session }, { force: true });
    const w1 = kept.calls.find((c) => /RETURNING/.test(c.sql));
    assert.equal(w1.params[10], null, 'the caller\'s copy (awaiting_approval) is not written back');
    assert.match(w1.sql, /integration_block_reasons = COALESCE\(\$11::jsonb, integration_block_reasons\)/,
      'measuring does not forget the lane\'s answer');
    assert.match(w1.sql, /integration_block_reasons AS block_reasons/);
    assert.deepEqual(out.blockReasons, ['behind_main'], 'the answer is what is stored, not the caller\'s copy');

    const cleared = fakePool({ wasClean: true, wasHead: HEAD });
    const out2 = await integration.measure({ pool: cleared, session }, { force: true, blockReasons: [] });
    const w2 = cleared.calls.find((c) => /RETURNING/.test(c.sql));
    assert.equal(w2.params[10], '[]');
    assert.deepEqual(out2.blockReasons, []);

    const given = fakePool({ wasClean: true, wasHead: HEAD, blockReasons: ['stale'] });
    const out3 = await integration.measure({ pool: given, session }, { force: true, blockReasons: 'conflicts' });
    assert.equal(given.calls.find((c) => /RETURNING/.test(c.sql)).params[10], JSON.stringify(['conflicts']));
    assert.deepEqual(out3.blockReasons, ['conflicts'], 'the caller\'s, when given');
  } finally { restore(); }
});
