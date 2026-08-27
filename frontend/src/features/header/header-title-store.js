/**
 * The header title's rendered state (Streamlined Concept groundwork).
 *
 * `#header-title` is on its way to becoming a React-owned control — the
 * Figma "Streamlined Concept" board makes the center of the top bar a
 * tappable "app name ⌄" tab that opens the app-context sheet. A tappable
 * control with a conditional chevron is state, and the stateful-island rule
 * says React may only render state it owns — so the title's text has to
 * arrive as store state rather than a `textContent` write from
 * public/js/app.js.
 *
 * ── Why a plain store and not React state ──────────────────────────────
 *
 * The only writer is `App.setHeaderTitle()` in public/js/app.js — a classic
 * script that cannot import from this bundle. It goes through
 * `window.UsernodeReact.headerTitle` (published in ./mount.ts) and lands
 * here, exactly the improve-store shape.
 *
 * ── The initial value is the prerender ─────────────────────────────────
 *
 * The shipped markup renders the title as "dApps" (see platform-header.tsx),
 * so that is the initial value — a first client render that disagrees with
 * the prerendered document is a hydration mismatch, and a console error on
 * any route fails proposal checks.
 *
 * During the transition (until header-title-tab.tsx takes ownership of the
 * subtree) app.js DUAL-WRITES: it publishes here AND still assigns
 * `textContent` directly. The direct write is removed in the same change
 * that makes React render the text.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {object} HeaderTitleState
 * @property {string} text  The visible title — the screen's only h1.
 */

/** @type {HeaderTitleState} */
const INITIAL = {
  text: 'dApps',
};

export const headerTitleStore = createStore(INITIAL);
