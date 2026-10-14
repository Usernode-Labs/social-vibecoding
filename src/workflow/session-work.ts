// Who is working on a session, read from the durable record of each kind of
// work, for a machine's facts (a decision that must leave such a session
// alone). Shared by the machines; SQL only.
//
//   a coding turn            chat_sessions.active_turn (its journal)
//   a turn on a local agent  local_agent_turns, while live
//   a shots run              shot_runs, heard from lately (LIVE_SHOTS_RUN)
//   a preview build or a     the preview machine's build or run item,
//     checks run               while outstanding (alive while its lease is)
//   a turn, or anything else a platform process's hold on the session
//     an old flow does (a      (process_holds, kind 'session': services/
//     sync, a dispatch, an     active-workers.js), while that process
//     upload)                  beats (services/processes.js)

// A shots run still using its proposal's worker, read from its own row
// (`r`, shot_runs): not finished, and heard from lately. A live run renews
// updated_at every 30 seconds; a run silent for five minutes (forty-five
// for one that never reported progress) is one services/shots-gc.js
// recovers as interrupted, and no longer holds anything. A 'planned' row is
// claimed within seconds of being made (shots-orchestrator
// scheduleForSession), or never: a merged change starts no new run. This is
// what worker.js's in-memory hold said, in the process that held it.
export const LIVE_SHOTS_RUN = `((r.state = 'planned' AND r.updated_at > NOW() - INTERVAL '2 minutes')
     OR (r.state IN ('provisioning', 'exploring', 'replaying', 'reviewing')
         AND r.updated_at > NOW() - (CASE WHEN COALESCE(r.trace_summary, '{}'::jsonb) ? 'progress'
                                          THEN INTERVAL '5 minutes' ELSE INTERVAL '45 minutes' END)))`;

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

// A platform process that has not beaten (platform_processes.heartbeat_at)
// for this long is gone, whatever it held. services/processes.js reads it
// from here.
export const PROCESS_LIVE_SECONDS = 45;

// True while a live platform process holds the session `sessionId` (an SQL
// expression): a turn or an operation of an old flow runs on it there. A
// hold is written as its work starts; with the preview machine on, the work
// waits for that write (services/active-workers.js), so a decision in
// another process sees it.
export function sessionHeldSql(sessionId: string): string {
  return `EXISTS (SELECT 1 FROM process_holds h JOIN platform_processes p ON p.id = h.process_id
                   WHERE h.kind = 'session' AND h.ref = (${sessionId})::text
                     AND p.heartbeat_at > NOW() - make_interval(secs => ${PROCESS_LIVE_SECONDS}))`;
}
