// Where a new project's time went (#4895): its setup's stopwatch snapshot
// and its first deploy's (services/app-creation-timing.js stopwatch, in the
// processes that ran them), as the one `app_creation_timed` record the
// Journey's creation path reads (services/journey.js creationPath). Pure.

import type { Json } from '../kernel/index.ts';

// The stages, in the order creation reaches them (app-creation-timing.js).
export const STAGES: readonly string[] = Object.freeze([
  'database', 'repository', 'card', 'checkout', 'lock', 'manifest', 'build', 'deploy', 'rollout',
]);
const OUTCOMES: ReadonlySet<string> = new Set(['running', 'awaiting_secrets', 'error']);
const RECORD_KEYS: ReadonlySet<string> = new Set(['outcome', 'totalMs', 'stages', 'failedIn']);
const ms = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));

/** One attempt's record from its two halves, the outcome and the whole time the machine saw; null when nothing was measured. */
export function combine({ setup = null, deploy = null, outcome = 'error', totalMs = 0 }:
  { setup?: any; deploy?: any; outcome?: string; totalMs?: number } = {}): Json {
  const parts = [setup, deploy].filter((p) => p && typeof p === 'object' && !Array.isArray(p));
  if (!parts.length) return null;
  const stages = new Map<string, number>();
  const notes: Record<string, Json> = {};
  let failedIn: Json = null;
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.stages || {})) if (STAGES.includes(k)) stages.set(k, (stages.get(k) || 0) + ms(v));
    for (const [k, v] of Object.entries(p)) if (!RECORD_KEYS.has(k)) notes[k] = v as Json;
    if (Array.isArray(p.failedIn) && p.failedIn.length) failedIn = p.failedIn;
  }
  const result = OUTCOMES.has(outcome) ? outcome : 'error';
  return {
    outcome: result,
    totalMs: ms(totalMs),
    stages: Object.fromEntries(STAGES.filter((s) => stages.has(s)).map((s) => [s, stages.get(s)!])),
    ...(result === 'error' && failedIn ? { failedIn } : {}),
    ...notes,
  };
}
