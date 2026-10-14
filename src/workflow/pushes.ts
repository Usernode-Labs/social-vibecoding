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
export const voteUpdate = (data: JsonObject) => scoped('vote_update', data);     // ws.pushVoteUpdate
export const appUpdate = (data: JsonObject) => scoped('app_update', data);       // ws.pushAppUpdate

// The version pill: the app now runs this build.
export function appVersion(d: { appId: number; appSlug: string; sha: string | null; prNumber: number | null }): Push {
  return { kind: 'scoped', routing: { appId: d.appId, appSlug: d.appSlug },
    data: { type: 'app_version_changed', appSlug: d.appSlug, sha: d.sha || null, prNumber: d.prNumber || null } };
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
