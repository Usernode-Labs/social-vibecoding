/**
 * The header's back slot, as state instead of a classList write.
 *
 * `#back-btn` lives inside <PlatformHeader/>, and until now its whole
 * appearance was written from outside React: `App.setBackIcon()` in
 * public/js/app.js toggled `hidden` on the anchor and on each of the two
 * glyphs, then set `aria-label` and `href`. That was safe only while the
 * header island never re-rendered — a rendered `className` is React's, and
 * React rewrites it from its own props the moment anything in that component
 * renders again, silently undoing the legacy write.
 *
 * The Streamlined Concept made the header re-render: the left slot now holds
 * `#back-btn` XOR <HeaderAppIcon/>, the bar carries <SessionStatusPill/>, and
 * both of those read stores. So the same rule AGENTS.md states for screen
 * visibility applies here — publish through a store, never toggle `.hidden`
 * from outside React — and this is that store.
 *
 * ── Why a plain store and not React state ──────────────────────────────
 *
 * The only writer is `App.setBackIcon()`, a classic script that cannot import
 * from this bundle. It goes through `window.UsernodeReact.backButton`
 * (published in ./mount.ts) and lands here, exactly the header-title shape.
 *
 * ── The initial value is the prerender ─────────────────────────────────
 *
 * `mode: 'home'` with no href renders precisely the anchor the hand-written
 * shell shipped: `hidden` on the anchor, `#back-icon-home` visible,
 * `#back-icon-arrow` hidden, `aria-label="Home"`, and NO href attribute at
 * all. A first client render that disagrees with the prerendered document is
 * a hydration mismatch, and a console error on any route fails proposal
 * checks.
 *
 * ── 'home' means HIDDEN, which reads wrong and is right ────────────────
 *
 * `mode` is really a boolean: only 'arrow' shows the anchor. The slot belongs
 * to the app glyph otherwise (features/header/header-app-icon.tsx), so the
 * home mode is "there is nothing to go back to here" rather than "draw a
 * house". The house glyph survives because setBackIcon's two modes are still
 * spelled that way at ~40 call sites.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {object} BackButtonState
 * @property {'home'|'arrow'} mode  'arrow' shows the anchor; anything else hides it.
 * @property {string|null} href     The resolved destination, or null before
 *                                  the first setBackIcon() — which is the one
 *                                  state that renders no href attribute, so
 *                                  the prerender has none either.
 */

/** @type {BackButtonState} */
const INITIAL = {
  mode: 'home',
  href: null,
};

export const backButtonStore = createStore(INITIAL);
