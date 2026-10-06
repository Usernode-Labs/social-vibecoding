// defineMachine: validates a machine's transition table once, at load, so
// every (state x event) pair is either handled or explicitly ignored.

import { createHash } from 'node:crypto';
import type {
  Authorize, Check, Decoder, Event, Ignored, Json, MachineDefinition, Notifier, Rejection, State,
  TableEntry, Transition, WriteHandler,
} from './types.ts';

// The pseudo-state of an instance that does not exist yet. Its row in a
// transition table holds the creating events.
export const NONE = '(none)';

// Work results are kernel events: every machine receives them, and a state
// that does not list them refuses them as unexpected.
export const WORK_EVENTS: ReadonlySet<string> = new Set(['WorkSucceeded', 'WorkFailed', 'WorkExhausted']);
export interface WorkResultPayload {
  workId: string;
  kind: string;
  workKey: string;
  attempt: number;
  result?: Json;
  error?: { message: string; code?: string | null };
}

export function ok(): true { return true; }
export function reject(reason: string): Rejection { return { reject: reason }; }
export function isRejection(check: Check): check is Rejection {
  return check !== true;
}
export function isIgnored<S extends State, F>(entry: TableEntry<S, F>): entry is Ignored {
  return typeof (entry as Ignored).ignore === 'string';
}

export class WorkflowInputError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function decodeWorkResult(payload: unknown): WorkResultPayload {
  const p = payload as Partial<WorkResultPayload> | null;
  if (!p || typeof p.workId !== 'string' || typeof p.kind !== 'string'
      || typeof p.workKey !== 'string' || !Number.isInteger(p.attempt)) {
    throw new WorkflowInputError('invalid_payload', 'work result payload is malformed');
  }
  return p as WorkResultPayload;
}

// A defined machine: every table is a Map or Set, built once from the
// authoring objects. `events` includes the kernel's work-result events.
export interface Machine<S extends State = State, F = unknown> {
  readonly name: string;
  readonly version: number;
  readonly states: ReadonlySet<string>;
  readonly create: ReadonlySet<string>;
  readonly terminal: ReadonlySet<string>;
  readonly events: ReadonlyMap<string, Decoder>;
  readonly authorize: ReadonlyMap<string, Authorize<S, F>>;
  readonly transitions: ReadonlyMap<string, ReadonlyMap<string, TableEntry<S, F>>>;
  readonly writes: ReadonlyMap<string, WriteHandler>;
  readonly notifiers: ReadonlyMap<string, Notifier>;
  readonly decode: MachineDefinition<S, F>['decode'];
  readonly facts?: MachineDefinition<S, F>['facts'];
  readonly project?: MachineDefinition<S, F>['project'];
  entryFor(state: string, type: string): TableEntry<S, F>;
  check(event: Event<any>, facts: F, state: S): Check;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const toMap = <V>(record: Record<string, V> | undefined) => new Map<string, V>(Object.entries(record || {}));

export function defineMachine<S extends State, F>(def: MachineDefinition<S, F>): Machine<S, F> {
  const fail = (msg: string): never => { throw new Error(`defineMachine(${def.name}): ${msg}`); };
  if (!NAME.test(def.name)) fail('name must be kebab-case');
  if (!Number.isInteger(def.version) || def.version < 1) fail('version must be a positive integer');

  // The boundary: authoring objects become Maps and Sets here, once.
  const own = toMap(def.events);
  const authorize = toMap(def.authorize);
  const transitions = new Map(Object.entries(def.transitions).map(([state, row]) => [state, toMap(row)]));
  const create = new Set(def.create || []);
  const terminal = new Set(def.terminal || []);
  const states = new Set([...transitions.keys()].filter((s) => s !== NONE));

  if (!own.size) fail('declares no events');
  for (const type of own.keys()) {
    if (WORK_EVENTS.has(type)) fail(`${type} is a kernel event`);
    if (typeof authorize.get(type) !== 'function') fail(`no authorize rule for ${type}`);
  }
  const events = new Map(own);
  for (const type of WORK_EVENTS) events.set(type, decodeWorkResult);
  if (!states.size) fail('declares no states');
  for (const t of terminal) if (!states.has(t)) fail(`terminal state ${t} is not declared`);
  for (const c of create) if (!own.has(c)) fail(`creating event ${c} is not declared`);

  for (const [state, row] of transitions) {
    for (const [type, entry] of row) {
      if (type !== '*' && !events.has(type)) fail(`${state}.${type} names an undeclared event`);
      if (!isIgnored(entry) && typeof (entry as Transition<S, F>).to !== 'function') {
        fail(`${state}.${type} has neither \`to\` nor \`ignore\``);
      }
      if (state === NONE && type !== '*' && !create.has(type) && !isIgnored(entry)) {
        fail(`${NONE}.${type} handles an event not listed in create`);
      }
    }
    // Completeness: every declared event is handled or ignored in every state.
    if (state !== NONE && !row.has('*')) {
      for (const type of own.keys()) if (!row.has(type)) fail(`state ${state} neither handles nor ignores ${type}`);
    }
  }
  for (const c of create) {
    const entry = transitions.get(NONE)?.get(c);
    if (!entry || isIgnored(entry)) fail(`creating event ${c} has no transition from ${NONE}`);
  }

  return Object.freeze({
    name: def.name,
    version: def.version,
    states, create, terminal, events, authorize, transitions,
    writes: toMap(def.writes),
    notifiers: toMap(def.notifiers),
    decode: def.decode,
    facts: def.facts,
    project: def.project,
    entryFor(state: string, type: string): TableEntry<S, F> {
      const row = transitions.get(state);
      if (state === NONE) return row?.get(type) || row?.get('*') || { ignore: 'no_instance' };
      if (!row) throw new Error(`${def.name}: state ${state} is not declared`);
      if (WORK_EVENTS.has(type)) return row.get(type) || { ignore: 'unexpected_work_result' };
      if (!events.has(type)) return { ignore: 'unknown_event' };
      return row.get(type) || row.get('*')!;
    },
    check(event: Event<any>, facts: F, state: S): Check {
      if (WORK_EVENTS.has(event.type)) {
        const p = event.payload as WorkResultPayload;
        return event.source.kind === 'service' && event.source.workId === p.workId
          ? true : reject('not_a_service_result');
      }
      const rule = authorize.get(event.type);
      return rule ? rule(event, facts, state) : reject('unknown_event');
    },
  });
}

// Data-only values: plain objects, arrays, strings, finite numbers,
// booleans and null. Everything stored or hashed passes through this.
export function assertJson(value: unknown, path = '$'): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkflowInputError('invalid_payload', `${path} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertJson(v, `${path}[${i}]`)); return; }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value as object)) {
      if (v === undefined) continue;
      assertJson(v, `${path}.${k}`);
    }
    return;
  }
  throw new WorkflowInputError('invalid_payload', `${path} is not JSON data`);
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k] as Json)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHash(value: Json): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
