/**
 * The Kudos pane's rendered state (#1191 slice 6, conversion 6).
 *
 * `#leaderboard-root` was the second of the Leaderboard screen's three
 * innerHTML hosts; ./kudos-pane.tsx is its only writer now, and this is what
 * ./leaderboard.js pushes into.
 *
 * TWO descriptors rather than one, because the pane re-renders at two
 * different rates and always did: `_render()` rebuilds the CHROME (the
 * sub-tab strip and window pills, or the profile header) when the tab
 * selection changes, and `_renderBody()` rebuilds the BODY on every load,
 * every cache hit and every load-more toggle. Keeping them apart preserves
 * that: a body refresh cannot re-key the chrome, so the sub-tabs are not
 * re-created underneath a click.
 *
 * PLANTED, not imported, for the same reason ./topochain-standings-store.js is
 * — see that file's header. ./leaderboard.js reaches its section store through
 * `window` (see ./section-store.ts) rather than importing it, and this module
 * keeps that shape so the file's dependency story stays one story.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The initial value is the PRERENDER state. The shipped `#leaderboard-root` is
 * empty AND hidden — Kudos is not the default section — so `mounted: false`
 * renders nothing at all.
 */
export const kudosPaneStore = createStore({
  /** Flipped by _render(), i.e. the first time the Kudos tab is shown. */
  mounted: false,
  /** The tab strip / profile header descriptor (see chromeView), or null. */
  chrome: null,
  /** The #leaderboard-body descriptor (see bodyView), or null. */
  body: null,
});
