// Admission for human workflow commands. A producer's source/actor fields
// describe who asked; they do not grant permissions. Read current authority
// in the deciding transaction, before a receipt can replay a private reply.
//
// This is an authorization check inside the trusted platform, not protection
// against a process/SQL writer that can impersonate an arbitrary actor. That
// needs separate database credentials and authenticated producer identities.

import { createRuntime, ok, reject } from './kernel/index.ts';
import type { Check, Event, EventAuthorizer, RuntimeOptions, TransitionContext, Tx } from './kernel/index.ts';

// The console's command inventory is also the admission inventory. Evaluate
// has a legitimate timer producer; every other command here is a human action.
export const ADMIN_EVENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['governance-proposal', new Set(['Evaluate', 'AdminApply', 'RetryFollowup'])],
  ['merge-followups', new Set(['RetryDelivery', 'RetryFollowup'])],
  ['app-delivery', new Set(['EndDeploy'])],
  ['preview', new Set(['AdminRetry', 'AdminRetire', 'AdminEnd'])],
  ['bot-change', new Set(['RetryFollowup'])],
  ['clock', new Set(['RunNow'])],
]);
const CAMPAIGN_ACTIONS = new Set(['RetryApp', 'MergeGreen', 'Stop', 'Resume', 'AutoMerge']);
const REFUSED = () => reject('not_authorized');
const userId = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : null;
const actorId = (actor: string | null): number | null => {
  const m = /^user:([1-9]\d*)$/.exec(actor || '');
  return m ? userId(Number(m[1])) : null;
};

// SHARE locks keep demotion/removal from racing the command's commit. No
// cached req.user or per-project admin roster crosses this boundary.
async function fullAdmin(tx: Tx, id: number): Promise<boolean> {
  const { rows: [u] } = await tx.query(
    'SELECT is_admin, admin_readonly FROM users WHERE id = $1 FOR SHARE', [id]);
  return !!u?.is_admin && !u.admin_readonly;
}
async function appAdmin(tx: Tx, appId: number, id: number): Promise<boolean> {
  const { rows } = await tx.query(
    'SELECT 1 FROM app_admins WHERE app_id = $1 AND user_id = $2 FOR SHARE', [appId, id]);
  return rows.length > 0;
}

interface Target { app_id: number; requires_explicit_approval?: boolean; kind?: string }
async function target(tx: Tx, ctx: TransitionContext, event: Event<any>, kind: 'session' | 'issue'): Promise<Target | null> {
  const m = new RegExp(`^${kind}:([1-9]\\d*)$`).exec(ctx.key);
  const id = m ? userId(Number(m[1])) : null;
  if (!id || (event.payload?.[kind === 'session' ? 'sessionId' : 'issueId'] != null
    && event.payload[kind === 'session' ? 'sessionId' : 'issueId'] !== id)) return null;
  const { rows: [r] } = kind === 'session'
    ? await tx.query<Target>('SELECT app_id, requires_explicit_approval FROM chat_sessions WHERE id = $1 FOR SHARE', [id])
    : await tx.query<Target>('SELECT app_id, kind FROM issues WHERE id = $1 FOR SHARE', [id]);
  if (!r || (ctx.appId != null && ctx.appId !== r.app_id) || (event.appId != null && event.appId !== r.app_id)) return null;
  return r;
}

async function projectAction(tx: Tx, event: Event<any>, ctx: TransitionContext, id: number, mode: 'force' | 'apply' | 'waive'): Promise<Check> {
  const r = await target(tx, ctx, event, mode === 'apply' ? 'issue' : 'session');
  if (!r) return REFUSED();
  if (await fullAdmin(tx, id)) return ok();
  // Match app-admins.canForceMerge: project admins cannot bypass a protected
  // change's explicit approval or force a fleet-wide maintenance campaign.
  if (mode === 'force' && r.requires_explicit_approval) return REFUSED();
  if (mode === 'apply' && (r.kind === 'secret_change' || r.kind === 'maintenance_campaign')) return REFUSED();
  if (mode === 'waive') {
    const { rows: [app] } = await tx.query('SELECT created_by FROM apps WHERE id = $1 FOR SHARE', [r.app_id]);
    if (app?.created_by === id) return ok();
  }
  return await appAdmin(tx, r.app_id, id) ? ok() : REFUSED();
}

export const authorizePlatformEvent: EventAuthorizer = async (tx, event, ctx) => {
  const isApply = ctx.machine === 'governance-proposal' && event.type === 'AdminApply';
  const isForce = ctx.machine === 'proposal' && event.type === 'ForceMerge';
  const isWaive = ctx.machine === 'shots' && event.type === 'WaiveRequested';
  const campaign = ctx.machine === 'campaign' && CAMPAIGN_ACTIONS.has(event.type);
  const manualDelivery = ctx.machine === 'app-delivery' && (
    (event.type === 'DeployRequested' && event.payload?.reason === 'redeploy')
    || (event.type === 'MainMoved' && event.payload?.byHand === true));
  const consoleAction = ADMIN_EVENTS.get(ctx.machine)?.has(event.type) && event.type !== 'Evaluate';
  const requiresAdmin = event.source.kind === 'admin' || consoleAction || campaign || manualDelivery
    || (ctx.machine === 'main-check' && event.type === 'Resume');
  if (!requiresAdmin && !isForce && !isWaive) return ok();

  // A campaign's message carries the administrator who asked for/armed its
  // merges. The kernel supplies message provenance; recheck that person's
  // platform authority when its proposal consumes the message.
  if (isForce && event.source.kind === 'message' && event.source.from.machine === 'campaign') {
    const id = userId(event.payload?.userId);
    return id && await fullAdmin(tx, id) ? ok() : REFUSED();
  }
  const id = actorId(event.actor);
  if (!id) return REFUSED();
  if (event.payload?.userId != null && event.payload.userId !== id) return REFUSED();
  if (isForce || isApply || isWaive) {
    if (userId(event.payload?.userId) !== id) return REFUSED();
    return projectAction(tx, event, ctx, id, isForce ? 'force' : isApply ? 'apply' : 'waive');
  }
  return await fullAdmin(tx, id) ? ok() : REFUSED();
};

// Both production startup and the database regressions use this factory.
export function createPlatformRuntime(opts: Omit<RuntimeOptions, 'authorizeEvent'>) {
  return createRuntime({ ...opts, authorizeEvent: authorizePlatformEvent });
}
