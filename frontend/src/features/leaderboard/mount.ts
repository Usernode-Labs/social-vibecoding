/**
 * The legacy → React seam for the Leaderboard screen's panes (#1191 slice 6,
 * conversion 5 — the standings pane; the Kudos and Challenges panes join this
 * file as their own conversions land).
 *
 * `setFlush(flushSync)` for the same reason as ../notifications/mount.ts: the
 * controller reads the DOM on the line after it renders. `open()` calls
 * `_renderShell()` and then `loadLeaderboard()`, whose first act is another
 * render; and `_openDrill` renders the panel and then scrolls it into view.
 * Batched, the scroll would measure the previous frame.
 *
 * `TopochainLeaderboard._store` is a PLANT, not an import in the controller —
 * see the header of ./topochain-standings-store.js for why that dependency
 * points this way (tests/standings-screen.test.js still compiles the
 * controller's real source as a classic script).
 */

import { flushSync } from 'react-dom';

import './topochain-leaderboard.js';
import { topochainStandingsStore } from './topochain-standings-store.js';

topochainStandingsStore.setFlush(flushSync);

export { topochainStandingsStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as {
    TopochainLeaderboard?: Record<string, unknown>;
    UsernodeReact?: Record<string, unknown>;
  };
  if (host.TopochainLeaderboard) host.TopochainLeaderboard._store = topochainStandingsStore;
  const bridge = (host.UsernodeReact ||= {});
  bridge.topochainStandings = host.TopochainLeaderboard;
}
