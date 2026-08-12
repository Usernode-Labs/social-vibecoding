// Unit tests for #687 Slice 3 — the imported-PR sync poller, the
// head-change vote-tally reset, and revision-scoped approval counting.
//
// Covers (spec "Tests"):
//   - governedGate/qualifiedCounts head-scoping: an imported proposal's
//     gate counts only approvals cast against the CURRENT head SHA, so a
//     superseded head's approvals are ignored;
//   - syncImportedProposal: no-op on an unchanged head; on a head change it
//     advances imported_pr_head_sha, CLEARS the tally, posts the re-review
//     note, refreshes drift, and re-runs checks pinned to the new head;
//   - non-imported rows are skipped without any DB work.
//
// Run with: node --test tests/pr-import-sync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const governance = require('../src/services/governance');
const config = require('../src/config');

// The client picker (usesMockGithubForImports) selects the in-memory mock
// GitHub source when USERNODE_ENV === 'staging'. These tests exercise the
// REAL-client path via the fakeGithub stub below, so pin the env to
// production regardless of what the harness set.
process.env.USERNODE_ENV = 'production';

// The worker's unit environment ships a minimal node_modules (no `ws`,
// `jsonwebtoken`, etc.), so several service modules can't be require()'d for
// real here. pr-import-sync pulls all of its heavy collaborators lazily via
// require('./x') at call time, and binds `github` at module load, so we
// pre-seed the module cache with controllable fakes BEFORE requiring
// pr-import-sync. Tests replace individual methods on these fakes to script
// GitHub responses and observe side effects.
function fakeModule(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
  return exports;
}

const fakeGithub = fakeModule('../src/services/github', {
  isEnabled: () => true,
  getPR: async () => ({}),
  getOctokit: async () => ({ rest: { repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) } } }),
});
const fakeWs = fakeModule('../src/services/ws', {
  sendSystemMessage: async () => {},
  pushVoteUpdate: () => {},
  pushSessionUpdate: () => {},
  broadcastGlobal: () => {},
});
fakeModule('../src/services/visuals', {
  setChecksPending: async () => {},
  notifyChecksPending: () => {},
  captureForSession: async () => {},
});
fakeModule('../src/services/staging', {
  buildAndDeployStaging: async () => ({ containerId: 'c', stagingUrl: 'u', hostname: 'h' }),
  verifyStagingEdge: async () => {},
});
fakeModule('../src/services/sync-main', {
  // Mirror the real persistBehindMain's DB write so the recording pool
  // captures it (the test asserts drift is refreshed).
  persistBehindMain: async (pool, session, n) => {
    await pool.query('UPDATE chat_sessions SET behind_main = $1 WHERE id = $2', [n, session.id]);
  },
  persistConflictState: async () => {},
});
fakeModule('../src/services/staging-recovery', {
  recordStagingBootFailure: async () => {},
});

const fakeVisuals = require('../src/services/visuals');
const fakeStaging = require('../src/services/staging');
const fakeRecovery = require('../src/services/staging-recovery');
const prImportSync = require('../src/services/pr-import-sync');

// ── governedGate head-scoping ─────────────────────────────────────────
//
// A scripted pool that answers the governance queries AND honours the
// optional `head_sha = $N` predicate Slice 3 threads into qualifiedCounts.
// Votes carry an optional `headSha`; when the gate is head-scoped only
// matching votes count.
function mockPool({ policy, atLeast, members, admins, votes, activeCount }) {
  return {
    query: async (sql, params) => {
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) {
        return { rows: [{ approver_policy: policy, approvals_required: atLeast }] };
      }
      if (/SELECT user_id FROM app_approvers/.test(sql)) {
        return { rows: (members || []).map((id) => ({ user_id: id })) };
      }
      if (/SELECT id FROM users WHERE is_admin = TRUE/.test(sql)) {
        return { rows: (admins || []).map((id) => ({ id })) };
      }
      if (/FILTER \(WHERE vote = /.test(sql)) {
        // Restricted electorate. params = [id, approverIds, headSha?].
        const allowed = params[1];
        const headSha = params.length > 2 ? params[2] : null;
        const scoped = /AND head_sha = \$3/.test(sql);
        const counted = (votes || []).filter((v) =>
          allowed.includes(v.userId) && (!scoped || v.headSha === headSha));
        return {
          rows: [{
            yes: String(counted.filter((v) => v.vote === 'yes').length),
            no: String(counted.filter((v) => v.vote === 'no').length),
          }],
        };
      }
      if (/SELECT COUNT\(\*\) as cnt FROM (pr_votes|issue_votes)/.test(sql)) {
        // Unrestricted electorate. params = [id, headSha?].
        const side = /vote = 'yes'/.test(sql) ? 'yes' : 'no';
        const headSha = params.length > 1 ? params[1] : null;
        const scoped = /AND head_sha = \$2/.test(sql);
        const counted = (votes || []).filter((v) =>
          v.vote === side && (!scoped || v.headSha === headSha));
        return { rows: [{ cnt: String(counted.length) }] };
      }
      if (/SELECT self_hosted, collab_visibility FROM apps/.test(sql)) {
        return { rows: [{ self_hosted: false, collab_visibility: 'public' }] };
      }
      if (/COUNT\(DISTINCT a\.user_id\) AS cnt/.test(sql)) {
        return { rows: [{ cnt: String(activeCount || 0) }] };
      }
      return { rows: [] };
    },
  };
}

let nextAppId = 5000;

test('governedGate: imported gate counts only approvals matching the current head', async () => {
  const appId = nextAppId++;
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);
  const pool = mockPool({
    policy: 'invited', atLeast: 1, activeCount: 50,
    members: [10, 11],
    votes: [
      { userId: 10, vote: 'yes', headSha: OLD },
      { userId: 11, vote: 'yes', headSha: NEW },
    ],
  });
  const gateNew = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 42, openedAt: Date.now(), headSha: NEW,
  });
  assert.equal(gateNew.qualifiedYes, 1, 'only the current-head approval counts');
  assert.equal(gateNew.mergeable, true);
});

test('governedGate: a superseded-head approval alone does NOT satisfy the gate', async () => {
  const appId = nextAppId++;
  const OLD = 'c'.repeat(40);
  const NEW = 'd'.repeat(40);
  const pool = mockPool({
    policy: 'invited', atLeast: 1, activeCount: 50,
    members: [10, 11],
    votes: [{ userId: 10, vote: 'yes', headSha: OLD }],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 43, openedAt: Date.now(), headSha: NEW,
  });
  assert.equal(gate.qualifiedYes, 0, 'the stale-revision approval is ignored');
  assert.equal(gate.mergeable, false, 'the head change re-opened approval');
});

test('governedGate: no headSha (native proposal) counts every approver vote', async () => {
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: 1, activeCount: 50,
    members: [10, 11],
    votes: [
      { userId: 10, vote: 'yes', headSha: null },
      { userId: 11, vote: 'yes', headSha: 'e'.repeat(40) },
    ],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 44, openedAt: Date.now(), // no headSha → unfiltered
  });
  assert.equal(gate.qualifiedYes, 2, 'native counting is unchanged (no head filter)');
});

test('qualifiedCounts: anyone policy honours the head filter for imported rows', async () => {
  const H = 'f'.repeat(40);
  const pool = mockPool({
    policy: 'anyone', atLeast: null, activeCount: 4,
    votes: [
      { userId: 1, vote: 'yes', headSha: H },
      { userId: 2, vote: 'yes', headSha: '0'.repeat(40) },
      { userId: 3, vote: 'no', headSha: H },
    ],
  });
  const scoped = await governance.qualifiedCounts(pool, 'pr', 7, null, H);
  assert.deepEqual(scoped, { yes: 1, no: 1 }, 'only current-head votes count');
  const unscoped = await governance.qualifiedCounts(pool, 'pr', 7, null, null);
  assert.deepEqual(unscoped, { yes: 2, no: 1 }, 'no head filter → all votes count');
});

// ── syncImportedProposal ──────────────────────────────────────────────

// Save/restore individual fake methods so tests don't leak stubs.
function withStubs(stubs, fn) {
  const originals = stubs.map(([mod, key]) => [mod, key, mod[key]]);
  for (const [mod, key, val] of stubs) mod[key] = val;
  return (async () => {
    try { return await fn(); }
    finally { for (const [mod, key, val] of originals) mod[key] = val; }
  })();
}

function recordingPool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
  };
}

// `status` matters since #1162: an import can be In progress (no votes to
// clear, so no "please re-review") or up for vote. Both callers of
// syncImportedProposal select cs.*, so the column is always present.
const SESSION = {
  id: 321, app_id: 9, app_slug: 'demo', app_name: 'Demo', status: 'promoted',
  source: 'imported', pr_number: 77, pr_title: 'External work',
  branch_name: 'feature/x', repo_url: 'https://github.com/acme/demo',
  imported_pr_head_sha: 'a'.repeat(40),
};

test('syncImportedProposal: unchanged head no-ops (one getPR, no writes)', async () => {
  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
  ], async () => {
    let getPrCalls = 0;
    const realGetPr = fakeGithub.getPR;
    fakeGithub.getPR = async (...a) => { getPrCalls++; return realGetPr(...a); };
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({ config: {}, pool, session: { ...SESSION } });
    assert.equal(res, 'unchanged');
    assert.equal(getPrCalls, 1);
    assert.equal(pool.calls.length, 0, 'unchanged head performs no writes');
  });
});

test('syncImportedProposal: head change resets tally, posts re-review, re-runs pinned checks', async () => {
  const NEW = 'b'.repeat(40);
  const sysMessages = [];
  let buildSha = null;
  let captureSha = null;

  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeGithub, 'getOctokit', async () => ({ rest: { repos: { compareCommits: async () => ({ data: { behind_by: 3 } }) } } })],
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content, msgType, meta, thread) => {
      sysMessages.push({ content, msgType, meta, thread });
    }],
    [fakeStaging, 'buildAndDeployStaging', async (_c, _s, _a, sha) => { buildSha = sha; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
    [fakeVisuals, 'captureForSession', async (_c, _s, _a, sha) => { captureSha = sha; }],
  ], async () => {
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({ config: {}, pool, session: { ...SESSION } });
    assert.equal(res, 'updated');

    const sqls = pool.calls.map((c) => c.sql);
    const headUpdate = pool.calls.find((c) => /SET imported_pr_head_sha = \$1/.test(c.sql));
    assert.ok(headUpdate, 'imported_pr_head_sha is advanced');
    assert.equal(headUpdate.params[0], NEW);

    assert.ok(sqls.some((s) => /DELETE FROM pr_votes WHERE session_id = \$1/.test(s)), 'vote tally cleared');

    assert.equal(sysMessages.length, 1, 'exactly one re-review note');
    assert.match(sysMessages[0].content, /updated on GitHub/i);
    assert.match(sysMessages[0].content, /re-review/i);
    assert.deepEqual(sysMessages[0].thread, { type: 'session', ref: SESSION.id });
    // #866: the rebuild rides as an appended clause on that ONE note rather
    // than a second post — the card's Preview slot going back to
    // "building…" is a consequence of the same event.
    assert.match(sysMessages[0].content, /preview and automated checks are being rebuilt/i);

    assert.ok(sqls.some((s) => /SET behind_main = \$1/.test(s)), 'behind_main refreshed');

    assert.equal(buildSha, NEW, 'staging build pinned to the new head SHA');
    assert.equal(captureSha, NEW, 'checks captured against the new head SHA');
  });
});

// #1162 — the same head change on an In-progress import. Everything the
// sweeper DOES is unchanged (advance the SHA, rebuild the pinned preview);
// what changes is the note it posts, because an In-progress import has no
// votes to have cleared. Telling people their votes were cleared and asking
// them to re-review a proposal nobody was ever asked to vote on is a false
// statement, and it is the note most likely to be read on the board.
test('syncImportedProposal: an In-progress import is told the preview is rebuilding, not to re-review', async () => {
  const NEW = 'b'.repeat(40);
  const sysMessages = [];
  let buildSha = null;

  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeGithub, 'getOctokit', async () => ({ rest: { repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) } } })],
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content, msgType, meta, thread) => {
      sysMessages.push({ content, msgType, meta, thread });
    }],
    [fakeStaging, 'buildAndDeployStaging', async (_c, _s, _a, sha) => { buildSha = sha; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
    [fakeVisuals, 'captureForSession', async () => {}],
  ], async () => {
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({
      config: {}, pool, session: { ...SESSION, status: 'active' },
    });
    assert.equal(res, 'updated');

    assert.equal(sysMessages.length, 1, 'still exactly one note');
    assert.match(sysMessages[0].content, /updated on GitHub/i);
    assert.doesNotMatch(sysMessages[0].content, /re-review/i,
      'nobody was asked to review it yet, so there is nothing to re-review');
    assert.doesNotMatch(sysMessages[0].content, /votes/i,
      'an In-progress import has no votes to have cleared');
    assert.match(sysMessages[0].content, /preview and automated checks are being rebuilt/i,
      'the preview really is rebuilding, In progress or not');

    assert.equal(buildSha, NEW, 'the pinned rebuild happens either way');
    const headUpdate = pool.calls.find((c) => /SET imported_pr_head_sha = \$1/.test(c.sql));
    assert.equal(headUpdate.params[0], NEW, 'the head SHA still advances');
  });
});

// #866 — the rebuild path shares the withdrawn-mid-build guard with the
// import-time kick: a proposal closed while the (minutes-long) rebuild ran
// must not have the finished preview persisted onto it.
test('rerunChecksForNewHead discards the rebuild when the proposal is no longer open', async () => {
  const NEW = 'c'.repeat(40);
  let toreDown = null;
  await withStubs([
    [fakeStaging, 'buildAndDeployStaging', async () => ({ containerId: 'cid2', stagingUrl: 'https://s2', hostname: 'h' })],
    [fakeStaging, 'teardownStaging', async (s, app) => {
      toreDown = { containerId: s.staging_container_id, url: s.staging_url, slug: app && app.slug };
    }],
  ], async () => {
    const calls = [];
    const pool = {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT status FROM chat_sessions/.test(sql)) return { rows: [{ status: 'archived' }] };
        return { rows: [] };
      },
    };
    await prImportSync.rerunChecksForNewHead({
      config: {}, pool, session: { ...SESSION }, newHead: NEW,
    });

    assert.ok(!calls.some((c) => /UPDATE chat_sessions SET staging_container_id/.test(c.sql)),
      'no staging_url written onto a withdrawn proposal');
    assert.deepEqual(toreDown, { containerId: 'cid2', url: 'https://s2', slug: 'demo' },
      'the fresh container + URL are torn down instead');
  });
});

// #866 — a failed rebuild records the terminal verdict (which is what
// narrates the reason into the thread — see recordStagingBootFailure) and
// pushes staging_failed so open cards flip to "Preview unavailable" live
// instead of holding a spinner until something else refetches.
test('rerunChecksForNewHead records the failure and pushes staging_failed', async () => {
  const NEW = 'd'.repeat(40);
  const pushes = [];
  const recorded = [];
  await withStubs([
    [fakeStaging, 'buildAndDeployStaging', async () => { throw new Error('missing secret OPENAI_KEY'); }],
    [fakeRecovery, 'recordStagingBootFailure', async ({ commitHash, err }) => {
      recorded.push({ commitHash, message: err.message });
    }],
    [fakeWs, 'pushSessionUpdate', (payload) => { pushes.push(payload); }],
  ], async () => {
    const pool = recordingPool();
    await assert.rejects(
      prImportSync.rerunChecksForNewHead({ config: {}, pool, session: { ...SESSION }, newHead: NEW }),
      /missing secret/,
      'the failure still propagates to the caller (which logs it)'
    );
    assert.deepEqual(recorded, [{ commitHash: NEW, message: 'missing secret OPENAI_KEY' }],
      'verdict recorded against the new head');
    assert.deepEqual(pushes.map((p) => p.action), ['staging_failed']);
    assert.equal(pushes[0].appSlug, 'demo');
    assert.ok(!pool.calls.some((c) => /UPDATE chat_sessions SET staging_container_id/.test(c.sql)),
      'no preview persisted for a build that failed');
  });
});

test('syncImportedProposal: native rows are skipped', async () => {
  const pool = recordingPool();
  const res = await prImportSync.syncImportedProposal({ config: {}, pool, session: { ...SESSION, source: 'native' } });
  assert.equal(res, 'skipped');
  assert.equal(pool.calls.length, 0);
});
