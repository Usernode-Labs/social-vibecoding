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
//   a durable build          the bot-build machine's instance, while it
//                              builds (buildHoldSql)
//   a sync with main         the proposal machine's sync item, while
//                              outstanding (syncWorkingSql)
//   the Homeroom bot's look  its request instance, reading or following
//                              up on the session (botLookingSql)

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
// process. `exceptParam`: an SQL value naming one operation not to count (a
// caller's own record, read by a decision it asks for while it holds it);
// `exceptKinds`: kinds not to count (constants of services/active-workers.js).
export function operationsLiveSql(sessionId: string, exceptParam: string | null = null, exceptKinds: readonly string[] = []): string {
  for (const k of exceptKinds) if (!/^[a-z][a-z-]*$/.test(k)) throw new Error(`bad operation kind ${k}`);
  return `EXISTS (SELECT 1 FROM wf_instances p,
                         jsonb_array_elements(COALESCE(p.data->'operations', '[]'::jsonb)) AS o
                   WHERE p.machine = 'preview' AND p.key = 'session:' || ${sessionId}
                     AND p.state NOT IN ('detached', 'retired')${exceptParam ? `
                     AND (o->>'id') IS DISTINCT FROM ${exceptParam}` : ''}${exceptKinds.length ? `
                     AND (o->>'kind') NOT IN (${exceptKinds.map((k) => `'${k}'`).join(', ')})` : ''}
                     AND ${holderAliveSql(`(o->>'holder')`)})`;
}

// True while a durable build (the bot-build machine) holds the session
// `alias` names: chat_sessions.workflow_owner points at its instance, still
// building, its turns and the time between them included.
export function buildHoldSql(alias: string): string {
  return `(${alias}.workflow_owner IS NOT NULL AND EXISTS (
             SELECT 1 FROM wf_instances b
              WHERE b.machine = split_part(${alias}.workflow_owner, '/', 1)
                AND b.key = substr(${alias}.workflow_owner, length(split_part(${alias}.workflow_owner, '/', 1)) + 2)
                AND b.state = 'building'))`;
}

// ── Turns workflow work runs ────────────────────────────────────────────
// A coding turn that workflow work started carries its work item on its
// record (`active_turn.owner`, written with the claim: services/worker.js
// execInWorker, agent-turn.startCodexAttempt). The item's lease is the
// turn's presence: no process hold or registry says whose it is.

// The work kinds that run such turns, by machine.
export const TURN_WORK = new Map<string, readonly string[]>([
  ['proposal', Object.freeze(['branch.sync'])],
  ['shots', Object.freeze(['shots.agent'])],
  ['bot-build', Object.freeze(['build.run'])],
  ['bot-request', Object.freeze(['bot.look'])],
]);

// True while the turn record `at` (an SQL expression of an active_turn
// value) belongs to a work item still outstanding: its machine's, in every
// process and across a restart. A record whose item settled (cancelled,
// ended) is an orphan.
export function workflowTurnHeldSql(at: string): string {
  return `EXISTS (SELECT 1 FROM wf_work tw
                   WHERE tw.id::text = (${at})->'owner'->>'workId'
                     AND tw.status <> 'settled')`;
}

// True while the proposal machine's sync of the session `sessionId` is
// outstanding, its spin-up before the turn's record included.
export function syncWorkingSql(sessionId: string): string {
  return `EXISTS (SELECT 1 FROM wf_work sw
                   WHERE sw.machine = 'proposal' AND sw.key = 'session:' || ${sessionId}
                     AND sw.kind = 'branch.sync' AND sw.status <> 'settled')`;
}

// The Homeroom bot's request instances' states in which it reads or works
// on a session (its data names the session).
export const BOT_LOOKING_STATES: readonly string[] = Object.freeze(['reading', 'following_up']);

// True while a request of the Homeroom bot's reads or works on the session
// `sessionId` (its triage session, or its proposal's), spin-up included.
export function botLookingSql(sessionId: string): string {
  return `EXISTS (SELECT 1 FROM wf_instances bl
                   WHERE bl.machine = 'bot-request'
                     AND bl.state IN (${BOT_LOOKING_STATES.map((st) => `'${st}'`).join(', ')})
                     AND (bl.data->'look'->>'sessionId')::int = ${sessionId})`;
}

// The instance whose workflow turn is on the session `$1`, starting or
// running, for a Stop (one row: machine, key), most specific first: the
// record's owner, then a sync, a shots run, a durable build, the bot.
export const TURN_OWNER_SQL = `
  SELECT owner_machine AS machine, owner_key AS key FROM (
    SELECT 1 AS rank, cs.active_turn->'owner'->>'machine' AS owner_machine, cs.active_turn->'owner'->>'key' AS owner_key
      FROM chat_sessions cs
     WHERE cs.id = $1 AND cs.active_turn->'owner' IS NOT NULL AND ${workflowTurnHeldSql('cs.active_turn')}
    UNION ALL
    SELECT 2, 'proposal', 'session:' || $1 WHERE ${syncWorkingSql('$1')}
    UNION ALL
    SELECT 3, 'shots', 'session:' || $1 WHERE ${shotsRunningSql('$1')}
    UNION ALL
    SELECT 4, split_part(cs.workflow_owner, '/', 1), substr(cs.workflow_owner, length(split_part(cs.workflow_owner, '/', 1)) + 2)
      FROM chat_sessions cs WHERE cs.id = $1 AND ${buildHoldSql('cs')}
    UNION ALL
    SELECT 5, 'bot-request', bl.key FROM wf_instances bl
     WHERE bl.machine = 'bot-request' AND bl.state IN (${BOT_LOOKING_STATES.map((st) => `'${st}'`).join(', ')})
       AND (bl.data->'look'->>'sessionId')::int = $1
  ) o ORDER BY rank LIMIT 1`;

// True while anything above works on the session `sessionId` (an SQL
// expression over chat_sessions as `cs`): a coding turn, a turn on a local
// agent, a shots run, a durable build, or an old flow's recorded operation.
// The same in every process and after a restart (the Homeroom bot's voice
// reads it to say whether a run is going on a change).
export function workedOnSql(): string {
  return `(cs.active_turn IS NOT NULL
           OR EXISTS (SELECT 1 FROM local_agent_turns t
                       WHERE t.session_id = cs.id AND t.status IN ('queued', 'offered', 'accepted', 'running'))
           OR ${shotsRunningSql('cs.id')}
           OR ${operationsLiveSql('cs.id')}
           OR ${buildHoldSql('cs')}
           OR ${syncWorkingSql('cs.id')}
           OR ${botLookingSql('cs.id')})`;
}
