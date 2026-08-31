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
 * ── THREE modes now, and 'home' finally means what it says ─────────────
 *
 * `mode` used to be a boolean wearing three names: only 'arrow' showed the
 * anchor, and 'home' meant HIDDEN — a leftover from #1443, which retired the
 * house glyph on the grounds that the chip's menu carries a Home row an inch
 * to its right. The slot was empty on most screens as a result: the app
 * itself, Profile, Settings, Admin and Messages all had no way off them in
 * the bar at all.
 *
 * "Every page should have a back or a home button, except Home." So the
 * modes are now genuinely three:
 *
 *   'none'   the anchor is hidden. Home only — you are already there.
 *   'home'   the house, linking to home. The DEFAULT, which is what makes
 *            this safe: `_showOnlyScreen` publishes it on every screen swap,
 *            so a screen gets a way out by existing rather than by
 *            remembering to ask for one.
 *   'arrow'  the chevron, linking one level UP to `href`.
 *
 * Redefining 'home' rather than adding a fourth name is deliberate: ~40 call
 * sites already spell the default that way, and every one of them meant "no
 * level above this" — which is exactly the screen that should offer home.
 * The ones that must NOT (only Home itself) are the ones that changed.
 *
 * ── The initial value is the prerender ─────────────────────────────────
 *
 * `mode: 'none'` with no href renders precisely the anchor the shipped
 * document has: `hidden` on the anchor and NO href attribute at all. A first
 * client render that disagrees with the prerendered document is a hydration
 * mismatch, and a console error on any route fails proposal checks. It is
 * 'none' and not 'home' for a second reason too: the cold document is most
 * often Home, and a house that paints for one frame before the router says
 * otherwise is a flicker on the most-visited screen.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {object} BackButtonState
 * @property {'none'|'home'|'arrow'} mode  Which glyph, or none at all.
 * @property {string|null} href     The resolved destination, or null before
 *                                  the first setBackIcon() — which is the one
 *                                  state that renders no href attribute, so
 *                                  the prerender has none either.
 */

/** @type {BackButtonState} */
const INITIAL = {
  mode: 'none',
  href: null,
};

export const backButtonStore = createStore(INITIAL);
