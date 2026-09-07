// Sweeper-decision tests for the auto-takedown (rejection) pass.
//
// The takedown wiring in server.js's stale-PR sweeper is a thin branch over
// the pure gate: for each promoted PR it computes `mergeGate(...)`, merges
// first when `gate.mergeable`, and otherwise archives via
// `sessionLifecycle.archiveSession({ reason: 'auto-rejected' })` + a
// `pushVoteUpdate` when `gate.rejectable`. These tests lock that decision
// predicate (the part with all the policy in it) over a matrix of vote splits
// and ages, plus assert the rejection-specific chat copy branch in
// archiveSession. They use the REAL active-users helpers — no DB/sweeper spin-up.
//
// Run with: node --test tests/rejection-sweeper.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');

const DAY = 24 * 60 * 60 * 1000;
const opened = '2026-06-01T00:00:00.000Z';
const openedMs = Date.parse(opened);

// Mirror of the sweeper's per-row branch (server.js Pass 0): returns the
// action the sweeper would take for this row's gate.
function sweepAction(gate) {
  if (gate.mergeable) return 'merge';
  if (gate.rejectable) return 'reject';
  return 'none';
}

test('sweeper would auto-reject a promoted PR once its rejection window elapses', () => {
  // active=20, yes=2, no=3 (slim No majority, under 1/3 support).
  const fresh = mergeGate(20, 2, 3, opened, openedMs + 60 * 1000);
  assert.equal(sweepAction(fresh), 'none', 'inside the window → no takedown yet');

  const aged = mergeGate(20, 2, 3, opened, openedMs + 8 * DAY);
  assert.equal(sweepAction(aged), 'reject', 'window elapsed → archive as auto-rejected');
});

test('sweeper never rejects a kept-alive (>=1/3 Yes) or not-losing PR', () => {
  // Kept alive: 7/20 Yes despite heavy No, even long after opening.
  const keptAlive = mergeGate(20, 7, 12, opened, openedMs + 60 * DAY);
  assert.equal(sweepAction(keptAlive), 'none');

  // Not losing: Yes still ahead. Never rejected — and since the Yes lead is
  // uncontested (4/20 No < 1/3), the lazy-consensus clock has long elapsed,
  // so the sweeper MERGES it (silence is consent) rather than leaving it.
  const ahead = mergeGate(20, 5, 4, opened, openedMs + 60 * DAY);
  assert.notEqual(sweepAction(ahead), 'reject');
  assert.equal(sweepAction(ahead), 'merge');

  // Lone No: below the min-No floor → never arms (and No leads, so the lazy
  // merge clock never arms either) → untouched.
  const loneNo = mergeGate(20, 0, 1, opened, openedMs + 60 * DAY);
  assert.equal(sweepAction(loneNo), 'none');
});

test('sweeper prefers merge over reject when a row is somehow both-eligible', () => {
  // They are mutually exclusive by construction, but the branch order must
  // still favor merge. A clear majority long after opening is mergeable.
  const majority = mergeGate(20, 11, 0, opened, openedMs + 60 * DAY);
  assert.equal(sweepAction(majority), 'merge');
});

test('archiveSession posts rejection-specific chat copy for reason=auto-rejected', async () => {
  // Stub ws/github/etc. so archiveSession runs without real infra, and capture
  // the system message it posts.
  const Module = require('module');
  const ids = {
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    worker: require.resolve('../src/services/worker'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/session-lifecycle'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const messages = [];
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content) => { messages.push(content); },
    pushSessionUpdate() {},
    pushVoteUpdate() {},
  });
  stub(ids.github, { closePR: async () => {} });
  stub(ids.staging, { teardownStaging: async () => {} });
  stub(ids.worker, {
    destroyWorker: async () => {}, workerContainerName: (id) => `w${id}`,
    destroyCcVolume: async () => {},
  });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  const { archiveSession } = require(ids.subject);

  // Minimal pool: the UPDATE returns the row id (archive proceeds), the
  // follow-up SELECT returns a session with a PR number so the chat line fires.
  const pool = {
    async query(sql) {
      if (/UPDATE chat_sessions SET status = 'archived'/.test(sql)) return { rows: [{ id: 7 }] };
      if (/SELECT cs\.\*/.test(sql)) {
        return { rows: [{
          id: 7, app_id: 5, app_slug: 'widget', pr_number: 12,
          pr_title: 'Risky change', repo_url: '', owner_username: 'alice',
          staging_container_id: null,
        }] };
      }
      return { rows: [] };
    },
  };

  try {
    const res = await archiveSession({ pool, sessionId: 7, reason: 'auto-rejected' });
    assert.equal(res.archived, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /set aside for now \(more No than Yes/);
    assert.doesNotMatch(messages[0], /withdrew|went quiet/);
  } finally {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  }
});
