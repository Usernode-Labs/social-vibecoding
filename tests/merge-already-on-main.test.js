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
//   - native-merge flags that refusal as already on main, and only when main
//     on the host is still the main it merged against: a main that moved in
//     between is refused as main moving, to be tried again (Codex review);
//   - routes/votes.js attemptMerge answers it as its own outcome, never a
//     refusal to retry;
//   - the proposal machine closes the change, saying why, and tells the queue.
//
// Run with: node --test tests/merge-already-on-main.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// native-merge's collaborators, stubbed through the require cache: the mirror
// says the merge changes nothing, and the host's main is read again.
async function squashNoOp({ hostMain }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    gitHost: require.resolve('../src/services/git-host'),
    repoMirror: require.resolve('../src/services/repo-mirror'),
    appNumbers: require.resolve('../src/services/app-numbers'),
    codeHostWrite: require.resolve('../src/services/code-host-write'),
    requests: require.resolve('../src/services/requests'),
    subject: require.resolve('../src/services/native-merge'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  // Anything first loaded while the stubs stand is dropped afterwards, so no
  // module keeps a stub (code-missing reads git-host when it loads).
  const before = new Set(Object.keys(require.cache));
  const reads = [];
  const updates = [];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.codeHostWrite, { requireCodeHostWrite() {} });
  stub(ids.requests, { async appFor() { return { id: 7, slug: 'gas-lock-07613b' }; } });
  stub(ids.appNumbers, {
    getPool: () => ({
      async query(sql) {
        if (/^\s*SELECT/.test(sql)) {
          return { rows: [{ number: 15, title: 'Chip', body: '', head_branch: 'dev/x', base_branch: 'main', draft: false,
            state: 'open', merged: false, merge_commit_sha: null, merged_head_sha: null }] };
        }
        updates.push(sql);
        return { rows: [] };
      },
    }),
  });
  stub(ids.repoMirror, {
    async ensureMirror() { return '/mirror'; },
    async resolveBranch(dir, name) { return name === 'main' ? SHA('f') : SHA('9'); },
    async mergeTree() { return { clean: true, tree: SHA('7'), conflicts: [] }; },
    async treeOf() { return SHA('7'); },
  });
  stub(ids.gitHost, {
    async readRef(repo, ref) { reads.push([repo, ref]); if (hostMain instanceof Error) throw hostMain; return hostMain; },
    defaultAuthor: () => ({ name: 'Homeroom', email: 'h@example.test' }),
    async git() { throw new Error('no commit is made for a merge that changes nothing'); },
    async casUpdateRef() { throw new Error('main is never moved for a merge that changes nothing'); },
  });
  delete require.cache[ids.subject];
  try {
    const { squashMerge } = require(ids.subject);
    let err = null;
    try {
      await squashMerge({ owner: 'apps', repo: 'gas-lock-07613b', number: 15, pinnedSha: SHA('9') });
    } catch (e) { err = e; }
    return { err, reads, updates };
  } finally {
    for (const id of Object.keys(require.cache)) if (!before.has(id)) delete require.cache[id];
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  }
}

test('native-merge: a merge that changes nothing, main unchanged on the host: flagged as already on main', async () => {
  const { err, reads, updates } = await squashNoOp({ hostMain: SHA('f') });
  assert.ok(err, 'refused');
  assert.equal(err.status, 405);
  assert.equal(err.alreadyOnMain, true);
  assert.match(err.message, /changes nothing on main/);
  assert.deepEqual(reads, [[{ owner: 'apps', name: 'gas-lock-07613b' }, 'main']], 'main read again on the host');
  assert.deepEqual(updates, [], 'nothing recorded as merged');
});

test('native-merge: main moved on the host since the mirror was read: refused as main moving, never already on main', async () => {
  const { err } = await squashNoOp({ hostMain: SHA('e') });
  assert.ok(err, 'refused');
  assert.equal(err.alreadyOnMain, undefined, 'not closed for good');
  assert.match(err.message, /^Base branch was modified/);
  const { refusalKind } = require('../src/routes/votes');
  assert.equal(refusalKind(err, { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean' }), 'base_moved',
    'the machine asks once more against the new main');
});

test('native-merge: main that cannot be read again, or is gone: never flagged as already on main', async () => {
  const unreadable = new Error('ls-remote failed');
  const a = await squashNoOp({ hostMain: unreadable });
  assert.equal(a.err, unreadable, 'thrown, for the work to be tried again');
  const b = await squashNoOp({ hostMain: null });
  assert.ok(b.err);
  assert.equal(b.err.alreadyOnMain, undefined);
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
