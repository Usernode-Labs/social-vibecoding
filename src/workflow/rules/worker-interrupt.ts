// Ordinary Stop's conductor confirmation policy. Timers and attempt counts
// belong to the interrupt machine.
export const STOP_PROBE_INTERVAL_MS = 2000;
export const STOP_CONFIRM_TIMEOUT_MS = 30000;
export const STOP_MAX_KILL_ATTEMPTS = 3;

export function classifyStopProbe({ executing, attempts, elapsedMs }: {
  executing: boolean | null; attempts: number; elapsedMs: number;
}) {
  if (executing === false) return 'confirmed';
  if (!(elapsedMs < STOP_CONFIRM_TIMEOUT_MS) || !(attempts < STOP_MAX_KILL_ATTEMPTS)) return 'giveup';
  return 'retry';
}
