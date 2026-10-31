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
                     AND w.state IN (${SHOTS_LIVE_STATES.map((st) => `'${st}'`).join(', ')})
                     AND w.flag IS NULL)`;
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

// The recorded operations that do not move a proposal's branch: a worker's
// turn record (the turn is read from its journal, chat_sessions.active_turn)
// and a hand-off's pipeline (it checks the very commit being proposed). Every
// other live operation keeps a proposal `moving` (proposal/facts.ts), and its
// end is what asks the merge queue again (preview/machine.ts opEnded).
export const NOT_MOVING_KINDS: readonly string[] = Object.freeze(['turn', 'handoff-pipeline']);

// The coding turns that do not move a proposal's branch either: the before
// & after shots agent's (the worker's `shots` mode, recorded on
// active_turn.mode like every turn's). It takes pictures of the proposal's
// exact head on copies of its own and writes nothing to the branch. Counted
// as moving, it made the proposal answer the merge queue `busy` for as long
// as it ran, and nothing asked again when it ended: on 21 Oct 2026 PR 5787
// had its checks and its vote at 17:40:47 and merged at 17:44:40, on an
// unrelated ask 47 s after its shots were published. Exempt for the merge
// queue's ask only (proposal/facts.ts mergeMoving): a sync with main, a
// promote and an unpromote still wait for it.
export const NOT_MOVING_TURN_MODES: readonly string[] = Object.freeze(['shots']);

// True while the session row `alias` has a coding turn that may move its
// branch (an SQL expression): any turn but those NOT_MOVING_TURN_MODES names.
export function movingTurnSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`bad alias ${alias}`);
  return `(${alias}.active_turn IS NOT NULL
             AND COALESCE(${alias}.active_turn->>'mode', '') NOT IN (${NOT_MOVING_TURN_MODES.map((m) => `'${m}'`).join(', ')}))`;
}

// True while an operation recorded on that instance is held by a live
// process. `exceptParam`: an SQL value naming one operation not to count (a
// caller's own record, read by a decision it asks for while it holds it);
// `exceptKinds`: kinds not to count (constants of services/active-workers.js).
// A process's holder (services/process-presence.js holder()) as an SQL
// literal, for a reader that answers its own process's part from memory:
// its operations ended there before their OperationEnded reaches the
// preview machine.
export function holderLiteral(holder: string): string {
  return `'${String(holder).replace(/'/g, "''")}'`;
}

export function operationsLiveSql(sessionId: string, exceptParam: string | null = null, exceptKinds: readonly string[] = [],
  exceptHolder: string | null = null): string {
  for (const k of exceptKinds) if (!/^[a-z][a-z-]*$/.test(k)) throw new Error(`bad operation kind ${k}`);
  return `EXISTS (SELECT 1 FROM wf_instances p,
                         jsonb_array_elements(COALESCE(p.data->'operations', '[]'::jsonb)) AS o
                   WHERE p.machine = 'preview' AND p.key = 'session:' || ${sessionId}
                     AND p.state NOT IN ('detached', 'retired')${exceptParam ? `
                     AND (o->>'id') IS DISTINCT FROM ${exceptParam}` : ''}${exceptKinds.length ? `
                     AND (o->>'kind') NOT IN (${exceptKinds.map((k) => `'${k}'`).join(', ')})` : ''}${exceptHolder ? `
                     AND (o->>'holder') IS DISTINCT FROM ${holderLiteral(exceptHolder)}` : ''}
                     AND ${holderAliveSql(`(o->>'holder')`)})`;
}

// True while a live process runs an operation of `kind` on the session
// `sessionId` (an SQL expression), as its preview instance records it: a
// hand-off pipeline ('handoff-pipeline'), on whichever process.
export function operationOfKindLiveSql(sessionId: string, kind: string, exceptHolder: string | null = null): string {
  if (!/^[a-z][a-z-]*$/.test(kind)) throw new Error(`bad operation kind ${kind}`);
  return `EXISTS (SELECT 1 FROM wf_instances p,
                         jsonb_array_elements(COALESCE(p.data->'operations', '[]'::jsonb)) AS o
                   WHERE p.machine = 'preview' AND p.key = 'session:' || ${sessionId}
                     AND p.state NOT IN ('detached', 'retired')
                     AND (o->>'kind') = '${kind}'${exceptHolder ? `
                     AND (o->>'holder') IS DISTINCT FROM ${holderLiteral(exceptHolder)}` : ''}
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
                AND b.state = 'building'
                AND b.flag IS NULL
                AND EXISTS (SELECT 1 FROM wf_work bw
                             WHERE bw.machine = b.machine AND bw.key = b.key
                               AND bw.kind = 'build.run' AND bw.status <> 'settled')))`;
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
// outstanding, its spin-up before the turn's record included. `started`:
// only once it has begun (services/sync-main.js's `started` step), not
// while a platform sync waits for the session to be idle, for whoever it
// waits on (the shots agent): two that wait on each other would both wait
// out the sync's ten minutes.
export function syncWorkingSql(sessionId: string, { started = false }: { started?: boolean } = {}): string {
  return `EXISTS (SELECT 1 FROM wf_work sw
                   WHERE sw.machine = 'proposal' AND sw.key = 'session:' || ${sessionId}
                     AND sw.kind = 'branch.sync' AND sw.status <> 'settled'${started ? `
                     AND sw.checkpoint ? 'started'` : ''})`;
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
                     AND bl.flag IS NULL
                     AND (bl.data->'look'->>'sessionId')::int = ${sessionId}
                     AND EXISTS (SELECT 1 FROM wf_work lw
                                  WHERE lw.machine = 'bot-request' AND lw.key = bl.key
                                    AND lw.kind = 'bot.look' AND lw.status <> 'settled'))`;
}

// The instance whose workflow turn is on the session `$1`, starting or
// running, for a Stop (one row: machine, key), most specific first: the
// record's owner, then, only while no turn record is on the session (a
// workflow turn spinning up), a sync, a shots run, a durable build, the bot,
// a person's own dev chat turn (the turn machine's, in its Mayor's phase).
// A record that is not a workflow's held turn (a person's own, an orphan)
// answers nothing here: that Stop is the person's turn's, on the old path,
// and never ends a platform job that merely waits beside it.
const NO_RECORD = `NOT EXISTS (SELECT 1 FROM chat_sessions nr WHERE nr.id = $1 AND nr.active_turn IS NOT NULL)`;
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
    UNION ALL
    -- A dev chat turn before its record: the turn hears its Stop from its
    -- instance (services/turns.js watchClassicStop). A headless run between
    -- its steps has no such ear: its Stop takes the person's own path.
    SELECT 6, 'turn', t.key FROM wf_instances t
     WHERE t.machine = 'turn' AND t.key = 'session:' || $1 AND t.state = 'running'
       AND t.data->'running'->>'kind' = 'classic'
  ) o WHERE rank = 1 OR ${NO_RECORD} ORDER BY rank LIMIT 1`;

// True while anything above works on the session `sessionId` (an SQL
// expression over chat_sessions as `cs`): a coding turn, a turn on a local
// agent, a shots run, a durable build, a person's turn its machine runs (the
// dev chat's Mayor before it dispatches, a headless run between its steps:
// src/workflow/turn/), or an old flow's recorded operation. `turns: false`
// leaves the turn machine's instance out: what a person's turn asks of its
// own change, which that instance is. `exceptHolder` leaves out the
// operations of one process: the reader's own, which it answers from memory.
// The same in every process and after a restart (the Homeroom bot's voice
// reads it to say whether a run is going on a change).
export interface HolderOptions {
  turns?: boolean;
  // A sync's own wait for idle leaves its own item out, or it would wait on
  // itself (services/sync-main.js).
  sync?: boolean;
  exceptHolder?: string | null;
}

// ── Holders: the same work, named ──────────────────────────────────────
// One row per record that says work is happening on the session: `kind`,
// `since`, and a `ref` a releaser needs (an operation's id). workedOnSql is
// an EXISTS over this, so a surface that asks "is anything running?" and one
// that asks "what is running?" cannot disagree.
//
// A machine state (`wf_instances.state`) is a projection: it changes only
// when a transition runs, and a transition that faulted is held with the old
// state still in place. So no machine-state clause counts unless the
// instance is unflagged AND the work item that would move it is outstanding.
// That is the difference between "a record says work started" and "work is
// running", and it is what made a change stay busy after its run ended
// (request #6068).
export const HOLDER_KINDS: readonly string[] = Object.freeze([
  'turn', 'local_agent', 'shots', 'operation', 'build', 'sync', 'bot', 'turn_instance',
]);

function holderSelects(alias: string, { turns = true, sync = true, exceptHolder = null }: HolderOptions = {}): string[] {
  const a = alias;
  const out = [
    // A coding turn's record: the one kind a person can wait on by name.
    `SELECT 'turn'::text AS kind,
            COALESCE(${a}.active_turn->>'startedAt', ${a}.active_turn->>'lifecycleUpdatedAt')::timestamptz AS since,
            NULL::text AS ref
       WHERE ${a}.active_turn IS NOT NULL`,
    // A turn on a machine the user attached.
    `SELECT 'local_agent'::text, t.created_at, NULL::text
       FROM local_agent_turns t
      WHERE t.session_id = ${a}.id AND t.status IN ('queued', 'offered', 'accepted', 'running')`,
    // The before & after shots.
    `SELECT 'shots'::text, w.updated_at, NULL::text
       FROM wf_instances w
      WHERE w.machine = 'shots' AND w.key = 'session:' || ${a}.id
        AND w.state IN (${SHOTS_LIVE_STATES.map((st) => `'${st}'`).join(', ')})
        AND w.flag IS NULL`,
    // Anything else an old flow does: a dispatch, an upload, a hand-off. Its
    // process's presence lock is its liveness.
    `SELECT 'operation'::text, (o->>'since')::timestamptz, (o->>'id')::text
       FROM wf_instances p,
            jsonb_array_elements(COALESCE(p.data->'operations', '[]'::jsonb)) AS o
      WHERE p.machine = 'preview' AND p.key = 'session:' || ${a}.id
        AND p.state NOT IN ('detached', 'retired')${exceptHolder ? `
        AND (o->>'holder') IS DISTINCT FROM ${holderLiteral(exceptHolder)}` : ''}
        AND ${holderAliveSql(`(o->>'holder')`)}`,
    // A durable build, its turns and the time between them included.
    `SELECT 'build'::text, b.updated_at, NULL::text
       FROM wf_instances b
      WHERE ${a}.workflow_owner IS NOT NULL
        AND b.machine = split_part(${a}.workflow_owner, '/', 1)
        AND b.key = substr(${a}.workflow_owner, length(split_part(${a}.workflow_owner, '/', 1)) + 2)
        AND b.state = 'building' AND b.flag IS NULL
        AND EXISTS (SELECT 1 FROM wf_work bw
                     WHERE bw.machine = b.machine AND bw.key = b.key
                       AND bw.kind = 'build.run' AND bw.status <> 'settled')`,
    // The Homeroom bot reading or following up on it.
    `SELECT 'bot'::text,
            COALESCE((bl.data->'look'->>'startedAt')::timestamptz, bl.updated_at),
            NULL::text
       FROM wf_instances bl
      WHERE bl.machine = 'bot-request'
        AND bl.state IN (${BOT_LOOKING_STATES.map((st) => `'${st}'`).join(', ')})
        AND bl.flag IS NULL
        AND (bl.data->'look'->>'sessionId')::int = ${a}.id
        AND EXISTS (SELECT 1 FROM wf_work lw
                     WHERE lw.machine = 'bot-request' AND lw.key = bl.key
                       AND lw.kind = 'bot.look' AND lw.status <> 'settled')`,
  ];
  if (sync) {
    out.push(`SELECT 'sync'::text, sw.created_at, NULL::text
       FROM wf_work sw
      WHERE sw.machine = 'proposal' AND sw.key = 'session:' || ${a}.id
        AND sw.kind = 'branch.sync' AND sw.status <> 'settled'`);
  }
  if (turns) {
    out.push(`SELECT 'turn_instance'::text, tm.updated_at, NULL::text
       FROM wf_instances tm
      WHERE tm.machine = 'turn' AND tm.key = 'session:' || ${a}.id
        AND tm.state = 'running' AND tm.flag IS NULL
        AND EXISTS (SELECT 1 FROM wf_work tw
                     WHERE tw.machine = 'turn' AND tw.key = tm.key
                       AND tw.kind = 'turn.run' AND tw.status <> 'settled')`);
  }
  return out;
}

// Every holder of the session `session` (an SQL value), one row each, for a
// caller that names what is working on it (services/change-busy.js).
export function sessionHoldersSql(session: string, opts: HolderOptions = {}): string {
  return `SELECT h.kind, h.since, h.ref
            FROM chat_sessions hcs
            CROSS JOIN LATERAL (${holderSelects('hcs', opts).join('\n    UNION ALL\n    ')}) h
           WHERE hcs.id = ${session}`;
}

export function workedOnSql(opts: HolderOptions = {}): string {
  return `EXISTS (${sessionHoldersSql('cs.id', opts)})`;
}
