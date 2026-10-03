'use strict';

// Real disposable PostgreSQL and the actual fork-submission producer/decisions.
// GitHub, mirror classification, build/runtime/activation and capture I/O are
// injected. This suite is not additional actual Kubernetes integration evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { enabled } = require('./lib/preview-postgres-fixture');
const { fixture, candidate, tick } = require('./lib/manual-preview-fixture');
const producer = require('../src/services/proposal-update');
const { createNativePreviewWork } = require('../src/services/cli-preview-handoff/work');
const { PREPARE_RUNTIME } = require('../src/services/preview-flow/work');
const { replayDecision } = require('../src/services/cli-preview-handoff/reducer');
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
const testing = { testingPaths: ['/changed'], testingSteps: 'Check the changed screen.' };

async function setup(t, { status = 'active', moveKind = 'authored', enroll = true } = {}) {
  const f = await fixture(t, { native: true });
  await f.pool.query(`ALTER TABLE apps ADD COLUMN collab_visibility TEXT, ADD COLUMN view_visibility TEXT;
    ALTER TABLE chat_sessions ADD COLUMN testing_paths JSONB, ADD COLUMN testing_path TEXT, ADD COLUMN testing_md TEXT,
      ADD COLUMN pr_summary_input_version INTEGER DEFAULT 0, ADD COLUMN pr_summary_md TEXT,
      ADD COLUMN pr_summary_previous_md TEXT, ADD COLUMN pr_summary_stale BOOLEAN DEFAULT FALSE,
      ADD COLUMN pr_summary_source TEXT, ADD COLUMN pr_summary_source_head_sha TEXT,
      ADD COLUMN shots_state TEXT, ADD COLUMN shots_run_id TEXT, ADD COLUMN shots_detail JSONB,
      ADD COLUMN shots_updated_at TIMESTAMPTZ;
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE pr_votes (session_id INTEGER, approval_epoch INTEGER);
    INSERT INTO pr_votes VALUES (1,7),(1,7);
    CREATE TABLE chat_session_messages (id SERIAL PRIMARY KEY, session_id INTEGER, role TEXT, content TEXT, metadata JSONB)`);
  const schema = readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await f.pool.query(schema.match(/CREATE TABLE IF NOT EXISTS shot_runs \([\s\S]*?\n\);/)[0]);
  const work = f.make();
  let baseline;
  if (enroll) {
    baseline = await work.admitManual({ session: await f.session(), headSha: HEAD,
      kind: 'deploy', requestId: randomUUID(), userId: 1 });
    await candidate(f, work, baseline);
    await tick(work);
  }
  await f.pool.query(`UPDATE chat_sessions SET status = $1,
    reviewed_head_sha = CASE WHEN $1 = 'promoted' THEN $2 ELSE NULL END,
    approval_epoch = 7, pr_summary_md = 'Previous explanation', shots_state = 'reviewing',
    shots_run_id = $3, shots_detail = $4 WHERE id = 1`,
  [status, HEAD, '1'.repeat(32), JSON.stringify({ headSha: HEAD, required: true })]);
  await f.pool.query(`INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state)
    VALUES ($1,1,$2,$2,'{}','reviewing')`, ['1'.repeat(32), HEAD]);

  let liveHead = HEAD;
  let pushes = 0;
  let afterPush = async () => {};
  let activeWork = work;
  const external = {
    isEnabled: () => true,
    parseGithubUrl: () => ({ owner: 'example', repo: 'demo' }),
    getBranchSha: async () => liveHead,
    compareCommitAncestry: async () => ({ status: 'ahead' }),
  };
  const forbidden = () => assert.fail('Replaced web preparation/check/teardown owner');
  async function submit(headSha = NEXT, extra = {}) {
    return producer.updateProposalFromForkBranch({
      pool: f.pool, config: f.config, gh: external, nativeWork: activeWork,
      githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'author' }) },
      head: {
        validRef: () => true, validSegment: () => true,
        verifyForkBranch: async () => ({ ok: true, headSha, forkRepo: 'demo' }),
        async pushForkBranchToAppBranch({ expectedRemoteSha }) {
          assert.equal(expectedRemoteSha, liveHead, 'Retain lease-checked push');
          liveHead = headSha;
          pushes++;
          await afterPush();
          return { ok: true };
        },
      },
      inspectSubmissionReview: async () => ({ kind: moveKind }),
      votes: { reconcileNativeReviewedHead: forbidden, announceNativeHeadMove: async () => {} },
      pipeline: { beginHandoffPipeline: forbidden, startHandoffPipeline: forbidden },
      lifecycle: { teardownStaging: forbidden },
      busy: () => false, beginOperation: () => () => {},
    }, { user: { id: 1, username: 'author' }, session: await f.session(),
      branch: 'proposal', expectedHeadSha: HEAD, testing, ...extra });
  }
  return { ...f, work, baseline, submit, github: external, pushes: () => pushes,
    afterPush: value => { afterPush = value; }, use: value => { activeWork = value; } };
}

async function preparations(f, headSha) {
  return (await f.pool.query(`SELECT * FROM execution_work_requests
    WHERE workflow = $1 AND input->'identity'->>'headSha' = $2`, [PREPARE_RUNTIME, headSha])).rows;
}

function assertReplay(traces) {
  for (const entry of traces) assert.deepEqual(replayDecision(entry), entry.decision);
}

test('native changed-head producer: atomic admission, reply loss, restart, completed retry and durable continuation',
  { skip: !enabled }, async t => {
    const f = await setup(t);
    const serving = await f.session();
    let lost = false;
    const losingPool = {
      query: (...args) => f.pool.query(...args),
      async connect() {
        const client = await f.pool.connect();
        return {
          async query(...args) {
            const result = await client.query(...args);
            if (args[0] === 'COMMIT' && !lost) {
              lost = true;
              throw new Error('Lost committed admission acknowledgment');
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    };
    f.use(createNativePreviewWork(losingPool, f.config));
    await assert.rejects(f.submit(), /Lost committed/);
    assert.equal((await f.session()).checks_commit_sha, NEXT);
    assert.equal((await f.session()).testing_path, '/changed');
    assert.equal((await f.session()).staging_runtime_name, serving.staging_runtime_name);
    assert.equal((await f.session()).pr_summary_stale, true);
    assert.equal((await f.pool.query('SELECT state FROM shot_runs')).rows[0].state, 'cancelled');
    const restarted = f.make();
    f.use(restarted);
    const replies = await Promise.all(Array.from({ length: 4 }, () => f.submit()));
    assert.ok(replies.every(reply => reply.ok && reply.preparationRequest.replayed));
    const [prepared] = await preparations(f, NEXT);
    assert.equal((await preparations(f, NEXT)).length, 1);
    assert.equal(replies[0].preparationRequest.workId, prepared.id);
    assert.equal(f.pushes(), 1);
    const admitted = { work: prepared };
    await candidate(f, restarted, admitted);
    const continuation = (await restarted.owner.read(1)).handoff.continuation_work_id;
    assert.ok(continuation, 'Candidate completion durably hands off continuation');
    await tick(f.make());
    assert.equal((await f.session()).check_state, 'passing');
    assert.equal((await restarted.store.read(continuation)).status, 'succeeded');
    f.config.nativeManualPreviewEnabled = false;
    const completed = await f.submit();
    assert.equal(completed.preparationRequest.workId, prepared.id);
    assert.equal(completed.preparationRequest.replayed, true);
    assert.equal((await preparations(f, NEXT)).length, 1);
    const headerless = await f.submit(NEXT, { expectedHeadSha: undefined });
    assert.equal(headerless.preparationRequest.workId, prepared.id);
    assert.equal((await f.pool.query('SELECT COUNT(*) FROM chat_session_messages')).rows[0].count, '1');
    assertReplay(await restarted.owner.trace(1));
  });

test('native changed-head producer: failed enqueue rolls back all admission writes; landed push retry reconciles',
  { skip: !enabled }, async t => {
    const f = await setup(t);
    const before = await f.session();
    const traces = (await f.work.owner.trace(1)).length;
    const request = f.work.preview.requestInTransaction;
    f.work.preview.requestInTransaction = async (...args) => {
      await request(...args);
      throw new Error('Interruption after required preparation write');
    };
    await assert.rejects(f.submit(), /Interruption after required/);
    assert.equal((await preparations(f, NEXT)).length, 0);
    assert.equal((await f.session()).checks_commit_sha, HEAD);
    assert.equal((await f.session()).check_state, before.check_state);
    assert.equal((await f.session()).testing_paths, null);
    assert.equal((await f.pool.query('SELECT COUNT(*) FROM chat_session_messages')).rows[0].count, '0');
    assert.equal((await f.session()).pr_summary_stale, false);
    assert.equal((await f.pool.query('SELECT state FROM shot_runs')).rows[0].state, 'reviewing');
    assert.equal((await f.work.owner.trace(1)).length, traces);
    f.use(f.make());
    assert.equal((await f.submit()).ok, true);
    assert.equal(f.pushes(), 1, 'Adopt the landed revision instead of pushing again');
    assert.equal((await preparations(f, NEXT)).length, 1);
  });

test('native changed-head producer: lost push acknowledgment never strands a new pending verdict',
  { skip: !enabled }, async t => {
    const f = await setup(t);
    f.afterPush(async () => { throw new Error('Lost Git push reply'); });
    await assert.rejects(f.submit(), /Lost Git push/);
    assert.equal((await f.session()).checks_commit_sha, HEAD);
    assert.equal((await preparations(f, NEXT)).length, 0);
    f.use(f.make());
    assert.equal((await f.submit()).ok, true);
    assert.equal(f.pushes(), 1);
    assert.equal((await preparations(f, NEXT)).length, 1);
  });

for (const status of ['active', 'paused']) {
  test(`native ${status} changed head: admission-off obligation, bounded discovery and recovery`,
    { skip: !enabled }, async t => {
      const f = await setup(t, { status });
      const serving = await f.session();
      f.config.nativeManualPreviewEnabled = false;
      const result = await f.submit();
      assert.equal(result.ok, true);
      assert.equal(result.preparationRequest.status, 'blocked');
      assert.equal(result.checksRerun, false);
      assert.equal((await f.session()).checks_commit_sha, NEXT);
      assert.equal((await f.session()).staging_runtime_name, serving.staging_runtime_name);
      assert.equal((await preparations(f, NEXT)).length, 0);
      assert.equal((await f.make().recover(1)).status, 'blocked');
      f.config.nativeManualPreviewEnabled = true;
      if (status === 'paused') {
        assert.equal((await f.make().recover(1)).code, 'status_changed');
        await f.pool.query("UPDATE chat_sessions SET status = 'active' WHERE id = 1");
      }
      await Promise.all([f.make().reconcileSyncs(), f.make().recover(1), f.submit()]);
      assert.equal((await preparations(f, NEXT)).length, 1);
      assert.equal((await f.work.owner.read(1)).handoff.sync_reconciliation, null);
      f.config.nativeManualPreviewEnabled = false;
      const restarted = f.make();
      assert.equal((await restarted.recover(1)).status, 'queued');
      await candidate(f, restarted, { work: (await preparations(f, NEXT))[0] });
      await tick(restarted);
      assert.equal((await f.session()).check_state, 'passing');
    });
}

for (const moveKind of ['authored', 'mechanical', 'resolved', 'initialized']) {
  test(`native promoted ${moveKind} submission preserves approval and green-carry policy`,
    { skip: !enabled }, async t => {
      const f = await setup(t, { status: 'promoted', moveKind });
      if (moveKind === 'initialized') await f.pool.query('UPDATE chat_sessions SET reviewed_head_sha = NULL WHERE id = 1');
      const result = await f.submit();
      assert.equal(result.ok, true);
      const row = await f.session();
      assert.equal(row.reviewed_head_sha, NEXT);
      assert.equal((await f.pool.query('SELECT COUNT(*) FROM chat_session_messages')).rows[0].count, '0');
      assert.equal(row.approval_epoch, moveKind === 'authored' ? 8 : 7);
      assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM pr_votes')).rows[0].count), 2,
        'Epoch-scoped approvals remain history; never delete another revision’s votes');
      assert.equal(row.check_state, moveKind === 'mechanical' ? 'passing' : 'pending');
      assert.equal(result.checksRerun, moveKind !== 'mechanical');
      const restarted = f.make(moveKind === 'mechanical'
        ? { capture: async () => assert.fail('Verified mechanical green verdict must carry') } : {});
      await candidate(f, restarted, { work: (await preparations(f, NEXT))[0] });
      await tick(restarted);
      assert.equal((await f.session()).check_state, 'passing');
      assertReplay(await restarted.owner.trace(1));
    });
}

test('native producer concurrent newer-head admission rejects stale acceptance and obsolete publication',
  { skip: !enabled }, async t => {
    const f = await setup(t);
    const serving = await f.session();
    f.afterPush(async () => {
      const accepted = await f.work.admitSubmission({ session: await f.session(),
        headSha: NEWER, landedHeadSha: NEWER, moveKind: 'authored' });
      assert.equal(accepted.accepted, true);
    });
    const stale = await f.submit();
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'native_submission_reconciliation_required');
    assert.equal(stale.reason, 'session_state_changed');
    assert.equal((await preparations(f, NEXT)).length, 0);
    assert.equal((await preparations(f, NEWER)).length, 1);
    assert.equal((await f.session()).checks_commit_sha, NEWER);
    assert.equal((await f.session()).staging_runtime_name, serving.staging_runtime_name);
    const rejected = await f.work.admitSubmission({ session: { ...serving, status: 'active' },
      headSha: NEXT, landedHeadSha: NEXT, moveKind: 'authored' });
    assert.equal(rejected.accepted, false);
    assert.equal(await require('../src/services/visuals').storeChecks(f.pool, 1, NEXT,
      { state: 'passing', results: [] }), false);
  });

test('native producer supersession retires the old handoff without activation or capture',
  { skip: !enabled }, async t => {
    const f = await setup(t);
    const first = await f.submit();
    await candidate(f, f.work, { work: await f.work.store.read(first.preparationRequest.workId) });
    const continuation = (await f.work.owner.read(1)).handoff.continuation_work_id;
    const serving = await f.session();
    const second = await f.submit(NEWER, { expectedHeadSha: NEXT });
    assert.equal(second.ok, true);
    await tick(f.make({ capture: async () => assert.fail('Superseded capture') }));
    assert.equal((await f.work.store.read(continuation)).last_code, 'handoff_obsolete');
    assert.equal((await f.session()).staging_runtime_name, serving.staging_runtime_name);
    assert.equal((await f.submit(NEXT)).code, 'branch_moved');
    assert.equal((await f.session()).checks_commit_sha, NEWER);
  });


test('fresh paused native submission records discoverable ownership without a prior flow',
  { skip: !enabled }, async t => {
    const f = await setup(t, { status: 'paused', enroll: false });
    const result = await f.submit();
    assert.equal(result.ok, true);
    assert.equal(result.resumeRequired, true);
    assert.equal(result.preparationRequest.code, 'session_paused');
    const state = await f.work.owner.read(1);
    assert.equal(state.handoff.flow_id, null);
    assert.equal(state.handoff.sync_reconciliation.source, 'native-submission');
    assert.equal(await require('../src/services/cli-preview-handoff/work').enrolled(f.pool, 1), true);
    assert.equal((await f.make().recover(1)).status, 'blocked');
    await f.pool.query("UPDATE chat_sessions SET status = 'active' WHERE id = 1");
    await f.make().reconcileSyncs();
    assert.equal((await preparations(f, NEXT)).length, 1);
    assertReplay(await f.work.owner.trace(1));
  });

test('native submission guards source, owner, lifecycle and exact external head',
  { skip: !enabled }, async t => {
    const f = await setup(t);
    const session = await f.session();
    for (const [patch, reason] of [
      [{ user_id: 2 }, 'session_owner_changed'],
      [{ status: 'promoted' }, 'session_state_changed'],
      [{ branch_name: 'other' }, 'session_state_changed'],
    ]) {
      const result = await f.work.admitSubmission({ session: { ...session, ...patch },
        headSha: NEXT, landedHeadSha: NEXT, moveKind: 'authored' });
      assert.equal(result.reason, reason);
    }
    assert.equal((await f.work.admitSubmission({ session, headSha: NEXT,
      landedHeadSha: NEWER, moveKind: 'authored' })).reason, 'submission_head_unverified');
    await f.pool.query("UPDATE chat_sessions SET active_turn = '{}' WHERE id = 1");
    assert.equal((await f.work.admitSubmission({ session, headSha: NEXT,
      landedHeadSha: NEXT, moveKind: 'authored' })).reason, 'session_busy');
    await f.pool.query("UPDATE chat_sessions SET active_turn = NULL, source = 'cli_handoff' WHERE id = 1");
    assert.equal((await f.work.admitSubmission({ session, headSha: NEXT,
      landedHeadSha: NEXT, moveKind: 'authored' })).reason, 'ordinary_native_required');
    assert.equal((await preparations(f, NEXT)).length, 0);
  });

test('native source readback failure leaves acceptance uncommitted and exposes its retry owner',
  { skip: !enabled }, async t => {
    const f = await setup(t);
    const read = f.github.getBranchSha;
    let reads = 0;
    f.github.getBranchSha = async () => ++reads === 1 ? HEAD : null;
    const result = await f.submit();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'submission_revision_unverified');
    assert.equal(result.reconciliation.owner, 'native-preview-requests');
    assert.equal((await f.session()).checks_commit_sha, HEAD);
    assert.equal((await preparations(f, NEXT)).length, 0);
    f.github.getBranchSha = read;
    assert.equal((await f.submit()).ok, true);
    assert.equal(f.pushes(), 1);
  });

test('native promoted admission preserves the author summary already pinned to its exact head',
  { skip: !enabled }, async t => {
    const f = await setup(t, { status: 'promoted' });
    await f.pool.query(`UPDATE chat_sessions SET pr_summary_source = 'author',
      pr_summary_source_head_sha = $1, pr_summary_stale = FALSE WHERE id = 1`, [NEXT]);
    assert.equal((await f.submit()).ok, true);
    assert.equal((await f.session()).pr_summary_stale, false);
    assert.equal((await f.session()).pr_summary_input_version, 0);
  });


test('disabled admission cannot enroll a fresh native session through the action boundary',
  { skip: !enabled }, async t => {
    const f = await setup(t, { enroll: false });
    f.config.nativeManualPreviewEnabled = false;
    const result = await f.work.admitSubmission({ session: await f.session(),
      headSha: NEXT, landedHeadSha: NEXT, moveKind: 'authored' });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'native_admission_disabled');
    assert.equal((await preparations(f, NEXT)).length, 0);
    assert.equal((await f.session()).checks_commit_sha, HEAD);
    assert.equal((await f.work.owner.read(1)).handoff, null);
  });


test('native submission receipt survives a distinct same-head manual repair without competing preparation',
  { skip: !enabled }, async t => {
    const f = await setup(t, { enroll: false });
    const original = await f.submit();
    await candidate(f, f.work, { work: await f.work.store.read(original.preparationRequest.workId) });
    await tick(f.make());
    const repaired = await f.work.admitManual({ session: await f.session(), headSha: NEXT,
      requestId: randomUUID(), userId: 1, kind: 'deploy', repair: true });
    assert.equal(repaired.accepted, true);
    assert.notEqual(repaired.work.id, original.preparationRequest.workId);
    const replay = await f.submit(NEXT, { expectedHeadSha: undefined });
    assert.equal(replay.preparationRequest.requestId, original.preparationRequest.requestId);
    assert.equal(replay.preparationRequest.workId, original.preparationRequest.workId);
    assert.equal(replay.preparationRequest.workStatus, 'succeeded');
    assert.equal((await preparations(f, NEXT)).length, 2, 'Original submission and explicit repair only');
    assert.equal((await f.work.owner.read(1)).handoff.preparation_work_id, repaired.work.id);
  });


test('native changed-head capacity waiting is explicit reconciliation, not a failed build or pending verdict',
  { skip: !enabled }, async t => {
    const f = await setup(t);
    const accepted = await f.submit();
    await candidate(f, f.work, { work: await f.work.store.read(accepted.preparationRequest.workId) });
    await tick(f.make());
    const serving = await f.session();
    const cards = (await f.pool.query('SELECT COUNT(*) FROM chat_session_messages')).rows[0].count;
    const blocked = await f.submit(NEWER, { expectedHeadSha: NEXT });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'native_submission_reconciliation_required');
    assert.equal(blocked.reason, 'consumer_retirement_required');
    assert.equal(blocked.reconciliation.owner, 'native-preview-requests');
    assert.equal((await f.session()).checks_commit_sha, NEXT);
    assert.equal((await f.session()).check_state, 'passing');
    assert.equal((await f.session()).staging_runtime_name, serving.staging_runtime_name);
    assert.equal((await preparations(f, NEWER)).length, 0);
    assert.equal((await f.pool.query('SELECT COUNT(*) FROM chat_session_messages')).rows[0].count, cards);
    const retry = await f.submit(NEWER, { expectedHeadSha: NEXT });
    assert.equal(retry.reason, 'consumer_retirement_required');
    assert.equal(f.pushes(), 2, 'Waiting retries adopt the landed push, never repeat it');
  });
