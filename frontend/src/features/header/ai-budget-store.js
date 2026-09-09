/**
 * `#ai-budget-slot` — the viewer's own daily AI allowance, as a view model.
 *
 * ── One picture, four states ───────────────────────────────────────────
 *
 * The meter says one of four things: the ordinary spend/limit pair, "verify
 * account · unlock $10/day" for a zero tier, "credits temporarily
 * unavailable" when eligibility could not be checked, or nothing at all.
 * Every one of them is the same picture — a run of coloured text fragments
 * under one tooltip — so this carries fragments rather than four variants,
 * the same shape ../dev-chat/budget-pill-store.ts uses for the composer's
 * copy of the same figure.
 *
 * WHICH fragments stays in ./ai-credit.js, where the budget data and
 * `CreditOptions.creditState` are: the thresholds, the dollar formatting,
 * the reset sentence and the limit-first billing rule that decides whether a
 * "your key $X" figure appears at all.
 *
 * ── Why the tones are names ────────────────────────────────────────────
 *
 * `high` / `mid` / `low` resolve to red / amber / emerald in the component,
 * as complete class literals. Tailwind's extractor is a regex over source
 * text, so a palette carried in the model would compile to nothing — and
 * `low` and `byok` map to the same literal today on purpose: one is a spend
 * threshold, the other is the BYOK figure, and they are free to diverge.
 *
 * ── `hidden` is a third state, not `!view` ─────────────────────────────
 *
 * The row ships VISIBLE and empty and is hidden only once a me-scoped fetch
 * has answered with nothing to show — which is what `setRowVisible` did.
 * Collapsing that into "no view means hidden" would hide the row on a
 * document that has not fetched yet, and a declared check resolves
 * `#drawer-row-ai-budget #ai-budget-slot` on a plain `/#settings/api-key`.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * Plain `.js`, and imported with its extension, because ./ai-credit.js
 * imports it directly and Node's ESM resolver has no bundler to add one —
 * the same arrangement ../app-frame/app-frame-store.js is in, for the same
 * reason. The TYPES live beside the component in ./ai-budget.tsx.
 */
export const aiBudgetStore = createStore({ view: null, hidden: false });
