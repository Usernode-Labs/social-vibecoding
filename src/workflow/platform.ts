// The workflow runtime inside the platform process: created at boot when a
// workflow flag is on, with its own small pool so pipeline slots and the
// outcome listener never take request connections. Every process appends
// and waits; the loops run on the leader, and on a staging preview (which
// never stands for election) so a preview with the flag on still decides.

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createRuntime } from './kernel/index.ts';
import type { EventOutcome, Logger, Pool, Runtime } from './kernel/index.ts';
import { legacy } from './legacy.ts';
import { GOVERNANCE_KINDS } from './governance-proposal/facts.ts';
import { MACHINE, governanceProposal, issueKey } from './governance-proposal/machine.ts';
import { governanceNotifiers, governanceServices } from './governance-proposal/services.ts';

const pg = createRequire(import.meta.url)('pg');

let runtime: Runtime | null = null;
let kernelPool: Pool & { end(): Promise<void> } | null = null;
let machine: ReturnType<typeof governanceProposal> | null = null;
let log: Logger | null = null;

// 'raise' (tests, staging, local) or 'log' (production, until no legacy
// writer is left): what an ownership trigger does with a write made outside
// the pipeline. Synced on every boot, flag or not, so turning a flag off
// again never leaves production raising on rows a machine enrolled.
export async function syncOwnershipMode(pool: Pool, mode: string): Promise<void> {
  if (mode === 'log') {
    await pool.query(
      `INSERT INTO wf_settings (key, value) VALUES ('ownership_mode', 'log')
       ON CONFLICT (key) DO UPDATE SET value = 'log', updated_at = NOW()`);
  } else {
    await pool.query(`DELETE FROM wf_settings WHERE key = 'ownership_mode'`);
  }
}

export async function startWorkflow(config: any, opts: { loops: boolean }): Promise<void> {
  log = legacy('services/logger');
  await syncOwnershipMode(legacy('db/pool').getPool(config), config.wfOwnershipMode);
  if (!config.wfGovernanceEnabled || runtime) return;
  kernelPool = new pg.Pool({ connectionString: config.databaseUrl, max: config.wfPoolMax, idleTimeoutMillis: 30000 });
  const deps = { config, pool: legacy('db/pool').getPool(config) };
  machine = governanceProposal({ dataKey: config.dataEncryptionKey, notifiers: governanceNotifiers(deps) });
  runtime = createRuntime({
    pool: kernelPool!, machines: [machine], services: governanceServices(deps), slots: config.wfSlots, log: log!,
  });
  await runtime.start({ loops: false });
  log!.info('workflow', 'Workflow runtime started', { machines: [MACHINE] });
  if (opts.loops) await startWorkflowLoops();
}

// The leader's part: pipeline slots, timers and services, then enrolling
// every open governance row the machine does not hold yet.
export async function startWorkflowLoops(): Promise<void> {
  if (!runtime) return;
  await runtime.start({ loops: true });
  const { rows } = await kernelPool!.query(
    `SELECT i.id, i.app_id FROM issues i
      WHERE i.status = 'open' AND i.kind = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = $2 AND w.key = 'issue:' || i.id)`,
    [[...GOVERNANCE_KINDS], MACHINE]);
  for (const r of rows) await file(r.id, r.app_id, { kind: 'system', name: 'backfill' });
  if (rows.length) log!.info('workflow', 'Enrolled open governance proposals', { count: rows.length });
}

export async function stopWorkflow(): Promise<void> {
  const r = runtime;
  runtime = null;
  await r?.stop();
  await kernelPool?.end();
  kernelPool = null;
}

// ── Governance proposals, for the routes ────────────────────────────────

export function governanceEnabled(): boolean {
  return runtime !== null;
}

export function governsKind(kind: string): boolean {
  return runtime !== null && GOVERNANCE_KINDS.has(kind);
}

type Source = { kind: 'route' | 'system' | 'admin'; name?: string };

async function file(issueId: number, appId: number, source: Source = { kind: 'route' }) {
  return runtime!.append(machine!, issueKey(issueId), { type: 'Filed', payload: { issueId } },
    { requestKey: `file:${issueId}`, source, appId });
}

// Enroll a governance row now (after the route that created it commits).
export async function fileProposal(issueId: number, appId: number): Promise<void> {
  if (runtime) await file(issueId, appId);
}

// Enroll a row that predates the flag, if the backfill has not reached it.
async function ensureFiled(issue: { id: number; app_id: number }) {
  const { rows } = await kernelPool!.query(
    'SELECT 1 FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, issueKey(issue.id)]);
  if (!rows.length) await file(issue.id, issue.app_id);
}

export interface Reply { status: number; body: Record<string, unknown> }

const REJECTIONS = new Map<string, Reply>([
  ['not_open', { status: 409, body: { error: 'Issue is not open' } }],
  ['no_issue', { status: 404, body: { error: 'Issue not found' } }],
  ['no_instance', { status: 404, body: { error: 'Issue not found' } }],
  ['not_author', { status: 403, body: { error: 'Only the proposer can withdraw this proposal' } }],
  ['not_the_voter', { status: 403, body: { error: 'Forbidden' } }],
  ['admin_only', { status: 403, body: { error: 'Full admin access required' } }],
  ['not_admin_appliable', { status: 400, body: { error: 'Only secret-change, close-issue, maintenance-campaign, and featured-illustration proposals can be admin-applied' } }],
]);

function failed(outcome: EventOutcome): Reply | null {
  if (outcome.status === 'pending') return { status: 202, body: { ok: true, pending: true, requestKey: outcome.requestKey } };
  if (outcome.status === 'faulted') return { status: 500, body: { error: 'Internal server error' } };
  if (outcome.status === 'rejected') {
    if (outcome.reason === 'reason_required') {
      const votes = legacy('routes/votes');
      return { status: 400, body: { error: 'reason_required', message: votes.VOTE_REASON_REQUIRED, maxLength: votes.VOTE_REASON_MAX } };
    }
    return REJECTIONS.get(outcome.reason || '') || { status: 409, body: { error: outcome.reason } };
  }
  return null;
}

const RESULT_KEYS = new Map([
  ['rename', 'renamed'], ['secret_change', 'secretChanged'], ['close_issue', 'issueClosed'],
  ['maintenance_campaign', 'campaignStarted'], ['featured_illustration', 'illustrationChanged'],
]);

// The per-kind result object the client has always read off a vote or an
// admin apply: { applied, superseded, refused, awaitingAdmin, ... }.
async function kindResult(issueId: number): Promise<Record<string, unknown>> {
  const [{ rows: [inst] }, { rows: [issue] }] = await Promise.all([
    kernelPool!.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, issueKey(issueId)]),
    kernelPool!.query('SELECT kind, payload FROM issues WHERE id = $1', [issueId]),
  ]);
  const p = issue?.payload || {};
  if (inst?.state === 'applied') {
    return { applied: true, issueNumber: p.issueNumber, newName: p.newName, campaignId: p.campaignId,
      illustration: p.proposed || null, upCount: p.upCount, required: p.required, active: p.active };
  }
  if (inst?.state === 'superseded') return { applied: false, superseded: true };
  if (inst?.state === 'refused') return { applied: false, refused: true, error: String(p.appliedBy || '').replace(/^refused:/, '') };
  const e = inst?.data?.evaluation || {};
  return { applied: false, awaitingAdmin: e.waiting === 'awaiting_admin', upCount: e.yes, required: e.required,
    active: e.active, windowEndsAt: e.windowEndsAt, waitingForWindow: e.waiting === 'waiting_for_window' };
}

export async function voteOnProposal(
  issue: { id: number; app_id: number; kind: string },
  user: { id: number; username: string },
  vote: { vote: string; reason: string | null; requestKey?: string },
): Promise<Reply> {
  await ensureFiled(issue);
  const outcome = await runtime!.appendAndWait(machine!, issueKey(issue.id), {
    type: 'VoteCast', payload: { userId: user.id, username: user.username, vote: vote.vote, reason: vote.reason },
  }, { requestKey: vote.requestKey || `vote:${user.id}:${randomUUID()}`, source: { kind: 'route', name: 'vote' }, actor: `user:${user.id}`, appId: issue.app_id });
  const refused = failed(outcome);
  if (refused) return refused;
  const { rows } = await kernelPool!.query('SELECT 1 FROM issue_votes WHERE issue_id = $1 AND user_id = $2', [issue.id, user.id]);
  if (!rows.length) return { status: 200, body: { ok: true, toggled: true } };
  return { status: 200, body: { ok: true, [RESULT_KEYS.get(issue.kind)!]: await kindResult(issue.id) } };
}

export async function withdrawProposal(issue: { id: number; app_id: number }, user: { id: number; username: string }): Promise<Reply> {
  await ensureFiled(issue);
  const outcome = await runtime!.appendAndWait(machine!, issueKey(issue.id), {
    type: 'Withdraw', payload: { userId: user.id, username: user.username },
  }, { requestKey: `withdraw:${issue.id}:${user.id}`, source: { kind: 'route', name: 'withdraw' }, actor: `user:${user.id}`, appId: issue.app_id });
  if (outcome.status === 'rejected' && outcome.reason === 'not_open') return { status: 404, body: { error: 'Proposal not open' } };
  return failed(outcome) || { status: 200, body: { ok: true } };
}

export async function adminApplyProposal(
  issue: { id: number; app_id: number; kind: string }, user: { id: number; username: string }, requestKey?: string,
): Promise<Reply> {
  await ensureFiled(issue);
  const outcome = await runtime!.appendAndWait(machine!, issueKey(issue.id), {
    type: 'AdminApply', payload: { userId: user.id, username: user.username },
  }, { requestKey: requestKey || `admin-apply:${issue.id}:${randomUUID()}`, source: { kind: 'admin', name: 'admin-apply' }, actor: `user:${user.id}`, appId: issue.app_id });
  const refused = failed(outcome);
  if (refused) return refused;
  const applied = await kindResult(issue.id);
  return { status: 200, body: { ok: true, applied, secretChanged: issue.kind === 'secret_change' ? applied : null } };
}

// A close proposal's target was closed elsewhere (a merged PR's `Closes #N`,
// the issue-close watcher): tell each open proposal for those numbers.
export async function targetsClosed(appId: number, numbers: number[], cause: { kind: string; prNumber?: number }): Promise<number[]> {
  const { rows } = await kernelPool!.query(
    `SELECT id, (payload->>'issueNumber')::int AS n FROM issues
      WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
        AND (payload->>'issueNumber')::int = ANY($2::int[])`, [appId, numbers]);
  for (const r of rows) {
    await ensureFiled({ id: r.id, app_id: appId });
    await runtime!.append(machine!, issueKey(r.id), { type: 'TargetClosed', payload: { issueNumber: r.n, cause } },
      { requestKey: `target:${r.n}:${cause.kind}:${cause.prNumber ?? ''}`, source: { kind: 'system', name: 'target-closed' }, appId });
  }
  return rows.map((r: { id: number }) => r.id);
}
