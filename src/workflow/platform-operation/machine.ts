// Privileged operations a web process asks a conductor to run
// (docs/plans/web-and-conductor.md, "Privileged operations"). One machine for
// every typed operation, so a code-host or provider write never needs its
// own: the route keeps the checks and refusals it always had and appends the
// request; the conductor's work rechecks the requester's current authority
// and target before any outside write and keeps each write as a step, so a
// retry or a restart finishes the same request instead of repeating it.
import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Json, Outcome } from '../kernel/index.ts';

export const MACHINE = 'platform-operation';
export const WORK = 'operation.run';
// The operations services/platform-operations.js runs, by name.
export const OPERATIONS: ReadonlySet<string> = new Set([
  'manifest.propose', 'branch.ensure', 'revert.open', 'domain.check', 'domain.teardown', 'app.remove',
  'openrouter.provision', 'openrouter.sync', 'openrouter.disable', 'openrouter.remove',
  'previewProject.create', 'previewProject.build', 'previewProject.deploy', 'previewProject.restart', 'previewProject.remove',
  // commits
  'proposal.commit',
  // git-host flows: a version's suggestion to its original, its updates
  // down, the App bench studio's reference builds, demo mode's proposals
  'suggestBack.open', 'upstream.open', 'upstream.skip', 'bench.scaffold', 'bench.reference', 'demo.propose', 'demo.reset',
  // PR metadata
  'pr.sync',
  // fork flows
  'fork.update', 'work.share', 'work.submit', 'work.discard',
]);
// What an operation's input may weigh: what a route captured, never a file.
export const MAX_INPUT_BYTES = 64 * 1024;
// One instance per request; an operation that must not run twice at once on
// the same target (an Undo of one change) has one instance per target, so a
// second request while one is under way is the same request, and a new one
// starts once it has finished. Such an operation is only appended, never
// waited for by key (platform.ts appendOperation).
const SINGLE_FLIGHT: ReadonlyMap<string, (input: any) => string> = new Map([
  ['revert.open', (input: any) => `session:${input.sessionId}`],
]);
export const operationKey = (p: { op: string; requestId: string; input: any }) => {
  const target = SINGLE_FLIGHT.get(p.op);
  return target ? `op:${p.op}:${target(p.input)}` : `op:${p.requestId}`;
};
export const singleFlight = (op: string) => SINGLE_FLIGHT.has(op);
// Each operation is its own work kind, so a conductor claims only the ones
// its build knows: during a rollout an older conductor leaves a newer one's
// operation for a newer conductor instead of failing it.
export const workKind = (op: string) => `operation.${op}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Request { op: string; requestId: string; appId: number | null; userId: number; input: Json }
interface Facts { refusal: string | null }
type State = { name: typeof NONE | 'queued'; data: null } | { name: 'done' | 'failed'; data: Json };
const ended = (name: 'done' | 'failed', data: Json): Outcome<State> => ({ next: { name, data } });
const id = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 2147483647;

// An operation's name: `area.verb`. One this build does not know is still a
// request: its work is a kind of its own (workKind), which only a conductor
// that knows it claims, so during a rollout an older conductor leaves a newer
// operation queued instead of refusing it.
const OP_NAME = /^[a-z][A-Za-z]{0,31}\.[a-z][A-Za-z]{0,31}$/;

export function requested(p: any): Request {
  if (typeof p?.op !== 'string' || !OP_NAME.test(p.op)) throw new Error('An operation must name its kind');
  if (typeof p.requestId !== 'string' || !UUID.test(p.requestId)) throw new Error('An operation must name its request');
  if (!id(p.userId) || (p.appId !== null && !id(p.appId))) throw new Error('An operation must name its requester and project');
  if (!p.input || typeof p.input !== 'object' || Array.isArray(p.input)
      || JSON.stringify(p.input).length > MAX_INPUT_BYTES) throw new Error('An operation must carry its input');
  if (p.op === 'revert.open' && !id(p.input.sessionId)) throw new Error('An Undo must name its change');
  if (p.op.startsWith('previewProject.') && (!id(p.input.sessionId) || !Number.isSafeInteger(p.input.projectId) || p.input.projectId < 1)) {
    throw new Error('A preview project\'s operation must name its preview and project');
  }
  // commits: a local agent's commit (services/proposal-commit-operation.js),
  // a hand-off's upload or a build turn's, which names its turn and lease.
  // The head it builds on may be none (the branch then says it moved).
  if (p.op === 'proposal.commit') {
    const i = p.input;
    const sha = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
    const rowId = (v: unknown) => /^[1-9][0-9]{0,18}$/.test(String(v ?? ''));
    if (!id(i.sessionId) || !['handoff', 'turn'].includes(i.surface) || typeof i.branch !== 'string' || !i.branch
        || ![i.localCommitSha, i.parentSha, i.parentTreeSha, i.treeSha].every(sha)
        || !(i.expectedParent === null || sha(i.expectedParent))
        || (i.surface === 'turn' && !(rowId(i.turnId) && rowId(i.leaseId)))) {
      throw new Error('A commit must name its change, its surface and its commits');
    }
  }
  // git-host flows: each names the project it writes for, or (the bench's)
  // the studio run, brief and pack; a demo reset the proposals it removes.
  if (['suggestBack.open', 'upstream.open', 'upstream.skip', 'demo.propose', 'demo.reset'].includes(p.op) && !id(p.appId)) {
    throw new Error('A project\'s operation must name its project');
  }
  if (p.op.startsWith('bench.') && (!id(p.input.runId) || !id(p.input.taskId)
      || !Number.isSafeInteger(p.input.packId) || p.input.packId < 0)) {
    throw new Error('A bench operation must name its run, brief and pack');
  }
  if (p.op === 'demo.reset' && (!Array.isArray(p.input.sessionIds) || !p.input.sessionIds.every(id))) {
    throw new Error('A demo reset must name the proposals it removes');
  }
  // PR metadata: what a `pr.sync` writes (services/pr-sync-operation.js WRITES).
  if (p.op === 'pr.sync' && (!id(p.input.sessionId) || !['summary', 'issues', 'title', 'create'].includes(p.input.write))) {
    throw new Error('A pull request\'s write must name its change and what it writes');
  }
  // fork flows (services/fork-operations.js): each is on a project, and names
  // the proposal or the task it is for; a discard names the branch it removes.
  if (['fork.update', 'work.share', 'work.submit', 'work.discard'].includes(p.op) && p.appId === null) {
    throw new Error('A fork flow must name its project');
  }
  if (p.op === 'fork.update' && !id(p.input.sessionId)) throw new Error('An update must name its proposal');
  if ((p.op === 'work.submit' || p.op === 'work.discard') && !id(p.input.taskId)) throw new Error('A submission must name its task');
  if (p.op === 'work.submit' && p.input.mode !== 'patch' && p.input.mode !== 'branch') throw new Error('A submission must say what it carries');
  if (p.op === 'work.discard' && (typeof p.input.branch !== 'string' || !p.input.branch)) throw new Error('A discard must name its branch');
  return { op: p.op, requestId: p.requestId, appId: p.appId, userId: p.userId, input: p.input };
}

export function platformOperation() {
  const failed = { to: (_s: State, e: any) => ended('failed', { error: e.payload?.error ?? null }) };
  // The work item is the request's own, so a target's next request is a new one.
  const start = { to: (_s: State, e: any) => ({ next: { name: 'queued' as const, data: null },
    work: [{ kind: workKind(e.payload.op), key: `run:${e.payload.requestId}`, input: e.payload as unknown as Json }] }) };
  return defineMachine<State, Facts>({
    name: MACHINE, version: 1, retainDays: 2,
    events: { Requested: requested }, create: ['Requested'], terminal: ['done', 'failed'],
    decode: row => ({ name: row.state, data: row.data }) as State,
    // Admission only proves the request is this instance's and its requester
    // and project still exist. Each operation's own authority is read again
    // by its work, immediately before the first outside write.
    async facts(tx, _state, e, ctx) {
      if (e.type !== 'Requested') return { refusal: null };
      const p = e.payload;
      if (ctx.key !== operationKey(p) || ctx.appId !== p.appId) return { refusal: 'scope_mismatch' };
      const { rows: [u] } = await tx.query('SELECT anonymised_at FROM users WHERE id = $1 FOR SHARE', [p.userId]);
      if (!u || u.anonymised_at) return { refusal: 'not_authorized' };
      if (p.appId !== null) {
        const { rows: [a] } = await tx.query('SELECT 1 FROM apps WHERE id = $1 FOR SHARE', [p.appId]);
        if (!a) return { refusal: 'not_found' };
      }
      return { refusal: null };
    },
    authorize: { Requested: (e, f) =>
      (e.source.kind !== 'route' || e.source.name !== WORK || e.actor !== `user:${e.payload.userId}`)
        ? reject('not_a_producer') : f.refusal ? reject(f.refusal) : ok() },
    transitions: {
      [NONE]: { Requested: start },
      queued: {
        Requested: { ignore: 'already_requested' },
        WorkSucceeded: { to: (_s, e) => ended('done', e.payload.result ?? null) },
        WorkFailed: failed, WorkExhausted: failed,
      },
      done: { Requested: start, '*': { ignore: 'done' } }, failed: { Requested: start, '*': { ignore: 'failed' } },
    },
  });
}
