'use strict';

const { randomUUID } = require('node:crypto');
const { createSessionDecisionRuntime } = require('../decision-runtime');
const { createExecutionStore } = require('../execution/store');
const { retryDelay } = require('../execution/worker');
const { parseAction, reduce } = require('./settlement-reducer');

const GATE = 'native-cli-check-gate';

function createChecksSettlement(pool, config, {
  store = createExecutionStore(pool),
  recordHistory = require('../check-history').recordRunStrict,
  github = require('../github'),
  merge = (appId) => require('../merge-queue').enqueue(config, appId, { propagateErrors: true }),
  bot = (sessionId) => require('../homeroom-bot').noteProposalChecks(pool, { sessionId, propagateErrors: true }),
} = {}) {
  const runtime = createSessionDecisionRuntime(pool);
  const machine = {
    name: 'cli-checks-settlement',
    version: 1,
    parseAction,
    reduce,
    async load(client, session, { sessionId, action, lock }) {
      const handoff = (await client.query(`SELECT flow_id, head_sha FROM cli_preview_handoffs
        WHERE session_id = $1`, [sessionId])).rows[0] || null;
      const operation = (await client.query(`SELECT run_id, revision, desired_revision, phase, state
        FROM preview_operations WHERE session_id = $1`, [sessionId])).rows[0] || null;
      if (lock) {
        await client.query('SELECT run_id FROM check_runs WHERE session_id = $1 AND run_id = $2 FOR UPDATE',
          [sessionId, action.runId]);
        // History belongs to an app, not a session. Both enrolled settlements
        // use this lock after their session/manifest locks, before history writes.
        await client.query('SELECT id FROM apps WHERE id = $1 FOR UPDATE', [session?.app_id || null]);
      }
      const manifest = (await client.query(`SELECT commit_sha, owner, manifest FROM check_runs
        WHERE session_id = $1 AND run_id = $2`, [sessionId, action.runId])).rows[0] || null;
      const preview = (await client.query(`SELECT f.id, f.head_sha, f.state, b.observed
        FROM preview_flow_heads h JOIN preview_flows f ON f.id = h.flow_id
        LEFT JOIN preview_bindings b ON b.session_id = h.session_id
        WHERE h.session_id = $1`, [sessionId])).rows[0] || null;
      const receipt = await findSettlement(client, sessionId, action.runId);
      const projected = session ? Object.fromEntries([
        'id', 'app_id', 'source', 'status', 'handoff_head_sha', 'checks_commit_sha',
        'staging_commit_sha', 'staging_runtime_name', 'check_state', 'check_phase', 'reviewed_head_sha',
      ].map(key => [key, session[key] ?? null])) : null;
      return {
        session: projected,
        handoff,
        operation,
        manifest,
        preview,
        settlement: receipt?.decision || null,
      };
    },
    facts: () => ({}),
    actionConflict: () => new Error('Checks settlement action identity reused with different input'),
    async persist(client, { state, action }) {
      if (action.type !== 'SettleCliChecks') return;
      const visuals = require('../visuals');
      const deferred = action.result.state === 'deferred';
      const stored = deferred
        ? await visuals.storeChecksDeferred(client, action.sessionId, action.headSha, action.errorDetail)
        : await visuals.storeChecks(client, action.sessionId, action.headSha, action.result, action.errorDetail);
      if (!stored) throw new Error('Accepted checks settlement could not persist its verdict');
      if (!deferred) {
        await visuals.storeConsoleCheck(client, action.sessionId,
          visuals.consoleSnapshotFromTests(action.result), action.headSha);
      }
      if (!['error', 'deferred'].includes(action.result.state)) {
        await recordHistory(client, state.session.app_id, action.history);
      }
    },
    journal: {
      async findReceipt(client, sessionId, actionId) {
        return (await client.query(`SELECT action_hash, decision FROM cli_check_settlement_receipts
          WHERE session_id = $1 AND action_id = $2`, [sessionId, actionId])).rows[0];
      },
      saveReceipt: (client, values) => client.query(`INSERT INTO cli_check_settlement_receipts
        (session_id, action_id, action_hash, decision, run_id)
        VALUES ($1,$2,$3,$4, CASE WHEN ($4::jsonb->>'accepted')::boolean
          AND $4::jsonb->>'reason' = 'cli_checks_settled'
          THEN ($4::jsonb#>>'{identity,runId}')::uuid END)`, values),
      saveTrace: (client, values) => client.query(`INSERT INTO cli_check_settlement_decisions
        (session_id, action_id, reducer_version, pre_state, action, facts, decision)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, values),
      async trace(client, sessionId) {
        return (await client.query(`SELECT * FROM cli_check_settlement_decisions
          WHERE session_id = $1 ORDER BY id`, [sessionId])).rows;
      },
    },
  };

  async function findSettlement(client, sessionId, runId) {
    return (await client.query(`SELECT decision FROM cli_check_settlement_receipts
      WHERE session_id = $1 AND run_id = $2`, [sessionId, runId])).rows[0];
  }

  async function settled(sessionId, runId) {
    const receipt = await findSettlement(pool, sessionId, runId);
    return receipt?.decision.accepted ? receipt.decision : null;
  }

  async function settleInTransaction(transaction, {
    sessionId, runId, headSha, result, history = [], errorDetail = null,
    actionId = randomUUID(), observedOwner = require('../check-runs').selfOwner(),
  }) {
    return transaction.withSession(sessionId, async client => {
      const receipt = await findSettlement(client, sessionId, runId);
      const handoff = (await client.query('SELECT flow_id FROM cli_preview_handoffs WHERE session_id = $1',
        [sessionId])).rows[0];
      const manifest = (await client.query(`SELECT manifest FROM check_runs
        WHERE session_id = $1 AND run_id = $2`, [sessionId, runId])).rows[0]?.manifest;

      // The first accepted facts are immutable. Later parsing or an optional
      // artifact failure must not replace them after an unknown COMMIT reply.
      if (receipt) {
        const decision = receipt.decision;
        if (decision.accepted && decision.identity.headSha !== headSha) {
          throw new Error('Checks run identity reused with a different revision');
        }
        return { decision, replayed: true };
      }
      if (!handoff?.flow_id) throw new Error('Checks settlement requires persisted CLI enrollment');
      const action = {
        type: 'SettleCliChecks',
        actionId,
        sessionId,
        runId,
        headSha,
        flowId: manifest?.cliFlowId || handoff.flow_id,
        result,
        errorDetail,
        observedOwner,
        history: history.map(row => ({
          checkKey: row.checkKey,
          name: row.name || '',
          path: row.path || '',
          passes: Number.isInteger(row.passes) ? row.passes : (row.passed ? 1 : 0),
          fails: Number.isInteger(row.fails) ? row.fails : (row.passed ? 0 : 1),
        })),
      };
      const applied = await transaction.apply(machine, action);
      for (const effect of applied.decision.effects) {
        await store.enqueue(transaction, {
          id: randomUUID(),
          effectKey: effect.effectKey,
          sessionId,
          workflow: GATE,
          version: 1,
          causedBy: actionId,
          input: { sessionId, runId, headSha, flowId: action.flowId, gate: effect.gate },
        });
      }
      return applied;
    });
  }

  async function runGate({ attempt }) {
    const permission = await runtime.apply(machine, {
      type: 'DeliverCliCheckGate',
      actionId: attempt.claim_id,
      ...attempt.input,
    });
    if (!permission.decision.accepted) return { outcome: 'succeeded', code: permission.decision.reason };

    const session = permission.current.session;
    // These services retain their own live policy and merge/queue ownership.
    // The durable obligation owns retry of delivery, not GitHub execution.
    if (attempt.input.gate === 'merge') {
      if (!github.isEnabled()) {
        const status = github.getInitializationStatus();
        const reason = ['uninitialized', 'initializing', 'unavailable', 'failed'].includes(status)
          ? status : 'unavailable';

        return {
          outcome: 'retry',
          code: `github_${reason}`,
          delayMs: retryDelay(attempt.attempt_count, 1000, 60000),
        };
      }

      await merge(session.app_id);
    } else {
      await bot(session.id);
    }

    return { outcome: 'succeeded', code: 'gate_delivered' };
  }

  return {
    settle: input => runtime.transact(transaction => settleInTransaction(transaction, input)),
    settleInTransaction,
    settled,
    trace: sessionId => runtime.trace(machine, sessionId),
    handlers: { [GATE]: { version: 1, run: runGate } },
  };
}

module.exports = { createChecksSettlement, GATE };
