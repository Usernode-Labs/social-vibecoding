'use strict';

// Request 6549: an approved change whose code is already on main.
//
// Gas & Lock's PR #15 (change 12940) and #14 were built for the same request.
// #14 merged first; #15 was synced onto main and the sync kept main's side of
// every file, so its branch's tree became main's tree. The git host's merge
// (services/native-merge.js) refuses a merge that changes nothing, and that
// refusal read as a plain "GitHub refused it": the queue asked again every
// four minutes for days while the card said "Waiting on GitHub".
//
// What this pins, without a database:
//   - native-merge flags that refusal as already on main;
//   - routes/votes.js attemptMerge answers it as its own outcome, never a
//     refusal to retry;
//   - the proposal machine closes the change, saying why, and tells the queue.
//
// Run with: node --test tests/merge-already-on-main.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('native-merge flags a merge that changes nothing on main as already on main', () => {
  const src = read('src/services/native-merge.js');
  assert.match(src, /'Pull Request is not mergeable: it changes nothing on main', 405\);\s*e\.alreadyOnMain = true;\s*throw e;/);
});

// ── attemptMerge ───────────────────────────────────────────────────────

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const SHA = (c) => c.repeat(40);

test('attemptMerge: everything already on main is its own outcome, not a refusal tried again', async () => {
  process.env.USERNODE_ENV = 'production';
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    platform: require.resolve('../src/workflow/platform.ts'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const { HeadMovedError } = require('../src/services/github');
  let gets = 0;
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, {
    isEnabled: () => true,
    canActOn: () => true,
    HeadMovedError,
    async mergePR() {
      const e = new Error('Pull Request is not mergeable: it changes nothing on main');
      e.status = 405;
      e.alreadyOnMain = true;
      throw e;
    },
    async getPR() { gets++; return { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean' }; },
    async reopenPR() { return {}; },
    async markPrReadyForReview() { return {}; },
  });
  stub(ids.platform, {});
  stub(ids.ws, { sendSystemMessage: async () => {}, pushVoteUpdate() {}, pushSessionUpdate() {} });
  delete require.cache[ids.subject];
  try {
    const subject = require(ids.subject);
    const session = {
      id: 12940, app_id: 7, app_slug: 'gas-lock-07613b', repo_url: 'https://github.com/apps/gas-lock-07613b',
      pr_number: 15, pr_title: 'Best time to transact chip', user_id: 94, source: 'native', reviewed_head_sha: SHA('9'),
    };
    const pool = {
      async query(sql) {
        if (/FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id WHERE cs\.id = \$1/.test(String(sql))) return { rows: [session] };
        return { rows: [] };
      },
    };
    const out = await subject.attemptMerge({}, pool, 12940, { head: SHA('9'), checkpoint: async () => {} });
    assert.equal(out.outcome, 'already_on_main', JSON.stringify(out));
    assert.equal(out.kind, undefined, 'not a refusal of any kind');
    assert.match(out.message, /everything in it is already on main/);
    assert.equal(gets, 0, 'nothing more to ask about the pull request');
  } finally {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  }
});

// ── The proposal machine ───────────────────────────────────────────────

const NOW = new Date('2026-11-11T09:57:49Z');

function machine() {
  const { proposal } = require('../src/workflow/proposal/machine.ts');
  return proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 0, staleGraceMs: 0 });
}

function row(over = {}) {
  return {
    id: 12940, appId: 7, appSlug: 'gas-lock-07613b', selfHosted: false, repo: { owner: 'apps', repo: 'gas-lock-07613b' },
    userId: 94, ownerName: 'mei215', ownerSynthetic: false, status: 'merging', imported: false, headless: false,
    prNumber: 15, prTitle: 'Best time to transact chip next to Weekly fee heatmap', branch: 'dev/mei215-best-time',
    head: SHA('9'), reviewedHead: SHA('9'), importedHead: null, epoch: 1, promotedAt: '2026-11-08T16:10:29Z',
    createdAt: '2026-11-08T15:04:02Z', staleNotifiedAt: null, lastActivityAt: '2026-11-11T03:40:10Z', linkedIssues: [13],
    agentSessionId: 1137, explicitApproval: false, explicitReason: null, mergeAttemptAt: null, shots: false, fixture: false,
    activeTurn: false, workedOn: false, moving: false, shotsRunning: false, buildHold: false, pendingSecret: false,
    checkState: 'passing', checksCommitSha: SHA('9'), bootFailureSyncHead: null, fixedCheckSyncHead: null, fixedCheckSyncKeys: [],
    integrationHead: SHA('9'), integrationMain: SHA('f'), integrationBehindBy: 0, integrationResolvedEpoch: null, forkHead: false,
    baseRef: null, waitsFor: null, ...over,
  };
}

function merging() {
  return {
    name: 'merging',
    data: {
      sessionId: 12940, appId: 7, imported: false, slot: 'none', promoting: null, answer: null, reason: null,
      claim: { n: 3, at: '2026-11-11T09:57:48Z' }, pr: { running: null, next: [] }, doomed: [], n: 3,
      refused: { head: SHA('9'), main: SHA('f'), kind: 'blocked', at: '2026-11-11T09:53:00Z', retryAt: '2026-11-11T09:57:00Z', checks: null, since: '2026-11-11T08:06:16Z' },
      attempt: { n: 3, queueN: 9, stage: 'merge', head: SHA('9'), epoch: 1, force: false, forcedBy: null, tally: null },
    },
  };
}

test('the proposal machine closes a change already on main, says why, and tells the queue', () => {
  const { WORK } = require('../src/workflow/proposal/machine.ts');
  const m = machine();
  const s = merging();
  const event = { id: 240001, type: 'WorkSucceeded', source: { kind: 'service', workId: 'w1' },
    payload: { sessionId: 12940, kind: WORK.attempt, workKey: 'attempt:3',
      result: { outcome: 'already_on_main', message: 'nothing left to merge' } } };
  const facts = { row: row(), caps: null, gate: null, interestAt: null, mergesPaused: false, electorate: null, waiting: [] };
  const out = m.entryFor(s.name, 'WorkSucceeded').to(s, event, facts, { now: NOW, key: 'session:12940' });

  assert.equal(out.next.name, 'closed', 'closed, not back in review to be asked again');
  assert.equal(out.next.data.reason, 'already-on-main');
  assert.equal(out.next.data.attempt, null);
  const writes = out.writes || [];
  assert.deepEqual(writes.filter((w) => w.type === 'mergeHeld'), [], 'never held as waiting on GitHub');
  const closed = writes.find((w) => w.type === 'closed');
  assert.ok(closed, 'the row is closed');
  const said = JSON.stringify(writes);
  assert.match(said, /was closed: everything in it is already on main, so there was nothing left to merge\./);
  const ended = (out.messages || []).filter((msg) => msg.event.type === 'AttemptEnded');
  assert.equal(ended.length, 1, 'the queue hears once');
  assert.equal(ended[0].event.payload.outcome, 'closed');
  assert.equal(ended[0].event.payload.n, 9);
  assert.ok((out.work || []).some((w) => w.kind === WORK.close), 'its pull request is closed on the git host');
});
