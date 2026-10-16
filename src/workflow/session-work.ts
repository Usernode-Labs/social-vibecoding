// Who is working on a session, read from the durable record of each kind of
// work, for a machine's facts (a decision that must leave such a session
// alone). Shared by the machines; SQL only.
//
//   a coding turn            chat_sessions.active_turn (its journal)
//   a turn on a local agent  local_agent_turns, while live
//   a shots run              the shots machine's instance (shotsRunningSql)
//   a preview build or a     the preview machine's build or run item,
//     checks run               while outstanding (alive while its lease is)
//   anything else an old     the preview machine's instance's operations,
//     flow does (a sync,       recorded by services/active-workers.js, each
//     a dispatch, an upload)   counted while the process that holds it is
//                              alive (rules/presence.ts)

import { holderAliveSql } from './rules/presence.ts';

// The shots machine's states in which a run is under way: it holds the
// proposal's worker (its agent is at work in it, or about to be) and its
// copies (src/workflow/shots/).
export const SHOTS_LIVE_STATES: readonly string[] = Object.freeze(['building_copies', 'waiting_for_agent', 'taking_shots', 'publishing']);

// True while a shots run of the session `sessionId` is under way (an SQL
// expression), read from the shots machine's instance: true across restarts
// and in every process, and false the moment the run ends.
export function shotsRunningSql(sessionId: string): string {
  return `EXISTS (SELECT 1 FROM wf_instances w
                   WHERE w.machine = 'shots' AND w.key = 'session:' || ${sessionId}
                     AND w.state IN (${SHOTS_LIVE_STATES.map((st) => `'${st}'`).join(', ')}))`;
}

// The preview machine's work that is a build or a checks run.
export const PREVIEW_WORK_KINDS: readonly string[] = Object.freeze(['preview.prepare', 'checks.run']);

// True while the preview machine builds or checks the session `sessionId`
// (an SQL expression): its build or run is outstanding (queued, running, or
// reported and not yet applied). A running item is alive while its lease
// is; one whose process died is claimed again after it.
export function previewWorkingSql(sessionId: string): string {
  return `EXISTS (SELECT 1 FROM wf_work p
                   WHERE p.machine = 'preview' AND p.key = 'session:' || ${sessionId}
                     AND p.kind IN (${PREVIEW_WORK_KINDS.map((k) => `'${k}'`).join(', ')})
                     AND p.status IN ('queued', 'running', 'reported'))`;
}

// True while an operation recorded on that instance is held by a live
// process.
export function operationsLiveSql(sessionId: string): string {
  return `EXISTS (SELECT 1 FROM wf_instances p,
                         jsonb_array_elements(COALESCE(p.data->'operations', '[]'::jsonb)) AS o
                   WHERE p.machine = 'preview' AND p.key = 'session:' || ${sessionId}
                     AND p.state NOT IN ('detached', 'retired')
                     AND ${holderAliveSql(`(o->>'holder')`)})`;
}
