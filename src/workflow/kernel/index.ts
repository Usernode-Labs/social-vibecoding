// The workflow kernel's entry point. A process creates one runtime with the
// machines and services it knows. Every process can append and wait; the
// pipeline slots, timer loop and services run where `start` enables them
// (slots on every process, the rest on the leader). Correctness never
// depends on which process runs what: it comes from row locks and SKIP
// LOCKED claims.
// docs/workflows.md explains the model and how to write a machine.

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { processNext } from './pipeline.ts';
import { fireDueTimers, nextDeadlineMs, purge } from './timers.ts';
import { claim, execute, nextDueMs } from './services.ts';
import { Signals, append, waitForOutcome } from './stream.ts';
import type { AppendOptions } from './stream.ts';
import { release } from './inspect.ts';
import type { Machine } from './machine.ts';
import type { EventOutcome, Logger, Pool, Push, Queryable, WorkHandler } from './types.ts';

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
  // Idle wake-up when no notification arrives: a fallback while listening
  // (default 30 s), the polling interval when not (default and at most 1 s).
  pollMs?: number;
  serviceId?: string;
  // Publishes what browsers should hear, inside the transition's transaction.
  publish?: (q: Queryable, pushes: Push[]) => Promise<void>;
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
  const pipeline = { pool: opts.pool, machines, log, ...timeouts, stallAfter: opts.stallAfter ?? 5, publish: opts.publish };
  const service = { pool: opts.pool, handlers, log, serviceId: opts.serviceId || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    versions: new Map([...machines].map(([name, m]) => [name, m.version])) };
  const signals = new Signals(opts.pool, log);
  const stopping = new AbortController();
  const loops: Promise<void>[] = [];
  const running = new Map<string, Set<Promise<void>>>();
  let listening = false;
  let slotsRunning = false;
  let leaderLoops = false;

  const machineFor = (m: Machine<any, any> | string) =>
    typeof m === 'string' ? (machines.get(m) || m) : m;

  const idleMs = () => (signals.listening ? (opts.pollMs ?? 30000) : Math.min(opts.pollMs ?? 1000, 1000));

  // A loop works while its body finds work, then sleeps until a
  // notification on `channel`, the next thing it knows is due (`dueIn`), or
  // the idle fallback, whichever comes first. With `wakesFor`, only a
  // notification it takes wakes the loop (given the payload and the time
  // the loop sleeps until).
  function loop(name: string, body: () => Promise<boolean>, channel: string, dueIn: () => Promise<number | null>,
    wakesFor?: (payload: string, until: number) => boolean) {
    loops.push((async () => {
      while (!stopping.signal.aborted) {
        let busy = false;
        try { busy = await body(); } catch (err) {
          log.error('workflow', `${name} loop failed`, { message: (err as Error).message });
        }
        if (busy || stopping.signal.aborted) continue;
        let ms = idleMs();
        try {
          const due = await dueIn();
          if (due !== null) ms = Math.min(ms, Math.max(due, 250));
        } catch { /* the fallback still bounds the wait */ }
        const until = Date.now() + ms;
        if (!stopping.signal.aborted) await signals.sleep(channel, ms, wakesFor && ((payload) => wakesFor(payload, until)));
      }
    })());
  }

  // Kinds this process has room to run.
  const kindsWithRoom = () => [...handlers].filter(([kind, h]) => (running.get(kind)?.size ?? 0) < (h.concurrency ?? 4)).map(([k]) => k);

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
          .finally(() => { set.delete(run); signals.wake('wf_work'); });
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
      // Watch before appending: the first read is the one after the outcome.
      const watch = listening ? signals.watch() : null;
      let id: number;
      try {
        id = await append(opts.pool, machineFor(machine), key, event, o);
      } catch (err) {
        watch?.close();
        throw err;
      }
      return waitForOutcome(opts.pool, listening ? signals : null, id, o.waitMs ?? 3000, watch);
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

    // Every process starts signals (so appendAndWait wakes on outcomes).
    // With `slots`, it also runs pipeline slots: every process may, since
    // an instance's row lock decides who applies its events. With `loops`,
    // it runs the slots, timers and services: the leader for now. Callable
    // again later: a follower starts its loops when it is elected.
    async start(o: { loops?: boolean; slots?: boolean } = {}) {
      if (!listening) {
        listening = true;
        await signals.start();
      }
      if ((o.slots || o.loops) && !slotsRunning) {
        slotsRunning = true;
        for (let i = 0; i < (opts.slots ?? 8); i++) {
          const idle = { retryInMs: null as number | null };
          loop(`pipeline slot ${i}`, async () => (await processNext(pipeline, idle)) !== null, 'wf_events',
            async () => idle.retryInMs);
        }
      }
      if (!o.loops || leaderLoops) return;
      leaderLoops = true;
      let lastPurge = 0;
      loop('timer', async () => {
        if (Date.now() - lastPurge > 3600000) {
          lastPurge = Date.now();
          await runtime.purge().catch((err) => log.warn('workflow', 'retention purge failed', { message: err.message }));
        }
        return (await fireDueTimers(opts.pool, timeouts)) > 0;
      }, 'wf_timer', async () => Math.min(await nextDeadlineMs(opts.pool) ?? Infinity, 3600000 - (Date.now() - lastPurge)),
      // A transition announces each deadline it sets; only one earlier than
      // the loop's wake-up wakes it (every vote re-arms a later backstop).
      (payload, until) => Number(payload) < until);
      if (handlers.size) {
        loop('services', async () => (await startServices()).length > 0, 'wf_work', () => nextDueMs(opts.pool, kindsWithRoom()));
      }
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
