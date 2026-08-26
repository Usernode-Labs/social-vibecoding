/**
 * The app list behind the switcher chip's menu (#1436).
 *
 * ── What this deliberately does NOT own ────────────────────────────────
 *
 * **The chip's label.** Which app is on screen is already published: the
 * Improve panel needs the same fact for its own header, and
 * `Improve.publishTarget()` / `Home.publishImproveTarget()` have been writing
 * `target` / `slug` / `appName` into ../improve/improve-store.js since THE UI
 * OVERHAUL. The chip subscribes to THAT. Two stores fed by the same two
 * callers is exactly how a header label and a panel header start disagreeing
 * about which app you are looking at.
 *
 * **Whether the menu is open.** That stays in
 * ../header/header-menu-controller.js, which owns the presentation — the kit
 * `panel` adoption, the ghost-click guard, the nav-arm window and the dismiss
 * waiters. The menu is a re-aimed drawer, not a new surface, so its open/close
 * is the drawer's, unchanged.
 *
 * What is left is the one genuinely new thing: the list of apps to switch to.
 *
 * ── The list is borrowed, not re-fetched ───────────────────────────────
 *
 * `Home._apps` is the cached, visibility-filtered `/api/apps` payload the home
 * grid already loads. The menu reads it and fetches only when it is empty —
 * opening the switcher on a cold boot, before home has ever rendered. An
 * unconditional second fetch would double the request on the one screen that
 * always pays for it.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {Object} SwitcherApp
 * @property {string} slug
 * @property {string} name
 * @property {string|null} status
 */

/**
 * @typedef {Object} SwitcherState
 * @property {SwitcherApp[]} apps
 * @property {boolean} loading — an /api/apps load is in flight
 * @property {boolean} loaded  — a load has resolved at least once
 */

/**
 * Ships EMPTY, which is what the SSG pass in
 * frontend/scripts/build-shell.mjs prerenders and therefore what hydration
 * expects. Apps load from the drawer's `open()`, never from render: an initial
 * render that emitted rows would mismatch hydration, and a hydration mismatch
 * is a console.error, which fails proposal checks.
 *
 * @type {import('../../lib/plain-store.js').Store<SwitcherState>}
 */
export const switcherStore = createStore({
  apps: [],
  loading: false,
  loaded: false,
});
