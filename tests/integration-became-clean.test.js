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

// The flip is told to the preview machine in the write's own statement
// (tests/workflow-preview-postgres.test.js P6b runs it against PostgreSQL):
// a hook after the commit was lost by a restart in between, with the row
// already saying clean.
test('conflicting → clean on the SAME head is told in the measurement\'s own statement', async () => {
  const restore = stubMirror({ clean: true });
  try {
    const pool = fakePool({ wasClean: false, wasHead: HEAD });
    const out = await integration.measure({ pool, session }, { force: true });
    assert.equal(out.mergesClean, true);
    const writes = pool.calls.filter((c) => /UPDATE chat_sessions/.test(c.sql));
    assert.equal(writes.length, 1, 'one statement: the write and the event commit together');
    const [write] = writes;
    // The comparison is against the STORED answer, read in the write itself.
    assert.match(write.sql, /WITH prev AS/);
    assert.match(write.sql, /SELECT was_clean FROM prev/);
    assert.match(write.sql, /INSERT INTO wf_events[\s\S]*'ConflictResolved'/);
    assert.match(write.sql, /prev\.was_clean = FALSE AND \$7::boolean IS TRUE AND lower\(prev\.was_head\) = lower\(\$2::text\)/);
    assert.match(write.sql, /wi\.machine = 'preview' AND wi\.key = 'session:' \|\| \$1::int/);
    const { MACHINE, sessionKey } = require('../src/workflow/preview/machine.ts');
    assert.equal(MACHINE, 'preview');
    assert.equal(sessionKey(9), 'session:9');
  } finally { restore(); }
});

test('no hook is left to register', () => {
  assert.equal(integration.onBecameClean, undefined);
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
