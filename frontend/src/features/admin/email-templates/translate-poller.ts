'use strict';

// Follows a Translate job: reads its status, and reads again while it runs.
// A failed read while the job was last seen running is retried after a
// growing pause (2 s, 4 s, 8 s, … up to 30 s), so one dropped request does
// not leave the progress frozen; the last status stays on screen meanwhile.
// It stops when the job is done or stopped, and for good on `stop()`.
//
// Kept apart from React, with its timer and its request handed in, so a test
// can step it with fake timers and a stubbed request.

export interface PollAnswer<S> { ok: true; status: S }
export interface PollFailure<F> { ok: false; failure: F }

export interface PollerOptions<S extends { state: string }, F> {
  read: () => Promise<PollAnswer<S> | PollFailure<F>>;
  onStatus: (status: S) => void;
  onFailure: (failure: F) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  baseMs?: number;
  maxMs?: number;
}

export const POLL_BASE_MS = 2000;
export const POLL_MAX_MS = 30000;

/** The pause before the next read, after `failures` failed reads in a row. */
export function nextDelay(failures: number, baseMs = POLL_BASE_MS, maxMs = POLL_MAX_MS): number {
  if (failures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** (failures - 1), maxMs);
}

export function createPoller<S extends { state: string }, F>(options: PollerOptions<S, F>) {
  const { read, onStatus, onFailure, setTimer, clearTimer, baseMs = POLL_BASE_MS, maxMs = POLL_MAX_MS } = options;
  let timer: unknown = null;
  let stopped = false;
  let failures = 0;
  let lastState: string | null = null;
  // Each read carries a number; only the newest may act, so a read started
  // by `poll()` while another was in flight does not schedule twice.
  let seq = 0;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    cancel();
    timer = setTimer(() => { timer = null; poll(); }, ms);
  };

  async function poll(): Promise<void> {
    if (stopped) return;
    cancel();
    const mine = ++seq;
    const answer = await read();
    if (stopped || mine !== seq) return;
    if (answer.ok) {
      failures = 0;
      lastState = answer.status.state;
      onStatus(answer.status);
      if (lastState === 'running') schedule(nextDelay(0, baseMs, maxMs));
      return;
    }
    failures += 1;
    onFailure(answer.failure);
    // Only a job last seen running is worth asking about again.
    if (lastState === 'running') schedule(nextDelay(failures, baseMs, maxMs));
  }

  return {
    poll,
    /** A start answered with the job: follow it from that state. */
    seen(status: S) {
      if (stopped) return;
      lastState = status.state;
      failures = 0;
      if (lastState === 'running') schedule(nextDelay(0, baseMs, maxMs));
    },
    stop() {
      stopped = true;
      cancel();
    },
    get scheduled() { return timer !== null; },
  };
}
