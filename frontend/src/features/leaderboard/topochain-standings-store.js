/**
 * The standings pane's rendered state (#1191 slice 6, conversion 5).
 *
 * `#topochain-leaderboard-root` was the first of the Leaderboard screen's three
 * innerHTML hosts; ./topochain-standings.tsx is its only writer now, and this
 * is what the controller pushes into.
 *
 * PLANTED, not imported. ./topochain-leaderboard.js may not grow an `import`:
 * tests/standings-screen.test.js evaluates its real shipped source with
 * `new Function(src)` — a classic script — to render both the season and the
 * per-event board and diff them, which is the only reason that #999 regression
 * is caught at all. So ./mount.ts assigns this store onto the module
 * (`TopochainLeaderboard._store`), exactly as the notifications and browse
 * conversions do, and the controller treats a missing store as "not mounted
 * yet" rather than as an error.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The initial value is the PRERENDER state, and the shipped
 * `#topochain-leaderboard-root` is EMPTY — the pane's shell is written by
 * `_renderShell()` on the section's first open, not by the document. So
 * `mounted: false` renders nothing at all, not even the two hosts.
 */
export const topochainStandingsStore = createStore({
  /** Flipped by _renderShell(), i.e. the first time the section opens. */
  mounted: false,
  /** The #tc-lb-body descriptor (see _renderBody), or null before the first. */
  body: null,
  /** The #tc-lb-drill descriptor, or null when the panel is closed. */
  drill: null,
});
