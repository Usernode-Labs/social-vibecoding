// A work item's steps: what a long handler (a Homeroom bot build, a sync
// with main, a shots agent's turn) keeps as it goes, so that the same code,
// run again after a restart, carries on from the last step it finished
// instead of starting over or being finished by recovery code of its own.
// The work item's checkpoint is where it is kept: there is no other store,
// and nothing outlives the attempt but what the checkpoint saved
// (docs/workflows.md, "Work items and services"). A handler gets it as
// `ctx.steps()`; code not run by the kernel (tests, a person's own dev chat)
// gets the inert context of services/durable-steps.js, where every step
// simply runs.
//
// Everything a step keeps is JSON in that one object, keyed by step:
//
//   once(key, fn)   a step that has run returns what it saved, and is not run
//                   again; one that has not runs, and what it resolves is saved
//   get / set       state a step keeps as it goes (a review's loop state)
//   scope(prefix)   a child context whose keys are its own (a second try)
//   fence()         throws once the work is no longer this process's
//   race(promise)   the promise, or the stop, whichever comes first
//   listen / tell   what the pipeline's own watchers are told as it goes (a
//                   turn starting, or a turn a restart caught being
//                   followed: a bench trial's watch recounts its looks)
//   triesLeft       how many more tries the kernel gives the work if this
//                   one throws (0 on its last): a step refused for now
//                   throws only while one is left
//
// The stop is sticky: once the signal has aborted, every later step throws
// it again, so a stop that one `catch` swallows on the way out (much of the
// pipeline fails open on purpose) is thrown by the next step instead of
// letting a process that lost the work archive its session or post its
// failure. A step whose work was under way when a process began stopping is
// still saved (the kernel takes a checkpoint for as long as the process
// holds the lease), and the stop is thrown once it is: what it did is not
// done again by the next process. Only a lost lease refuses the save.

import type { Json, Logger } from './types.ts';

// A checkpoint write that failed for another reason than a lost lease (the
// database blinked) is tried again this many times, this far apart.
const SAVE_RETRY_MS: readonly number[] = Object.freeze([500, 2000, 5000]);

const leaseLost = (err: any) => !!err && (err.constructor?.name === 'LeaseLost' || err.message === 'work lease lost');

/** The error a fenced step throws. `stopped` tells it from a step's own failure. */
export class StepsStopped extends Error {
  code = 'steps_stopped';
  stopped = true;
  constructor(why = 'the work is no longer this process\'s to run') { super(why); }
}

export function isStopped(err: any): boolean {
  return !!(err && (err.stopped === true || err.code === 'steps_stopped'));
}

// What a step's value is kept as: JSON data, nothing else. A Date becomes its
// ISO string, undefined is left out (null in an array), a function is dropped.
export function plain(value: unknown): any {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

export interface StepsOptions {
  resumeFrom?: Json | null;
  checkpoint: (value: Json) => Promise<void>;
  signal?: AbortSignal | null;
  attempt?: number;
  lostAttempts?: number;
  // What these steps belong to ('bot-build/run:12'), for the logs and for
  // a row a step marks so recovery elsewhere leaves it alone.
  owner?: string | null;
  triesLeft?: number;
  log?: Logger | null;
}

export interface Steps {
  readonly active: boolean;
  readonly resumed: boolean;
  readonly attempt: number;
  readonly lostAttempts: number;
  readonly triesLeft: number;
  readonly owner: string | null;
  readonly signal: AbortSignal | null;
  readonly stopped: boolean;
  has(key: string): boolean;
  get(key: string): any;
  path(key: string): string;
  set(key: string, value: unknown): Promise<void>;
  merge(key: string, patch: Record<string, unknown> | null | undefined): Promise<void>;
  once<T>(key: string, fn: () => Promise<T> | T): Promise<any>;
  fence(): void;
  race<T>(promise: Promise<T> | T): Promise<T>;
  scope(child: string): Steps;
  flush(): Promise<void>;
  listen(fn: (event: any) => unknown): void;
  tell(event?: Record<string, unknown>): Promise<void>;
}

export function steps({
  resumeFrom = null, checkpoint, signal = null, attempt = 1, lostAttempts = 0, owner = null, triesLeft = 0, log = null,
}: StepsOptions): Steps {
  if (typeof checkpoint !== 'function') throw new Error('steps: a checkpoint function is required');
  const state: Record<string, any> = resumeFrom && typeof resumeFrom === 'object' && !Array.isArray(resumeFrom) ? { ...resumeFrom } : {};
  let stopped = !!signal?.aborted;
  let writes: Promise<unknown> = Promise.resolve();
  const listeners: ((event: any) => unknown)[] = [];
  signal?.addEventListener('abort', () => { stopped = true; }, { once: true });

  const fence = () => {
    if (stopped || signal?.aborted) {
      stopped = true;
      throw new StepsStopped();
    }
  };
  const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const write1 = async (snapshot: Json) => {
    for (let i = 0; ; i += 1) {
      try {
        return await checkpoint(snapshot);
      } catch (err) {
        if (leaseLost(err) || isStopped(err) || i >= SAVE_RETRY_MS.length) throw err;
        log?.warn('durable', 'Could not save a step; trying again', { owner, err: (err as Error).message });
        await wait(SAVE_RETRY_MS[i]!);
      }
    }
  };
  // One write at a time, each with everything kept so far: a later write
  // never lands under an earlier one.
  const save = () => {
    const snapshot = plain(state);
    const write = writes.then(() => write1(snapshot));
    writes = write.catch(() => {});
    return write.catch((err) => {
      // The kernel's checkpoint throws only when the claim is gone.
      stopped = true;
      throw isStopped(err) ? err : Object.assign(new StepsStopped(`could not save the step: ${err.message}`), { cause: err });
    });
  };

  const make = (prefix: string): Steps => {
    const k = (key: string) => (prefix ? `${prefix}/${key}` : String(key));
    const has = (key: string) => Object.prototype.hasOwnProperty.call(state, k(key));
    const ctx: Steps = {
      active: true,
      resumed: !!resumeFrom,
      attempt,
      lostAttempts,
      triesLeft: Math.max(0, Math.floor(Number(triesLeft) || 0)),
      owner,
      signal,
      get stopped() { return stopped || !!signal?.aborted; },
      has,
      // A copy: a caller that changes what it was handed (a build's result
      // it adds a cost to) changes nothing kept, and the next save cannot
      // carry the change in.
      get(key) { return has(key) ? plain(state[k(key)]) : undefined; },
      // The key as it is kept, scope included: what a row a step writes
      // carries so the step finds it again (a session it opened).
      path(key) { return k(key); },
      // Saved even once the process is stopping, while it holds the lease:
      // state a step keeps as it goes is what the next process reads.
      async set(key, value) {
        if (value === undefined) delete state[k(key)];
        else state[k(key)] = plain(value);
        await save();
      },
      async merge(key, patch) {
        const prior = ctx.get(key);
        await ctx.set(key, { ...(prior && typeof prior === 'object' ? prior : {}), ...(patch || {}) });
      },
      async once(key, fn) {
        fence();
        if (has(key)) return ctx.get(key);
        const value = await fn();
        // Its work is done: kept, even if the process began stopping
        // meanwhile, and then the stop is thrown.
        await ctx.set(key, value === undefined ? null : value);
        fence();
        return ctx.get(key);
      },
      fence,
      race(promise) {
        if (!signal) return Promise.resolve(promise);
        return new Promise((resolve, reject) => {
          // Checked first: a listener added to a signal that has already
          // aborted is never called.
          if (stopped || signal.aborted) { stopped = true; reject(new StepsStopped()); return; }
          const onAbort = () => { stopped = true; reject(new StepsStopped()); };
          signal.addEventListener('abort', onAbort, { once: true });
          Promise.resolve(promise).then(
            (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
          );
        });
      },
      scope(child) { return make(k(child)); },
      // Every write made so far is saved (the handler's last act).
      async flush() { await writes; },
      listen(fn) { if (typeof fn === 'function') listeners.push(fn); },
      // A watcher that throws is logged; a stop it causes is the next step's.
      async tell(event = {}) {
        const told = { ...event, key: event.key != null ? k(String(event.key)) : null };
        for (const fn of listeners) {
          try { await fn(told); } catch (err) {
            log?.warn('durable', 'A watcher of the steps failed', { kind: (told as any).kind, key: told.key, err: (err as Error).message });
          }
        }
      },
    };
    return ctx;
  };
  return make('');
}
