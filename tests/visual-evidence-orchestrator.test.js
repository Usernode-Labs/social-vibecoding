'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/services/visual-evidence-plan');
const controlPlane = require('../src/services/visual-evidence-control');
const orchestrator = require('../src/services/visual-evidence-orchestrator');
const fixtures = require('./fixtures/visual-evidence');

const RUN_ID = '1'.repeat(32);
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const provenance = {
  baseSha: BASE,
  headSha: HEAD,
  fixtureFingerprint: 'fixture-1',
  baseImageDigest: 'sha256:base',
  headImageDigest: 'sha256:head',
};

function setup({ dispatch, storeArtifacts } = {}) {
  const transitions = [];
  const calls = { resets: 0, passes: [], stored: 0, cleaned: 0, dispatches: 0 };
  let currentState = 'planned';
  const pool = {
    query: async (sql) => {
      if (/SELECT active_turn/.test(String(sql))) return { rows: [{ active_turn: false }] };
      throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
    },
  };
  const run = {
    id: RUN_ID, session_id: 42, state: 'planned', base_sha: BASE, head_sha: HEAD,
    intent: contract.parseIntent(fixtures.intent()),
  };
  const session = {
    id: 42, user_id: 7, app_id: 9, app_slug: 'demo', branch_name: 'proposal',
    repo_url: 'https://github.com/acme/demo.git', agent_backend: 'claude_code',
  };
  const app = { id: 9, slug: 'demo', repo_url: session.repo_url };
  const pair = {
    fixtureFingerprint: provenance.fixtureFingerprint,
    sides: {
      base: { imageDigest: provenance.baseImageDigest, checkout: '/tmp/base' },
      head: { imageDigest: provenance.headImageDigest, checkout: '/tmp/head' },
    },
  };
  const artifacts = [{
    storyId: 'invite-suggestions', viewport: 'desktop', side: 'head',
    variant: 'focus', media: 'png', contentType: 'image/png', data: Buffer.from('png'),
  }];
  const dependencies = {
    state: {
      transitionRun: async (_pool, _runId, next, patch) => {
        transitions.push({ next, patch });
        currentState = next;
        return { ...run, state: next };
      },
      getForSession: async () => ({ state: currentState, headSha: HEAD }),
      getRun: async () => ({ ...run, state: currentState, current_run_id: RUN_ID }),
    },
    environment: {
      preparePair: async () => pair,
      resetPair: async () => {
        calls.resets += 1;
        return {
          origins: { base: 'http://base.internal:3000', head: 'http://head.internal:3000' },
          ...provenance,
        };
      },
      cleanupPair: async () => { calls.cleaned += 1; },
    },
    identities: { mintEvidenceAuthTokens: async () => ({ member: 'member.jwt', read_only_admin: 'admin.jwt' }) },
    replay: {
      runPass: async (_config, _sessionId, input) => {
        calls.passes.push(input.pass);
        return {
          result: { passed: true, pass: input.pass, planHash: contract.planHash(input.plan) },
          artifacts: input.pass === 2 ? artifacts : [],
        };
      },
      comparePasses: (_first, second, { plan }) => ({
        passed: true, runs: 2, stories: [{ id: 'invite-suggestions', viewport: 'desktop' }],
        relativePointer: false, planHash: contract.planHash(plan || fixtures.plan()),
      }),
      storeArtifacts: storeArtifacts || (async () => { calls.stored += 1; }),
    },
    reviewer: { review: async () => { throw new Error('fallback reviewer should not run'); } },
    evidenceAgent: {
      dispatch: async (_config, options) => {
        calls.dispatches += 1;
        if (dispatch) return dispatch(options, calls.dispatches);
        const control = controlPlane.forRequest({ runId: options.runId, sessionId: session.id });
        const result = await control.runPlan(fixtures.plan());
        control.finish({
          status: 'verified', reason: 'The replayed pair demonstrates the dialog change.',
          planHash: result.planHash,
        });
        return { backend: 'claude_code', threadId: 'thread-1' };
      },
    },
    evidenceControl: controlPlane,
    worker: { isInFlight: () => false },
  };
  return { pool, run, session, app, pair, artifacts, dependencies, transitions, calls };
}

async function execute(fixture) {
  controlPlane._clearForTests();
  return orchestrator.executeRun({
    visualEvidence: { maxRunMs: 60_000, maxAgentMs: 10_000 },
  }, {
    pool: fixture.pool,
    run: fixture.run,
    session: fixture.session,
    app: fixture.app,
    revision: { baseSha: BASE, headSha: HEAD, files: [], filesComplete: true },
  }, fixture.dependencies);
}

test('a successful agent plan is replayed twice from fresh paired state before verification', async () => {
  const fixture = setup();
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.deepEqual(fixture.calls.passes, [1, 2]);
  assert.equal(fixture.calls.resets, 3, 'one exploration reset and one per clean replay');
  assert.equal(fixture.calls.stored, 1, 'only the second pass media is stored');
  assert.equal(fixture.calls.cleaned, 1);
  assert.deepEqual(fixture.transitions.map((entry) => entry.next),
    ['provisioning', 'exploring', 'replaying', 'reviewing', 'verified']);
});

test('an irrelevant first result gets exactly one corrected replay-plan attempt', async () => {
  const fixture = setup({
    dispatch: async (options, attempt) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      const nextPlan = JSON.parse(JSON.stringify(fixtures.plan()));
      if (attempt === 2) nextPlan.stories[0].replay.after.actions[1].target.value = 'invite-member-v2';
      const result = await control.runPlan(nextPlan);
      control.finish(attempt === 1
        ? { status: 'not_relevant', reason: 'The crop hid the changed list.' }
        : { status: 'verified', reason: 'The corrected crop clearly shows the list.', planHash: result.planHash });
      return { backend: 'claude_code', threadId: `thread-${attempt}` };
    },
  });
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.deepEqual(fixture.calls.passes, [1, 2, 1, 2]);
  assert.equal(fixture.transitions.filter((entry) => entry.next === 'replaying').length, 2);
  assert.equal(fixture.transitions.at(-1).patch.repairAttempt, 1);
});

test('a Codex model that fails before submitting a plan falls back to the platform vision agent', async () => {
  const fixture = setup({
    dispatch: async (options, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('model cannot use browser tools'), { code: 'evidence_agent_failed' });
      assert.equal(options.forceBackend, 'claude_code');
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      const result = await control.runPlan(fixtures.plan());
      control.finish({
        status: 'verified', reason: 'The fallback vision agent verified the exact replay.',
        planHash: result.planHash,
      });
      return { backend: 'claude_code', threadId: 'fallback-thread' };
    },
  });
  fixture.session.agent_backend = 'codex_openrouter';
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.deepEqual(fixture.calls.passes, [1, 2]);
});

test('a stale artifact fence cannot publish or transition the superseded run to verified', async () => {
  const stale = Object.assign(new Error('The proposal head moved.'), { code: 'stale_evidence_operation' });
  const fixture = setup({ storeArtifacts: async () => { throw stale; } });
  fixture.dependencies.state.getRun = async () => ({
    ...fixture.run, state: 'reviewing', current_run_id: '2'.repeat(32),
  });
  await assert.rejects(execute(fixture), { code: 'stale_evidence_operation' });
  assert.equal(fixture.calls.cleaned, 1);
  assert.equal(fixture.transitions.some((entry) => entry.next === 'verified'), false);
  assert.equal(fixture.transitions.some((entry) => entry.next === 'failed'), false,
    'the newer run owns the state slot and must not be overwritten');
});

test('revision resolution prefers the immutable recorded base and reviewed head', async () => {
  assert.equal(orchestrator.headForSession({
    reviewed_head_sha: HEAD,
    handoff_head_sha: 'c'.repeat(40),
    checks_commit_sha: 'd'.repeat(40),
  }), HEAD);
  let repoHeadCalls = 0;
  const refs = [];
  const result = await orchestrator.resolveRevisionContext({
    repo_url: 'https://github.com/acme/demo.git',
    handoff_base_sha: BASE,
    reviewed_head_sha: HEAD,
  }, null, {
    getRepoHead: async () => { repoHeadCalls += 1; throw new Error('must not move the base'); },
    compareRefs: async (_owner, _repo, ref) => {
      refs.push(ref);
      return { files: ['frontend/dialog.tsx'], filesComplete: true };
    },
    getProposalDiff: async (_owner, _repo, ref, budget) => {
      assert.equal(ref, `${BASE}...${HEAD}`);
      assert.equal(budget, 8000);
      return { diff: 'diff --git a/frontend/dialog.tsx b/frontend/dialog.tsx', fileCount: 1, truncated: false };
    },
  });
  assert.equal(repoHeadCalls, 0);
  assert.deepEqual(refs, [`${BASE}...${HEAD}`]);
  assert.equal(result.baseSha, BASE);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.diffSummary.fileCount, 1);
  assert.match(result.diffSummary.text, /frontend\/dialog\.tsx/);
});

test('paired resets are fenced by both exact revisions and immutable fixture provenance', () => {
  assert.equal(orchestrator.sameProvenance(provenance, provenance), true);
  assert.equal(orchestrator.sameProvenance({ ...provenance, headSha: 'c'.repeat(40) }, provenance), false);
  assert.equal(orchestrator.sameProvenance({ ...provenance, baseImageDigest: 'sha256:other' }, provenance), false);
});

// ── #2601/#2558: a run that never starts says why ────────────────────────
//
// Every proposal submitted through the connector sat at 'planned' from
// submission to merge, because `recordIntent` writes that state and only a
// scheduled run moves it on. When scheduling was refused the reason was a
// return value the caller logged at warn and dropped, so the reviewer
// surfaces had nothing to show and span indefinitely.
test('a refused schedule records why on the proposal and returns its reason', async () => {
  const notStarted = [];
  const cleared = [];
  const injected = {
    state: {
      recordNotStarted: async (_pool, sessionId, reason) => {
        notStarted.push({ sessionId, reason });
        return { recorded: true };
      },
      clearNotStarted: async (_pool, sessionId) => { cleared.push(sessionId); return { cleared: true }; },
    },
  };

  // Execution switched off: refused before any session is even loaded, so
  // this is the one refusal a pool lookup can never explain.
  const disabledPool = {
    query: async () => { throw new Error('must not load a session when execution is off'); },
  };
  const disabled = await orchestrator.scheduleForSession(
    { visualEvidence: { execute: false } },
    { pool: disabledPool, sessionId: 42 },
    injected
  );
  assert.equal(disabled.scheduled, false);
  assert.equal(disabled.reason, 'disabled');

  // No claim recorded: there is nothing to run.
  const noIntentPool = {
    query: async () => ({ rows: [{ id: 42, app_id: 9, app_slug: 'demo', visual_evidence_detail: null }] }),
  };
  const missing = await orchestrator.scheduleForSession(
    { visualEvidence: { execute: true } },
    { pool: noIntentPool, sessionId: 42 },
    injected
  );
  assert.equal(missing.scheduled, false);
  assert.equal(missing.reason, 'missing_intent');

  assert.deepEqual(notStarted.map((n) => n.sessionId), [42, 42]);
  assert.deepEqual(
    notStarted.map((n) => n.reason),
    [orchestrator.NOT_STARTED_REASONS.disabled, orchestrator.NOT_STARTED_REASONS.missing_intent]
  );
  assert.deepEqual(cleared, [], 'nothing started, so nothing to clear');
  for (const note of notStarted) {
    assert.ok(note.reason.length > 20, 'the stored reason is a sentence a reviewer can read');
    assert.ok(!note.reason.includes('_'), `no bare refusal code reaches a reviewer: ${note.reason}`);
  }
});

test('the refusal reasons are a closed set, and the two non-failures are absent', () => {
  assert.deepEqual(Object.keys(orchestrator.NOT_STARTED_REASONS).sort(),
    ['disabled', 'missing_intent', 'no_revision', 'no_staging_preview']);
  // `already_running` is a run that IS going and `not_required` is a
  // settled verdict; neither is a run that failed to start, so neither may
  // ever write a "not started" note over a state that says more.
  assert.equal(orchestrator.NOT_STARTED_REASONS.already_running, undefined);
  assert.equal(orchestrator.NOT_STARTED_REASONS.not_required, undefined);
});

test('an unknown refusal logs but writes nothing, so no proposal carries an empty reason', async () => {
  let recorded = 0;
  await orchestrator.noteNotStarted({}, 42, 'something_new', {
    state: { recordNotStarted: async () => { recorded += 1; return { recorded: true }; } },
  });
  assert.equal(recorded, 0);
});
