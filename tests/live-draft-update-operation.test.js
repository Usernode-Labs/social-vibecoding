'use strict';

// 20 Nov 2026 (live-draft review, C): `draft.update`, the conductor
// operation behind a live draft's Update proposal
// (src/services/live-draft-update-operation.js). It moves the proposal's
// branch to the draft's head only as a fast-forward, under the proposal
// lock, then hands the move to the head-moved machinery
// (proposal-update.js settleLandedHead), and refuses a draft that is not the
// requester's, not up for a vote, or whose proposal is no longer open.

const test = require('node:test');
const assert = require('node:assert/strict');

const github = require('../src/services/github');
const proposalUpdate = require('../src/services/proposal-update');
const appAccess = require('../src/services/app-access');
const communities = require('../src/services/communities');
const op = require('../src/services/live-draft-update-operation');
const platformOperations = require('../src/services/platform-operations');
const { OPERATIONS } = require('../src/workflow/platform-operation/machine.ts');

const HEAD = 'b'.repeat(40);

function fakePool(draft) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (/FROM live_drafts d/.test(sql)) return { rows: draft && Number(params[0]) === draft.id ? [draft] : [] };
      if (/FROM apps WHERE id/.test(sql)) return { rows: [{ id: 4, slug: 'gym' }] };
      if (/FROM chat_sessions WHERE id/.test(sql)) return { rows: [{ id: 50, status: 'promoted' }] };
      if (/^UPDATE live_drafts/.test(sql.trim())) { writes.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

function steps() {
  const kept = new Map();
  return { has: (k) => kept.has(k), async once(k, fn) { if (!kept.has(k)) kept.set(k, await fn()); return kept.get(k); } };
}

test('draft.update is a registered platform operation, on both sides', () => {
  assert.ok(OPERATIONS.has('draft.update'));
  assert.ok(platformOperations.OPERATIONS.has('draft.update'));
});

test('draft.update moves the proposal to the draft\'s head as a fast-forward, then settles it', async (t) => {
  const draft = {
    id: 3, user_id: 7, app_id: 4, state: 'proposed', head_sha: HEAD, proposal_session_id: 50, proposed_head_sha: 'a'.repeat(40),
    app_slug: 'gym', repo_url: 'https://github.com/acme/gym', proposal_status: 'promoted', proposal_branch: 'dev/draft-50',
  };
  const pool = fakePool(draft);
  const calls = [];
  const saved = {
    advance: github.advanceBranchToSha, settle: proposalUpdate.settleLandedHead, lock: proposalUpdate.withProposalLock,
    access: appAccess.checkAppAccess, join: communities.appNeedsJoin,
  };
  t.after(() => {
    github.advanceBranchToSha = saved.advance; proposalUpdate.settleLandedHead = saved.settle;
    proposalUpdate.withProposalLock = saved.lock; appAccess.checkAppAccess = saved.access; communities.appNeedsJoin = saved.join;
  });
  appAccess.checkAppAccess = async () => true;
  communities.appNeedsJoin = async () => null;
  proposalUpdate.withProposalLock = async (_p, id, fn) => { calls.push(['lock', id]); return fn(); };
  github.advanceBranchToSha = async (...args) => { calls.push(['advance', ...args]); return { previousSha: draft.proposed_head_sha, updated: true }; };
  proposalUpdate.settleLandedHead = async ({ session, headSha, via }) => { calls.push(['settle', session.id, headSha, via]); return { tail: 'proposal', rebuilding: true }; };

  const request = { appId: 4, input: { draftId: 3, sessionId: 50, head: HEAD } };
  const user = { id: 7 };
  assert.equal(await op.authorize({ pool }, request, user), null);
  const out = await op.run({ config: {}, pool }, request, user, steps());
  assert.deepEqual(out, { updated: true, head: HEAD, rebuilding: true });
  assert.deepEqual(calls, [
    ['lock', 50], ['advance', 'acme', 'gym', 'dev/draft-50', HEAD], ['settle', 50, HEAD, 'homeroom'],
  ]);
  assert.deepEqual(pool.writes, [[3, HEAD]], 'the draft records the head its proposal is at now');

  // Not theirs, not up for a vote, or a proposal no longer open: refused.
  assert.equal((await op.authorize({ pool }, request, { id: 8 })).status, 404);
  assert.equal((await op.authorize({ pool }, { ...request, input: { ...request.input, sessionId: 51 } }, user)).status, 404);
  draft.proposal_status = 'merging';
  assert.equal((await op.authorize({ pool }, request, user)).status, 409);
  draft.proposal_status = 'promoted';

  // A proposal that moved some other way is refused, never overwritten.
  github.advanceBranchToSha = async () => { throw Object.assign(new Error('nope'), { code: 'non_fast_forward' }); };
  calls.length = 0;
  const moved = await op.run({ config: {}, pool }, request, user, steps());
  assert.deepEqual([moved.ok, moved.status, moved.code], [false, 409, 'branch_moved']);
  assert.ok(!calls.some((c) => c[0] === 'settle'));
});
