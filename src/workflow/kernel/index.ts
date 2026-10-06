// The workflow kernel's entry point. A process creates one runtime with the
// machines and services it knows. Every process can append and wait; the
// pipeline slots, timer loop and services run where `start` enables them
// (initially the leader). Correctness never depends on which process runs
// what: it comes from instance row locks and SKIP LOCKED claims.

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { processNext } from './pipeline.ts';
import { fireDueTimers, purge } from './timers.ts';
import { claim, execute } from './services.ts';
import { Signals, append, waitForOutcome } from './stream.ts';
import type { AppendOptions } from './stream.ts';
import { release } from './inspect.ts';
import type { Machine } from './machine.ts';
import type { EventOutcome, Logger, Pool, WorkHandler } from './types.ts';

export { NONE, WORK_EVENTS, WorkflowInputError, defineMachine, ok, reject, canonicalHash } from './machine.ts';
export type { Machine, WorkResultPayload } from './machine.ts';
export { LeaseLost } from './services.ts';
// Admin reads take a pool: problems, stateCounts, listInstances, instance.
export * as inspect from './inspect.ts';
export type * from './types.ts';

export interface RuntimeOptions {
  pool: Pool;
  machines: Machine<any, any>[];
  services?: Record<string, WorkHandler>;
  log?: Logger;
  slots?: number;              // concurrent pipeline slots in this process
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  stallAfter?: number;
  pollMs?: number;             // idle wake-up when no notification arrives
  serviceId?: string;
}

const quiet: Logger = { info() {}, warn() {}, error() {} };

export function createRuntime(opts: RuntimeOptions) {
  const log = opts.log || quiet;
  const machines = new Map<string, Machine<any, any>>();
  for (const m of opts.machines) {
    if (machines.has(m.name)) throw new Error(`workflow machine ${m.name} registered twice`);
    machines.set(m.name, m);
  }
  // Handlers are authored as an object and used as a Map, like machine tables.
  const handlers = new Map(Object.entries(opts.services || {}));
  const timeouts = { lockTimeoutMs: opts.lockTimeoutMs ?? 2000, statementTimeoutMs: opts.statementTimeoutMs ?? 5000 };
  const pipeline = { pool: opts.pool, machines, log, ...timeouts, stallAfter: opts.stallAfter ?? 5 };
  const service = { pool: opts.pool, handlers, log, serviceId: opts.serviceId || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}` };
  const signals = new Signals(opts.pool, log);
  const pollMs = opts.pollMs ?? 1000;
  const stopping = new AbortController();
  const loops: Promise<void>[] = [];
  const running = new Map<string, Set<Promise<void>>>();
  let started = false;

  const machineFor = (m: Machine<any, any> | string) =>
    typeof m === 'string' ? (machines.get(m) || m) : m;

  async function idle(channel: string) {
    if (!stopping.signal.aborted) await signals.sleep(channel, pollMs);
  }

  function loop(name: string, body: () => Promise<boolean>, channel: string) {
    loops.push((async () => {
      while (!stopping.signal.aborted) {
        let busy = false;
        try { busy = await body(); } catch (err) {
          log.error('workflow', `${name} loop failed`, { message: (err as Error).message });
        }
        if (!busy) await idle(channel);
      }
    })());
  }

  // Claim and start what this process has room for; returns the started runs.
  async function startServices(): Promise<Promise<void>[]> {
    const started: Promise<void>[] = [];
    for (const [kind, handler] of handlers) {
      const set = running.get(kind) || new Set();
      running.set(kind, set);
      const room = (handler.concurrency ?? 4) - set.size;
      if (room <= 0) continue;
      for (const w of await claim(service, kind, room)) {
        const run = execute(service, w, stopping.signal)
          .catch((err) => log.error('workflow', 'work execution failed', { kind, workId: w.id, message: err?.message }))
          .finally(() => set.delete(run));
        set.add(run);
        started.push(run);
      }
    }
    return started;
  }

  const runtime = {
    append(machine: Machine<any, any> | string, key: string, event: { type: string; payload?: unknown }, o: AppendOptions) {
      return append(o.db || opts.pool, machineFor(machine), key, event, o);
    },

    // Append, then wait up to waitMs for the outcome. 'pending' means answer
    // 202 with the request key; retrying that key replays the result.
    async appendAndWait(machine: Machine<any, any> | string, key: string, event: { type: string; payload?: unknown },
      o: AppendOptions & { waitMs?: number }): Promise<EventOutcome> {
      // Inside the caller's transaction the event is invisible until it
      // commits, so waiting there could only ever time out.
      if (o.db) throw new Error('appendAndWait cannot run inside a caller transaction; use append');
      const id = await append(opts.pool, machineFor(machine), key, event, o);
      return waitForOutcome(opts.pool, started ? signals : null, id, o.waitMs ?? 3000);
    },

    // Single steps, for tests and admin tooling.
    processNext: () => processNext(pipeline),
    async drain(max = 1000): Promise<number> {
      let n = 0;
      while (n < max && (await processNext(pipeline)) !== null) n++;
      return n;
    },
    fireTimers: () => fireDueTimers(opts.pool, timeouts),
    async runServices(): Promise<number> {
      const runs = await startServices();
      await Promise.all(runs);
      return runs.length;
    },
    purge: (o: { eventsDays?: number; receiptsDays?: number; workDays?: number } = {}) =>
      purge(opts.pool, { ...timeouts, ...o, machines }),

    release: (machine: string, key: string, o: { mode: 'retry' | 'skip'; actor: string }) =>
      release(opts.pool, machine, key, { ...o, ...timeouts }),

    // Every process starts signals (so appendAndWait wakes on outcomes);
    // with `loops`, it also runs pipeline slots, timers and services. That
    // is the leader for now; correctness does not depend on it.
    async start(o: { loops?: boolean } = {}) {
      if (started) return;
      started = true;
      await signals.start();
      if (!o.loops) return;
      for (let i = 0; i < (opts.slots ?? 8); i++) {
        loop(`pipeline slot ${i}`, async () => (await processNext(pipeline)) !== null, 'wf_events');
      }
      let lastPurge = 0;
      loop('timer', async () => {
        if (Date.now() - lastPurge > 3600000) {
          lastPurge = Date.now();
          await runtime.purge().catch((err) => log.warn('workflow', 'retention purge failed', { message: err.message }));
        }
        return (await fireDueTimers(opts.pool, timeouts)) > 0;
      }, 'wf_timer');
      if (handlers.size) loop('services', async () => (await startServices()).length > 0, 'wf_work');
    },

    async stop() {
      stopping.abort();
      await signals.stop();
      await Promise.all(loops);
      await Promise.all([...running.values()].flatMap((s) => [...s]));
    },
  };
  return runtime;
}

export type Runtime = ReturnType<typeof createRuntime>;
