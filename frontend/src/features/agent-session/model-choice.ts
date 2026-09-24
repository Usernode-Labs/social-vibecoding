// The agent-session composer's model picker (#2779): which coding agent the
// conversation runs on, and on which model. One choice per conversation,
// changeable at any time: the Mayor answers with it from its next turn, a
// change the conversation starts is created with it, and the active change
// takes it at its next build. A turn or a build already running finishes on
// the model it started with — the server reads the choice when each starts.
//
// Pure: the picker component and the store call these, and
// tests/agent-session-ui.test.js pins them without a browser.
//
// The option values are the dev chat picker's own (`anthropic:<id>`,
// `openrouter:<id>`), and the list is built in its order (dev-chat.js
// `_flatModelOptions`): the platform's recommended OpenRouter models, the
// Anthropic models, then anything else this account already uses. What it
// leaves out is the full catalog dialog; a model starred there shows up here
// as a favourite.
//
// Each model carries what a typical change costs on it, the dev chat's own
// figure (#2570, dev-chat.js `_modelCostNote`): the platform's estimate for a
// model it curates, otherwise the viewer's catalog prices times the server's
// token profile of a typical change. Never a bare amount: always "about $X
// for a typical change", because a naked "$1.55" reads as per message, per
// hour or per month just as easily.

import type { AgentChoice, ModelCatalog, OpenRouterModel } from './api';

export const ANTHROPIC_PREFIX = 'anthropic:';
export const OPENROUTER_PREFIX = 'openrouter:';

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

const OPENROUTER_TITLE = 'Runs on your OpenRouter key';
const ANTHROPIC_TITLE = 'Runs on the platform Claude allowance, or your own Anthropic key';

export interface PickerOption {
  value: string;
  label: string;
  title?: string;
  /**
   * What a conversation with no choice of its own runs on. The open list says
   * "(default)" after it; the closed control shows just the label.
   */
  isDefault?: boolean;
  /**
   * The model's note and cost, "general coding work · about $1.55 for a
   * typical change", shown after its name in the open list.
   */
  detail?: string;
  /** The cost alone, "about $1.55 for a typical change", beside the closed control. */
  cost?: string;
}

/** A model's note and the estimate of a typical change on it. */
export interface ModelCost {
  note: string;
  /** "about $1.55 for a typical change", or '' with no estimate. */
  perChange: string;
  /** The note and the cost together, for the open list. */
  compact: string;
}

/**
 * What a typical change costs on a model: the platform's estimate for one it
 * curates, else the catalog's per-token prices times the typical change's
 * token profile. Under a cent reads "<$0.01", never "$0.00": a model that
 * costs something must not look free.
 */
export function modelCost(id: string | null | undefined, catalog: ModelCatalog | null, model: OpenRouterModel | null = null): ModelCost {
  const notes = catalog?.notes || null;
  const entry = id && notes ? notes.models[id] || null : null;
  const note = entry && typeof entry.note === 'string' ? entry.note : '';
  let cents = entry && entry.estimateCents != null && Number.isFinite(Number(entry.estimateCents)) ? Number(entry.estimateCents) : null;
  if (cents == null && notes?.typicalChange && model) {
    const input = Number(model.inputPricePerMillion);
    const output = Number(model.outputPricePerMillion);
    if (model.inputPricePerMillion != null && model.outputPricePerMillion != null && Number.isFinite(input) && Number.isFinite(output)) {
      const dollars = (notes.typicalChange.inputTokens / 1_000_000) * input
        + (notes.typicalChange.outputTokens / 1_000_000) * output;
      cents = Math.round(dollars * 100 * 100) / 100;
    }
  }
  const money = cents == null ? '' : (cents > 0 && cents < 1 ? '<$0.01' : `$${(cents / 100).toFixed(2)}`);
  const perChange = money ? `about ${money} for a typical change` : '';
  return { note, perChange, compact: [note, perChange].filter(Boolean).join(' · ') };
}

function withCost(option: PickerOption, cost: ModelCost): PickerOption {
  return {
    ...option,
    ...(cost.compact ? { detail: cost.compact } : {}),
    ...(cost.perChange ? { cost: cost.perChange } : {}),
  };
}

export function choiceValue(choice: AgentChoice | null | undefined): string {
  if (!choice) return '';
  return choice.backend === 'codex_openrouter'
    ? `${OPENROUTER_PREFIX}${choice.model || ''}`
    : `${ANTHROPIC_PREFIX}${choice.model || ''}`;
}

function openRouterModel(catalog: ModelCatalog | null, id: string | null): OpenRouterModel | null {
  if (!catalog || !id) return null;
  return catalog.openrouter.find((model) => model.id === id) || null;
}

function recommendedOpenRouterId(catalog: ModelCatalog): string | null {
  const ids = new Set(catalog.openrouter.map((model) => model.id));
  if (catalog.recommendedOpenRouterId && ids.has(catalog.recommendedOpenRouterId)) return catalog.recommendedOpenRouterId;
  return catalog.openrouter.find((model) => model.isRecommended)?.id || catalog.openrouter[0]?.id || null;
}

/**
 * The choice a conversation is on: its own when it has one, otherwise the
 * user's saved default, as the server resolves a conversation with none.
 * Null until the catalog has loaded and the conversation has no choice.
 */
export function effectiveChoice(explicit: AgentChoice | null | undefined, catalog: ModelCatalog | null): AgentChoice | null {
  if (explicit) {
    if (explicit.backend === 'claude_code' && !explicit.model && catalog?.anthropicDefault) {
      return { ...explicit, model: catalog.anthropicDefault };
    }
    return explicit;
  }
  if (!catalog) return null;
  if (catalog.defaultBackend === 'codex_openrouter' && catalog.codexAvailable) {
    const saved = catalog.savedOpenRouter;
    const model = (saved && saved.model) || recommendedOpenRouterId(catalog);
    if (model) {
      return { backend: 'codex_openrouter', model, reasoningEffort: (saved && saved.reasoningEffort) || null };
    }
  }
  return { backend: 'claude_code', model: catalog.anthropicDefault || catalog.anthropic[0]?.id || null, reasoningEffort: null };
}

/** The flat list the picker shows, always including what `selected` is on. */
export function pickerOptions(catalog: ModelCatalog | null, selected: AgentChoice | null): PickerOption[] {
  const options: PickerOption[] = [];
  const seen = new Set<string>();
  const push = (option: PickerOption) => {
    if (seen.has(option.value)) return;
    seen.add(option.value);
    options.push(option);
  };
  const pushOpenRouter = (id: string | null | undefined) => {
    if (!id) return;
    const model = openRouterModel(catalog, id);
    push(withCost({ value: `${OPENROUTER_PREFIX}${id}`, label: model?.name || id, title: OPENROUTER_TITLE }, modelCost(id, catalog, model)));
  };
  const openRouter = !!catalog && catalog.codexAvailable && catalog.openrouter.length > 0;

  // 1. The platform's recommended OpenRouter models, its first pick first.
  if (openRouter && catalog) {
    pushOpenRouter(recommendedOpenRouterId(catalog));
    for (const model of catalog.openrouter) if (model.isDefaultFavorite) pushOpenRouter(model.id);
    for (const model of catalog.openrouter) if (model.isRecommended) pushOpenRouter(model.id);
  }
  // 2. The Anthropic models.
  for (const model of catalog?.anthropic || []) {
    push(withCost({ value: `${ANTHROPIC_PREFIX}${model.id}`, label: model.label, title: ANTHROPIC_TITLE }, modelCost(model.id, catalog)));
  }
  // 3. What this account already uses: the saved default and the favourites.
  if (openRouter && catalog) {
    pushOpenRouter(catalog.savedOpenRouter?.model);
    for (const model of catalog.openrouter) if (model.isFavorite) pushOpenRouter(model.id);
  }
  // The conversation's own choice is always an option, even one the catalog
  // no longer lists or has not loaded, so the control never shows a model
  // the conversation is not on.
  if (selected) {
    const value = choiceValue(selected);
    if (!seen.has(value)) {
      if (selected.backend === 'codex_openrouter') pushOpenRouter(selected.model);
      else push(withCost({ value, label: selected.model || 'Claude', title: ANTHROPIC_TITLE }, modelCost(selected.model, catalog)));
    }
  }
  const fallback = catalog ? choiceValue(effectiveChoice(null, catalog)) : null;
  return options.map((option) => (option.value === fallback ? { ...option, isDefault: true } : option));
}

/** Does this choice take a reasoning effort? Only an OpenRouter model that offers one. */
export function offersReasoning(choice: AgentChoice | null, catalog: ModelCatalog | null): boolean {
  if (!choice || choice.backend !== 'codex_openrouter') return false;
  const model = openRouterModel(catalog, choice.model);
  return !model || model.supportsReasoning !== false;
}

/**
 * The choice a picked option means. An OpenRouter model keeps the effort the
 * conversation was on (or the saved one) when it offers reasoning, and drops
 * it when it does not; the server applies the same rule.
 */
export function choiceFromValue(value: string, catalog: ModelCatalog | null, previous: AgentChoice | null): AgentChoice | null {
  if (value.startsWith(ANTHROPIC_PREFIX)) {
    const model = value.slice(ANTHROPIC_PREFIX.length);
    return model ? { backend: 'claude_code', model, reasoningEffort: null } : null;
  }
  if (value.startsWith(OPENROUTER_PREFIX)) {
    const model = value.slice(OPENROUTER_PREFIX.length);
    if (!model) return null;
    const next: AgentChoice = { backend: 'codex_openrouter', model, reasoningEffort: null };
    if (offersReasoning(next, catalog)) {
      next.reasoningEffort = (previous && previous.backend === 'codex_openrouter' ? previous.reasoningEffort : null)
        || catalog?.savedOpenRouter?.reasoningEffort
        || null;
    }
    return next;
  }
  return null;
}

/**
 * The reasoning control's options, in the server's order. '' follows the
 * deployment's default, so the default effort IS that option, marked
 * "(default)" in the open list, rather than a second "Default (High)" entry
 * beside a plain "High". With no default known, '' is a plain "Default".
 */
export function effortOptions(catalog: ModelCatalog | null): PickerOption[] {
  const fallback = catalog?.defaultReasoningEffort && EFFORT_LABELS[catalog.defaultReasoningEffort]
    ? catalog.defaultReasoningEffort
    : null;
  const efforts = REASONING_EFFORTS.map((effort): PickerOption => (effort === fallback
    ? { value: '', label: EFFORT_LABELS[effort], isDefault: true }
    : { value: effort, label: EFFORT_LABELS[effort] }));
  return fallback ? efforts : [{ value: '', label: 'Default', isDefault: true }, ...efforts];
}

/** The option a choice's effort is: its own, or '' when it follows the default or names it. */
export function effortValue(choice: AgentChoice | null, catalog: ModelCatalog | null): string {
  const effort = (choice && choice.reasoningEffort) || '';
  return effort && effort === catalog?.defaultReasoningEffort ? '' : effort;
}

/** Two choices that run the same way. */
export function sameChoice(a: AgentChoice | null, b: AgentChoice | null): boolean {
  if (!a || !b) return a === b;
  return a.backend === b.backend && (a.model || null) === (b.model || null)
    && (a.reasoningEffort || null) === (b.reasoningEffort || null);
}
