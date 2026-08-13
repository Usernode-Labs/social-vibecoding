/**
 * The Challenges pane's rendered state (#1191 slice 6, conversion 7 — the
 * third and last of the Leaderboard screen's three panes).
 *
 * `#challenges-root` was the screen's remaining innerHTML host;
 * ./challenges-pane.tsx is its only writer now, and this is what
 * ./topochain-challenges.js pushes into.
 *
 * FOUR descriptors rather than one, because the pane has four independent
 * render rates and always did — `_renderShell()`, `_renderGrid()`,
 * `_renderDetailOverlay()` and `_renderProfileOverlay()` were four separate
 * innerHTML writes into three separate hosts. Keeping them apart preserves
 * that: paging the participant breakdown re-renders the detail panel without
 * touching the grid underneath it, which is what stops a "Load more" click
 * from re-keying (and so re-mounting) the cards behind the overlay.
 *
 * `detail` and `profile` double as the overlays' VISIBILITY. Both roots used
 * to be `classList.toggle('hidden', …)`-ed by the controller; now that the
 * whole subtree is React-owned, `null` means hidden and a descriptor means
 * shown, so the two can never disagree.
 *
 * PLANTED, not imported, and here that is not merely for consistency with
 * ./kudos-pane-store.js and ./topochain-standings-store.js — it is forced.
 * tests/challenge-deep-link.test.js drives the SHIPPED controller through
 * `vm.runInContext`, i.e. as a classic script with no module loader at all,
 * because the #982 deep link's whole point is the ordering between the
 * router, the mount and the first paint, and only running the real file
 * proves it. An `import` here would make that file unloadable. ./mount.ts
 * plants this store instead, and every write in the controller goes through
 * `?.` so the prerender pass and that vm both see a no-op.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The initial value is the PRERENDER state. The shipped `#challenges-root` is
 * empty AND hidden — Challenges is not the default section — so
 * `mounted: false` renders nothing at all, which is exactly the markup the
 * hand-written shell shipped.
 */
export const topochainChallengesStore = createStore({
  /** Flipped by _renderShell(), i.e. the first time the pane is opened. */
  mounted: false,
  /** The #tc-se-grid descriptor (see gridView), or null before the first load. */
  grid: null,
  /** The detail overlay descriptor (see detailView), or null when it is closed. */
  detail: null,
  /** The profile overlay descriptor (see profileView), or null when closed. */
  profile: null,
});
