// The workflow runtime inside the platform process: created at boot in
// every process (a failed start ends it: server.js), with its own small pool
// so pipeline slots and the outcome listener never take request
// connections. Every process appends, waits and runs pipeline slots (so a
// Pod that is not the leader, during a rollout, still decides its own votes
// at once); timers, services and the boot backfill run on the leader, and
// on a staging preview (which never stands for election) so a preview still
// decides.

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
import { LIVE as SHOTS_LIVE, MACHINE as SHOTS, sessionKey as shotsKey, shots } from './shots/machine.ts';
import { shotsServices } from './shots/services.ts';

const pg = createRequire(import.meta.url)('pg');

let runtime: Runtime | null = null;
let kernelPool: Pool & { end(): Promise<void> } | null = null;
// The machines this process registered: every one, in every process (their
// old paths are deleted).
let machine: ReturnType<typeof governanceProposal> | null = null;
let merges: ReturnType<typeof mergeFollowups> | null = null;
// The Homeroom bot's builds and the bench's trials: on in every process that
// runs the workflow, which is every process (docs/plans/bot-build-workflow.md).
const builds = botBuild();
let deliveries: ReturnType<typeof appDelivery> | null = null;
let previews: ReturnType<typeof preview> | null = null;
let shotRuns: ReturnType<typeof shots> | null = null;
let log: Logger | null = null;

// What the ownership triggers read, synced on every boot: enabled:<machine>
// for every machine (wf_holds reads it). Every machine is the only path for
// what it decides, so its guard is always on and always refuses a write
// from outside it.
const MACHINES = [MACHINE, MERGE, DELIVERY, PREVIEW, SHOTS];

export async function syncSettings(pool: Pool): Promise<void> {
  for (const name of MACHINES) {
    await pool.query(
      `INSERT INTO wf_settings (key, value) VALUES ($1, '1')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [`enabled:${name}`]);
  }
}

// The build this process booted with, recorded on the platform's own row
// (apps.booted_shas, newest first, at most ten, one entry per build): what
// served, unlike main_sha, which the migration Job writes from the incoming
// release before the rollout. A history, so an older Pod booting after a
// newer one (a rollout) does not erase that the newer build ran. One
// statement: the row lock serialises two processes booting at once. Every
// serving process records it (releaseServing): a merge recovery records late
// reads it.
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
  await syncSettings(appPool);
  if (runtime) return;
  const workflowPool = new pg.Pool({
    connectionString: config.databaseUrl, max: config.wfPoolMax, idleTimeoutMillis: 30000, application_name: 'homeroom-workflow',
  });
  // An idle connection the server drops (a restart, a failover, an admin's
  // pg_terminate_backend) is reported here; without a listener it would be
  // an uncaught 'error' and end the process. The pool replaces it.
  workflowPool.on('error', (err: Error) => log!.warn('workflow', 'Idle workflow database connection lost', { message: err.message }));
  kernelPool = workflowPool;
  const deps = { config, pool: appPool, requestDeploy };
  machine = governanceProposal({ dataKey: config.dataEncryptionKey, notifiers: governanceNotifiers(deps) });
  merges = mergeFollowups({ dataKey: config.dataEncryptionKey, notifiers: mergeFollowupsNotifiers(deps) });
  deliveries = appDelivery();
  // A cancelled prepare learns it at its next checkpoint or lease renewal;
  // its attempt is retired, and a retirement runs, a lease and more later
  // (and never while it serves: services.ts).
  previews = preview({ maxRetries: config.checkMaxAutoRetries ?? 6, retireAfterMs: PREPARE_LEASE_MS + 30000 });
  shotRuns = shots({
    execute: !!config.shots?.execute,
    agentBudgetMs: Number(config.shots?.maxAgentMs) || 480_000,
    runBudgetMs: Number(config.shots?.maxRunMs) || 1_440_000,
    buildSha: /^[0-9a-f]{40}$/.test(String(process.env.GIT_SHA || '')) ? String(process.env.GIT_SHA) : null,
  });
  const machines = [machine, merges, builds, deliveries, previews, shotRuns];
  const services = {
    ...governanceServices(deps), ...mergeFollowupsServices(deps), ...botBuildServices(deps),
    ...appDeliveryServices(deps), ...previewServices(deps), ...shotsServices(deps),
  };
  const started = createRuntime({
    pool: kernelPool!, machines, services, slots: config.wfSlots, log: log!, publish: publishPushes,
  });
  try {
    await started.start({ slots: true });
  } catch (err) {
    // Half started is not started: the caller (server.js) exits the process.
    await started.stop().catch(() => {});
    await kernelPool!.end().catch(() => {});
    kernelPool = null;
    machine = null;
    merges = null;
    deliveries = null;
    previews = null;
    shotRuns = null;
    throw err;
  }
  runtime = started;
  log!.info('workflow', 'Workflow runtime started', { machines: machines.map((m) => m.name) });
  if (opts.loops) await startWorkflowLoops();
}

// This process serves people the build it booted with: server.js calls it
// once its listener is up, on a process that serves requests, beside
// platform-release.recordRunning. The build is recorded on the platform's
// own row (recordBooted), and every self-hosted merge waiting to go live
// hears it is deployed (releaseBooted). A conductor serves nobody
// (docs/plans/web-and-conductor.md): its booting says nothing about what
// people get, and a release's conductor can be up before its web Pods
// serve, so it never calls this. Never throws.
export async function releaseServing(pool: Pool): Promise<void> {
  const warn = (what: string) => (err: Error) =>
    (log ?? legacy('services/logger')).warn('workflow', what, { message: err.message });
  await recordBooted(pool).catch(warn('Could not record the booted build'));
  if (runtime) await releaseBooted(pool).catch(warn('Could not report the running release'));
}

// The leader's part: timers and services, then enrolling every open
// governance row the machine does not hold yet.
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
  await retryPlatformFaults();
  await retryShotsCutOff();
  watchShotsCutOff();
}

// Shots [main] was taking in a process the release replaced (or that a
// release interrupted, on the head they were for): each open proposal's are
// taken again by the shots machine, once. Its first event adopts the
// proposal from its row (ending the run that was cut off). A run counts once
// it has gone quiet: [main]'s run beats its row every few seconds while its
// process lives, and a rollout keeps [main]'s processes serving (and
// starting runs) for a while after this one leads, so this looks again every
// two minutes for an hour. Transitional: once no release from before the
// machine runs, there is nothing to find.
const CUT_OFF_QUIET = '5 minutes';
const CUT_OFF_EVERY_MS = 2 * 60 * 1000;
const CUT_OFF_FOR_MS = 60 * 60 * 1000;
let cutOffWatch: NodeJS.Timeout | null = null;

async function retryShotsCutOff(): Promise<void> {
  if (!shotRuns || !runtime) return;
  const { rows } = await kernelPool!.query(
    `SELECT cs.id, cs.app_id FROM chat_sessions cs JOIN shot_runs r ON r.id = cs.shots_run_id
      WHERE cs.status IN ('active', 'paused', 'promoted', 'merging')
        AND ((r.state IN ('planned', 'provisioning', 'exploring', 'replaying', 'reviewing')
              AND r.updated_at < NOW() - $2::interval)
             OR (r.state = 'failed' AND r.failure_code = 'shots_run_interrupted'))
        AND NOT EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = $1 AND w.key = 'session:' || cs.id)`,
    [SHOTS, CUT_OFF_QUIET]);
  const release = String(process.env.GIT_SHA || 'dev').slice(0, 40);
  for (const r of rows) {
    await runtime!.append(shotRuns, shotsKey(r.id), { type: 'RetryRequested', payload: { sessionId: r.id, reason: 'release' } },
      { requestKey: `shots-release:${release}:${r.id}`, source: { kind: 'system', name: 'release' }, appId: r.app_id ?? undefined })
      .catch((err: Error) => log!.warn('workflow', 'Could not take cut-off shots again', { sessionId: r.id, message: err.message }));
  }
  if (rows.length) log!.info('workflow', 'Shots cut off by the release taken again', { count: rows.length });
}

function watchShotsCutOff(): void {
  if (cutOffWatch) return;
  const until = Date.now() + CUT_OFF_FOR_MS;
  cutOffWatch = setInterval(() => {
    if (Date.now() > until || !runtime) { clearInterval(cutOffWatch!); cutOffWatch = null; return; }
    retryShotsCutOff().catch((err: Error) => log!.warn('workflow', 'Could not look for cut-off shots', { message: err.message }));
  }, CUT_OFF_EVERY_MS);
  cutOffWatch.unref?.();
}

// A release is when a fix to the platform's own fault (a check Job refused
// or lost, the preview database server down) most often arrives: every
// preview whose last error was the platform's, within the day it keeps
// retrying, is retried now instead of at its scheduled retry up to 30
// minutes on. Once per release (the request key names the build).
async function retryPlatformFaults(): Promise<void> {
  if (!previews) return;
  const { rows } = await kernelPool!.query(
    `SELECT key, app_id FROM wf_instances
      WHERE machine = $1
        AND (state = 'failed' OR (state = 'settled' AND data->>'verdict' = 'error'))
        AND (data->>'platformFault')::boolean
        AND (data->>'firstFailureAt')::timestamptz > now() - interval '1 day'`, [PREVIEW]);
  const release = String(process.env.GIT_SHA || 'dev').slice(0, 40);
  for (const r of rows) {
    await runtime!.append(previews, r.key, { type: 'RetryDue', payload: {} },
      { requestKey: `release-retry:${release}:${r.key}`, source: { kind: 'system', name: 'release-retry' }, appId: r.app_id ?? undefined })
      .catch((err: Error) => log!.warn('workflow', 'Could not retry a platform fault at boot', { key: r.key, message: err.message }));
  }
  if (rows.length) log!.info('workflow', 'Platform faults retried at boot', { count: rows.length });
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
  if (cutOffWatch) { clearInterval(cutOffWatch); cutOffWatch = null; }
  const r = runtime;
  runtime = null;
  machine = null;
  merges = null;
  deliveries = null;
  previews = null;
  shotRuns = null;
  await r?.stop();
  await kernelPool?.end();
  kernelPool = null;
}

// ── Governance proposals, for the routes ────────────────────────────────

// The runtime this process decides with. A route reached before it started,
// or after it stopped, answers an error rather than deciding without it.
function running(): Runtime {
  if (!runtime || !machine) throw new Error('The workflow runtime is not running in this process');
  return runtime;
}

// Whether the runtime runs in this process (the admin console's reads say so).
export function workflowRunning(): boolean {
  return runtime !== null;
}

type Source = { kind: 'route' | 'system' | 'admin'; name?: string };

async function file(issueId: number, appId: number, source: Source = { kind: 'route' }) {
  return running().append(machine!, issueKey(issueId), { type: 'Filed', payload: { issueId } },
    { requestKey: `file:${issueId}`, source, appId });
}

// Enroll a governance row now (after the route that created it commits).
export async function fileProposal(issueId: number, appId: number): Promise<void> {
  if (runtime) await file(issueId, appId);
}

// Append a route's event and wait for its outcome. An open row the machine
// does not hold yet (one filed before the machine ran, if the boot backfill has
// not reached it) answers `no_instance`: file it, then send the event again
// under the same request key (a rejection leaves no receipt). Checking first
// would cost every request a query for a case the backfill almost always
// has covered.
async function appendFiled(issue: { id: number; app_id: number; status?: string }, event: { type: string; payload: unknown },
  o: { requestKey: string; source: Source; actor: string }): Promise<EventOutcome> {
  const send = () => running().appendAndWait(machine!, issueKey(issue.id), event, { ...o, appId: issue.app_id });
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
  running();
  const { rows } = await kernelPool!.query(
    `SELECT id, (payload->>'issueNumber')::int AS n FROM issues
      WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
        AND (payload->>'issueNumber')::int = ANY($2::int[])`, [appId, numbers]);
  for (const r of rows) {
    // Filing an enrolled row is a no-op (a replay, or `already_filed`).
    await file(r.id, appId, { kind: 'system', name: 'target-closed' });
    await running().append(machine!, issueKey(r.id), { type: 'TargetClosed', payload: { issueNumber: r.n, cause } },
      { requestKey: `target:${r.n}:${cause.kind}:${cause.prNumber ?? ''}`, source: { kind: 'system', name: 'target-closed' }, appId });
  }
  return rows.map((r: { id: number }) => r.id);
}

// ── Merge follow-ups ────────────────────────────────────────────────────

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

// The platform's own app now runs `sha` (its release booting): every merge
// of it still waiting to go live hears it, and checks whether that build
// contains it. (A child app's deploys are app-delivery's, which tells the
// merges waiting on it.)
async function productionDeployed(appId: number, sha: string): Promise<void> {
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

// Ask for a deploy of an app's production (the Redeploy route, the drift
// poller, heal, rollover, a demo reset, and the old deploy work a merge or
// a secret change recorded before every deploy was app-delivery's):
// recorded at once, deployed by the machine one at a time. Resolves the
// event's id; the "deploying" state and its end reach browsers from the
// machine. A request key makes asking again a replay.
export async function requestDeploy(appId: number, reason: string, o: {
  prNumber?: number | null; revision?: string | null; reuse?: unknown; requestKey?: string;
} = {}): Promise<number> {
  return runtime!.append(deliveries!, appKey(appId), { type: 'DeployRequested', payload: {
    appId, reason, prNumber: o.prNumber ?? null, revision: o.revision ?? null, reuse: o.reuse ?? null,
  } }, { requestKey: o.requestKey ?? `deploy:${reason}:${randomUUID()}`, source: { kind: 'system', name: reason }, appId });
}

// ── Previews and required checks ────────────────────────────────────────

// Whether the preview machine runs in this process: in every process once
// its runtime has started (a failed start ends the process: server.js).
export function previewsEnabled(): boolean {
  return runtime !== null && previews !== null;
}

// The preview machine's instance of a session, as the sources and readers
// need it: its state and data, or null.
export async function previewInstance(sessionId: number): Promise<{ state: string; data: any; deadline_at: Date | null } | null> {
  if (!kernelPool) return null;
  const { rows: [r] } = await kernelPool.query(
    'SELECT state, data, deadline_at FROM wf_instances WHERE machine = $1 AND key = $2', [PREVIEW, previewKey(sessionId)]);
  return r ? { state: r.state, data: r.data, deadline_at: r.deadline_at ?? null } : null;
}

// The machine holds the session (not retired, nor handed back before its
// old paths were deleted).
export async function previewHeld(sessionId: number): Promise<boolean> {
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
  return runtime!.appendAndWait(previews!, previewKey(sessionId), { type: 'ChecksCleared', payload: { reason, sessionId } },
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

// Retire a session's preview (one the machine does not hold yet is adopted
// from its row first). A non-terminal retirement is refused while someone
// works on the session, while it is under review, or while it builds or
// checks.
export async function retirePreview(sessionId: number, appId: number, reason: string, terminal: boolean,
  waitMs = 2000): Promise<EventOutcome> {
  return runtime!.appendAndWait(previews!, previewKey(sessionId), { type: 'RetireRequested', payload: { reason, terminal, sessionId } },
    { requestKey: await versioned(sessionId, `retire:${reason}`), source: sys(reason), appId, waitMs });
}

// Who is working on a session: an old flow's operation starts or ends
// (services/active-workers.js). The start is waited for, so a reader in
// another process sees it before the work goes on.
export async function operationStarted(o: { sessionId: number; id: string; kind: string; holder: string }): Promise<void> {
  if (!previewsEnabled()) return;   // no runtime: a script or a test
  const { rows: [s] } = await kernelPool!.query('SELECT app_id FROM chat_sessions WHERE id = $1', [o.sessionId]);
  await runtime!.appendAndWait(previews!, previewKey(o.sessionId), { type: 'OperationStarted', payload: o },
    { requestKey: `op:${o.id}:start`, source: sys('operation'), appId: s?.app_id ?? null, waitMs: 2000 });
}
export async function operationEnded(o: { sessionId: number; id: string }): Promise<void> {
  if (!previewsEnabled()) return;
  await runtime!.append(previews!, previewKey(o.sessionId), { type: 'OperationEnded', payload: { id: o.id } },
    { requestKey: `op:${o.id}:end`, source: sys('operation') });
}

// ── Before & after shots ────────────────────────────────────────────────

// The shots machine's instance of a proposal: its state and data, or null.
export async function shotsInstance(sessionId: number): Promise<{ state: string; data: any } | null> {
  if (!kernelPool) return null;
  const { rows: [r] } = await kernelPool.query(
    'SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [SHOTS, shotsKey(sessionId)]);
  return r ? { state: r.state, data: r.data } : null;
}

// A run of the proposal's shots is under way, for a coding turn deciding
// whether to wait for it (the Homeroom bot, the Mayor), read from the
// instance: true across restarts and in every process. A run waiting for the
// proposal's agent is not one to wait for: it waits for the turn, and the
// two would wait for each other until the run gave up.
export async function shotsRunning(sessionId: number): Promise<boolean> {
  const i = await shotsInstance(sessionId);
  return !!i && SHOTS_LIVE.has(i.state) && i.state !== 'waiting_for_agent';
}

function shotsMachine() {
  if (!runtime || !shotRuns) throw new Error('The workflow runtime is not running in this process');
  return shotRuns;
}

type HeadFence = { pin?: 'imported' | 'reviewed' | 'handoff' | null; from?: string | null };

// A declaration of visible changes (already validated: visible-changes.js
// parseIntent) for `head`, or the row's newest. Inside a caller's
// transaction (`db`, PR import) it is only appended; it applies once that
// transaction commits.
export async function shotsDeclared(d: { sessionId: number; appId?: number | null; head?: string | null; intent: unknown;
  db?: Queryable; actor?: string | null } & HeadFence): Promise<EventOutcome | null> {
  const m = shotsMachine();
  const event = { type: 'Declared', payload: { sessionId: d.sessionId, head: d.head ?? null, intent: d.intent,
    pin: d.pin ?? null, from: d.from ?? null } };
  const o = { requestKey: `declare:${randomUUID()}`, source: { kind: 'route' as const, name: 'declare' },
    appId: d.appId ?? undefined, actor: d.actor ?? undefined };
  if (d.db) { await runtime!.append(m, shotsKey(d.sessionId), event, { ...o, db: d.db }); return null; }
  return runtime!.appendAndWait(m, shotsKey(d.sessionId), event, { ...o, waitMs: 5000 });
}

// The proposal's head moved: shots of other heads stop counting. `pin`:
// the revision column the caller moved (and `from`, the head the caller
// read there), so an event a newer move overtook is refused instead of
// taking the slot back (shots/machine.ts staleHead).
export async function shotsHeadMoved(sessionId: number, head: string, reason: string | null = null,
  f: HeadFence = {}): Promise<number> {
  return runtime!.append(shotsMachine(), shotsKey(sessionId),
    { type: 'HeadMoved', payload: { sessionId, head, reason, pin: f.pin ?? null, from: f.from ?? null } },
    { requestKey: `head:${head}:${randomUUID()}`, source: { kind: 'system', name: 'head-moved' } });
}

// A person's Retry (with a new declaration, maybe), Stop and waiver.
export async function shotsRetry(r: { sessionId: number; appId: number; intent?: unknown; actor?: string | null }): Promise<EventOutcome> {
  return runtime!.appendAndWait(shotsMachine(), shotsKey(r.sessionId),
    { type: 'RetryRequested', payload: { sessionId: r.sessionId, intent: r.intent ?? null } },
    { requestKey: `retry:${randomUUID()}`, source: { kind: 'route', name: 'retry' }, appId: r.appId, actor: r.actor ?? undefined, waitMs: 5000 });
}
export async function shotsStop(r: { sessionId: number; appId: number; actor?: string | null }): Promise<EventOutcome> {
  return runtime!.appendAndWait(shotsMachine(), shotsKey(r.sessionId), { type: 'StopRequested', payload: { sessionId: r.sessionId } },
    { requestKey: `stop:${randomUUID()}`, source: { kind: 'route', name: 'stop' }, appId: r.appId, actor: r.actor ?? undefined, waitMs: 5000 });
}
export async function shotsWaive(r: { sessionId: number; appId: number; userId: number; reason: string }): Promise<EventOutcome> {
  return runtime!.appendAndWait(shotsMachine(), shotsKey(r.sessionId),
    { type: 'WaiveRequested', payload: { sessionId: r.sessionId, userId: r.userId, reason: r.reason } },
    { requestKey: `waive:${randomUUID()}`, source: { kind: 'route', name: 'waive' }, appId: r.appId, actor: `user:${r.userId}`, waitMs: 5000 });
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
