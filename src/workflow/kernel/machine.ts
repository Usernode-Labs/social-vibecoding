// defineMachine: validates a machine's transition table once, at load, so
// every (state x event) pair is either handled or explicitly ignored.

import { createHash } from 'node:crypto';
import type {
  Check, Event, Ignored, Json, MachineDefinition, Rejection, State, TableEntry, Transition,
} from './types.ts';

// The pseudo-state of an instance that does not exist yet. Its row in a
// transition table holds the creating events.
export const NONE = '(none)';

// Work results are kernel events: every machine receives them, and a state
// that does not list them refuses them as unexpected.
export const WORK_EVENTS = ['WorkSucceeded', 'WorkFailed', 'WorkExhausted'] as const;
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

export interface Machine<S extends State = State, F = unknown> extends MachineDefinition<S, F> {
  states: string[];
  decoders: Record<string, (payload: unknown) => unknown>;
  entryFor(state: string, type: string): TableEntry<S, F>;
  check(event: Event<any>, facts: F, state: S): Check;
}

const NAME = /^[a-z][a-z0-9-]*$/;

export function defineMachine<S extends State, F>(def: MachineDefinition<S, F>): Machine<S, F> {
  const fail = (msg: string): never => { throw new Error(`defineMachine(${def.name}): ${msg}`); };
  if (!NAME.test(def.name)) fail('name must be kebab-case');
  if (!Number.isInteger(def.version) || def.version < 1) fail('version must be a positive integer');
  const own = Object.keys(def.events);
  if (!own.length) fail('declares no events');
  for (const type of own) {
    if ((WORK_EVENTS as readonly string[]).includes(type)) fail(`${type} is a kernel event`);
    if (typeof def.authorize[type] !== 'function') fail(`no authorize rule for ${type}`);
  }
  const decoders: Record<string, (payload: unknown) => unknown> = { ...def.events };
  for (const type of WORK_EVENTS) decoders[type] = decodeWorkResult;
  const states = Object.keys(def.transitions).filter((s) => s !== NONE);
  if (!states.length) fail('declares no states');
  for (const t of def.terminal || []) if (!states.includes(t)) fail(`terminal state ${t} is not declared`);
  for (const c of def.create || []) if (!own.includes(c)) fail(`creating event ${c} is not declared`);

  for (const [state, row] of Object.entries(def.transitions)) {
    for (const [type, entry] of Object.entries(row)) {
      if (type !== '*' && !decoders[type]) fail(`${state}.${type} names an undeclared event`);
      if (!isIgnored(entry) && typeof (entry as Transition<S, F>).to !== 'function') {
        fail(`${state}.${type} has neither \`to\` nor \`ignore\``);
      }
    }
    if (state === NONE) {
      for (const type of Object.keys(row)) {
        if (type !== '*' && !(def.create || []).includes(type) && !isIgnored(row[type]!)) {
          fail(`${NONE}.${type} handles an event not listed in create`);
        }
      }
      continue;
    }
    // Completeness: every declared event is handled or ignored in every state.
    if (!row['*']) {
      for (const type of own) if (!row[type]) fail(`state ${state} neither handles nor ignores ${type}`);
    }
  }
  for (const c of def.create || []) {
    const entry = def.transitions[NONE]?.[c];
    if (!entry || isIgnored(entry)) fail(`creating event ${c} has no transition from ${NONE}`);
  }

  const machine: Machine<S, F> = {
    ...def,
    states,
    decoders,
    entryFor(state, type) {
      const row = def.transitions[state];
      if (state === NONE) return row?.[type] || row?.['*'] || { ignore: 'no_instance' };
      if (!row) throw new Error(`${def.name}: state ${state} is not declared`);
      const entry = row[type] || ((WORK_EVENTS as readonly string[]).includes(type) ? undefined : row['*']);
      return entry || { ignore: 'unexpected_work_result' };
    },
    check(event, facts, state) {
      if ((WORK_EVENTS as readonly string[]).includes(event.type)) {
        const p = event.payload as WorkResultPayload;
        return event.source.kind === 'service' && event.source.workId === p.workId
          ? true : reject('not_a_service_result');
      }
      return def.authorize[event.type]!(event, facts, state);
    },
  };
  return Object.freeze(machine);
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
