'use strict';

// The programme console's control-styling tokens (Task 15; #1179), lifted out
// of admin-topochain.js in #1120 slice 24 so the screens being converted to
// React can build from the SAME strings the innerHTML screens do. Nothing here
// changed in the move — the block below is the original, verbatim, and
// admin-topochain.js now imports it instead of declaring it.
//
// Keeping one copy is the point: a converted screen and an unconverted one sit
// side by side in the same sub-nav for as long as the conversion runs, and two
// drifting copies of BTN.primary would be visible as two different buttons.

// The shared admin class-string registry.
import { AdminUI } from '../admin-console.js';

// ── Control styling tokens ───────────────────────────────────────────
//
// Every button, field and panel in this file is built from the strings
// below rather than a hand-written class list, so size, radius, focus
// ring and colour are identical on all eleven screens — the first pass
// modernised the LISTS and left each form and editor with whatever
// classes it happened to be written with.
//
// They are plain string constants rather than a helper that RETURNS a
// <button> for two reasons: the class names stay WHOLE LITERALS, which
// is the only form Tailwind's extractor scans for, and the markup keeps
// the literal ``canWrite ? `<button …`` shape that
// tests/topochain-admin-screens.test.js counts to prove every mutating
// control is gated.
//
// Tap targets are >= 44px tall below sm: (a finger) and tighten to a
// pointer-sized control at sm: and up, where a mouse is likely and
// vertical space is worth more. `touch-manipulation` drops the 300ms
// double-tap delay that otherwise makes the small row chips feel dead.
export const BTN_BASE = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium '
  + 'transition-colors touch-manipulation focus:outline-none focus-visible:ring-2 '
  + 'focus-visible:ring-zinc-900 dark:focus-visible:ring-zinc-100 disabled:opacity-40 disabled:pointer-events-none';
export const BTN_MD = 'min-h-[44px] sm:min-h-[36px] px-4 py-2 text-sm';
export const BTN_SM = 'min-h-[44px] sm:min-h-[34px] px-3 py-1.5 text-sm';
export const BTN_ROW = 'min-h-[36px] sm:min-h-[30px] px-2.5 py-1 text-xs';
export const BTN = {
  // Page/panel-level primary + secondary (Save, Cancel, Run, Send).
  primary: `${BTN_BASE} ${BTN_MD} bg-violet-600 hover:bg-violet-500 text-black shadow-sm dark:shadow-none`,
  secondary: `${BTN_BASE} ${BTN_MD} border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800`,
  // Toolbar variants — same colours, one size down.
  primarySm: `${BTN_BASE} ${BTN_SM} bg-violet-600 hover:bg-violet-500 text-black shadow-sm dark:shadow-none`,
  secondarySm: `${BTN_BASE} ${BTN_SM} border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800`,
  dangerSm: `${BTN_BASE} ${BTN_SM} bg-red-600 hover:bg-red-700 text-white`,
  warnSm: `${BTN_BASE} ${BTN_SM} border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-950/40`,
  // Row actions. Chips, not bare text links: a bordered box is a target
  // you can see and hit, and it wraps predictably inside both the table
  // cell and the card footer _list() renders them into.
  row: `${BTN_BASE} ${BTN_ROW} border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-azure-400 hover:text-azure-700 dark:hover:text-azure-300`,
  rowPrimary: `${BTN_BASE} ${BTN_ROW} border border-azure-300 dark:border-azure-800 text-azure-700 dark:text-azure-300 hover:bg-azure-50 dark:hover:bg-azure-950/40`,
  rowDanger: `${BTN_BASE} ${BTN_ROW} border border-red-200 dark:border-red-900 text-red-700 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-950/40`,
  rowWarn: `${BTN_BASE} ${BTN_ROW} border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-950/40`,
  // Full-width list entry in a reference sidebar (SQL templates, schema
  // tables). Left-aligned rather than centred, and tall enough to hit.
  sidebar: 'flex w-full items-center min-h-[36px] rounded-lg px-2.5 py-1.5 text-left text-xs '
    + 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 '
    + 'touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:focus-visible:ring-zinc-100',
  // Back control on a nested screen, and the ✕ in a panel header.
  // 800/200, tracking AdminUI.btn.link: `back` is a TEXT button (no border,
  // only a hover wash), so it takes the link ink rather than the 700 the two
  // `row*` chips above keep. The -ml-2 is an optical nudge, not separation —
  // it pulls the glyph's box back to the screen's text edge.
  back: `${BTN_BASE} min-h-[44px] sm:min-h-[36px] -ml-2 px-2 py-1 text-sm text-azure-800 dark:text-azure-200 hover:bg-azure-50 dark:hover:bg-azure-950/40`,
  close: 'inline-flex shrink-0 items-center justify-center h-9 w-9 rounded-lg text-zinc-500 dark:text-zinc-300 '
    + 'hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 '
    + 'touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:focus-visible:ring-zinc-100',
};

// Text inputs / selects / textareas. Same 44px-then-36px rule as the
// buttons so a field and the button beside it line up at every width.
export const FIELD_CLS = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 '
  + 'px-3 py-2 text-sm min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 '
  + 'focus:ring-zinc-900 dark:focus:ring-zinc-100 focus:border-transparent disabled:opacity-60';
// Textareas set their height from `rows`, so they take everything but
// the min-height.
export const TEXTAREA_CLS = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 '
  + 'px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 focus:border-transparent';

// Panel and card surfaces, shared by every form, picker and detail view.
export const PANEL_CLS = AdminUI.card; // identical recipe — one source of truth
