// What browsers hear from a machine, shaped as services/ws.js's push helpers
// shape it: the same message types, audiences and routing, so the client
// cannot tell a machine's push from a route's. A transition returns them in
// `push`, a domain write adds them with `ctx.push`; the kernel publishes them
// in the transition's transaction (platform.ts) and every web process relays
// them once it commits (services/ws-bus.js WORKFLOW_SENDER).

import type { Json, JsonObject, Push } from './kernel/index.ts';

// Everyone who may view the app (ws.broadcastGlobalScoped).
function scoped(type: string, data: JsonObject): Push {
  return { kind: 'scoped', routing: { appId: data.appId ?? null, appSlug: data.appSlug ?? null }, data: { type, ...data } };
}

export const issueUpdate = (data: JsonObject) => scoped('issue_update', data);   // ws.pushIssueUpdate

// A card moved on a board: besides the browsers, the Workshop's placement
// stage hears it in every web process that relays the push (services/ws.js
// `routing.boardChange` → workshop-themes.noteBoardChange, debounced and
// leased per app), the deciding one included. What ws.pushIssueUpdate /
// pushSessionUpdate kick in the process that calls them.
export const boardMoved = (p: Push): Push => ({ ...p, routing: { ...(p.routing || {}), boardChange: true } });
export const voteUpdate = (data: JsonObject) => scoped('vote_update', data);     // ws.pushVoteUpdate
export const appUpdate = (data: JsonObject) => scoped('app_update', data);       // ws.pushAppUpdate

// The version pill: the app now runs this build.
export function appVersion(d: { appId: number; appSlug: string; sha: string | null; prNumber: number | null }): Push {
  return { kind: 'scoped', routing: { appId: d.appId, appSlug: d.appSlug },
    data: { type: 'app_version_changed', appSlug: d.appSlug, sha: d.sha || null, prNumber: d.prNumber || null } };
}

// The version pill's "deploying", started or ended: services/app-deploy-status.js
// markStart/markEnd's broadcast, to everyone (ws.broadcastGlobal).
export function redeployStatus(d: {
  appSlug: string; deploying: boolean; startedAt: string; fromSha: string | null;
  toSha?: string | null; failed?: boolean; missingSecrets?: string[] | null;
}): Push {
  const data: JsonObject = { type: 'app_redeploy_status', appSlug: d.appSlug, deploying: d.deploying, startedAt: d.startedAt, fromSha: d.fromSha };
  if (!d.deploying) Object.assign(data, { toSha: d.toSha ?? null, failed: !!d.failed, missingSecrets: d.missingSecrets ?? null });
  return { kind: 'global', data };
}

// Issues just closed on GitHub, to every web process's own copy of the
// repository's open issues (github.js: the "just closed" suppression, since
// GitHub's list lags, and the cache). `open`: issues hidden as about to
// close that are still open after all, shown again. It reaches no browser:
// services/ws.js applies it where it relays workflow pushes. The cache is
// per process, and this is how a process that did not close them hears it.
export function issuesClosed(d: { owner: string; repo: string; numbers: number[]; open?: number[] }): Push {
  return { kind: 'issues_closed', routing: { owner: d.owner, repo: d.repo },
    data: { numbers: d.numbers, ...(d.open?.length ? { open: d.open } : {}) } };
}

// One person's tabs (ws.pushToUser).
export const toUser = (userId: number, data: JsonObject): Push => ({ kind: 'user', routing: { userId }, data });

// A thread line the transition wrote, to the app's chat room, as
// ws.sendSystemMessage broadcasts it, from the row its INSERT returned (id,
// app_id, content, msg_type, metadata, thread_type, thread_ref,
// created_at). `wfEvent`, the machine's own marker on the row, stays out of
// what browsers get.
export interface LineRow {
  id: number; app_id: number; content: string; msg_type: string; metadata: JsonObject | null;
  thread_type: string; thread_ref: number; created_at: Date | string;
}
export function chatLine(row: LineRow): Push {
  const { wfEvent, ...metadata } = (row.metadata || {}) as JsonObject;
  void wfEvent;
  return { kind: 'room', routing: { appId: row.app_id }, data: {
    type: 'chat', id: Number(row.id), userId: null, username: null, content: row.content, msgType: row.msg_type,
    ...(Object.keys(metadata).length ? { metadata } : {}),
    thread: { type: row.thread_type, ref: Number(row.thread_ref) },
    createdAt: (row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at) as Json,
  } };
}

// One session's live event (ws.broadcastGlobal's `session_event`, routed by
// session as services/ws.js broadcastSessionEvent routes it): the owner's
// tabs and the tabs watching the session, and for the few events lists and
// boards draw (a checks run's progress and verdict, a preview built or
// failed) everyone who may view the app. `seq` is the client's dedup key
// (`_seq`), unique per event: the transition's instance and version.
const SESSION_FANOUT_EVENTS: ReadonlySet<string> = new Set(['checks_ready', 'staging_ready', 'staging_failed']);
export interface SessionRoute { sessionId: number; userId: number | null; appId: number | null; appSlug: string | null }
export function sessionEvent(to: SessionRoute, event: string, seq: string, data: JsonObject): Push {
  return {
    kind: 'session',
    routing: { sessionId: to.sessionId, userId: to.userId, appId: to.appId, appSlug: to.appSlug,
      fanout: SESSION_FANOUT_EVENTS.has(event) },
    data: { _seq: seq, ...data, type: 'session_event', sessionId: to.sessionId, event },
  };
}

// A session's card moved on a board or list (ws.pushSessionUpdate, without
// its in-process Workshop listener).
export const sessionUpdate = (data: JsonObject) => scoped('session_update', data);
