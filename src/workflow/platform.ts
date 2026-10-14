// The workflow runtime inside the platform process: created at boot when a
// workflow flag is on, with its own small pool so pipeline slots and the
// outcome listener never take request connections. Every process appends,
// waits and runs pipeline slots (so a Pod that is not the leader, during a
// rollout, still decides its own votes at once); timers, services and the
// boot backfill run on the leader, and on a staging preview (which never
// stands for election) so a preview with the flag on still decides.

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createRuntime } from './kernel/index.ts';
import type { EventOutcome, Logger, Pool, Push, Queryable, Runtime } from './kernel/index.ts';
import { legacy } from './legacy.ts';
import { GOVERNANCE_KINDS } from './governance-proposal/facts.ts';
import { MACHINE, governanceProposal, issueKey } from './governance-proposal/machine.ts';
import { governanceNotifiers, governanceServices } from './governance-proposal/services.ts';
import { MACHINE as MERGE, mergeFollowups, sessionKey } from './merge-followups/machine.ts';
import { mergeFollowupsNotifiers, mergeFollowupsServices } from './merge-followups/services.ts';
import { MACHINE as BUILD, botBuild, buildKey } from './bot-build/machine.ts';
import type { Target as BuildTarget } from './bot-build/machine.ts';
import { botBuildServices } from './bot-build/services.ts';
import { MACHINE as DELIVERY, appDelivery, appKey } from './app-delivery/machine.ts';
import { appDeliveryServices } from './app-delivery/services.ts';
import { MACHINE as PREVIEW, preview, sessionKey as previewKey } from './preview/machine.ts';
import { PREPARE_LEASE_MS, previewServices } from './preview/services.ts';

const pg = createRequire(import.meta.url)('pg');

let runtime: Runtime | null = null;
let kernelPool: Pool & { end(): Promise<void> } | null = null;
// The machines this process registered, each only under its own flag
// (merge-followups also while it has work left to finish with its flag off).
let machine: ReturnType<typeof governanceProposal> | null = null;
let merges: ReturnType<typeof mergeFollowups> | null = null;
let mergesAdmitted = false;
// The Homeroom bot's builds and the bench's trials: on in every process that
// runs the workflow, which is every process (docs/plans/bot-build-workflow.md).
const builds = botBuild();
let deliveries: ReturnType<typeof appDelivery> | null = null;
let deliveriesAdmitted = false;
let previews: ReturnType<typeof preview> | null = null;
let previewsAdmitted = false;
let log: Logger | null = null;

// What the ownership triggers read, synced on every boot:
// - ownership_mode: 'raise' (tests, staging, local) or 'log' (production,
//   until no legacy writer is left);
// - enabled:<machine>: the machine's guard. A boot with its flag on sets
//   it. In 'log' mode (production) a boot with its flag off leaves it: the
//   flag is per process and the guard is the cluster's, and an old Pod still
//   running (a rollout, a rollback, a restart of a Pod from before) must not
//   switch it off under the Pods that run the machine. It goes when an admin
//   turns it off (turnGuardOff, Admin → Workflows) once no process runs the
//   machine. In 'raise' mode a flag-off boot turns it off, as before.
//   With it off, the triggers leave enrolled rows to the legacy writers
//   again, and the machine closes any instance whose row they closed when
//   it comes back.
async function setSetting(pool: Pool, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await pool.query('DELETE FROM wf_settings WHERE key = $1', [key]);
  } else {
    await pool.query(
      `INSERT INTO wf_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, value]);
  }
}

// Each machine's flag in this process's configuration.
// App delivery runs only beside merge follow-ups: with merge follow-ups
// off, the legacy merge tail deploys and marks a change live in one call,
// and nothing else may deploy beside the machine.
const FLAGS = new Map<string, { flag: string; on: (config: any) => boolean }>([
  [MACHINE, { flag: 'WF_GOVERNANCE_ENABLED', on: (c) => !!c.wfGovernanceEnabled }],
  [MERGE, { flag: 'WF_MERGE_FOLLOWUPS_ENABLED', on: (c) => !!c.wfMergeFollowupsEnabled }],
  [DELIVERY, { flag: 'WF_APP_DELIVERY_ENABLED', on: (c) => !!c.wfAppDeliveryEnabled && !!c.wfMergeFollowupsEnabled }],
  [PREVIEW, { flag: 'WF_PREVIEWS_ENABLED', on: (c) => !!c.wfPreviewsEnabled }],
]);

// Why a flag that is set does not run its machine here, for the boot log
// and Admin → Workflows.
export function flagBlocked(name: string, config: any): string | null {
  if (name === DELIVERY && config.wfAppDeliveryEnabled && !config.wfMergeFollowupsEnabled) {
    return 'WF_APP_DELIVERY_ENABLED needs WF_MERGE_FOLLOWUPS_ENABLED';
  }
  return null;
}

export async function syncSettings(pool: Pool, config: any): Promise<void> {
  const logMode = config.wfOwnershipMode === 'log';
  await setSetting(pool, 'ownership_mode', logMode ? 'log' : null);
  for (const [name, f] of FLAGS) {
    if (f.on(config)) { await setSetting(pool, `enabled:${name}`, '1'); continue; }
    // In 'raise' mode (development, staging previews, tests: one process,
    // where a guard left on refuses every legacy write to the rows it
    // held), a flag-off boot turns it off as before. In 'log' mode
    // (production, where Pods overlap) it stays until an admin turns it off.
    if (!logMode) { await setSetting(pool, `enabled:${name}`, null); continue; }
    const { rows } = await pool.query('SELECT 1 FROM wf_settings WHERE key = $1', [`enabled:${name}`]);
    if (rows.length) {
      (log || legacy('services/logger')).warn('workflow', 'A machine\'s ownership guard is on while its flag is off here; turn it off in Admin → Workflows once no process runs it',
        { machine: name, flag: f.flag });
    }
  }
}

// Each machine's guard, and whether this process's flag runs it: the admin
// view shows a guard on while the flag is off here (every process's flag
// may be off by now, after a rollback).
export async function guards(pool: Pool, config: any): Promise<{ machine: string; flag: string; on: boolean; flagHere: boolean; blocked: string | null }[]> {
  const { rows } = await pool.query(`SELECT key FROM wf_settings WHERE key LIKE 'enabled:%'`);
  const set = new Set(rows.map((r: { key: string }) => r.key));
  return [...FLAGS].map(([name, f]) => ({
    machine: name, flag: f.flag, on: set.has(`enabled:${name}`), flagHere: f.on(config), blocked: flagBlocked(name, config),
  }));
}

// An admin turns a machine's guard off, once its flag is off everywhere
// (here at least: a process whose flag is on would set it again at its
// next boot, and runs the machine meanwhile).
export async function turnGuardOff(pool: Pool, config: any, name: string, admin: { id: number }): Promise<void> {
  const f = FLAGS.get(name);
  if (!f) throw new AdminActionError(400, `${name} is not a workflow machine`);
  if (f.on(config)) throw new AdminActionError(409, `${f.flag} is on in this process: turn the flag off first`);
  await setSetting(pool, `enabled:${name}`, null);
  (log || legacy('services/logger')).warn('workflow', 'A machine\'s ownership guard was turned off', { machine: name, adminId: admin.id });
}

// Merges merge-followups accepted before its flag went off still finish
// (K13): their queued work, the events waiting for them, and the merges
// still waiting for a deploy that contains them (delivering, deploy_failed),
// which only this runtime hears about (productionDeployed).
async function mergesUnfinished(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM wf_work WHERE machine = $1 AND status IN ('queued', 'running', 'reported'))
         OR EXISTS (SELECT 1 FROM wf_events WHERE machine = $1 AND status = 'pending')
         OR EXISTS (SELECT 1 FROM wf_instances WHERE machine = $1 AND state IN ('delivering', 'deploy_failed')) AS unfinished`,
    [MERGE]);
  return !!rows[0]?.unfinished;
}

// Deploys app-delivery accepted before its flag went off still finish:
// requests waiting for it, its running deploys and their results.
async function deliveriesUnfinished(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM wf_work WHERE machine = $1 AND status IN ('queued', 'running', 'reported'))
         OR EXISTS (SELECT 1 FROM wf_events WHERE machine = $1 AND status = 'pending')
         OR EXISTS (SELECT 1 FROM wf_instances WHERE machine = $1 AND state = 'deploying') AS unfinished`,
    [DELIVERY]);
  return !!rows[0]?.unfinished;
}

// Sessions the preview machine still holds (not handed back, not retired):
// with its flag off, a boot hands each back to [main]'s paths (Detach).
async function previewsHeld(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM wf_instances WHERE machine = $1 AND state NOT IN ('detached', 'retired'))
         OR EXISTS (SELECT 1 FROM wf_work WHERE machine = $1 AND status IN ('queued', 'running', 'reported')) AS held`,
    [PREVIEW]);
  return !!rows[0]?.held;
}

// The build this process booted with, recorded on the platform's own row
// (apps.booted_shas, newest first, at most ten, one entry per build): what
// served, unlike main_sha, which the migration Job writes from the incoming
// release before the rollout. A history, so an older Pod booting after a
// newer one (a rollout) does not erase that the newer build ran. One
// statement: the row lock serialises two processes booting at once. Every
// process records it, flags or not, so it is there when a flag is turned on.
async function recordBooted(pool: Pool): Promise<void> {
  const sha = String(process.env.GIT_SHA || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return;
  await pool.query(
    `UPDATE apps a SET booted_shas = (
       SELECT COALESCE(jsonb_agg(y.e ORDER BY y.at DESC), '[]'::jsonb) FROM (
         SELECT x.e, x.at FROM (
           SELECT DISTINCT ON (e->>'sha') e, (e->>'at')::timestamptz AS at
             FROM jsonb_array_elements(jsonb_build_array(jsonb_build_object('sha', $1::text, 'at', now())) || a.booted_shas) e
            ORDER BY e->>'sha', (e->>'at')::timestamptz DESC) x
          ORDER BY x.at DESC LIMIT 10) y)
      WHERE a.self_hosted = TRUE`, [sha]);
}

// What browsers should hear, published on the WebSocket bus's channel in
// the transition's own transaction: Postgres delivers a NOTIFY only if it
// commits, to every web process listening then, the deciding one included
// (services/ws-bus.js WORKFLOW_SENDER), which relays it to its sockets.
export async function publishPushes(q: Queryable, pushes: Push[]): Promise<void> {
  const bus = legacy('services/ws-bus');
  await q.query('SELECT pg_notify($1, body) FROM unnest($2::text[]) WITH ORDINALITY AS t(body, n) ORDER BY n',
    [bus.CHANNEL, pushes.map((p) => bus.workflowBody(p.kind, p.routing ?? null, p.data))]);
}

export async function startWorkflow(config: any, opts: { loops: boolean }): Promise<void> {
  log = legacy('services/logger');
  const appPool = legacy('db/pool').getPool(config);
  await syncSettings(appPool, config);
  await recordBooted(appPool).catch((err) => log!.warn('workflow', 'Could not record the booted build', { message: err.message }));
  if (runtime) return;
  for (const name of FLAGS.keys()) {
    const blocked = flagBlocked(name, config);
    if (blocked) log!.warn('workflow', 'A workflow flag is set but its machine does not run', { machine: name, reason: blocked });
  }
  const deliveryOn = FLAGS.get(DELIVERY)!.on(config);
  const withMerges = !!config.wfMergeFollowupsEnabled || await mergesUnfinished(appPool).catch(() => false);
  const withDeliveries = deliveryOn || await deliveriesUnfinished(appPool).catch(() => false);
  const previewsOn = !!config.wfPreviewsEnabled;
  const withPreviews = previewsOn || await previewsHeld(appPool).catch(() => false);
  // The runtime always starts: bot builds have no other path. The other
  // machines still come and go with their flags.
  const workflowPool = new pg.Pool({
    connectionString: config.databaseUrl, max: config.wfPoolMax, idleTimeoutMillis: 30000, application_name: 'homeroom-workflow',
  });
  // An idle connection the server drops (a restart, a failover, an admin's
  // pg_terminate_backend) is reported here; without a listener it would be
  // an uncaught 'error' and end the process. The pool replaces it.
  workflowPool.on('error', (err: Error) => log!.warn('workflow', 'Idle workflow database connection lost', { message: err.message }));
  kernelPool = workflowPool;
  const deps = { config, pool: appPool };
  const machines = [];
  let services = {};
  // Whether the other machines ask app-delivery for a deploy: its flag here
  // (a request is recorded on the instance that made it, so one decided on
  // the work path stays there).
  const delivery = () => deliveriesAdmitted;
  if (config.wfGovernanceEnabled) {
    machine = governanceProposal({ dataKey: config.dataEncryptionKey, notifiers: governanceNotifiers(deps), delivery });
    machines.push(machine);
    services = { ...services, ...governanceServices(deps) };
  }
  if (withMerges) {
    merges = mergeFollowups({ dataKey: config.dataEncryptionKey, notifiers: mergeFollowupsNotifiers(deps), delivery,
      previews: () => previewsAdmitted });
    mergesAdmitted = !!config.wfMergeFollowupsEnabled;
    machines.push(merges);
    services = { ...services, ...mergeFollowupsServices(deps) };
  }
  machines.push(builds);
  services = { ...services, ...botBuildServices(deps) };
  if (withDeliveries) {
    deliveries = appDelivery();
    deliveriesAdmitted = deliveryOn;
    machines.push(deliveries);
    services = { ...services, ...appDeliveryServices(deps) };
  }
  if (withPreviews) {
    // A cancelled prepare learns it at its next checkpoint or lease renewal;
    // its attempt is retired, and a retirement runs, a lease and more later
    // (and never while it serves: services.ts).
    previews = preview({ maxRetries: config.checkMaxAutoRetries ?? 6, retireAfterMs: PREPARE_LEASE_MS + 30000 });
    previewsAdmitted = previewsOn;
    machines.push(previews);
    services = { ...services, ...previewServices(deps) };
  }
  const started = createRuntime({
    pool: kernelPool!, machines, services, slots: config.wfSlots, log: log!, publish: publishPushes,
  });
  try {
    await started.start({ slots: true });
  } catch (err) {
    // Half started is not started: the routes must keep using the legacy paths.
    await started.stop().catch(() => {});
    await kernelPool!.end().catch(() => {});
    kernelPool = null;
    machine = null;
    merges = null;
    mergesAdmitted = false;
    deliveries = null;
    deliveriesAdmitted = false;
    previews = null;
    previewsAdmitted = false;
    throw err;
  }
  runtime = started;
  log!.info('workflow', 'Workflow runtime started', { machines: machines.map((m) => m.name) });
  if (merges) await releaseBooted(appPool).catch((err) => log!.warn('workflow', 'Could not report the running release', { message: err.message }));
  if (opts.loops) await startWorkflowLoops();
}

// The leader's part: timers and services, then enrolling every open
// governance row the machine does not hold yet.
export async function startWorkflowLoops(): Promise<void> {
  if (!runtime) return;
  await runtime.start({ loops: true });
  if (previews && !previewsAdmitted) await detachPreviews();
  if (!machine) return;
  const { rows } = await kernelPool!.query(
    `SELECT i.id, i.app_id FROM issues i
      WHERE i.status = 'open' AND i.kind = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = $2 AND w.key = 'issue:' || i.id)`,
    [[...GOVERNANCE_KINDS], MACHINE]);
  for (const r of rows) await file(r.id, r.app_id, { kind: 'system', name: 'backfill' });
  if (rows.length) log!.info('workflow', 'Enrolled open governance proposals', { count: rows.length });
}

// The process stops leading but finishes its running work
// (docs/plans/draining-releases.md): no slot, timer or claim from here on;
// stopWorkflow() later aborts whatever is still running.
export async function quiesceWorkflow(): Promise<void> {
  if (runtime) await runtime.quiesce();
}

// The work items this process is running now (the drain waits for them).
export function workflowWorkRunning(): number {
  return runtime ? runtime.running() : 0;
}

export async function stopWorkflow(): Promise<void> {
  const r = runtime;
  runtime = null;
  machine = null;
  merges = null;
  mergesAdmitted = false;
  deliveries = null;
  deliveriesAdmitted = false;
  previews = null;
  previewsAdmitted = false;
  await r?.stop();
  await kernelPool?.end();
  kernelPool = null;
}

// ── Governance proposals, for the routes ────────────────────────────────

export function governanceEnabled(): boolean {
  return runtime !== null && machine !== null;
}

export function governsKind(kind: string): boolean {
  return governanceEnabled() && GOVERNANCE_KINDS.has(kind);
}

// Whether the runtime runs in this process (the admin console's reads say so).
export function workflowRunning(): boolean {
  return runtime !== null;
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

// Append a route's event and wait for its outcome. An open row the machine
// does not hold yet (one that predates the flag, if the boot backfill has
// not reached it) answers `no_instance`: file it, then send the event again
// under the same request key (a rejection leaves no receipt). Checking first
// would cost every request a query for a case the backfill almost always
// has covered.
async function appendFiled(issue: { id: number; app_id: number; status?: string }, event: { type: string; payload: unknown },
  o: { requestKey: string; source: Source; actor: string }): Promise<EventOutcome> {
  const send = () => runtime!.appendAndWait(machine!, issueKey(issue.id), event, { ...o, appId: issue.app_id });
  const outcome = await send();
  if (outcome.status !== 'rejected' || outcome.reason !== 'no_instance' || issue.status !== 'open') return outcome;
  await file(issue.id, issue.app_id);
  return send();
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

// What the machine recorded as its answer (VoteCast, AdminApply): either
// { toggled: true } or { result: <the per-kind result the client reads> }.
const answer = (outcome: EventOutcome) => (outcome.reply || {}) as { toggled?: boolean; result?: Record<string, unknown> };

export async function voteOnProposal(
  issue: { id: number; app_id: number; kind: string; status: string },
  user: { id: number; username: string },
  vote: { vote: string; reason: string | null; requestKey?: string },
): Promise<Reply> {
  const outcome = await appendFiled(issue, {
    type: 'VoteCast', payload: { userId: user.id, username: user.username, vote: vote.vote, reason: vote.reason },
  }, { requestKey: vote.requestKey || `vote:${user.id}:${randomUUID()}`, source: { kind: 'route', name: 'vote' }, actor: `user:${user.id}` });
  // A closed row the machine never held: [main] decided it.
  if (outcome.status === 'rejected' && outcome.reason === 'no_instance') return REJECTIONS.get('not_open')!;
  const refused = failed(outcome);
  if (refused) return refused;
  const { toggled, result } = answer(outcome);
  if (toggled) return { status: 200, body: { ok: true, toggled: true } };
  return { status: 200, body: { ok: true, [RESULT_KEYS.get(issue.kind)!]: result ?? null } };
}

export async function withdrawProposal(issue: { id: number; app_id: number; status: string }, user: { id: number; username: string }): Promise<Reply> {
  const outcome = await appendFiled(issue, {
    type: 'Withdraw', payload: { userId: user.id, username: user.username },
  }, { requestKey: `withdraw:${issue.id}:${user.id}`, source: { kind: 'route', name: 'withdraw' }, actor: `user:${user.id}` });
  if (outcome.status === 'rejected' && ['not_open', 'no_instance'].includes(outcome.reason || '')) {
    return { status: 404, body: { error: 'Proposal not open' } };
  }
  return failed(outcome) || { status: 200, body: { ok: true } };
}

export async function adminApplyProposal(
  issue: { id: number; app_id: number; kind: string; status: string }, user: { id: number; username: string }, requestKey?: string,
): Promise<Reply> {
  const outcome = await appendFiled(issue, {
    type: 'AdminApply', payload: { userId: user.id, username: user.username },
  }, { requestKey: requestKey || `admin-apply:${issue.id}:${randomUUID()}`, source: { kind: 'admin', name: 'admin-apply' }, actor: `user:${user.id}` });
  // A closed row the machine never held: [main] decided it.
  if (outcome.status === 'rejected' && outcome.reason === 'no_instance') return REJECTIONS.get('not_open')!;
  const refused = failed(outcome);
  if (refused) return refused;
  const applied = answer(outcome).result ?? null;
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
    // Filing an enrolled row is a no-op (a replay, or `already_filed`).
    await file(r.id, appId, { kind: 'system', name: 'target-closed' });
    await runtime!.append(machine!, issueKey(r.id), { type: 'TargetClosed', payload: { issueNumber: r.n, cause } },
      { requestKey: `target:${r.n}:${cause.kind}:${cause.prNumber ?? ''}`, source: { kind: 'system', name: 'target-closed' }, appId });
  }
  return rows.map((r: { id: number }) => r.id);
}

// ── Merge follow-ups ────────────────────────────────────────────────────

// Whether a merge hands its follow-ups to the machine. Off with the flag,
// even while the machine finishes work it accepted before.
export function mergeFollowupsEnabled(): boolean {
  return runtime !== null && merges !== null && mergesAdmitted;
}

const count = (n: unknown) => (Number.isInteger(n) && (n as number) >= 0 ? n as number : null);

// GitHub merged a proposal: the merge itself (routes/votes.js checkAndMerge)
// reports it and waits briefly for the status move. Resolves the outcome;
// 'pending' still means the merge is recorded once the event is processed.
export async function mergeConfirmed(m: {
  sessionId: number; appId: number; mergeSha: string | null; force: boolean; forcedBy?: string | null;
  tally: { yes: unknown; required: unknown; active: unknown };
}): Promise<EventOutcome> {
  return runtime!.appendAndWait(merges!, sessionKey(m.sessionId), { type: 'Merged', payload: {
    sessionId: m.sessionId, mergeSha: m.mergeSha, mergedAt: new Date().toISOString(), force: !!m.force,
    forcedBy: m.forcedBy || null, observedBy: 'merge',
    tally: { yes: count(m.tally.yes) ?? 0, required: count(m.tally.required), active: count(m.tally.active) },
  } }, { requestKey: `merged:${m.sessionId}:merge`, source: { kind: 'system', name: 'merge' }, appId: m.appId, waitMs: 5000 });
}

// Recovery found on GitHub a merge whose own report was lost (a crash
// between GitHub's answer and the append). The tally is read again: the
// counted Yes votes on the version that merged, and the app's active members.
export async function mergeObserved(m: { sessionId: number; appId: number; mergeSha: string | null; mergedAt: string | null }): Promise<number> {
  const pool = kernelPool!;
  const { countedVotePredicateSql } = legacy('services/pr-vote-revision');
  const { rows: [v] } = await pool.query(
    `SELECT count(*)::int AS yes, cs.votes_required FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE pv.session_id = $1 AND pv.vote = 'yes' AND ${countedVotePredicateSql('pv', 'cs')}
      GROUP BY cs.votes_required`, [m.sessionId]);
  const stats = await legacy('services/active-users').getActiveUserStats(pool, m.appId).catch(() => null);
  return runtime!.append(merges!, sessionKey(m.sessionId), { type: 'Merged', payload: {
    sessionId: m.sessionId, mergeSha: m.mergeSha, mergedAt: m.mergedAt || new Date().toISOString(), force: false,
    observedBy: 'recovery',
    tally: { yes: v?.yes ?? 0, required: count(v?.votes_required), active: count(stats?.active) },
  } }, { requestKey: `merged:${m.sessionId}:recovery`, source: { kind: 'system', name: 'recovery' }, appId: m.appId });
}

// Production of an app now runs `sha` (staging.rebuildProduction, whoever
// called it): every merge of that app still waiting to go live hears it,
// and checks whether that build contains it. Also while the flag is off, so
// accepted merges still finish.
export async function productionDeployed(appId: number, sha: string): Promise<void> {
  if (!runtime || !merges || !/^[0-9a-f]{40}$/i.test(String(sha || ''))) return;
  const { rows } = await kernelPool!.query(
    `SELECT key FROM wf_instances
      WHERE machine = $1 AND app_id = $2 AND state IN ('delivering', 'deploy_failed') AND data->>'role' = 'merge'`,
    [MERGE, appId]);
  for (const r of rows) {
    await runtime.append(merges, r.key, { type: 'Deployed', payload: { sha: sha.toLowerCase() } },
      { requestKey: `deployed:${sha.toLowerCase()}`, source: { kind: 'system', name: 'deploy' }, appId });
  }
}

// The platform's own app is released outside this process (GitHub Actions,
// Argo CD): each process that boots reports the build it runs.
async function releaseBooted(pool: Pool): Promise<void> {
  const sha = String(process.env.GIT_SHA || '');
  if (!/^[0-9a-f]{40}$/i.test(sha)) return;
  const { rows } = await pool.query('SELECT id FROM apps WHERE self_hosted = TRUE');
  for (const a of rows) await productionDeployed(a.id, sha);
}

// ── Bot builds and bench trials ─────────────────────────────────────────

// Whether builds run on the machine here; without the runtime (it failed to
// start) services/build-runs.js runs them in its process, unkept, as before.
export function botBuildsRunning(): boolean {
  return runtime !== null;
}

// Start a build: one instance per build, so asking twice starts it once.
export async function requestBuild(b: {
  target: BuildTarget; id: number; nonce?: string | null; appId: number | null; input: Record<string, unknown>;
}): Promise<string> {
  const key = buildKey(b.target, b.id, b.nonce ?? null);
  await runtime!.append(builds, key, { type: 'Requested', payload: { target: b.target, id: b.id, nonce: b.nonce ?? null, input: b.input } },
    { requestKey: `request:${key}`, source: { kind: 'system', name: 'bot-build' }, appId: b.appId ?? null });
  return key;
}

// Where a build is: 'building', 'done', 'failed', or null when there is none.
export async function buildState(key: string): Promise<{ state: string; data: unknown } | null> {
  if (!kernelPool) return null;
  const { rows: [r] } = await kernelPool.query(`SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2`, [BUILD, key]);
  return r ? { state: r.state, data: r.data } : null;
}

// The builds under way, for the bot's and the lane's slots after a restart.
export async function buildsUnderWay(target?: BuildTarget): Promise<{ key: string; target: BuildTarget; id: number; nonce: string | null; appId: number | null }[]> {
  if (!kernelPool) return [];
  const { rows } = await kernelPool.query(
    `SELECT key, app_id, data FROM wf_instances WHERE machine = $1 AND state = 'building'
        AND ($2::text IS NULL OR data->>'target' = $2) ORDER BY created_at`, [BUILD, target ?? null]);
  return rows.map((r: { key: string; app_id: number | null; data: { target: BuildTarget; id: number; nonce?: string | null } }) => ({
    key: r.key, target: r.data.target, id: Number(r.data.id), nonce: r.data.nonce ?? null, appId: r.app_id ?? null,
  }));
}

// ── App delivery ────────────────────────────────────────────────────────

// Whether a deploy is asked of app-delivery rather than run here. Off with
// the flag, even while the machine finishes deploys it accepted before.
export function deliveryEnabled(): boolean {
  return runtime !== null && deliveries !== null && deliveriesAdmitted;
}

// Ask for a deploy of an app's production (the Redeploy route, the drift
// poller, heal, rollover, a secret change, a demo reset): recorded at once,
// deployed by the machine one at a time. Resolves the event's id; the
// "deploying" state and its end reach browsers from the machine.
export async function requestDeploy(appId: number, reason: string): Promise<number> {
  return runtime!.append(deliveries!, appKey(appId), { type: 'DeployRequested', payload: { appId, reason } },
    { requestKey: `deploy:${reason}:${randomUUID()}`, source: { kind: 'system', name: reason }, appId });
}

// ── Previews and required checks ────────────────────────────────────────

// Whether a proposal's preview and checks are asked of the preview machine
// rather than built here. Off with the flag, even while the machine hands
// back the sessions it held.
export function previewsEnabled(): boolean {
  return runtime !== null && previews !== null && previewsAdmitted;
}

// The preview machine's instance of a session, as the sources and readers
// need it: its state and data, or null.
export async function previewInstance(sessionId: number): Promise<{ state: string; data: any } | null> {
  if (!kernelPool) return null;
  const { rows: [r] } = await kernelPool.query(
    'SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [PREVIEW, previewKey(sessionId)]);
  return r ? { state: r.state, data: r.data } : null;
}

// The machine holds the session (not handed back, not retired).
export async function previewHeld(sessionId: number): Promise<boolean> {
  if (!previewsEnabled()) return false;
  const i = await previewInstance(sessionId);
  return !!i && i.state !== 'detached' && i.state !== 'retired';
}

const sys = (name: string) => ({ kind: 'system' as const, name });
// A request key derived from what is asked and the instance's version: a
// repeated press joins by state (a run outstanding for the head), so the
// version is enough to tell two presses apart.
async function versioned(sessionId: number, what: string): Promise<string> {
  const { rows: [r] } = await kernelPool!.query(
    'SELECT version FROM wf_instances WHERE machine = $1 AND key = $2', [PREVIEW, previewKey(sessionId)]);
  return `${what}:v${r?.version ?? 0}`;
}

// A source announces a head (exact, 40 hex).
export async function submitRevision(r: { sessionId: number; appId: number; head: string; source: string;
  trigger?: string | null; carryFrom?: string | null }): Promise<EventOutcome> {
  return runtime!.appendAndWait(previews!, previewKey(r.sessionId), { type: 'RevisionSubmitted', payload: {
    sessionId: r.sessionId, head: r.head, source: r.source, trigger: r.trigger ?? null, carryFrom: r.carryFrom ?? null,
  } }, { requestKey: `rev:${r.head}:${r.source}:${randomUUID()}`, source: sys(r.source), appId: r.appId, waitMs: 2000 });
}

// A person asks for the preview (ensure: the Preview click; deploy).
export async function requestPreview(r: { sessionId: number; appId: number; head: string; reason: string; actor?: string | null }): Promise<EventOutcome> {
  return runtime!.appendAndWait(previews!, previewKey(r.sessionId), { type: 'PreviewRequested', payload: {
    sessionId: r.sessionId, head: r.head, reason: r.reason,
  } }, { requestKey: await versioned(r.sessionId, `${r.reason}:${r.head}`), source: { kind: 'route', name: r.reason },
    actor: r.actor ?? undefined, appId: r.appId, waitMs: 2000 });
}

export async function requestRecheck(r: { sessionId: number; appId: number; reason: string; trigger?: string | null;
  actor?: string | null; system?: boolean }): Promise<EventOutcome> {
  return runtime!.appendAndWait(previews!, previewKey(r.sessionId), { type: 'RecheckRequested', payload: {
    reason: r.reason, trigger: r.trigger ?? null,
  } }, { requestKey: await versioned(r.sessionId, `recheck:${r.reason}`), source: r.system ? sys(r.reason) : { kind: 'route', name: r.reason },
    actor: r.actor ?? undefined, appId: r.appId, waitMs: 2000 });
}

export async function checksSkipped(sessionId: number, appId: number, head: string, reason: string,
  expected: string | null = null): Promise<EventOutcome> {
  return runtime!.appendAndWait(previews!, previewKey(sessionId), { type: 'ChecksSkipped', payload: { sessionId, head, reason, expected } },
    { requestKey: `skipped:${head}:${randomUUID()}`, source: sys('checks-skipped'), appId, waitMs: 2000 });
}

export async function checksCleared(sessionId: number, appId: number, reason: string): Promise<EventOutcome> {
  return runtime!.appendAndWait(previews!, previewKey(sessionId), { type: 'ChecksCleared', payload: { reason } },
    { requestKey: `cleared:${reason}:${randomUUID()}`, source: { kind: 'route', name: reason }, appId, waitMs: 2000 });
}

export async function conflictResolved(sessionId: number, appId: number, head: string): Promise<number> {
  return runtime!.append(previews!, previewKey(sessionId), { type: 'ConflictResolved', payload: { head } },
    { requestKey: await versioned(sessionId, `clean:${head}`), source: sys('conflict-resolved'), appId });
}

export async function previewLost(sessionId: number, appId: number, attempt: number, detail: string | null): Promise<number> {
  return runtime!.append(previews!, previewKey(sessionId), { type: 'PreviewLost', payload: { attempt, detail } },
    { requestKey: await versioned(sessionId, `lost:${attempt}`), source: sys('preview-lost'), appId });
}

// Retire a session's preview. Answers null when the machine does not hold
// the session (the caller retires it on [main]'s path), else the outcome:
// a non-terminal retirement is refused while someone works on the session,
// while it is under review, or while it builds or checks.
export async function retirePreview(sessionId: number, appId: number, reason: string, terminal: boolean): Promise<EventOutcome | null> {
  if (!await previewHeld(sessionId)) return null;
  return runtime!.appendAndWait(previews!, previewKey(sessionId), { type: 'RetireRequested', payload: { reason, terminal } },
    { requestKey: await versioned(sessionId, `retire:${reason}`), source: sys(reason), appId, waitMs: 2000 });
}

// Who is working on a session: an old flow's operation starts or ends
// (services/active-workers.js). Recorded only with the flag on; the start
// is waited for, so a reader in another process sees it before the work
// goes on.
export async function operationStarted(o: { sessionId: number; id: string; kind: string; holder: string }): Promise<void> {
  if (!previewsEnabled()) return;
  const { rows: [s] } = await kernelPool!.query('SELECT app_id FROM chat_sessions WHERE id = $1', [o.sessionId]);
  await runtime!.appendAndWait(previews!, previewKey(o.sessionId), { type: 'OperationStarted', payload: o },
    { requestKey: `op:${o.id}:start`, source: sys('operation'), appId: s?.app_id ?? null, waitMs: 2000 });
}
export async function operationEnded(o: { sessionId: number; id: string }): Promise<void> {
  if (!previewsEnabled()) return;
  await runtime!.append(previews!, previewKey(o.sessionId), { type: 'OperationEnded', payload: { id: o.id } },
    { requestKey: `op:${o.id}:end`, source: sys('operation') });
}

// The flag is off here: hand every session the machine holds back to
// [main]'s paths. Its work is cancelled; what it built is left in place
// under names [main]'s reapers know.
async function detachPreviews(): Promise<void> {
  const boot = randomUUID();
  const { rows } = await kernelPool!.query(
    `SELECT key, app_id FROM wf_instances WHERE machine = $1 AND state NOT IN ('detached', 'retired')`, [PREVIEW]);
  for (const r of rows) {
    await runtime!.append(previews!, r.key, { type: 'Detach', payload: {} },
      { requestKey: `detach:${boot}`, source: sys('flag-off'), appId: r.app_id });
  }
  if (rows.length) log!.info('workflow', 'Handed previews back to the legacy paths (WF_PREVIEWS_ENABLED is off)', { count: rows.length });
}

// ── The admin console ───────────────────────────────────────────────────

// The events an admin may append from the console, per machine, and the
// payload each needs beyond the admin's own identity.
const ADMIN_EVENTS = new Map<string, ReadonlySet<string>>([
  [MACHINE, new Set(['Evaluate', 'AdminApply', 'RetryFollowup'])],
  [MERGE, new Set(['RetryDelivery', 'RetryFollowup'])],
  [DELIVERY, new Set(['EndDeploy'])],
  [PREVIEW, new Set(['AdminRetry', 'AdminRetire', 'AdminEnd'])],
]);

export function adminEvents(): Record<string, string[]> {
  return Object.fromEntries([...ADMIN_EVENTS].map(([m, types]) => [m, [...types]]));
}

export class AdminActionError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function adminEvent(
  machineName: string, key: string, type: string, payload: Record<string, unknown>, admin: { id: number; username: string },
): Promise<EventOutcome> {
  if (!runtime) throw new AdminActionError(409, 'The workflow runtime is not running here');
  if (!ADMIN_EVENTS.get(machineName)?.has(type)) throw new AdminActionError(400, `${type} is not an admin action on ${machineName}`);
  const body = type === 'AdminApply' ? { userId: admin.id, username: admin.username }
    : type === 'RetryFollowup' ? { workKey: String(payload.workKey || '') } : {};
  const target = machineName === MACHINE ? machine : machineName === MERGE ? merges
    : machineName === DELIVERY ? deliveries : machineName === PREVIEW ? previews : null;
  if (!target) throw new AdminActionError(409, `${machineName} is not running here`);
  return runtime.appendAndWait(target, key, { type, payload: body },
    { requestKey: `admin:${randomUUID()}`, source: { kind: 'admin', name: 'console' }, actor: `user:${admin.id}` });
}

export async function adminRelease(machineName: string, key: string, mode: 'retry' | 'skip', admin: { id: number }) {
  if (!runtime) throw new AdminActionError(409, 'The workflow runtime is not running here');
  return runtime.release(machineName, key, { mode, actor: `user:${admin.id}` });
}
