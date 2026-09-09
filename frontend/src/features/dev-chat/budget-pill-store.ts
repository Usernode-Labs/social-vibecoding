/**
 * `#dc-budget` — the dev chat composer's credit meter — as a view model.
 *
 * ── Nine states, one shape ────────────────────────────────────────────
 *
 * The meter says one of nine things depending on whether the session bills an
 * OpenRouter key, whether platform credits are locked behind an unverified
 * identity, whether eligibility could be checked at all, whether the viewer
 * has their own Anthropic key, whether spillover billing to that key has
 * started today, and where today's spend sits against the daily limit. Every
 * one of them is the same picture: a run of coloured text fragments, sometimes
 * one of them a link, under one tooltip.
 *
 * So this carries fragments rather than a discriminated union of nine
 * variants. WHICH fragments — the thresholds, the wording, the dollar
 * formatting, the reset sentence, and the limit-first billing rule that
 * decides whether a "your key $X" figure appears at all — stays in
 * dev-chat.js, where the budget data and `window.Settings.state` are.
 *
 * ── The host stays the module's ───────────────────────────────────────
 *
 * `#dc-budget` is written by `renderChatView`'s template, and a dapp.json
 * check selects it as `#dc-venue-detail ~ #dc-budget` — a SIBLING selector, so
 * where the element sits is part of the contract. React renders its children.
 */

import { createStore } from '../../lib/plain-store.js';

export interface BudgetPart {
  text: string;
  className: string;
  /** Set on the two "go and fix this" fragments, which are links. */
  href?: string | null;
  /** A fragment's own tooltip, where the original put one there. */
  title?: string | null;
}

export interface BudgetPillState {
  /**
   * The wrapper's tooltip. Non-null exactly where the original wrapped its
   * fragments in a titled `<span>`; null where the single fragment carried
   * the title itself, so the markup stays what it was.
   */
  title: string | null;
  /** Empty draws nothing — an OpenRouter session, or no budget data yet. */
  parts: BudgetPart[];
}

export const EMPTY_BUDGET_PILL: BudgetPillState = { title: null, parts: [] };

export const budgetPillStore = createStore<BudgetPillState>(EMPTY_BUDGET_PILL);
