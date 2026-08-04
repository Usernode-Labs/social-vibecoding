// The post-agent TAIL, and why a durable record has to span it.
//
// A dispatch turn has two halves. The first — `claude` running inside the
// worker — was always restart-proof: its output goes to a journal file and
// chat_sessions.active_turn points at it, so boot adoption replays it.
//
// The second half is the TAIL: heal the push, open/update the PR, build the
// staging preview, capture visuals, post the agent's summary card, re-issue
// the Mayor's wrap-up. That stretch is MINUTES long — a self-app preview
// build spends ~4:45 just cloning the platform database — and it used to
// run with active_turn already cleared, because execInWorker's `finally`
// dropped the record the moment the journal was consumed.
//
// Production consequence (session 2954): an unrelated proposal merged to
// main, the self-app deploy replaced the platform process mid-preview-build,
// and boot adoption saw a running container with no exec and no record. It
// took the "warm-idle, nothing to do" branch, and the dev chat kept
// "Building staging preview..." as its last word forever — no card, no
// summary, no error, no spinner. The owner eventually typed "continue",
// which bought a second full build turn for a commit that was already
// pushed.
//
// These tests pin the fix:
//   1. holdTurnRecord keeps the record (stamped phase 'tail') AND the
//      journal, so the existing resume path can pick the tail up.
//   2. finishTurn is what actually ends a turn, and it removes both.
//   3. Milestone stamps merge, never clobber, and can never resurrect a
//      released record.
//   4. finalizeRecoveredTurn honours those milestones, so a resumed tail
//      doesn't re-post cards, re-fire events or rebuild a live preview.
//
// Run with: node --test tests/turn-tail-lifecycle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load worker.js against a fake docker + logger + pg pool, so nothing
// touches a daemon or a database. Returns the module, the recorded docker
// execs, and the recorded SQL.
function loadWorker() {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const execs = [];
  const realDocker = require('../src/services/docker');
  stub(ids.docker, {
    ...realDocker,
    execFileAsync: async (cmd, args, opts) => {
      execs.push({ cmd, args, opts });
      return { stdout: '', stderr: '' };
    },
  });
  const noop = () => {};
  stub(ids.logger, { info: noop, warn: noop, error: noop, debug: noop });

  const queries = [];
  stub(ids.pool, {
    getPool: () => ({
      query: async (sql, params = []) => {
        queries.push({ sql: String(sql), params });
        return { rows: [], rowCount: 0 };
      },
    }),
  });

  delete require.cache[ids.subject];
  const worker = require('../src/services/worker');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
  };
  return { worker, execs, queries, restore };
}

// ── 1. The record's lifetime ────────────────────────────────────────────

test('markTurnTail stamps phase tail + tailStartedAt and merges milestones', async () => {
  const { worker, queries, restore } = loadWorker();
  try {
    await worker.markTurnTail(2954, { sha: 'dcdd174', pushOk: true });
    assert.equal(queries.length, 1);
    const { sql, params } = queries[0];
    assert.match(sql, /UPDATE chat_sessions/);
    assert.match(sql, /'\{phase\}'/, 'sets phase');
    assert.match(sql, /'\{tailStartedAt\}'/, 'stamps when the tail began');
    assert.match(sql, /'\{tail\}'/, 'seeds the milestone map');
    // The milestone map is MERGED into whatever is already there (`||`),
    // never assigned — a second stamp must not wipe the first.
    assert.match(sql, /COALESCE\(active_turn->'tail', '\{\}'::jsonb\) \|\| /);
    // Never resurrect a record the tail already released.
    assert.match(sql, /active_turn IS NOT NULL/);
    assert.equal(params[0], 2954);
    assert.equal(JSON.parse(params[1]), 'tail');
    assert.deepEqual(JSON.parse(params[3]), { sha: 'dcdd174', pushOk: true });
  } finally { restore(); }
});

test('noteTailMilestone merges one key and cannot revive a released record', async () => {
  const { worker, queries, restore } = loadWorker();
  try {
    await worker.noteTailMilestone(2954, { completionRowPosted: true });
    assert.equal(queries.length, 1);
    const { sql, params } = queries[0];
    assert.match(sql, /COALESCE\(active_turn->'tail', '\{\}'::jsonb\) \|\| \$2::jsonb/);
    assert.match(sql, /WHERE id = \$1 AND active_turn IS NOT NULL/,
      'a late stamp on a finished turn is a no-op, not an insert');
    assert.deepEqual(JSON.parse(params[1]), { completionRowPosted: true });

    // Nothing to record → no query at all (the wrap-up site calls this
    // unconditionally, and it must stay free when there's nothing to say).
    queries.length = 0;
    await worker.noteTailMilestone(2954, null);
    await worker.noteTailMilestone(2954, 'nope');
    assert.equal(queries.length, 0);
  } finally { restore(); }
});

test('finishTurn clears the record AND deletes the held journal', async () => {
  const { worker, execs, queries, restore } = loadWorker();
  try {
    await worker.finishTurn(2954, { journal: '/home/node/.claude/turn-777.log' });

    const rm = execs.find((c) => c.args.includes('rm'));
    assert.ok(rm, 'the journal a holdTurnRecord caller kept is removed here');
    assert.ok(rm.args.includes('/home/node/.claude/turn-777.log'));
    assert.ok(rm.args.includes('usernode-worker-2954'),
      'targets the session\'s own worker container');

    const cleared = queries.find((q) => /active_turn = NULL/.test(q.sql));
    assert.ok(cleared, 'the durable record is dropped');
    assert.deepEqual(cleared.params, [2954]);
  } finally { restore(); }
});

test('finishTurn with no journal still clears the record (idempotent)', async () => {
  const { worker, execs, queries, restore } = loadWorker();
  try {
    // Second call for the same turn, or a turn that never held a record.
    await worker.finishTurn(2954);
    assert.equal(execs.filter((c) => c.args.includes('rm')).length, 0,
      'nothing to delete, so no exec');
    assert.ok(queries.some((q) => /active_turn = NULL/.test(q.sql)));
  } finally { restore(); }
});

test('isTailPhase classifies a held tail, tolerating a string-encoded column', () => {
  const { worker, restore } = loadWorker();
  try {
    assert.equal(worker.isTailPhase(null), false);
    assert.equal(worker.isTailPhase({ mode: 'build', journal: '/j' }), false,
      'a mid-exec record is not a tail');
    assert.equal(worker.isTailPhase({ phase: 'tail' }), true);
    assert.equal(worker.isTailPhase(JSON.stringify({ phase: 'tail' })), true);
    assert.equal(worker.isTailPhase('not json'), false);
    assert.equal(worker.TURN_PHASE_TAIL, 'tail');
  } finally { restore(); }
});

// ── 2. execInWorker's two contracts, read off the source ────────────────
//
// The dispatch itself needs a live docker daemon, so pin the branch
// structurally: the journal delete and the clear are both gated on
// holdTurnRecord, and the tail branch hands off via markTurnTail.

const WORKER_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/worker.js'), 'utf8'
);

test('execInWorker keeps the journal and the record when holdTurnRecord is set', () => {
  assert.match(WORKER_SRC, /if \(!holdTurnRecord && state\.execExitSeen && !state\.fatalError\)/,
    'the journal delete is skipped for a tail-holding caller');
  assert.match(WORKER_SRC, /if \(holdTurnRecord\) \{[\s\S]{0,600}await markTurnTail\(sessionId,/,
    'the tail branch stamps the record instead of clearing it');
  assert.match(WORKER_SRC, /\} else \{\s*\n\s*await clearActiveTurn\(sessionId\);/,
    'the non-holding contract is unchanged: clear at exec end');
  // The seed milestones are what let a dead-worker recovery tell "code
  // landed" from "nothing landed" without a container to ask.
  assert.match(WORKER_SRC, /sha: execState\.sha \|\| null, pushOk: execState\.pushOk === true/);
});

// ── 3. Both dispatch tools opt in and release ───────────────────────────

const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/sessions.js'), 'utf8'
);

test('build and scout dispatches hold the record and release it in a finally', () => {
  const holds = SESSIONS_SRC.match(/holdTurnRecord: true/g) || [];
  assert.equal(holds.length, 2, 'both dispatch tools (build + scout) opt in');

  const finishes = SESSIONS_SRC.match(/worker\.finishTurn\(session\.id\)/g) || [];
  assert.equal(finishes.length, 2, 'and both release it');

  // Release must be unconditional — a held record with no owner is what
  // the stale-turn watchdog reaps, and reaping narrates an interruption
  // that never happened.
  for (const m of SESSIONS_SRC.matchAll(/worker\.finishTurn\(session\.id\)/g)) {
    const before = SESSIONS_SRC.slice(Math.max(0, m.index - 900), m.index);
    assert.match(before, /\} finally \{[\s\S]*$/,
      'finishTurn is called from a finally block');
  }

  // The sync path deliberately does NOT hold: it has no user-visible tail,
  // and resumeDetachedTurnInner already treats recovered sync turns as
  // no-ops.
  const SYNC_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/sync-main.js'), 'utf8'
  );
  assert.ok(!/holdTurnRecord/.test(SYNC_SRC), 'sync turns keep the old contract');
});

test('every non-idempotent tail step stamps a milestone', () => {
  for (const key of [
    'prOpenedEventRecorded', 'stagingUrl', 'votesResetFor',
    'completionRowPosted', 'wrapUpPosted',
  ]) {
    assert.match(SESSIONS_SRC, new RegExp(`noteTailMilestone\\([\\s\\S]{0,200}${key}`),
      `${key} must be stamped when that step lands`);
  }
});

// ── 4. finalizeRecoveredTurn skips what already landed ──────────────────

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('finalizeRecoveredTurn takes an alreadyDone map and defaults to empty', () => {
  assert.match(SERVER_SRC, /startedAtMs, alreadyDone = null,\s*\}\) \{/,
    'optional, so a genuine mid-exec recovery is unaffected');
  assert.match(SERVER_SRC,
    /const done = alreadyDone && typeof alreadyDone === 'object' \? alreadyDone : \{\};/);
});

test('a resumed tail does not duplicate the completion card or the PR event', () => {
  assert.match(SERVER_SRC, /if \(done\.completionRowPosted\) \{/,
    'the agent summary card is posted at most once');
  // ...but the summary still reaches the Mayor wrap-up, or the recovered
  // turn would be narrated blind.
  assert.match(SERVER_SRC,
    /if \(done\.completionRowPosted\) \{[\s\S]{0,400}summaryParts\.unshift\(`What the agent did/);
  assert.match(SERVER_SRC,
    /const prAnnounced = !!done\.prNumber \|\| !!done\.prOpenedEventRecorded;/);
  assert.match(SERVER_SRC, /wasNewPR && !prAnnounced/,
    '"PR #N created" is announced at most once');
  assert.match(SERVER_SRC, /done\.votesResetFor !== result\.sha/,
    'a vote reset the live tail already announced is not re-announced');
});

test('a resumed tail reuses a healthy preview instead of rebuilding for ~5 minutes', () => {
  assert.match(SERVER_SRC, /if \(done\.stagingUrl\) \{/);
  // Recorded is not enough — the container must still be alive. A dead one
  // falls through to a real rebuild, which is the point of this path.
  assert.match(SERVER_SRC, /stagingNeedsRebuild\(\{ \.\.\.session, \.\.\.live \}, \{ config \}\)/);
  assert.match(SERVER_SRC, /if \(!reusedStaging\) emit\('status', \{ text: 'Building staging preview\.\.\.' \}\)/,
    'no "building" line when nothing is being built');
  // Reuse still posts the Changes-ready card the interrupted tail owed the
  // user, and still re-runs checks (setChecksPending voided the verdict).
  assert.match(SERVER_SRC,
    /if \(reusedStaging\) \{[\s\S]{0,900}changesReady: true/);
  assert.match(SERVER_SRC,
    /if \(reusedStaging\) \{[\s\S]{0,1400}visuals\.captureForSession/);
});

test('resumeDetachedTurnInner threads the map through and skips a posted wrap-up', () => {
  assert.match(SERVER_SRC,
    /const tailDone = \(activeTurn && typeof activeTurn\.tail === 'object' && activeTurn\.tail\) \|\| \{\};/);
  assert.match(SERVER_SRC, /alreadyDone: tailDone,/,
    'finalizeRecoveredTurn receives it');
  assert.match(SERVER_SRC, /if \(wrapUpOutcome && tailDone\.wrapUpPosted\) \{/,
    'no second assistant reply describing the same build');
  // Operators need to tell "the agent was still typing" from "the platform
  // side was cut off" — they look identical in the logs otherwise.
  assert.match(SERVER_SRC, /phase: activeTurn\.phase \|\| 'exec',/);
});
