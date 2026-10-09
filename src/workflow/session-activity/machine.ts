// session-activity: who is using a chat session right now. One instance
// per session. Its state is the session's activities: one per thing
// happening on it (a turn, an operation on its branch or preview, a screenshot
// run's hold on the worker, a pause or teardown), granted here under the
// instance's lock so two that must not overlap never do, whichever process
// asks. The holder keeps its activity alive by renewing a lease on its row
// (lease.ts), as the kernel's work items do; an activity whose lease ran
// out stops counting the next time anything is decided. The turn's journal
// (chat_sessions.active_turn) stays the truth for turns: a live one counts
// as a turn whether or not an activity holds it.
// workflow-foundation's session-activity-design.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, Event, Json, Machine, Outcome, Push, TransitionContext, WorkResultPayload } from '../kernel/index.ts';
import { readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'session-activity';
export const sessionKey = (sessionId: number) => `session:${sessionId}`;

// A holder renews every RENEW_MS; an activity counts while its lease runs.
export const LEASE_MS = 90_000;
export const RENEW_MS = 15_000;

// Work kinds are one namespace across machines (merge-followups has its own
// 'worker.retire', which asks this machine).
export const WORK = Object.freeze({ retire: 'session.retireWorker' });

export type Kind = 'chat' | 'turn' | 'operation' | 'hold' | 'destroy';
export const KINDS: ReadonlySet<Kind> = new Set(['chat', 'turn', 'operation', 'hold', 'destroy']);

// What keeps a request out, from what [main] refuses today. A Mayor chat
// turn keeps nothing out: it is recorded so a Stop finds the process running
// it. An operation needs the session's branch and preview to itself (moving
// the branch, promoting, rebuilding the preview); a destroy pauses, evicts,
// reclaims or tears down. Staging builds and captures are not activities:
// Kubernetes already serialises a session's builds across processes
// (staging.js), and what refuses on them still asks staging.js and
// visuals.js as on [main].
// - a turn is kept out by a turn, an operation, a hold (other than its own)
//   and a destroy;
// - an operation by a turn, an operation and a destroy;
// - a hold by a destroy only: a screenshot run holds the worker first and
//   then waits for the session to go idle;
// - a destroy by anything but a chat turn;
// - a chat turn by nothing.
const BLOCKED_BY = new Map<Kind, ReadonlySet<Kind>>([
  ['chat', new Set()],
  ['turn', new Set(['turn', 'operation', 'hold', 'destroy'])],
  ['operation', new Set(['turn', 'operation', 'destroy'])],
  ['hold', new Set(['destroy'])],
  ['destroy', new Set(['turn', 'operation', 'hold', 'destroy'])],
]);
export const blockedBy = (requested: Kind, existing: Kind) => BLOCKED_BY.get(requested)!.has(existing);

// ── States ──────────────────────────────────────────────────────────────

export interface StopRequest {
  at: string;          // the first Stop for this turn
  n: number;           // which Stop this is (a forced one follows a first)
  by: { id: number; username: string; canAdminWrite: boolean };
  force: boolean;
  immediate: boolean;
  expectedTurnId: string | null;
}
export interface Activity {
  id: string;
  kind: Kind;
  holder: string;
  label: string | null;
  turnId: string | null;
  parent: string | null;
  // Whether it has a stop handle where it runs (the Mayor's turn, its
  // dispatch, an agent build, a recovered turn): what a Stop is sent to.
  stoppable: boolean;
  grantedAt: string;
  stop: StopRequest | null;
}
export interface Data {
  sessionId: number;
  activities: Activity[];
  // A retirement of the session's worker that waits for its activities to
  // end; `work` is its work key once it runs.
  retire: { requestedAt: string; by: string[]; work: string | null } | null;
}
export type SAState =
  | { name: 'idle' | 'in_use' | 'retiring'; data: Data }
  | { name: typeof NONE; data: null };
type Open = Extract<SAState, { data: Data }>;

// ── Events ──────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const uuid = (v: unknown, what: string) => {
  const s = String(v ?? '').toLowerCase();
  if (!UUID.test(s)) throw new Error(`${what} must be a uuid`);
  return s;
};
const optText = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const text = (v: unknown, what: string) => {
  const s = optText(v);
  if (!s) throw new Error(`${what} is required`);
  return s;
};

const EVENTS = {
  // Someone is about to start an activity on the session and waits for the
  // answer: granted, or refused with what is in the way.
  Requested: (p: any) => {
    if (!KINDS.has(p?.kind)) throw new Error('kind is unknown');
    return {
      sessionId: int(p?.sessionId, 'sessionId'),
      activityId: uuid(p?.activityId, 'activityId'),
      kind: p.kind as Kind,
      holder: text(p?.holder, 'holder'),
      label: optText(p?.label),
      turnId: optText(p?.turnId),
      parent: p?.parent == null ? null : uuid(p.parent, 'parent'),
      stoppable: p?.stoppable === true,
    };
  },
  // Its holder is done with it (or gave up waiting for the answer).
  Ended: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'),
    activityId: uuid(p?.activityId, 'activityId'),
    outcome: optText(p?.outcome, 40) || 'done',
  }),
  // A Stop for the session's turn, from whichever process received it.
  StopRequested: (p: any) => ({
    sessionId: int(p?.sessionId, 'sessionId'),
    by: { id: int(p?.by?.id, 'by.id'), username: text(p?.by?.username, 'by.username'), canAdminWrite: p?.by?.canAdminWrite === true },
    force: p?.force === true,
    immediate: p?.immediate === true,
    expectedTurnId: optText(p?.expectedTurnId),
  }),
  // A merge (or a change carried by one) no longer needs the worker.
  RetireRequested: (p: any) => ({ sessionId: int(p?.sessionId, 'sessionId'), by: text(p?.by, 'by') }),
  // The retirement's own timer: see whether what it waits for has ended.
  Recheck: () => ({}),
};

// ── Deciding ────────────────────────────────────────────────────────────

// The activities that still count: those whose lease runs.
const live = (d: Data, f: Facts) => d.activities.filter((a) => f.live.has(a.id));

// The first thing in the way of a request, or null. A request never
// conflicts with its own parent (a screenshot run's turn and its hold).
// A running turn's journal keeps out what a turn keeps out, except another
// turn: two turns are already kept apart where a turn records its journal
// (turn-lifecycle.js persistNewTurn), and a turn that continues the journal's
// own (recovery, a retry, a wrap-up) must not be refused by it. One naming
// the journal's turn is not kept out by it either (the watchdog reaping it).
function blocker(d: Data, f: Facts, p: { kind: Kind; parent: string | null; turnId: string | null; activityId: string }): Kind | null {
  // A turn that continues the journal's running turn (recovery, a retry)
  // is not kept out by a hold: the screenshot run holding the worker waits
  // for exactly that turn to end.
  const continuesJournal = p.kind === 'turn' && !!p.turnId && f.journal?.live && f.journal.turnId === p.turnId;
  for (const a of live(d, f)) {
    if (a.id === p.parent || a.id === p.activityId) continue;
    if (continuesJournal && a.kind === 'hold') continue;
    if (blockedBy(p.kind, a.kind)) return a.kind;
  }
  if (f.journal?.live && p.kind !== 'turn' && f.journal.turnId !== p.turnId && blockedBy(p.kind, 'turn')) return 'turn';
  return null;
}

const named = (activities: Activity[]): Open['name'] => (activities.length ? 'in_use' : 'idle');

// The retirement's next step: run it once nothing counts, else look again
// when the longest a holder can be gone without the lease running out has
// passed.
function retireStep(d: Data, f: Facts, ctx: TransitionContext): Outcome<SAState> {
  const activities = live(d, f);
  const next = { ...d, activities };
  if (activities.length) {
    return { next: { name: 'retiring', data: next }, timer: { at: new Date(ctx.now.getTime() + LEASE_MS), event: { type: 'Recheck' } } };
  }
  if (d.retire!.work) return { next: { name: 'retiring', data: next }, timer: null };
  const work = `retire:${ctx.version + 1}`;
  return {
    next: { name: 'retiring', data: { ...next, retire: { ...d.retire!, work } } },
    work: [{ kind: WORK.retire, key: work, input: { sessionId: d.sessionId } }],
    timer: null,
  };
}

const requested = {
  guard: (s: SAState, e: Event<any>, f: Facts): Check => {
    if (s.name === 'retiring') return reject('retiring');
    const d = s.name === NONE ? null : (s as Open).data;
    if (d?.activities.some((a) => a.id === e.payload.activityId)) return reject('already_granted');
    const b = blocker(d || empty(e.payload.sessionId), f, e.payload);
    return b ? reject(`busy_${b}`) : ok();
  },
  to: (s: SAState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<SAState> => {
    const d = s.name === NONE ? empty(e.payload.sessionId) : (s as Open).data;
    const p = e.payload;
    const parent = p.parent && live(d, f).some((a) => a.id === p.parent) ? p.parent : null;
    const activities = [...live(d, f), {
      id: p.activityId, kind: p.kind, holder: p.holder, label: p.label, turnId: p.turnId, parent,
      stoppable: p.stoppable, grantedAt: ctx.now.toISOString(), stop: null,
    }];
    return { next: { name: 'in_use', data: { ...d, activities } } };
  },
};

const ended = {
  guard: (s: SAState, e: Event<any>): Check =>
    (s.name !== NONE && (s as Open).data.activities.some((a) => a.id === e.payload.activityId) ? ok() : reject('not_held')),
  to: (s: SAState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<SAState> => {
    const d = (s as Open).data;
    const rest = { ...d, activities: d.activities.filter((a) => a.id !== e.payload.activityId) };
    if (s.name === 'retiring') return retireStep(rest, f, ctx);
    return { next: { name: named(live(rest, f)), data: { ...rest, activities: live(rest, f) } } };
  },
};

// A Stop goes to the holder of the session's live stoppable activity (one
// with a stop handle where it runs): the push reaches every process, and
// only the holder acts on it (services/session-activity.js). Without one
// there is nothing here to tell; the route falls back on the journal's
// durable stop stamp, which recovery reads, as on [main].
const stopRequested = {
  guard: (s: SAState, e: Event<any>, f: Facts): Check =>
    (s.name !== NONE && turnFor(live((s as Open).data, f), e.payload.expectedTurnId) ? ok() : reject('no_turn')),
  to: (s: SAState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<SAState> => {
    const d = (s as Open).data;
    const turn = turnFor(live(d, f), e.payload.expectedTurnId)!;
    const stop: StopRequest = { at: turn.stop?.at || ctx.now.toISOString(), n: (turn.stop?.n ?? 0) + 1, by: e.payload.by, force: e.payload.force,
      immediate: e.payload.immediate, expectedTurnId: e.payload.expectedTurnId };
    const activities = live(d, f).map((a) => (a.id === turn.id ? { ...a, stop } : a));
    const push: Push = { kind: 'session_stop', routing: { holder: turn.holder }, data: { sessionId: d.sessionId, activityId: turn.id, stop: { ...stop } } };
    return { next: { name: s.name as Open['name'], data: { ...d, activities } }, push: [push] };
  },
};
function turnFor(activities: Activity[], expectedTurnId: string | null): Activity | undefined {
  const turns = activities.filter((a) => a.stoppable);
  return (expectedTurnId && turns.find((a) => a.turnId === expectedTurnId))
    || turns.filter((a) => a.kind === 'turn').pop() || turns[turns.length - 1];
}

const retireRequested = {
  to: (s: SAState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<SAState> => {
    const d = s.name === NONE ? empty(e.payload.sessionId) : (s as Open).data;
    return retireStep({ ...d, retire: { requestedAt: ctx.now.toISOString(), by: [e.payload.by], work: null } }, f, ctx);
  },
};

// The retirement ran (or gave up after its attempts): the session is free
// again. A failed attempt is retried by the kernel and changes nothing here.
const retireResult = (status: 'done' | 'failed' | 'exhausted') => ({
  guard: (s: SAState, e: Event<any>): Check => {
    const p = e.payload as WorkResultPayload;
    return p.kind === WORK.retire && s.name === 'retiring' && (s as Open).data.retire?.work === p.workKey ? ok() : reject('not_this_retirement');
  },
  to: (s: SAState, e: Event<any>, f: Facts): Outcome<SAState> => {
    const d = (s as Open).data;
    if (status === 'failed') return { next: { name: 'retiring', data: d } };
    const activities = live(d, f);
    return { next: { name: named(activities), data: { ...d, activities, retire: null } } };
  },
});

const empty = (sessionId: number): Data => ({ sessionId, activities: [], retire: null });

// ── The machine ─────────────────────────────────────────────────────────

export function sessionActivity(): Machine<SAState, Facts> {
  const system = (e: Event<any>): Check => (e.source.kind === 'system' ? ok() : reject('internal_only'));
  const route = (e: Event<any>): Check => (e.source.kind === 'route' || e.source.kind === 'system' ? ok() : reject('internal_only'));
  const keyed = (ctx: TransitionContext, e: Event<any>): Check => (ctx.key === sessionKey(e.payload.sessionId) ? ok() : reject('key_mismatch'));
  const withKey = <T extends { guard?: any; to: any }>(t: T) => ({
    guard: (s: SAState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const k = keyed(ctx, e);
      return k !== true ? k : (t.guard ? t.guard(s, e, f, ctx) : ok());
    },
    to: t.to,
  });
  const open = {
    Requested: withKey(requested),
    Ended: withKey(ended),
    StopRequested: withKey(stopRequested),
    WorkSucceeded: retireResult('done'),
    WorkFailed: retireResult('failed'),
    WorkExhausted: retireResult('exhausted'),
  };

  return defineMachine<SAState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Requested', 'RetireRequested'],
    terminal: [],
    decode: (row) => ({ name: row.state, data: row.data } as SAState),
    facts: (tx, state, event, ctx) => readFacts(tx, Number(ctx.key.slice('session:'.length))),
    authorize: {
      Requested: system,
      Ended: system,
      StopRequested: route,
      RetireRequested: system,
      Recheck: (e) => (e.source.kind === 'timer' ? ok() : reject('internal_only')),
    },
    transitions: {
      [NONE]: {
        Requested: withKey(requested),
        RetireRequested: withKey(retireRequested),
        Ended: { ignore: 'not_held' },
        StopRequested: { ignore: 'no_turn' },
        Recheck: { ignore: 'nothing_waits' },
      },
      idle: {
        ...open,
        RetireRequested: withKey(retireRequested),
        Recheck: { ignore: 'nothing_waits' },
      },
      in_use: {
        ...open,
        RetireRequested: withKey(retireRequested),
        Recheck: { ignore: 'nothing_waits' },
      },
      retiring: {
        ...open,
        RetireRequested: { ignore: 'already_retiring' },
        Recheck: { to: (s, e, f, ctx) => retireStep((s as Open).data, f, ctx) },
      },
    },
    // The activities' rows: what readers see, and what holders renew.
    async project(tx, before, after, ctx) {
      if (after.name === NONE) return;
      const prev = new Map((before.name === NONE ? [] : (before as Open).data.activities).map((a) => [a.id, a]));
      const next = (after as Open).data.activities;
      const gone = [...prev.keys()].filter((id) => !next.some((a) => a.id === id));
      const added = next.filter((a) => !prev.has(a.id));
      const stopped = next.filter((a) => prev.has(a.id) && a.stop && JSON.stringify(a.stop) !== JSON.stringify(prev.get(a.id)!.stop));
      if (!gone.length && !added.length && !stopped.length) return;
      await tx.query(
        `WITH gone AS (DELETE FROM wf_session_activities WHERE id = ANY($1::uuid[])),
              added AS (
                INSERT INTO wf_session_activities (id, session_id, kind, holder, label, turn_id, parent_id, granted_at, lease_until)
                SELECT a.id, $2, a.kind, a.holder, a.label, a."turnId", a.parent, $4::timestamptz,
                       $4::timestamptz + make_interval(secs => $5::float8 / 1000)
                  FROM jsonb_to_recordset($3::jsonb) AS a(id uuid, kind text, holder text, label text, "turnId" text, parent uuid))
         UPDATE wf_session_activities w SET stop_requested_at = (s.stop->>'at')::timestamptz, stop = s.stop
           FROM jsonb_to_recordset($6::jsonb) AS s(id uuid, stop jsonb)
          WHERE w.id = s.id`,
        [gone, (after as Open).data.sessionId, JSON.stringify(added), ctx.now.toISOString(), LEASE_MS,
          JSON.stringify(stopped.map((a) => ({ id: a.id, stop: a.stop })))]);
    },
    reply: async (tx, event, after): Promise<Json | undefined> => {
      if (event.type === 'Requested') return { granted: true, leaseMs: LEASE_MS, renewMs: RENEW_MS };
      if (event.type === 'StopRequested') {
        const turn = turnFor((after as Open).data.activities.filter((a) => a.stop), event.payload.expectedTurnId);
        return { holder: turn?.holder ?? null, activityId: turn?.id ?? null };
      }
      if (event.type === 'RetireRequested') return { deferred: after.name === 'retiring' && !(after as Open).data.retire?.work };
      return undefined;
    },
  });
}
