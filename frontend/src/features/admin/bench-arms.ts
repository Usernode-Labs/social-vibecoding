// An arm of a core benchmark run, as services/bench/arms.js writes it: an
// OpenRouter model id, or one at a reasoning effort of its own
// (`vendor/model@max`), whose every turn runs at that effort. The launcher
// makes them from the models and the efforts ticked; the Configurations'
// "Compare on the benchmark" from the stages two versions differ at, in a
// model or in an effort.

// bot-configs.js EFFORTS; none is the bot's own.
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];

function isEffort(x: string): x is Effort {
  return (EFFORTS as readonly string[]).includes(x);
}

/** An arm's model and its effort (null for none). Pure. */
export function parseArm(arm: string): { model: string; effort: Effort | null } {
  const s = String(arm ?? '').trim();
  const at = s.lastIndexOf('@');
  if (at > 0) {
    const effort = s.slice(at + 1).trim().toLowerCase();
    if (isEffort(effort)) return { model: s.slice(0, at).trim(), effort };
  }
  return { model: s, effort: null };
}

/** The arm of `model` at `effort`, or the model alone for none. Pure. */
export function armOf(model: string, effort?: string | null): string {
  return effort && isEffort(effort) ? `${model}@${effort}` : model;
}

/** Every model at every effort ('' is none: the bot's own), a model's arms together. Pure. */
export function armsOf(models: string[], efforts: string[]): string[] {
  const at = efforts.length ? efforts : [''];
  return [...new Set(models.flatMap((m) => at.map((e) => armOf(m, e))))];
}

/**
 * The models and the efforts ('' for none) that a list of arms is every
 * combination of, as the launcher ticks them; null when it is not one (two
 * models at different efforts), which the launcher takes as typed. Pure.
 */
export function armsGrid(arms: string[]): { models: string[]; efforts: string[] } | null {
  const parsed = arms.map(parseArm);
  const models = [...new Set(parsed.map((p) => p.model))];
  const efforts = [...new Set(parsed.map((p) => p.effort || ''))];
  const all = new Set(arms.map((a) => { const p = parseArm(a); return armOf(p.model, p.effort); }));
  return all.size === models.length * efforts.length && armsOf(models, efforts).every((a) => all.has(a))
    ? { models, efforts }
    : null;
}
