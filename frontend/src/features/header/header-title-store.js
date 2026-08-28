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
 * During the transition (until app-switcher-chip.tsx takes ownership of the
 * subtree) app.js DUAL-WRITES: it publishes here AND still assigns
 * `textContent` directly. The direct write is removed in the same change
 * that makes React render the text.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * ── `screen`, and why the chip does not draw it ────────────────────────
 *
 * The Board and the Activity screens used to SET the title: you opened
 * Notes, tapped through to its board, and the chip read "Board". That threw
 * away the one fact the chip exists to carry — which app you are in — so it
 * became a SUBTITLE instead, a 10px second line stacked inside the chip's
 * 28px pill.
 *
 * That was the right fix to the wrong problem. The chip is one line of type
 * wide and the row it sits in is pinned from both directions
 * (tests/header-height-parity.test.js), so the screen's name was being
 * shrunk into the gaps of the app's name rather than given a place to live.
 * It has one now — the shell's second bar, features/shell/screen-bar.tsx —
 * and the frames render it as a heading with their own actions beside it.
 *
 * So NOTHING RENDERS THIS FIELD any more. It survives because
 * `document.title` still wants both halves, joined the other way round
 * ("Notes · Board", widest scope first, because a browser tab and the native
 * AppBar truncate from the RIGHT). Publishing it stays the one call that
 * says "you are in app X, on screen Y"; what reads it is App.setHeaderTitle.
 *
 * @typedef {object} HeaderTitleState
 * @property {string} text    The app's name — the chip's text, the screen's only h1.
 * @property {string} screen  The screen within it, or '' at the root. document.title only.
 */

/** @type {HeaderTitleState} */
const INITIAL = {
  text: 'dApps',
  screen: '',
};

export const headerTitleStore = createStore(INITIAL);
