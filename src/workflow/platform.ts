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
import { appendEvent, createRuntime } from './kernel/index.ts';
import type { EventOutcome, Json, Logger, Pool, Push, Queryable, Runtime } from './kernel/index.ts';
import { legacy } from './legacy.ts';
import { GOVERNANCE_KINDS } from './governance-proposal/facts.ts';
import { MACHINE, governanceProposal, issueKey } from './governance-proposal/machine.ts';
import { governanceServices } from './governance-proposal/services.ts';
import { MACHINE as MERGE, mergeFollowups, sessionKey } from './merge-followups/machine.ts';
import { mergeFollowupsServices } from './merge-followups/services.ts';
import { MACHINE as BUILD, botBuild, buildKey } from './bot-build/machine.ts';
import type { Target as BuildTarget } from './bot-build/machine.ts';
import { botBuildServices } from './bot-build/services.ts';
import { MACHINE as DELIVERY, appDelivery, appKey } from './app-delivery/machine.ts';
import { appDeliveryServices } from './app-delivery/services.ts';
import { MACHINE as PREVIEW, preview, sessionKey as previewKey } from './preview/machine.ts';
import { PREPARE_LEASE_MS, previewServices } from './preview/services.ts';
import { LIVE as SHOTS_LIVE, MACHINE as SHOTS, sessionKey as shotsKey, shots } from './shots/machine.ts';
import { shotsServices } from './shots/services.ts';
import { ATTENTION as PROPOSAL_ATTENTION, MACHINE as PROPOSAL, proposal, sessionKey as proposalKey } from './proposal/machine.ts';
import { proposalServices } from './proposal/services.ts';
import { MACHINE as QUEUE, appKey as queueKey, mergeQueue } from './merge-queue/machine.ts';
import { MACHINE as CAMPAIGN, campaign, campaignKey } from './campaign/machine.ts';
import { campaignServices } from './campaign/services.ts';
import { MACHINE as BOT_CHANGE, botChange, sessionKey as botChangeKey } from './bot-change/machine.ts';
import { botChangeServices } from './bot-change/services.ts';
import { botVoice } from './bot-voice/machine.ts';
import { botVoiceServices } from './bot-voice/services.ts';
import { botDm } from './bot-dm/machine.ts';
import { botDmServices } from './bot-dm/services.ts';
import { MACHINE as MAIN_CHECK, appKey as mainCheckKey, depsFromEnv as mainCheckDeps, mainCheck } from './main-check/machine.ts';
import { mainCheckServices } from './main-check/services.ts';
import { MACHINE as BOT_REQUEST, botRequest } from './bot-request/machine.ts';
import { botRequestServices } from './bot-request/services.ts';
import { MACHINE as BOT_LANE, KEY as LANE_KEY, botLane } from './bot-lane/machine.ts';
import { botLaneServices } from './bot-lane/services.ts';
import { requestKey as botRequestKey } from './rules/bot-loop.ts';
import { DM as BOT_DM, VOICE as BOT_VOICE, dmKey, placeOf, voiceKey } from './rules/bot-replies.ts';
import type { Place } from './rules/bot-replies.ts';
import { BOT_USERNAME } from './rules/bot-notes.ts';
import { activeUserStats } from './rules/electorate.ts';
import { appMetaFromRow } from './rules/governance-gate.ts';
import { countedVotePredicateSql } from './rules/vote-predicate.ts';
import { VOTE_REASON_MAX, VOTE_REASON_REQUIRED } from './rules/vote-reason.ts';
import { BUS_CHANNEL, workflowBody } from './pushes.ts';
import { TURN_OWNER_SQL } from './session-work.ts';

const pg = createRequire(import.meta.url)('pg');

let runtime: Runtime | null = null;
let kernelPool: Pool & { end(): Promise<void> } | null = null;
let log: Logger | null = null;

// What the ownership triggers read, synced on every boot: enabled:<machine>
// for every machine (wf_holds reads it). Every machine is the only path for
// what it decides, so its guard is always on and always refuses a write
// from outside it.
const MACHINES = [MACHINE, MERGE, DELIVERY, PREVIEW, SHOTS, PROPOSAL, QUEUE, CAMPAIGN, MAIN_CHECK, BOT_REQUEST];

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
//
// `badges`: everyone told their bell changed (`notifications_changed`) has
// their phone's icon re-badged too, from a row in the same statement
// (mobile_push_badge_syncs), which the push worker drains, coalesced per
// person (services/mobile-push-worker.js). A row, not a kick: it outlives
// a restart, and it runs where the sender runs. Off where the platform
// sends no pushes (nothing would drain the rows).
export async function publishPushes(q: Queryable, pushes: Push[], { badges = false }: { badges?: boolean } = {}): Promise<void> {
  const owed = badges ? [...new Set(pushes
    .filter((p) => p.kind === 'user' && p.data.type === 'notifications_changed')
    .map((p) => Number((p.routing as { userId?: unknown } | undefined)?.userId))
    .filter((id) => Number.isSafeInteger(id) && id > 0))] : [];
  await q.query(
    `WITH owed AS (
       INSERT INTO mobile_push_badge_syncs (user_id)
       SELECT DISTINCT x.u FROM unnest($3::int[]) AS x(u) JOIN users ON users.id = x.u
       ON CONFLICT (user_id) DO UPDATE SET queued_at = now(), claimed_until = NULL
       RETURNING 1)
     SELECT pg_notify($1, body) FROM unnest($2::text[]) WITH ORDINALITY AS t(body, n) ORDER BY n`,
    [BUS_CHANNEL, pushes.map((p) => workflowBody(p.kind, (p.routing ?? null) as Json, p.data)), owed]);
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
  const machine = governanceProposal({ dataKey: config.dataEncryptionKey });
  const merges = mergeFollowups({ dataKey: config.dataEncryptionKey });
  const deliveries = appDelivery();
  // A cancelled prepare learns it at its next checkpoint or lease renewal;
  // its attempt is retired, and a retirement runs, a lease and more later
  // (and never while it serves: services.ts).
  const previews = preview({ maxRetries: config.checkMaxAutoRetries ?? 6, retireAfterMs: PREPARE_LEASE_MS + 30000 });
  const shotRuns = shots({
    execute: !!config.shots?.execute,
    agentBudgetMs: Number(config.shots?.maxAgentMs) || 480_000,
    runBudgetMs: Number(config.shots?.maxRunMs) || 1_440_000,
  });
  const proposals = proposal(proposalDeps(config));
  const queues = mergeQueue();
  const campaigns = campaign();
  const botChanges = botChange();
  const voices = botVoice();
  const dms = botDm();
  const builds = botBuild();
  // The suite on each new main, with its switches from the environment.
  const checks = mainCheck(mainCheckDeps(process.env));
  // The bot's loop: a staging copy runs no worker turns, so the bot acts on
  // nothing there (rules/bot-loop.ts botOn).
  const staging = process.env.USERNODE_ENV === 'staging';
  const requests = botRequest({ staging });
  const lane = botLane({ staging });
  const machines = [machine, merges, builds, deliveries, previews, shotRuns, proposals, queues, campaigns, botChanges, voices, dms, checks, requests, lane];
  const services = {
    ...governanceServices(deps), ...mergeFollowupsServices(deps), ...botBuildServices(deps),
    ...appDeliveryServices(deps), ...previewServices(deps), ...shotsServices(deps), ...proposalServices(deps),
    ...campaignServices(deps), ...botChangeServices(deps), ...botVoiceServices(deps), ...botDmServices(deps),
    ...mainCheckServices(deps), ...botRequestServices(deps), ...botLaneServices(deps),
  };
  const started = createRuntime({
    pool: kernelPool!, machines, services, slots: config.wfSlots, log: log!,
    publish: (q, pushes) => publishPushes(q, pushes, { badges: !!config.mobilePushEnabled }),
  });
  try {
    await started.start({ slots: true });
  } catch (err) {
    // Half started is not started: the caller (server.js) exits the process.
    await started.stop().catch(() => {});
    await kernelPool!.end().catch(() => {});
    kernelPool = null;
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
// governance row and every proposal that needs a timer the machines do not
// hold yet.
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
  await adoptProposals();
  await rearmWaitingProposals();
  await adoptMergeQueues();
  await adoptDeferredDms();
  await adoptMainChecks();
  await adoptBotQueue();
  await retryPlatformFaults();
  // The bot's lane starts its clock (its refresh, its grants): idempotent,
  // the same tick at every boot.
  await runtime.append(BOT_LANE, LANE_KEY, { type: 'Tick', payload: {} },
    { requestKey: `boot:${randomUUID()}`, source: { kind: 'system', name: 'boot' } });
}

// ── The Homeroom bot's loop (bot-request, bot-lane) ────────────────────

type Db = Queryable;
const BOT_SOURCE = (name: string) => ({ kind: 'system' as const, name });

// Something owes request `issueNumber` of `appId` a look: appended in the
// caller's transaction when it has one (`db`), so the debt commits with
// what made it (an ask's row, a message, a filed request). `key` makes a
// retried caller append once.
export async function botOwed(db: Db, p: {
  appId: number; issueNumber: number; reason: string; priority: number; payer?: number | null; requestedBy?: number | null;
  changedBy?: string | null; threadSeenAt?: string | null; key?: string | null; source?: string;
}): Promise<void> {
  await appendEvent(db, BOT_REQUEST, botRequestKey(p.appId, p.issueNumber), {
    type: 'Owed',
    payload: { appId: Number(p.appId), issueNumber: Number(p.issueNumber), reason: p.reason, priority: p.priority,
      payer: p.payer ?? null, requestedBy: p.requestedBy ?? null, changedBy: p.changedBy ?? null, threadSeenAt: p.threadSeenAt ?? null } as any,
  }, { requestKey: p.key || `owed:${randomUUID()}`, source: BOT_SOURCE(p.source || 'owed'), appId: Number(p.appId) });
}

// The same, waiting briefly for its instance's answer (bot-request's reply:
// queued with its look's card key, or a look already runs). Null when the
// answer is not in yet.
export async function botOwedAndWait(p: Parameters<typeof botOwed>[1]): Promise<{ queued: boolean; looking: boolean; jobKey: string | null } | null> {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  const out = await runtime.appendAndWait(BOT_REQUEST, botRequestKey(p.appId, p.issueNumber), {
    type: 'Owed',
    payload: { appId: Number(p.appId), issueNumber: Number(p.issueNumber), reason: p.reason, priority: p.priority,
      payer: p.payer ?? null, requestedBy: p.requestedBy ?? null, changedBy: p.changedBy ?? null, threadSeenAt: p.threadSeenAt ?? null } as any,
  }, { requestKey: p.key || `owed:${randomUUID()}`, source: BOT_SOURCE(p.source || 'owed'), appId: Number(p.appId), waitMs: 3000 });
  return (out.reply as any) || null;
}

// The refresh: request `issueNumber` is no longer owed a look.
export async function botNotOwed(db: Db, p: { appId: number; issueNumber: number; quiet: boolean; key: string }): Promise<void> {
  await appendEvent(db, BOT_REQUEST, botRequestKey(p.appId, p.issueNumber), {
    type: 'NotOwed', payload: { appId: Number(p.appId), issueNumber: Number(p.issueNumber), quiet: !!p.quiet } as any,
  }, { requestKey: p.key, source: BOT_SOURCE('refresh'), appId: Number(p.appId) });
}

// A person wrote on a request's thread (in the statement's transaction).
export async function botActivity(db: Db, p: { appId: number; issueNumber: number; messageId?: number | null }): Promise<void> {
  await appendEvent(db, BOT_REQUEST, botRequestKey(p.appId, p.issueNumber), {
    type: 'Activity', payload: { appId: Number(p.appId), issueNumber: Number(p.issueNumber), at: new Date().toISOString() } as any,
  }, { requestKey: p.messageId ? `activity:${p.messageId}` : `activity:${randomUUID()}`, source: BOT_SOURCE('activity'), appId: Number(p.appId) });
}

// A ready verdict's build is owed (Build it in the DM, a carried plan).
// `key`: the sweep's own (a waiting run told again), else one per run.
export async function botBuildOwed(db: Db, p: { appId: number; issueNumber: number; runId: number; key?: string | null }): Promise<void> {
  await appendEvent(db, BOT_REQUEST, botRequestKey(p.appId, p.issueNumber), {
    type: 'BuildOwed', payload: { appId: Number(p.appId), issueNumber: Number(p.issueNumber), runId: Number(p.runId) } as any,
  }, { requestKey: p.key || `build:${Number(p.runId)}`, source: BOT_SOURCE('build'), appId: Number(p.appId) });
}

// The session a look runs on, once the look knows it (a project's first read
// makes its triage session).
export async function botLookOn(db: Db, p: { appId: number; issueNumber: number; n: number; sessionId: number }): Promise<void> {
  await appendEvent(db, BOT_REQUEST, botRequestKey(p.appId, p.issueNumber), {
    type: 'LookOn', payload: { appId: Number(p.appId), issueNumber: Number(p.issueNumber), n: Number(p.n), sessionId: Number(p.sessionId) } as any,
  }, { requestKey: `lookon:${Number(p.appId)}:${Number(p.issueNumber)}:${Number(p.n)}`, source: BOT_SOURCE('look'), appId: Number(p.appId) });
}

// bot-change's merge, told to each request it was for.
export async function botRequestMerged(db: Db, p: { appId: number; issueNumber: number; before: string | null; key: string }): Promise<void> {
  await appendEvent(db, BOT_REQUEST, botRequestKey(p.appId, p.issueNumber), {
    type: 'RequestMerged', payload: { appId: Number(p.appId), issueNumber: Number(p.issueNumber), before: p.before } as any,
  }, { requestKey: p.key, source: BOT_SOURCE('merged'), appId: Number(p.appId) });
}

// The lane, asked to refresh a project soon (null: every project).
export async function botRefresh(appId: number | null): Promise<void> {
  if (!runtime) return;
  await runtime.append(BOT_LANE, LANE_KEY, { type: 'RefreshAsked', payload: { appId } as any },
    { requestKey: `refresh:${randomUUID()}`, source: BOT_SOURCE('refresh'), appId: appId ?? undefined });
}

// What the bot's queue would answer about a request now: its instance's
// state (an admin's view, a DM's "already on it").
export async function botRequestState(appId: number, issueNumber: number): Promise<{ state: string; data: any } | null> {
  if (!runtime) return null;
  const { rows: [r] } = await kernelPool!.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2',
    [BOT_REQUEST, botRequestKey(appId, issueNumber)]);
  return r ? { state: r.state, data: r.data } : null;
}

// The boot (and a minute's sweep while any is left): every queue row no
// instance holds (an older release wrote it) is adopted: an unclaimed one
// is owed, a claimed one waits for the older release's look to end.
export async function adoptBotQueue(): Promise<number> {
  if (!runtime) return 0;
  const { rows } = await kernelPool!.query(
    `SELECT q.* FROM homeroom_bot_queue q
      WHERE NOT EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = $1 AND w.key = 'request:' || q.app_id || ':' || q.issue_number)
      ORDER BY q.id LIMIT 500`, [BOT_REQUEST]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  for (const q of rows) {
    await runtime.append(BOT_REQUEST, botRequestKey(q.app_id, q.issue_number), {
      type: 'Adopted', payload: {
        appId: q.app_id, issueNumber: q.issue_number, reason: q.reason, priority: q.priority, payer: q.payer_user_id,
        requestedBy: q.requested_by, changedBy: q.changed_by, threadSeenAt: iso(q.thread_seen_at), enqueuedAt: iso(q.enqueued_at),
        heldUntil: iso(q.held_until), startedAt: iso(q.started_at),
      } as any,
    }, { requestKey: `adopt:${q.id}:${q.enqueued_at ? new Date(q.enqueued_at).getTime() : 0}`, source: BOT_SOURCE('adopt'), appId: q.app_id })
      .catch((err: Error) => log!.warn('workflow', 'Could not adopt a queue row of the bot', { id: q.id, message: err.message }));
  }
  if (rows.length) log!.info('workflow', 'Adopted the bot\'s queue rows', { count: rows.length });
  return rows.length;
}

// ── The suite on each new main ──────────────────────────────────────────

// A commit on an app's main to check (the drift poller's new main; a
// merge's is merge-followups' message). Appended, not waited for.
export async function requestMainCheck(c: { appId: number; sha: string; sessionId?: number | null; prNumber?: number | null }): Promise<void> {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  if (!mainCheckDeps(process.env).enabled) return;   // MAIN_WATCH_ENABLED off: nothing is asked
  await runtime.append(MAIN_CHECK, mainCheckKey(c.appId), { type: 'CheckRequested', payload: {
    appId: c.appId, sha: c.sha, sessionId: c.sessionId ?? null, prNumber: c.prNumber ?? null,
  } }, { requestKey: `check:${c.appId}:${String(c.sha).toLowerCase()}:${randomUUID()}`, source: { kind: 'system', name: 'new-main' }, appId: c.appId });
}

// An admin resumes an app's merges paused by a red main: whether there was
// a pause to lift.
export async function resumeMainCheck(appId: number, user: { id: number; username?: string | null }): Promise<'resumed' | 'not_paused' | 'pending' | 'failed'> {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  const out = await runtime.appendAndWait(MAIN_CHECK, mainCheckKey(appId), { type: 'Resume', payload: { appId, by: user.username ?? null } },
    { requestKey: `resume:${appId}:${randomUUID()}`, source: { kind: 'route', name: 'main-check-resume' }, actor: `user:${user.id}`, appId, waitMs: 5000 });
  if (out.status === 'accepted' || out.status === 'replayed') return 'resumed';
  if (out.status === 'pending') return 'pending';
  if (out.status === 'faulted') return 'failed';
  return 'not_paused';
}

// Rows an older release left in the middle of a run, or paused with a
// recheck to come, that no instance holds yet: taken from the row, once per
// release. Transitional: deleted once no release older than the main-check
// machine can run.
async function adoptMainChecks(): Promise<number> {
  if (!runtime) return 0;
  const { rows } = await kernelPool!.query(
    `SELECT a.id, dead.run_id FROM apps a
       LEFT JOIN LATERAL (
         -- The older release's own run of the row's commit, admitted: its
         -- Jobs are read rather than the suite run again.
         SELECT cr.run_id FROM check_runs cr
          WHERE cr.kind = 'main' AND cr.app_id = a.id AND lower(cr.commit_sha) = lower(a.main_check_sha)
            AND cr.admitted_at IS NOT NULL
          ORDER BY cr.started_at DESC LIMIT 1) dead ON a.main_check_state IN ('running', 'confirming')
      WHERE (a.main_check_state IN ('running', 'confirming')
             OR (a.main_check_state = 'failing' AND lower(coalesce(a.main_check_paused_sha, '')) = lower(coalesce(a.main_check_sha, ''))))
        AND NOT EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = $1 AND w.key = 'app:' || a.id)
      ORDER BY a.id`, [MAIN_CHECK]);
  for (const r of rows) {
    await runtime.append(MAIN_CHECK, mainCheckKey(r.id), { type: 'Adopted', payload: { appId: r.id, runId: r.run_id ?? null } },
      { requestKey: `adopt:${r.id}`, source: { kind: 'system', name: 'adopt' }, appId: r.id })
      .catch((err: Error) => log!.warn('workflow', 'Could not adopt a main check', { appId: r.id, message: err.message }));
  }
  if (rows.length) log!.info('workflow', 'Adopted main checks', { count: rows.length });
  return rows.length;
}

// The bot's change machine hears `type` about session `sessionId`: from the
// bot's loop (FixRoundEnded, homeroom-bot.js). Only for a session of the
// bot's; the machine's guard refuses one no run of the bot's proposed.
export async function botNote(sessionId: number, type: string, payload: Record<string, unknown> = {},
  o: { requestKey?: string; source?: Source; appId?: number | null } = {}): Promise<EventOutcome | number> {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  const { rows: [own] } = await kernelPool!.query(
    `SELECT cs.app_id FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.id = $1 AND u.username = $2 AND u.is_synthetic = TRUE`, [sessionId, BOT_USERNAME]);
  if (!own) return 0;
  return runtime.append(BOT_CHANGE, botChangeKey(sessionId), { type, payload: { sessionId, ...payload } as any },
    { requestKey: o.requestKey || `${type}:${sessionId}:${randomUUID()}`, source: o.source || { kind: 'system', name: 'bot' },
      appId: o.appId ?? own.app_id });
}

// ── A Stop of a turn workflow work runs ────────────────────────────────

// A person's Stop of the session's turn, when the turn is one a machine's
// work runs (src/workflow/session-work.ts TURN_OWNER_SQL: its record's
// owner, or the sync, shots run, build or bot look spinning one up): the
// owning instance hears StopRequested and decides. Resolves the route's
// answer, or null when no machine runs a turn there (a person's own turn:
// the route's own path stops it). A job that changed since the person read
// it is refused as the route refuses it.
export async function stopWorkflowTurn(p: { sessionId: number; by: string | null; expectedTurnId?: string | null }): Promise<Reply | null> {
  if (!runtime) return null;
  const { rows: [owner] } = await kernelPool!.query(TURN_OWNER_SQL, [p.sessionId]);
  if (!owner?.machine || !owner?.key) return null;
  if (p.expectedTurnId) {
    const { rows: [t] } = await kernelPool!.query(
      `SELECT COALESCE(active_turn->>'turnId', active_turn->>'logicalTurnId', active_turn->>'turnUuid') AS id
         FROM chat_sessions WHERE id = $1`, [p.sessionId]);
    if (t?.id && t.id !== p.expectedTurnId) {
      return { status: 409, body: { error: 'The running job changed. Refresh its status before stopping it.', code: 'turn_changed' } };
    }
  }
  const outcome = await runtime.appendAndWait(owner.machine, owner.key,
    { type: 'StopRequested', payload: { sessionId: p.sessionId, by: p.by ?? null } as any },
    { requestKey: `stop:${p.sessionId}:${randomUUID()}`, source: { kind: 'route', name: 'stop' }, actor: p.by ?? undefined, waitMs: 5000 });
  if (outcome.status === 'rejected') {
    return { status: 200, body: { ok: true, stopped: false, reason: 'no active turn', code: outcome.reason || null } };
  }
  return { status: outcome.status === 'pending' ? 202 : 200, body: { ok: true, stopped: true, stopping: true, phase: null, machine: owner.machine } };
}

// ── The Homeroom bot's replies (bot-voice, bot-dm) ─────────────────────

// A person wrote in a project (services/ws.js handleMessage): the place's
// voice hears it in the statement that inserts the message, so an answer
// owed is never only in the memory of the process that took it.
// `insertSql` is its INSERT … RETURNING id,
// created_at, and the event is appended from the row it returns, column for
// column as the kernel's append writes one (kernel/stream.ts), so the two
// commit as one statement, in one round trip, with or without a
// transaction around it. Resolves the INSERT's rows. A place the voice has
// no part in (a governance vote's thread) inserts the message alone.
export async function insertHeard(db: Queryable, insertSql: string, values: unknown[],
  p: { appId: number; thread: { type?: unknown; ref?: unknown } | null }): Promise<{ id: number; created_at: string; requestHeard?: boolean }[]> {
  const place = placeOf(p.thread);
  if (!place) return (await db.query(insertSql, values)).rows;
  const n = values.length;
  // On a request's thread the request's own instance (bot-request) hears it
  // too, in the same statement, when it has one: a read of it under way
  // starts over, an idle one's project is refreshed soon. A request the bot
  // never had anything to do with gets no instance for every comment on it:
  // the row says it was not heard (`requestHeard`), and the caller asks for
  // its project's refresh instead.
  const onRequest = place.type === 'issue' && Number.isInteger(Number(place.ref)) && Number(place.ref) > 0;
  const { rows } = await db.query(
    `WITH m AS (${insertSql}),
     e AS (
       INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key, caused_by)
       SELECT $${n + 1}, $${n + 2}, $${n + 3}::int, 'Heard',
              jsonb_build_object('appId', $${n + 3}::int, 'place', $${n + 4}::jsonb, 'messageId', m.id),
              $${n + 5}::jsonb, NULL, 'heard:' || m.id, NULL
         FROM m
       RETURNING id)${onRequest ? `,
     r AS (
       INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key, caused_by)
       SELECT $${n + 6}, $${n + 7}, $${n + 3}::int, 'Activity',
              jsonb_build_object('appId', $${n + 3}::int, 'issueNumber', $${n + 8}::int, 'at', m.created_at),
              $${n + 5}::jsonb, NULL, 'activity:' || m.id, NULL
         FROM m
        WHERE EXISTS (SELECT 1 FROM wf_instances wi WHERE wi.machine = $${n + 6} AND wi.key = $${n + 7})
       RETURNING id)` : ''}
     SELECT m.id, m.created_at, (SELECT pg_notify('wf_events', $${n + 1}) FROM e LIMIT 1) AS woke${onRequest ? `,
            (SELECT pg_notify('wf_events', $${n + 6}) FROM r LIMIT 1) AS woke_request,
            EXISTS (SELECT 1 FROM r) AS request_heard` : ''} FROM m`,
    [...values, BOT_VOICE, voiceKey(p.appId, place), p.appId, JSON.stringify(place), JSON.stringify({ kind: 'route', name: 'chat' }),
      ...(onRequest ? [BOT_REQUEST, botRequestKey(p.appId, Number(place.ref)), Number(place.ref)] : [])]);
  return rows.map(({ woke: _woke, woke_request: _wr, request_heard: rh, ...row }: any) => (onRequest ? { ...row, requestHeard: !!rh } : row));
}

// A person wrote in their DM with the bot (routes/conversations.js, in
// conversations.sendMessage's own transaction, `db`).
export async function dmWritten(db: Queryable, p: { userId: number; conversationId: number; messageId: number; attempt?: number }): Promise<void> {
  await appendEvent(db, BOT_DM, dmKey(p.userId),
    { type: 'Wrote', payload: { userId: p.userId, conversationId: p.conversationId, messageId: p.messageId, attempt: p.attempt || 0 } },
    { requestKey: `wrote:${p.messageId}${p.attempt ? `:d${p.attempt}` : ''}`, source: { kind: 'route', name: 'dm' } });
}

// A hello of `kind` is owed to a person (joining by an invite, the tour's
// end): in the caller's transaction when it has one, so it commits with
// what makes it owed.
export async function greet(db: Queryable, p: { userId: number; kind: string; appId?: number | null }): Promise<void> {
  await appendEvent(db, BOT_DM, dmKey(Number(p.userId)),
    { type: 'Greet', payload: { userId: Number(p.userId), kind: p.kind, appId: p.appId == null ? null : Number(p.appId) } },
    { requestKey: `greet:${Number(p.userId)}:${p.kind}:${p.appId == null ? '' : Number(p.appId)}`, source: { kind: 'system', name: 'hello' }, appId: p.appId == null ? null : Number(p.appId) });
}

// What came of a change people asked for (the bot's follow-up,
// homeroom-bot-voice.js oweReport): the place they asked in owes them a
// report, appended in the transaction that ends their asks.
export async function reportOwed(db: Queryable, p: { appId: number; place: Place; sessionId: number; runTag: string; asks: number[]; outcome: unknown }): Promise<void> {
  await appendEvent(db, BOT_VOICE, voiceKey(p.appId, p.place),
    { type: 'Report', payload: { appId: p.appId, place: p.place as any, sessionId: p.sessionId, runTag: p.runTag, asks: p.asks, outcome: (p.outcome ?? {}) as any } },
    { requestKey: `report:${p.runTag}:${voiceKey(p.appId, p.place)}`, source: { kind: 'system', name: 'follow-up' }, appId: p.appId });
}

// The answer to a mention of the bot on a request a person holds (the
// bot's refresh, homeroom-bot-holds.js answerMentions): owed by the
// request's place, which writes its post row with the decision.
export async function heldAnswerOwed(db: Queryable, p: { appId: number; issueNumber: number; kind: string; text: string; mentionId: number; mention?: string | null; mentions?: string[] }): Promise<void> {
  const place: Place = { type: 'issue', ref: p.issueNumber };
  await appendEvent(db, BOT_VOICE, voiceKey(p.appId, place),
    { type: 'HeldAnswer', payload: { appId: p.appId, place: place as any, kind: p.kind, text: p.text, mentionId: p.mentionId, mention: p.mention ?? null, mentions: p.mentions || [] } },
    { requestKey: `held:${p.mentionId}:${p.kind}`, source: { kind: 'system', name: 'holds' }, appId: p.appId });
}

// What a refused tap answers: the thread's words (the room's toast shows
// them), and the DM's codes, as each route answered before.
const VOICE_TAP = new Map<string, { status: number; error: string }>([
  ['no_such_offer', { status: 404, error: 'Nothing to decide here.' }],
  ['not_for_you', { status: 403, error: 'Only the person it was offered to can decide it.' }],
  ['already_decided', { status: 409, error: 'That was already decided.' }],
]);
const DM_TAP = new Map<string, { status: number; error: string }>([
  ['no_such_choice', { status: 404, error: 'No such choice' }],
  ['already_decided', { status: 409, error: 'already_decided' }],
  ['wrong_choice', { status: 400, error: 'choice must be yes, no or build' }],
]);
function tapAnswer(out: EventOutcome, refusals: Map<string, { status: number; error: string }>): { ok: boolean; status?: number; error?: string; pending?: boolean } {
  if (out.status === 'accepted' || out.status === 'replayed') return { ok: true };
  if (out.status === 'pending') return { ok: true, pending: true };
  return { ok: false, ...(refusals.get(String(out.reason)) || { status: 409, error: 'That didn\'t work just now.' }) };
}

// A tap under one of the voice's offers (routes/chat.js): decided once in
// the place its message is in; the act is that place's work.
export async function tapVoiceOffer(p: { appId: number; offerId: number; messageId: number; userId: number; choice: string }) {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  const { rows: [m] } = await kernelPool!.query('SELECT thread_type, thread_ref FROM chat_messages WHERE id = $1 AND app_id = $2', [p.messageId, p.appId]);
  const place = m ? placeOf(m.thread_type ? { type: m.thread_type, ref: m.thread_ref } : null) : null;
  if (!place) return { ok: false, status: 404, error: 'Nothing to decide here.' };
  const out = await runtime.appendAndWait(BOT_VOICE, voiceKey(p.appId, place),
    { type: 'OfferTapped', payload: { appId: p.appId, place: place as any, offerId: p.offerId, userId: p.userId, choice: p.choice } },
    { requestKey: `tap-offer:${p.offerId}:${p.userId}:${randomUUID()}`, source: { kind: 'route', name: 'bot-offer' }, actor: `user:${p.userId}`, appId: p.appId });
  return tapAnswer(out, VOICE_TAP);
}

// A tap under one of the bot's offers in a person's DM, or Build it under a
// plan (routes/conversations.js): decided once in their DM's instance.
export async function tapDmAction(p: { userId: number; actionId: number; choice: string; answers?: unknown[] }) {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  const out = await runtime.appendAndWait(BOT_DM, dmKey(p.userId),
    { type: 'Tapped', payload: { userId: p.userId, actionId: p.actionId, choice: p.choice, answers: (p.answers || []) as any } },
    { requestKey: `tap-action:${p.actionId}:${randomUUID()}`, source: { kind: 'route', name: 'bot-action' }, actor: `user:${p.userId}` });
  return tapAnswer(out, DM_TAP);
}

// A later try an older release owed (homeroom-bot-mayor.js's in-memory
// deferred tries, which a restart lost: its turn rows say so), taken by the
// person's DM machine once, at the leader's boot. Transitional: an answer
// deferred since this release is the machine's own timer.
export async function adoptDeferredDms(): Promise<number> {
  if (!runtime) return 0;
  const { rows } = await kernelPool!.query(
    `SELECT t.message_id, t.conversation_id, t.user_id, t.tries FROM (
       SELECT DISTINCT ON (message_id) message_id, conversation_id, user_id, fallback,
              COUNT(*) OVER (PARTITION BY message_id)::int AS tries
         FROM homeroom_bot_dm_turns
        WHERE message_id IS NOT NULL AND created_at > NOW() - INTERVAL '20 minutes'
        ORDER BY message_id, id DESC) t
      WHERE t.fallback IN ('deferred', 'plain_later') AND t.tries <= 3 AND t.conversation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = $1 AND w.key = 'person:' || t.user_id)`, [BOT_DM]);
  for (const r of rows) {
    await dmWritten(kernelPool!, { userId: Number(r.user_id), conversationId: Number(r.conversation_id), messageId: Number(r.message_id), attempt: Number(r.tries) })
      .catch((err: Error) => log!.warn('workflow', 'Could not adopt a DM answer to ask again', { messageId: r.message_id, message: err.message }));
  }
  if (rows.length) log!.info('workflow', 'Adopted DM answers to ask again', { count: rows.length });
  return rows.length;
}

// An admin's moves on a campaign (routes/campaigns.js): retry one app, force
// its green proposals, stop it. Each answers with the machine's outcome.
export async function campaignEvent(campaignId: number, type: 'RetryApp' | 'MergeGreen' | 'Stop',
  payload: Record<string, unknown>, user: { id?: number | null; username?: string | null }): Promise<EventOutcome> {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  return runtime.appendAndWait(CAMPAIGN, campaignKey(campaignId),
    { type, payload: { ...payload, userId: user.id ?? null, username: user.username ?? null } },
    { requestKey: `${type}:${campaignId}:${randomUUID()}`, source: { kind: 'route', name: `campaign-${type}` },
      actor: user.id ? `user:${user.id}` : undefined, waitMs: 5000 });
}

// Every app with a proposal in review gets its merge queue's look at boot:
// a proposal that became mergeable while no process ran (its window
// elapsed, the electorate shrank) merges now. Once per release (the request
// key names the build); the queue's own state carries everything else.
export async function adoptMergeQueues(): Promise<number> {
  if (!runtime) return 0;
  const { rows } = await kernelPool!.query(`SELECT DISTINCT app_id FROM chat_sessions WHERE status = 'promoted'`);
  const release = String(process.env.GIT_SHA || 'dev').slice(0, 40);
  for (const r of rows) {
    await runtime.append(QUEUE, queueKey(r.app_id), { type: 'MergeWanted', payload: { appId: r.app_id, reason: 'boot' } },
      { requestKey: `boot:${release}:${r.app_id}`, source: { kind: 'system', name: 'boot' }, appId: r.app_id })
      .catch((err: Error) => log!.warn('workflow', 'Could not ask an app\'s merge queue at boot', { appId: r.app_id, message: err.message }));
  }
  return rows.length;
}

// A proposal waiting on GitHub with no clock (a claim an older release made,
// whose machine set none) gets its clock again, so GitHub is asked what
// happened. Once per release, like the queues' look.
export async function rearmWaitingProposals(): Promise<number> {
  if (!runtime) return 0;
  const { rows } = await kernelPool!.query(
    `SELECT key, app_id FROM wf_instances
      WHERE machine = $1 AND state IN ('merging', 'unconfirmed') AND deadline_at IS NULL`, [PROPOSAL]);
  const release = String(process.env.GIT_SHA || 'dev').slice(0, 40);
  for (const r of rows) {
    const sessionId = Number(String(r.key).split(':')[1]);
    await runtime.append(PROPOSAL, r.key, { type: 'Rearm', payload: { sessionId } },
      { requestKey: `rearm:${release}:${sessionId}`, source: { kind: 'system', name: 'boot' }, appId: r.app_id })
      .catch((err: Error) => log!.warn('workflow', 'Could not re-arm a proposal at boot', { sessionId, message: err.message }));
  }
  return rows.length;
}

// Every proposal in review or being merged (their review check) and every
// session holding a slot (its idle check) that the proposal machine does not
// hold yet is adopted from its row. The leader's sweep runs it again each
// minute (server.js), for the sessions created since. Resolves how many.
export async function adoptProposals(limit = 500): Promise<number> {
  if (!runtime) return 0;
  const { rows } = await kernelPool!.query(
    `SELECT cs.id, cs.app_id FROM chat_sessions cs
      WHERE cs.status IN ('active', 'promoted', 'merging')
        AND NOT EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = $1 AND w.key = 'session:' || cs.id)
      ORDER BY cs.id LIMIT $2`, [PROPOSAL, limit]);
  for (const r of rows) {
    await proposalAdopted({ sessionId: r.id, appId: r.app_id })
      .catch((err: Error) => log!.warn('workflow', 'Could not adopt a proposal', { sessionId: r.id, message: err.message }));
  }
  if (rows.length) log!.info('workflow', 'Adopted proposals', { count: rows.length });
  return rows.length;
}

// A release is when a fix to the platform's own fault (a check Job refused
// or lost, the preview database server down) most often arrives: every
// preview whose last error was the platform's, within the day it keeps
// retrying, is retried now instead of at its scheduled retry up to 30
// minutes on. Once per release (the request key names the build).
async function retryPlatformFaults(): Promise<void> {
  if (!runtime) return;
  const { rows } = await kernelPool!.query(
    `SELECT key, app_id FROM wf_instances
      WHERE machine = $1
        AND (state = 'failed' OR (state = 'settled' AND data->>'verdict' = 'error'))
        AND (data->>'platformFault')::boolean
        AND (data->>'firstFailureAt')::timestamptz > now() - interval '1 day'`, [PREVIEW]);
  const release = String(process.env.GIT_SHA || 'dev').slice(0, 40);
  for (const r of rows) {
    await runtime!.append(PREVIEW, r.key, { type: 'RetryDue', payload: {} },
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
  const r = runtime;
  runtime = null;
  await r?.stop();
  await kernelPool?.end();
  kernelPool = null;
}

// ── Governance proposals, for the routes ────────────────────────────────

// The runtime this process decides with. A route reached before it started,
// or after it stopped, answers an error rather than deciding without it.
function running(): Runtime {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  return runtime;
}

// Whether the runtime runs in this process (the admin console's reads say so).
export function workflowRunning(): boolean {
  return runtime !== null;
}

type Source = { kind: 'route' | 'system' | 'admin'; name?: string };

async function file(issueId: number, appId: number, source: Source = { kind: 'route' }) {
  return running().append(MACHINE, issueKey(issueId), { type: 'Filed', payload: { issueId } },
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
  const send = () => running().appendAndWait(MACHINE, issueKey(issue.id), event, { ...o, appId: issue.app_id });
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
      return { status: 400, body: { error: 'reason_required', message: VOTE_REASON_REQUIRED, maxLength: VOTE_REASON_MAX } };
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

// ── Merge follow-ups ────────────────────────────────────────────────────

const count = (n: unknown) => (Number.isInteger(n) && (n as number) >= 0 ? n as number : null);

// A merge found on GitHub that no attempt here reported (somebody merged the
// pull request by hand while it was up for a vote: the leader's boot looks).
// The tally is read again: the counted Yes votes on the version that merged,
// and the app's active members.
export async function mergeObserved(m: { sessionId: number; appId: number; mergeSha: string | null; mergedAt: string | null }): Promise<number> {
  const pool = kernelPool!;
  const { rows: [v] } = await pool.query(
    `SELECT count(*)::int AS yes, cs.votes_required FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE pv.session_id = $1 AND pv.vote = 'yes' AND ${countedVotePredicateSql('pv', 'cs')}
      GROUP BY cs.votes_required`, [m.sessionId]);
  const stats = await pool.query('SELECT self_hosted, collab_visibility FROM apps WHERE id = $1', [m.appId])
    .then(({ rows: [a] }) => activeUserStats(pool, m.appId, appMetaFromRow(a))).catch(() => null);
  return runtime!.append(MERGE, sessionKey(m.sessionId), { type: 'Merged', payload: {
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
  if (!runtime || !/^[0-9a-f]{40}$/i.test(String(sha || ''))) return;
  const { rows } = await kernelPool!.query(
    `SELECT key FROM wf_instances
      WHERE machine = $1 AND app_id = $2 AND state IN ('delivering', 'deploy_failed') AND data->>'role' = 'merge'`,
    [MERGE, appId]);
  for (const r of rows) {
    await runtime.append(MERGE, r.key, { type: 'Deployed', payload: { sha: sha.toLowerCase() } },
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

// Stop the builds of `target` under way for `ids` (the bench's cancel of a
// run or a trial): each instance hears StopRequested, which ends its work
// and stops its turn from whichever process runs it. Resolves how many.
export async function stopBuilds(target: BuildTarget, ids: number[], by: string | null = null): Promise<number> {
  if (!runtime || !ids.length) return 0;
  const { rows } = await kernelPool!.query(
    `SELECT key FROM wf_instances WHERE machine = $1 AND state = 'building'
        AND data->>'target' = $2 AND (data->>'id')::int = ANY($3::int[])`, [BUILD, target, ids.map(Number)]);
  for (const r of rows) {
    await runtime.append(BUILD, r.key, { type: 'StopRequested', payload: { by } as any },
      { requestKey: `stop:${r.key}`, source: { kind: 'admin', name: 'bench' }, actor: by ?? undefined });
  }
  return rows.length;
}

// Start a build: one instance per build, so asking twice starts it once.
// `replyTo`: who hears its end (BuildEnded): a live build's request instance.
export async function requestBuild(b: {
  target: BuildTarget; id: number; nonce?: string | null; appId: number | null; input: Record<string, unknown>;
  replyTo?: { machine: string; key: string } | null;
}): Promise<string> {
  const key = buildKey(b.target, b.id, b.nonce ?? null);
  await runtime!.append(BUILD, key, { type: 'Requested', payload: { target: b.target, id: b.id, nonce: b.nonce ?? null, input: b.input, replyTo: b.replyTo ?? null } as any },
    { requestKey: `request:${key}`, source: { kind: 'system', name: 'bot-build' }, appId: b.appId ?? null });
  return key;
}

// A person wrote on a request's thread (no transaction of the caller's: the
// message is stored). The request's instance hears it.
export async function botActivityNow(p: { appId: number; issueNumber: number; messageId?: number | null }): Promise<void> {
  if (!runtime) return;
  await botActivity(kernelPool!, p);
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
  return runtime!.append(DELIVERY, appKey(appId), { type: 'DeployRequested', payload: {
    appId, reason, prNumber: o.prNumber ?? null, revision: o.revision ?? null, reuse: o.reuse ?? null,
  } }, { requestKey: o.requestKey ?? `deploy:${reason}:${randomUUID()}`, source: { kind: 'system', name: reason }, appId });
}

// ── Previews and required checks ────────────────────────────────────────

// Whether the preview machine runs in this process: in every process once
// its runtime has started (a failed start ends the process: server.js).
export function previewsEnabled(): boolean {
  return runtime !== null;
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
  return runtime!.appendAndWait(PREVIEW, previewKey(r.sessionId), { type: 'RevisionSubmitted', payload: {
    sessionId: r.sessionId, head: r.head, source: r.source, trigger: r.trigger ?? null, carryFrom: r.carryFrom ?? null,
  } }, { requestKey: `rev:${r.head}:${r.source}:${randomUUID()}`, source: sys(r.source), appId: r.appId, waitMs: 2000 });
}

// A person asks for the preview (ensure: the Preview click; deploy).
export async function requestPreview(r: { sessionId: number; appId: number; head: string; reason: string; actor?: string | null }): Promise<EventOutcome> {
  return runtime!.appendAndWait(PREVIEW, previewKey(r.sessionId), { type: 'PreviewRequested', payload: {
    sessionId: r.sessionId, head: r.head, reason: r.reason,
  } }, { requestKey: await versioned(r.sessionId, `${r.reason}:${r.head}`), source: { kind: 'route', name: r.reason },
    actor: r.actor ?? undefined, appId: r.appId, waitMs: 2000 });
}

export async function requestRecheck(r: { sessionId: number; appId: number; reason: string; trigger?: string | null;
  actor?: string | null; system?: boolean }): Promise<EventOutcome> {
  return runtime!.appendAndWait(PREVIEW, previewKey(r.sessionId), { type: 'RecheckRequested', payload: {
    reason: r.reason, trigger: r.trigger ?? null,
  } }, { requestKey: await versioned(r.sessionId, `recheck:${r.reason}`), source: r.system ? sys(r.reason) : { kind: 'route', name: r.reason },
    actor: r.actor ?? undefined, appId: r.appId, waitMs: 2000 });
}

// A person's "Run checks again" folded into what the session is already
// doing (services/unit-suite-reuse.js owePendingRun): the machine stamps the
// head's stored verdict pending, if it is the head's and not pending already.
export async function recheckFolded(r: { sessionId: number; appId: number; head: string }): Promise<EventOutcome> {
  return runtime!.appendAndWait(PREVIEW, previewKey(r.sessionId), { type: 'RecheckFolded', payload: { head: r.head, sessionId: r.sessionId } },
    { requestKey: `folded:${r.head}:${randomUUID()}`, source: { kind: 'route', name: 'manual-recheck' }, appId: r.appId, waitMs: 2000 });
}

export async function checksSkipped(sessionId: number, appId: number, head: string, reason: string,
  expected: string | null = null): Promise<EventOutcome> {
  return runtime!.appendAndWait(PREVIEW, previewKey(sessionId), { type: 'ChecksSkipped', payload: { sessionId, head, reason, expected } },
    { requestKey: `skipped:${head}:${randomUUID()}`, source: sys('checks-skipped'), appId, waitMs: 2000 });
}

export async function checksCleared(sessionId: number, appId: number, reason: string): Promise<EventOutcome> {
  return runtime!.appendAndWait(PREVIEW, previewKey(sessionId), { type: 'ChecksCleared', payload: { reason, sessionId } },
    { requestKey: `cleared:${reason}:${randomUUID()}`, source: { kind: 'route', name: reason }, appId, waitMs: 2000 });
}

export async function conflictResolved(sessionId: number, appId: number, head: string): Promise<number> {
  return runtime!.append(PREVIEW, previewKey(sessionId), { type: 'ConflictResolved', payload: { head } },
    { requestKey: await versioned(sessionId, `clean:${head}`), source: sys('conflict-resolved'), appId });
}

export async function previewLost(sessionId: number, appId: number, attempt: number, detail: string | null): Promise<number> {
  return runtime!.append(PREVIEW, previewKey(sessionId), { type: 'PreviewLost', payload: { attempt, detail } },
    { requestKey: await versioned(sessionId, `lost:${attempt}`), source: sys('preview-lost'), appId });
}

// Retire a session's preview (one the machine does not hold yet is adopted
// from its row first). A non-terminal retirement is refused while someone
// works on the session, while it is under review, or while it builds or
// checks.
export async function retirePreview(sessionId: number, appId: number, reason: string, terminal: boolean,
  waitMs = 2000): Promise<EventOutcome> {
  return runtime!.appendAndWait(PREVIEW, previewKey(sessionId), { type: 'RetireRequested', payload: { reason, terminal, sessionId } },
    { requestKey: await versioned(sessionId, `retire:${reason}`), source: sys(reason), appId, waitMs });
}

// Who is working on a session: an old flow's operation starts or ends
// (services/active-workers.js). The start is waited for, so a reader in
// another process sees it before the work goes on.
export async function operationStarted(o: { sessionId: number; id: string; kind: string; holder: string }): Promise<void> {
  if (!previewsEnabled()) return;   // no runtime: a script or a test
  const { rows: [s] } = await kernelPool!.query('SELECT app_id FROM chat_sessions WHERE id = $1', [o.sessionId]);
  await runtime!.appendAndWait(PREVIEW, previewKey(o.sessionId), { type: 'OperationStarted', payload: o },
    { requestKey: `op:${o.id}:start`, source: sys('operation'), appId: s?.app_id ?? null, waitMs: 2000 });
}
export async function operationEnded(o: { sessionId: number; id: string }): Promise<void> {
  if (!previewsEnabled()) return;
  await runtime!.append(PREVIEW, previewKey(o.sessionId), { type: 'OperationEnded', payload: { id: o.id } },
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
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  return SHOTS;
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

// ── Proposals ───────────────────────────────────────────────────────────

// What the proposal machine needs from the configuration.
function proposalDeps(config: any) {
  const ms = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    idleMs: ms(config.sessionAutopauseIdleMs, 0),
    exemptFixtures: process.env.USERNODE_ENV === 'staging',
    reviewCheckMs: ms(config.staleSweepIntervalMs, 60 * 60 * 1000),
    staleNotifyMs: ms(config.prStaleNotifyMs, 0),
    staleGraceMs: ms(config.prStaleGraceMs, 0),
    shotsEnforced: !!config.shots?.enforce,
  };
}

// ── The merge (step 6) ──────────────────────────────────────────────────

// Something may make an app's proposals mergeable (a vote, main green, main
// moved, an admin resuming merges): the app's merge queue looks. In a
// caller's transaction (`db`) it is appended there.
export async function wantMerge(p: { appId: number; sessionId?: number | null; reason: string; db?: Queryable }): Promise<void> {
  if (!Number.isInteger(Number(p.appId)) || Number(p.appId) <= 0) return;
  const appId = Number(p.appId);
  const event = { type: 'MergeWanted', payload: { appId, sessionId: p.sessionId ?? null, reason: p.reason } };
  const opts = { requestKey: `want:${appId}:${randomUUID()}`, source: { kind: 'system' as const, name: p.reason }, appId };
  if (p.db && !runtime) {
    await appendEvent(p.db, mergeQueue(), queueKey(appId), event, opts);
    return;
  }
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  await runtime.append(QUEUE, queueKey(appId), event, p.db ? { ...opts, db: p.db } : opts);
}

// An admin forces the merge of a proposal in review (M4): the force lasts
// until it merges, closes, leaves review or its author pushes new code.
export function forceMerge(p: { sessionId: number; appId: number; from: string; userId?: number | null; username?: string | null }) {
  return proposalEvent('ForceMerge', { from: p.from, userId: p.userId ?? null, username: p.username ?? null },
    { sessionId: p.sessionId, appId: p.appId, source: { kind: 'route', name: 'admin-merge' }, actor: p.userId ? `user:${p.userId}` : null }) as Promise<EventOutcome>;
}

// A sync with main, for `reason` (proposal/machine.ts SYNC_REASONS). The
// machine decides whether it may run; `wait`: resolve once it has ended,
// with its outcome (`lastSync`), up to `waitMs`.
export async function requestSync(p: {
  sessionId: number; appId: number; reason: string; head?: string | null; keys?: string[] | null; userId?: number | null;
  wait?: boolean; waitMs?: number; source?: Source;
}): Promise<EventOutcome & { lastSync?: any; sync?: number | null }> {
  const out = await proposalEvent('SyncRequested', {
    reason: p.reason, head: p.head ?? null, keys: p.keys ?? null, userId: p.userId ?? null,
  }, { sessionId: p.sessionId, appId: p.appId, source: p.source || sys(`sync-${p.reason}`), actor: p.userId ? `user:${p.userId}` : null }) as EventOutcome;
  const n = (out.reply as any)?.sync ?? null;
  if ((out.status !== 'accepted' && out.status !== 'replayed') || !p.wait || n == null) return { ...out, sync: n };
  const last = await waitForSync(p.sessionId, n, p.waitMs);
  return { ...out, sync: n, ...(last ? { lastSync: last } : {}) };
}

// Wait for the sync `n` of a session to end (up to `waitMs`): its outcome,
// or null when it has not ended by then.
export async function waitForSync(sessionId: number, n: number, waitMs = 25 * 60 * 1000): Promise<any | null> {
  const done = (i: { state: string; data: any }) => !i.data?.sync || i.data.sync.n !== n;
  const i = await runtime!.waitFor(proposalMachine(), proposalKey(sessionId), done, waitMs).catch(() => null) as any;
  return i?.data?.lastSync && i.data.lastSync.n === n ? i.data.lastSync : null;
}

// Wait (up to `waitMs`) for a proposal to be merged: true once it is.
export async function waitForMerge(sessionId: number, waitMs: number): Promise<boolean> {
  const i = await runtime!.waitFor(proposalMachine(), proposalKey(sessionId), (x) => x.state === 'merged', waitMs).catch(() => null);
  return i?.state === 'merged';
}

// The sync the proposal machine runs for a session, if any (the status
// route's reload recovery).
export async function syncUnderWay(sessionId: number): Promise<{ n: number; reason: string; at: string } | null> {
  const i = await proposalInstance(sessionId);
  return i?.data?.sync ?? null;
}

function proposalMachine() {
  if (!runtime) throw new Error('The workflow runtime is not running in this process');
  return PROPOSAL;
}

// Whether the proposal machine runs in this process.
export function proposalsRunning(): boolean {
  return runtime !== null;
}

type ProposalAppend = {
  sessionId: number; appId?: number | null; source?: Source; actor?: string | null; requestKey?: string;
  // Inside a caller's transaction: appended there, applied once it commits.
  db?: Queryable; waitMs?: number;
  // How long the caller waits for it: past that the machine refuses it
  // (`expired`), so an answer the caller gave up on is never applied later.
  deadlineMs?: number;
};

// What a caller that acts on the answer waits for it.
const ANSWER_MS = 8000;

async function proposalEvent(type: string, payload: Record<string, unknown>, o: ProposalAppend): Promise<EventOutcome | number> {
  // In a process that does not run the machines (a script, a test that
  // appends in its own transaction), the events are decoded by a copy of the
  // machine: its deps decide nothing at an append.
  if (o.db && !runtime) {
    return appendEvent(o.db, proposal(proposalDeps({})), proposalKey(o.sessionId), { type, payload: { sessionId: o.sessionId, ...payload } }, {
      requestKey: o.requestKey || `${type}:${o.sessionId}:${randomUUID()}`,
      source: o.source || sys(type), actor: o.actor ?? undefined, appId: o.appId ?? undefined,
    });
  }
  const m = proposalMachine();
  const event = { type, payload: { sessionId: o.sessionId, ...payload,
    ...(o.deadlineMs ? { deadline: new Date(Date.now() + o.deadlineMs).toISOString() } : {}) } };
  const opts = {
    requestKey: o.requestKey || `${type}:${o.sessionId}:${randomUUID()}`,
    source: o.source || sys(type), actor: o.actor ?? undefined, appId: o.appId ?? undefined,
  };
  if (o.db) return runtime!.append(m, proposalKey(o.sessionId), event, { ...opts, db: o.db });
  return runtime!.appendAndWait(m, proposalKey(o.sessionId), event,
    { ...opts, waitMs: o.waitMs ?? (o.deadlineMs ? o.deadlineMs + 3000 : 5000) });
}

// The proposal machine's instance of a session: its state and data, or null.
export async function proposalInstance(sessionId: number): Promise<{ state: string; data: any } | null> {
  if (!kernelPool) return null;
  const { rows: [r] } = await kernelPool.query(
    'SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [PROPOSAL, proposalKey(sessionId)]);
  return r ? { state: r.state, data: r.data } : null;
}

// A row the machine does not hold yet, adopted (its timer armed): the
// leader's backfill, and an insert of a row born in review, in its own
// transaction (`db`). Asking again is a replay.
export async function proposalAdopted(o: { sessionId: number; appId?: number | null; db?: Queryable }): Promise<void> {
  if (o.db) {
    await proposalEvent('Adopted', {}, { ...o, requestKey: `adopt:${o.sessionId}`, source: sys('adopt') });
    return;
  }
  await runtime!.append(proposalMachine(), proposalKey(o.sessionId), { type: 'Adopted', payload: { sessionId: o.sessionId } },
    { requestKey: `adopt:${o.sessionId}`, source: sys('adopt'), appId: o.appId ?? undefined });
}

// The promote's answers, by the machine's rejection or review.open's code.
const PROMOTE_REFUSALS = new Map<string, Reply>([
  ['session_state_changed', { status: 409, body: { error: 'session_state_changed' } }],
  ['not_owner', { status: 404, body: { error: 'Active session not found' } }],
  ['headless', { status: 404, body: { error: 'Active session not found' } }],
  ['session_not_found', { status: 404, body: { error: 'Active session not found' } }],
  ['not_found', { status: 404, body: { error: 'Active session not found' } }],
  ['busy', { status: 409, body: { error: 'session_busy', message: 'The session is still working. Try again when it finishes.' } }],
  ['pr_merged', { status: 409, body: { error: 'This change was already merged on GitHub, so there is nothing to vote on.' } }],
  ['pr_closed', { status: 409, body: { error: 'This change was closed on GitHub, so it can\'t ask for approval.' } }],
  ['pr_draft', { status: 409, body: { error: 'This pull request is a draft on GitHub. Its author marks it ready for review before it can go up for a vote.' } }],
  ['merged', { status: 409, body: { error: 'This change was already merged.' } }],
]);
const PROMOTE_FAILURES = new Map<string, number>([
  ['no_commits', 409], ['github_unavailable', 503], ['pr_create_failed', 502], ['pr_merged', 409], ['pr_closed', 409],
  ['reopen_failed', 409], ['no_repo', 409], ['bad_head', 409], ['pr_draft', 409], ['ready_failed', 503], ['not_found', 404],
  ['session_state_changed', 409],
]);

// Up for a vote: the route has validated, and read the pull request from
// GitHub (`pr`, null when there is none yet). The machine claims the
// proposal for review, GitHub opens or readies its pull request, and the
// proposal is in review once it has: answered as soon as that is so, within
// about twenty seconds; past them, 202 (it is being put up for a vote, and
// the page hears when it is).
export async function promoteProposal(p: {
  sessionId: number; appId: number; userId: number; username: string | null; from: string; cap: number;
  pr: { state: string; draft: boolean; merged: boolean; head: string | null } | null;
  expectedHead?: string | null; viaAgent?: boolean; ownOperation?: string | null; source?: Source; waitMs?: number;
}): Promise<Reply> {
  const outcome = await proposalEvent('Promote', promotePayload(p),
    { sessionId: p.sessionId, appId: p.appId, source: p.source || { kind: 'route', name: 'promote' }, actor: `user:${p.userId}` }) as EventOutcome;
  return promoteAnswer(outcome, { sessionId: p.sessionId, cap: p.cap, waitMs: p.waitMs });
}

const promotePayload = (p: Parameters<typeof promoteProposal>[0]) => ({
  from: p.from, userId: p.userId, username: p.username, cap: p.cap, pr: p.pr,
  expectedHead: p.expectedHead ?? null, viaAgent: !!p.viaAgent, ownOperation: p.ownOperation ?? null,
});

// An import going straight to a vote: the promote is appended in the
// import's own transaction (`db`), so it is asked for whatever happens to
// the request after the commit; the route then waits for it
// (promoteImported's answer).
export async function promoteInTransaction(p: Parameters<typeof promoteProposal>[0] & { db: Queryable }): Promise<number> {
  return proposalEvent('Promote', promotePayload(p),
    { sessionId: p.sessionId, appId: p.appId, db: p.db, source: p.source || { kind: 'route', name: 'promote' }, actor: `user:${p.userId}` }) as Promise<number>;
}
export async function promoteCommitted(eventId: number, p: { sessionId: number; cap: number; waitMs?: number }): Promise<Reply> {
  return promoteAnswer(await runtime!.waitForEvent(eventId, 5000), p);
}

function promoteRefusal(reason: string | null | undefined, cap: number): Reply {
  if (reason === 'promoted_cap') {
    return { status: 429, body: { error: `You already have ${cap} changes waiting for approval. Wait for one to go live, or archive one first.` } };
  }
  return PROMOTE_REFUSALS.get(reason || '') || { status: 409, body: { error: reason } };
}

// What a promote came to: refused at once, or answered once GitHub has
// reported (200, or the refusal it ended in), or 202 while it still goes up.
async function promoteAnswer(outcome: EventOutcome, p: { sessionId: number; cap: number; waitMs?: number }): Promise<Reply> {
  if (outcome.status === 'rejected') return promoteRefusal(outcome.reason, p.cap);
  if (outcome.status === 'faulted') return { status: 500, body: { error: 'Internal server error' } };
  const n = (outcome.reply as any)?.promoting ?? null;
  if (outcome.status === 'pending' || n == null) return PROMOTE_PENDING;
  const i = await runtime!.waitFor(proposalMachine(), proposalKey(p.sessionId),
    (x) => x.state !== 'proposing' || x.data?.promoting?.n !== n, p.waitMs ?? 20000);
  if (i?.state === 'proposing' && i.data?.promoting?.n === n) return PROMOTE_PENDING;
  const a = i?.data?.answer;
  if (!a || a.n !== n) return PROMOTE_REFUSALS.get('session_state_changed')!;
  return answerReply(a);
}

const PROMOTE_PENDING: Reply = { status: 202, body: { ok: true, pending: true, message: 'Being put up for a vote.' } };

// A promote that answered 202, waited on until GitHub has reported: what its
// latest promote came to, or 202 again past `waitMs`.
export async function promoteSettled(p: { sessionId: number; waitMs: number }): Promise<Reply> {
  const i = await runtime!.waitFor(proposalMachine(), proposalKey(p.sessionId), (x) => x.state !== 'proposing', p.waitMs);
  if (!i || i.state === 'proposing') return PROMOTE_PENDING;
  const a = i.data?.answer;
  if (!a) return PROMOTE_REFUSALS.get('session_state_changed')!;
  return answerReply(a);
}

function answerReply(a: any): Reply {
  if (a.ok) return { status: 200, body: { ok: true, prNumber: a.prNumber ?? null, prUrl: a.prUrl ?? null, prTitle: a.prTitle ?? null } };
  if (a.code === 'branch_head_changed') return { status: 409, body: { error: 'branch_head_changed', message: a.message } };
  if (a.code === 'session_state_changed') return PROMOTE_REFUSALS.get('session_state_changed')!;
  return { status: PROMOTE_FAILURES.get(a.code) || 503, body: { error: a.message || 'Could not put the change up for a vote. Try again shortly.' } };
}

// The rest of a proposal's moves, each answered with the machine's outcome
// (services/session-lifecycle.js turns it into what its callers read). Each
// names what its caller read (`from`): one a newer move overtook is refused.
export function unpromoteProposal(p: { sessionId: number; appId?: number | null; userId: number; username?: string | null; from: string }) {
  return proposalEvent('Unpromote', { from: p.from, userId: p.userId, username: p.username ?? null },
    { sessionId: p.sessionId, appId: p.appId, source: { kind: 'route', name: 'unpromote' }, actor: `user:${p.userId}`,
      deadlineMs: ANSWER_MS }) as Promise<EventOutcome>;
}
export function pauseProposal(p: { sessionId: number; appId?: number | null; reason: string; from: string; userId?: number | null;
  db?: Queryable; requestKey?: string; source?: Source; waitMs?: number }): Promise<EventOutcome | number> {
  return proposalEvent('Pause', { from: p.from, reason: p.reason, userId: p.userId ?? null },
    { sessionId: p.sessionId, appId: p.appId, db: p.db, requestKey: p.requestKey, source: p.source || sys(`pause-${p.reason}`), waitMs: p.waitMs,
      actor: p.userId ? `user:${p.userId}` : null, deadlineMs: p.db ? undefined : ANSWER_MS });
}
export function resumeProposal(p: { sessionId: number; appId?: number | null; from: string; userId?: number | null;
  caps: { user: number; global: number } | null; source?: Source }) {
  return afterTeardown(p.sessionId, () => proposalEvent('Resume', { from: p.from, userId: p.userId ?? null, caps: p.caps },
    { sessionId: p.sessionId, appId: p.appId, source: p.source || sys('resume'), actor: p.userId ? `user:${p.userId}` : null,
      deadlineMs: ANSWER_MS }) as Promise<EventOutcome>);
}

// A resume or a reopen refused while the session's worker or CC volume is
// still being removed (`tearing_down`) is asked again once a removal has
// reported (the instance's list of them changes), or a second on (a removal
// that failed and waits to be tried again can be cancelled). Past
// TEARDOWN_WAIT_MS the refusal stands.
const TEARDOWN_WAIT_MS = 30000;
const TEARDOWN_RECHECK_MS = 1000;
async function afterTeardown(sessionId: number, ask: () => Promise<EventOutcome>): Promise<EventOutcome> {
  const until = Date.now() + TEARDOWN_WAIT_MS;
  for (;;) {
    const out = await ask();
    if (out.status !== 'rejected' || out.reason !== 'tearing_down' || Date.now() >= until) return out;
    const seen = JSON.stringify((await proposalInstance(sessionId))?.data?.doomed || []);
    await runtime!.waitFor(proposalMachine(), proposalKey(sessionId),
      (x) => JSON.stringify(x.data?.doomed || []) !== seen, TEARDOWN_RECHECK_MS);
  }
}
export function closeProposal(p: { sessionId: number; appId?: number | null; reason: string; from: string; userId?: number | null;
  username?: string | null; purgeCc?: boolean; db?: Queryable; requestKey?: string; source?: Source; waitMs?: number }): Promise<EventOutcome | number> {
  return proposalEvent('Close', { from: p.from, reason: p.reason, userId: p.userId ?? null, username: p.username ?? null, purgeCc: !!p.purgeCc },
    { sessionId: p.sessionId, appId: p.appId, db: p.db, requestKey: p.requestKey, source: p.source || sys(`close-${p.reason}`), waitMs: p.waitMs,
      actor: p.userId ? `user:${p.userId}` : null });
}
export function reopenProposal(p: { sessionId: number; appId?: number | null; userId: number; from: string }) {
  return afterTeardown(p.sessionId, () => proposalEvent('Reopen', { from: p.from, userId: p.userId },
    { sessionId: p.sessionId, appId: p.appId, source: { kind: 'route', name: 'reopen' }, actor: `user:${p.userId}`,
      deadlineMs: ANSWER_MS }) as Promise<EventOutcome>);
}

// The revision the group votes on moved (Q3): the caller read `from` in the
// column it names and found `to`. The reply carries the epoch after it and
// whether the description is stale now.
export function moveReviewHead(p: { sessionId: number; appId?: number | null; column: 'reviewed' | 'imported';
  from: string | null; to: string; keepVotes: boolean; fixOnly?: boolean; reason?: string | null }) {
  return proposalEvent('ReviewHeadMoved', { column: p.column, from: p.from, to: p.to, keepVotes: !!p.keepVotes,
    fixOnly: !!p.fixOnly, reason: p.reason ?? null },
  { sessionId: p.sessionId, appId: p.appId, source: sys('review-head'), deadlineMs: ANSWER_MS }) as Promise<EventOutcome>;
}
export function clearProposalApprovals(p: { sessionId: number; appId?: number | null; reason?: string | null }) {
  return proposalEvent('ApprovalsCleared', { reason: p.reason ?? null },
    { sessionId: p.sessionId, appId: p.appId, source: sys('approvals-cleared'), deadlineMs: ANSWER_MS }) as Promise<EventOutcome>;
}

// ── The admin console ───────────────────────────────────────────────────

// The events an admin may append from the console, per machine, and the
// payload each needs beyond the admin's own identity.
const ADMIN_EVENTS = new Map<string, ReadonlySet<string>>([
  [MACHINE, new Set(['Evaluate', 'AdminApply', 'RetryFollowup'])],
  [MERGE, new Set(['RetryDelivery', 'RetryFollowup'])],
  [DELIVERY, new Set(['EndDeploy'])],
  [PREVIEW, new Set(['AdminRetry', 'AdminRetire', 'AdminEnd'])],
  [BOT_CHANGE, new Set(['RetryFollowup'])],
]);

// The states a machine names as waiting on something outside (its
// `attention`), for Admin → Workflows' "Needs a person". Read from the
// machines' own declarations, so it answers with the runtime off too.
const ATTENTION = new Map<string, Readonly<Record<string, string>>>([[PROPOSAL, PROPOSAL_ATTENTION]]);
export function attentionStates(): { machine: string; state: string; says: string }[] {
  return [...ATTENTION].flatMap(([machineName, states]) =>
    Object.entries(states).map(([state, says]) => ({ machine: machineName, state, says })));
}

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
  return runtime.appendAndWait(machineName, key, { type, payload: body },
    { requestKey: `admin:${randomUUID()}`, source: { kind: 'admin', name: 'console' }, actor: `user:${admin.id}` });
}

export async function adminRelease(machineName: string, key: string, mode: 'retry' | 'skip', admin: { id: number }) {
  if (!runtime) throw new AdminActionError(409, 'The workflow runtime is not running here');
  return runtime.release(machineName, key, { mode, actor: `user:${admin.id}` });
}
