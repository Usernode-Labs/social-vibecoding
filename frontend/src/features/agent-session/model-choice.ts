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
// token profile of a typical change, its cached input priced at the model's
// cache rates (typicalChangeCents). Never a bare amount: always "about $X
// for a typical change", because a naked "$1.55" reads as per message, per
// hour or per month just as easily.

import type { AgentChoice, ModelCatalog, ModelNotes, OpenRouterModel } from './api';
import { prettyModel } from './transcript';

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
// #3296: the platform runs some OpenRouter models in Claude Code, not Codex.
const OPENROUTER_CLAUDE_TITLE = 'Runs on your OpenRouter key, in Claude Code';
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
 * Cents for the typical change at a catalog model's prices, the server's
 * arithmetic (services/model-costs.js tokenCostUsd): the profile's
 * inputTokens is every prompt token, and its cache-read and cache-write parts
 * are each priced at the model's cache rate where the catalog lists one and
 * at its prompt rate where it does not. Null without a prompt or completion
 * price.
 */
export function typicalChangeCents(profile: NonNullable<ModelNotes['typicalChange']>, model: OpenRouterModel): number | null {
  if (model.inputPricePerMillion == null || model.outputPricePerMillion == null) return null;
  const input = Number(model.inputPricePerMillion);
  const output = Number(model.outputPricePerMillion);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const rate = (value: number | null | undefined) => {
    const n = value == null ? NaN : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const readRate = rate(model.cacheReadPricePerMillion);
  const writeRate = rate(model.cacheWritePricePerMillion);
  const tokens = Math.max(Number(profile.inputTokens) || 0, 0);
  const part = (n: number | undefined, room: number) => Math.min(Math.max(Number(n) || 0, 0), Math.max(room, 0));
  const reads = readRate == null ? 0 : part(profile.cachedInputTokens, tokens);
  const writes = writeRate == null ? 0 : part(profile.cacheWriteInputTokens, tokens - reads);
  let perMillion = (tokens - reads - writes) * input + Math.max(Number(profile.outputTokens) || 0, 0) * output;
  if (reads > 0 && readRate != null) perMillion += reads * readRate;
  if (writes > 0 && writeRate != null) perMillion += writes * writeRate;
  return Math.round((perMillion / 1_000_000) * 100 * 100) / 100;
}

/**
 * What a typical change costs on a model: the platform's estimate for one it
 * curates, else the catalog's per-token prices times the typical change's
 * token profile (typicalChangeCents). Under a cent reads "<$0.01", never
 * "$0.00": a model that costs something must not look free.
 */
export function modelCost(id: string | null | undefined, catalog: ModelCatalog | null, model: OpenRouterModel | null = null): ModelCost {
  const notes = catalog?.notes || null;
  const entry = id && notes ? notes.models[id] || null : null;
  const note = entry && typeof entry.note === 'string' ? entry.note : '';
  let cents = entry && entry.estimateCents != null && Number.isFinite(Number(entry.estimateCents)) ? Number(entry.estimateCents) : null;
  if (cents == null && notes?.typicalChange && model) cents = typicalChangeCents(notes.typicalChange, model);
  const money = cents == null ? '' : (cents > 0 && cents < 1 ? '<$0.01' : `$${(cents / 100).toFixed(2)}`);
  const perChange = money ? `about ${money} for a typical change` : '';
  return { note, perChange, compact: [note, perChange].filter(Boolean).join(' · ') };
}

function withCost(option: PickerOption, cost: ModelCost): PickerOption {
  return {
    ...option,
    ...(cost.compact ? { detail: cost.compact } : {}),
  };
}

/**
 * A model's short name, for the closed pill (#3574). On a phone the pill gets
 * whatever the composer's row has left after the paperclip, the credits pill
 * and Send, which on a 390px screen is about 150px; OpenRouter names every
 * model "Provider: Model" ("DeepSeek: DeepSeek V4.1 Flash", "Z.ai: GLM 5.3
 * Flash"), so the pill spent its room on the provider and the credits pill
 * was drawn over the rest.
 *
 * So the short form is the catalog's own name with that "Provider: " prefix
 * taken off, and then a leading "Claude": the platform's own Claude models are
 * already named without it ("Opus 5.5", services/models.js), and an Opus
 * reached through OpenRouter should read the same. An option the catalog has
 * no name for carries its id as its label (pickerOptions, below: the
 * conversation is on a model the catalog no longer lists), and an id is
 * shortened the way the transcript names a model (transcript.ts prettyModel,
 * applied to what follows the provider's slash): "claude-opus-5-5" is "Opus
 * 5.5" and "openai/gpt-5.3-codex" is "gpt-5.3-codex".
 *
 * Derived from the name, never a table of models: one added to the catalog
 * tomorrow gets a short name with nobody editing a list, and a name the rules
 * cannot shorten is returned whole rather than emptied. The full name is not
 * lost: the pill keeps it as its tooltip and as what a screen reader hears,
 * and the sheet it opens lists every model by the name the catalog gave it.
 */
export function shortModelName(label: string | null | undefined): string {
  const full = String(label || '').trim();
  if (!full) return '';
  // A label with no space in it is an id, not a name.
  if (!/\s/.test(full)) return prettyModel(prettyModel(full)) || full;
  const short = full
    .replace(/^[^:/]{1,40}:\s+(?=\S)/, '')
    .replace(/^Claude\s+(?=\S)/, '');
  return short || full;
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
    const title = model?.harness === 'claude' ? OPENROUTER_CLAUDE_TITLE : OPENROUTER_TITLE;
    push(withCost({ value: `${OPENROUTER_PREFIX}${id}`, label: model?.name || id, title }, modelCost(id, catalog, model)));
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

/**
 * The thinking level the closed pill names after the model (#3079): the
 * choice's own effort, or the deployment's default it follows. '' when no
 * level applies (a model without reasoning) or none is known, never a
 * placeholder "Default".
 */
export function effortLabel(choice: AgentChoice | null, catalog: ModelCatalog | null): string {
  if (!offersReasoning(choice, catalog)) return '';
  const effort = (choice && choice.reasoningEffort) || catalog?.defaultReasoningEffort || '';
  return EFFORT_LABELS[effort] || '';
}

/** Two choices that run the same way. */
export function sameChoice(a: AgentChoice | null, b: AgentChoice | null): boolean {
  if (!a || !b) return a === b;
  return a.backend === b.backend && (a.model || null) === (b.model || null)
    && (a.reasoningEffort || null) === (b.reasoningEffort || null);
}
