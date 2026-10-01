'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createExecutionDatabase } = require('./lib/execution-database');
const { createReviewWork, ANNOUNCE_RETURN } = require('../src/services/proposal-review/work');
const { createProposalReview } = require('../src/services/proposal-review/store');
const { replayDecision } = require('../src/services/proposal-review/reducer');
const { createPreviewWork, PREPARE } = require('../src/services/preview-flow/work');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { createExecutionWorker } = require('../src/services/execution/worker');

const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
const HEAD = 'a'.repeat(40);

function action(sessionId = 1) {
  return { type: 'RequestImportedReturnToDevelopment', actionId: randomUUID(), sessionId, userId: 1, actorUsername: 'alice' };
}

function intercept(pool, query) {
  return {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      return { query: (sql, params) => query(client, String(sql), params), release: () => client.release() };
    },
  };
}

function failOnce(pool, matches, after = false) {
  let failed = false;
  return intercept(pool, async (client, sql, params) => {
    const fail = !failed && matches(sql);
    if (fail) failed = true;
    if (fail && !after) throw new Error('Injected persistence failure');
    const result = await client.query(sql, params);
    if (fail) throw new Error('Injected acknowledgment loss');
    return result;
  });
}

async function fixture(t) {
  const db = await createExecutionDatabase(databaseUrl);
  t.after(() => db.close());
  await db.pool.query("INSERT INTO chat_sessions (id, source, status, checks_commit_sha) VALUES (1, 'imported', 'promoted', $1)", [HEAD]);
  const config = { proposalReviewWorkerEnabled: true, nativePreviewWorkerEnabled: true, nativePreviewAttempts: true,
    dataEncryptionKey: 'test-key', databaseUrl: db.url, appRuntime: 'docker' };
  const review = createReviewWork(db.pool, config);
  async function attempt(executor = review) {
    return (await executor.store.claim(randomUUID(), [ANNOUNCE_RETURN], 1))[0];
  }
  async function deliver(executor = review) {
    const claimed = await attempt(executor);
    const handler = executor.handlers[ANNOUNCE_RETURN];
    const result = await handler.run({ attempt: claimed, signal: new AbortController().signal });
    return executor.store.settle(claimed, result, handler.commit);
  }
  return { ...db, config, review, attempt, deliver };
}

async function historicalResource(pool) {
  const flowId = randomUUID();
  await pool.query(`INSERT INTO preview_flows (id, session_id, generation, head_sha, started_status, state)
    VALUES ($1, 1, 1, $2, 'active', 'failed')`, [flowId, HEAD]);
  await pool.query('INSERT INTO preview_flow_resources (flow_id, session_id, intent) VALUES ($1, 1, $2)',
    [flowId, JSON.stringify({ runtimeKind: 'docker', runtimeName: 'historical', dbName: 'historical', namespace: null })]);
  return flowId;
}

test('real PostgreSQL: second workflow admission rolls back with its work, and lost acknowledgment returns original work', { skip: !databaseUrl }, async t => {
  const { pool, config, review } = await fixture(t);
  const request = action();
  const broken = createReviewWork(failOnce(pool, sql => sql.includes('INSERT INTO execution_work_events')), config);
  await assert.rejects(broken.request(request));
  assert.equal((await pool.query('SELECT status, approval_epoch FROM chat_sessions')).rows[0].status, 'promoted');
  for (const table of ['proposal_review_receipts', 'proposal_review_decisions', 'execution_work_requests']) {
    assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
  }
  const lost = createReviewWork(failOnce(pool, sql => sql === 'COMMIT', true), config);
  await assert.rejects(lost.request(request));
  const retry = await review.request(request);
  assert.equal(retry.replayed, true);
  assert.equal((await pool.query('SELECT * FROM execution_work_requests')).rowCount, 1);
  assert.equal((await pool.query('SELECT approval_epoch FROM chat_sessions')).rows[0].approval_epoch, 1);
});

test('real PostgreSQL: rejected review decisions remain composable and cannot admit work', { skip: !databaseUrl }, async t => {
  const { pool, config, review } = await fixture(t);
  assert.equal((await review.request({ ...action(), userId: 2 })).decision.reason, 'forbidden');
  await pool.query("UPDATE chat_sessions SET source = 'cli_handoff'");
  assert.equal((await review.request(action())).decision.reason, 'native_execution_not_enrolled');
  await pool.query("UPDATE chat_sessions SET source = 'imported'");
  await pool.query("INSERT INTO pending_secret_declarations VALUES (1, 'pending')");
  assert.equal((await review.request(action())).decision.reason, 'pending_secret');
  await pool.query('DELETE FROM pending_secret_declarations');
  const busy = createReviewWork(pool, config, { owner: createProposalReview(pool, { isBusy: () => true }) });
  assert.equal((await busy.request(action())).decision.reason, 'busy');
  assert.equal((await pool.query('SELECT * FROM execution_work_requests')).rowCount, 0);
  assert.equal((await review.request(action())).decision.reason, 'returned_to_development');
});

test('real PostgreSQL: interrupted review delivery retains identities and records historical text once', { skip: !databaseUrl }, async t => {
  const { pool, review, attempt, deliver } = await fixture(t);
  const admission = await review.request(action());
  const old = await attempt();
  await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
  // A historical notice does not revert a newer lifecycle status.
  await pool.query("UPDATE chat_sessions SET status = 'merging', pr_title = 'Changed later'");
  assert.equal((await deliver()).result.accepted, true);
  assert.deepEqual(await review.store.settle(old, { outcome: 'succeeded' }, review.handlers[ANNOUNCE_RETURN].commit), { lostClaim: true });
  const messages = (await pool.query('SELECT * FROM chat_messages')).rows;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].thread_type, 'session');
  assert.equal(messages[0].thread_ref, 1);
  assert.match(messages[0].content, /alice moved PR #7 back to Underway/);
  assert.doesNotMatch(messages[0].content, /Changed later/);
  assert.equal((await pool.query('SELECT status FROM chat_sessions')).rows[0].status, 'merging');
  assert.equal((await review.store.read(admission.work.id)).status, 'succeeded');
  for (const entry of await createProposalReview(pool).trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
});

for (const afterCommit of [false, true]) {
  test(`real PostgreSQL: review publication ${afterCommit ? 'commit acknowledgment loss' : 'journal failure'} cannot duplicate a message`, { skip: !databaseUrl }, async t => {
    const { pool, config, review, deliver } = await fixture(t);
    const admission = await review.request(action());
    const broken = createReviewWork(failOnce(pool, sql => afterCommit ? sql === 'COMMIT'
      : sql.includes('INSERT INTO proposal_review_decisions'), afterCommit), config);
    await assert.rejects(deliver(broken));
    if (!afterCommit) {
      assert.equal((await pool.query('SELECT * FROM chat_messages')).rowCount, 0);
      await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
      await deliver();
    }
    assert.equal((await pool.query('SELECT * FROM chat_messages')).rowCount, 1);
    assert.equal((await review.store.read(admission.work.id)).status, 'succeeded');
    assert.equal((await pool.query("SELECT * FROM proposal_review_decisions WHERE action->>'type' = 'RequestReturnAnnouncement'")).rowCount, 1);
  });
}

test('real PostgreSQL: a caught announcement mapping failure rolls back earlier preview decisions and all publication journals', { skip: !databaseUrl }, async t => {
  const { pool, config, review, attempt } = await fixture(t);
  const flowId = await historicalResource(pool);
  const admission = await review.request(action());
  const claimed = await attempt();
  const preview = createPreviewFlow(pool);
  const broken = createReviewWork(failOnce(pool, sql => sql.includes('INSERT INTO proposal_review_decisions')), config);
  await assert.rejects(broken.store.settle(claimed, { outcome: 'succeeded' }, async transaction => {
    await preview.applyInTransaction(transaction, { type: 'RequestPreviewCleanup', actionId: randomUUID(), sessionId: 1, flowId });
    try { await broken.handlers[ANNOUNCE_RETURN].commit(transaction, claimed, { outcome: 'succeeded' }); } catch {}
    return { outcome: 'succeeded' };
  }));
  assert.equal((await pool.query('SELECT * FROM chat_messages')).rowCount, 0);
  assert.equal((await pool.query('SELECT cleanup_started_at FROM preview_flow_resources')).rows[0].cleanup_started_at, null);
  assert.equal((await pool.query('SELECT * FROM preview_flow_decisions')).rowCount, 0);
  assert.equal((await review.store.read(admission.work.id)).status, 'running');
});

test('real PostgreSQL: both workflows serialize decisions on the same aggregate while another aggregate progresses', { skip: !databaseUrl }, async t => {
  const { pool, config, review, attempt, deliver } = await fixture(t);
  const flowId = await historicalResource(pool);
  await review.request(action());
  await pool.query("INSERT INTO chat_sessions (id, source, status) VALUES (2, 'imported', 'promoted')");
  await review.request(action(2));
  const claimed = await attempt();
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let publisherPid;
  const held = createReviewWork(intercept(pool, async (client, sql, params) => {
    const result = await client.query(sql, params);
    if (sql.includes('INSERT INTO chat_messages')) {
      publisherPid = client.processID;
      entered();
      await gate;
    }
    return result;
  }), config);
  const publishing = held.store.settle(claimed, { outcome: 'succeeded' }, held.handlers[ANNOUNCE_RETURN].commit);
  await started;
  let contenderPid;
  const preview = createPreviewFlow(intercept(pool, (client, sql, params) => {
    if (sql === 'SELECT * FROM chat_sessions WHERE id = $1 FOR UPDATE') contenderPid = client.processID;
    return client.query(sql, params);
  }));
  const competing = preview.apply({ type: 'RequestPreviewCleanup', actionId: randomUUID(), sessionId: 1, flowId });
  try {
    const deadline = Date.now() + 2000;
    for (;;) {
      if (contenderPid) {
        const blockers = (await pool.query('SELECT pg_blocking_pids($1) AS pids', [contenderPid])).rows[0].pids;
        if (blockers.includes(publisherPid)) break;
      }
      assert.ok(Date.now() < deadline, 'preview must wait on review aggregate ownership');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await deliver()).result.accepted, true, 'unrelated review delivery progresses while the aggregate is held');
    assert.equal((await pool.query('SELECT cleanup_started_at FROM preview_flow_resources')).rows[0].cleanup_started_at, null);
  } finally {
    release();
    await publishing;
    assert.equal((await competing).decision.accepted, true);
  }
  assert.equal((await pool.query('SELECT * FROM chat_messages')).rowCount, 2);
});

test('real PostgreSQL: shared scheduler progresses beyond a busy preview batch and retries review failures without duplication', { skip: !databaseUrl }, async t => {
  const { pool, config, review } = await fixture(t);
  await pool.query('DELETE FROM chat_sessions');
  let previewsBusy = true;
  let reviewFailing = true;
  const preview = createPreviewWork(pool, config, {
    store: review.store,
    lock: async (_config, _classifier, _sessionId, run) => previewsBusy ? { busy: true } : run(),
    inspect: async () => ({ present: false, receipt: null }),
    prepare: async (_config, session, app, head, candidate) => {
      await candidate.onClonePrepared();
      return { commitSha: head, stagingUrl: `http://${candidate.intent.runtimeName}:3000`,
        runtimeKind: 'docker', runtimeName: candidate.intent.runtimeName, containerId: candidate.intent.runtimeName,
        imageRef: 'test:image', buildRef: null, physicalId: randomUUID(), attemptId: candidate.intent.attemptId };
    },
  });
  const previewWork = [];
  for (let id = 1; id <= 25; id++) {
    await pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES ($1, $2)', [id, HEAD]);
    previewWork.push((await preview.request({ type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId: id,
      headSha: HEAD, startedStatus: 'active' })).work);
  }
  const reviewWork = [];
  for (let id = 26; id <= 31; id++) {
    await pool.query("INSERT INTO chat_sessions (id, source, status) VALUES ($1, 'imported', 'promoted')", [id]);
    reviewWork.push((await review.request(action(id))).work);
  }
  // One old review delivery is interrupted repeatedly; the other review
  // deliveries and preview attempts still share the same scheduler fairly.
  const original = review.handlers[ANNOUNCE_RETURN];
  const worker = createExecutionWorker({ store: review.store, concurrency: 4, retryMinimumMs: 100, retryMaximumMs: 100,
    handlers: { ...preview.handlers, [ANNOUNCE_RETURN]: { ...original, async run(context) {
      if (context.attempt.session_id === 26 && reviewFailing) throw new Error('Retryable review failure');
      return original.run(context);
    } } },
  });
  async function progress(check) {
    const deadline = Date.now() + 8000;
    while (!await check()) {
      assert.ok(Date.now() < deadline, 'eligible work must progress across workflow families');
      await worker.tick();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    await progress(async () => (await pool.query('SELECT * FROM chat_messages')).rowCount === 5);
    assert.equal(previewsBusy, true);
    assert.equal(reviewFailing, true);
    const pending = await pool.query("SELECT * FROM execution_work_requests WHERE workflow = $1", [PREPARE]);
    assert.equal(pending.rowCount, 25);
    assert.ok(pending.rows.every(row => row.status !== 'succeeded' && row.attempt_count > 0));
    previewsBusy = false;
    await pool.query("UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE status = 'queued'");
    await progress(async () => (await pool.query("SELECT * FROM execution_work_requests WHERE workflow = $1 AND status = 'succeeded'", [PREPARE])).rowCount === 25);
    assert.ok(['queued', 'running'].includes((await review.store.read(reviewWork[0].id)).status),
      'failing review obligation remains queued or in an unfinished retry attempt');
    reviewFailing = false;
    await progress(async () => (await pool.query('SELECT * FROM chat_messages')).rowCount === 6);
    assert.equal((await review.store.read(reviewWork[0].id)).status, 'succeeded');
    assert.ok((await review.store.trace(reviewWork[0].id)).some(row => row.detail.code === 'execution_retry'));
  } finally {
    await worker.drain();
  }
});

test('real PostgreSQL: announcement authority rejects missing or moved originals and deduplicates different publication action IDs', { skip: !databaseUrl }, async t => {
  const { pool, review, deliver } = await fixture(t);
  const owner = createProposalReview(pool);
  const request = action();
  assert.equal((await owner.apply({ type: 'RequestReturnAnnouncement', actionId: randomUUID(), sessionId: 1,
    returnActionId: request.actionId })).decision.reason, 'return_receipt_missing');
  await review.request(request);
  await deliver();
  assert.equal((await owner.apply({ type: 'RequestReturnAnnouncement', actionId: randomUUID(), sessionId: 1,
    returnActionId: request.actionId })).decision.reason, 'already_announced');
  assert.equal((await pool.query('SELECT * FROM chat_messages')).rowCount, 1);
  await pool.query("INSERT INTO apps VALUES (2, 'moved', 'https://github.com/example/moved')");
  await pool.query('UPDATE chat_sessions SET app_id = 2');
  assert.equal((await owner.apply({ type: 'RequestReturnAnnouncement', actionId: randomUUID(), sessionId: 1,
    returnActionId: request.actionId })).decision.reason, 'announcement_project_changed');
  assert.equal((await pool.query('SELECT * FROM chat_messages')).rowCount, 1);
});

test('real PostgreSQL: deleted announcement target settles as a recorded rejection without publishing elsewhere', { skip: !databaseUrl }, async t => {
  const { pool, review, deliver } = await fixture(t);
  const admission = await review.request(action());
  await pool.query('DELETE FROM chat_sessions WHERE id = 1');
  const result = await deliver();
  assert.deepEqual(result.result, { accepted: false, reason: 'not_found' });
  assert.equal((await review.store.read(admission.work.id)).status, 'succeeded');
  assert.equal((await pool.query('SELECT * FROM chat_messages')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM proposal_review_receipts')).rowCount, 2,
    'original acceptance and rejected publication remain correlated after aggregate deletion');
});
