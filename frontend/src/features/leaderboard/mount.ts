/**
 * The legacy → React seam for the Leaderboard screen's panes (#1191 slice 6 —
 * conversion 5 brought the standings pane, conversion 6 the Kudos pane; the
 * Challenges pane joins this file as conversion 7).
 *
 * `setFlush(flushSync)` for the same reason as ../notifications/mount.ts: both
 * controllers read the DOM on the line after they render. `open()` calls
 * `_renderShell()` and then `loadLeaderboard()`, whose first act is another
 * render; `_openDrill` renders the panel and then scrolls it into view; and the
 * Kudos pane's `_render()` writes the chrome and then immediately the body.
 * Batched, the scroll would measure the previous frame.
 *
 * Both `_store` fields are PLANTS, not imports in the controllers — see the
 * header of ./topochain-standings-store.js for why that dependency points this
 * way (tests/standings-screen.test.js still compiles the standings controller's
 * real source as a classic script, and ./leaderboard.js keeps the same shape so
 * the folder tells one dependency story).
 */

import { flushSync } from 'react-dom';

import './leaderboard.js';
import './topochain-leaderboard.js';
import { kudosPaneStore } from './kudos-pane-store.js';
import { topochainStandingsStore } from './topochain-standings-store.js';

kudosPaneStore.setFlush(flushSync);
topochainStandingsStore.setFlush(flushSync);

export { kudosPaneStore, topochainStandingsStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as {
    Leaderboard?: Record<string, unknown>;
    TopochainLeaderboard?: Record<string, unknown>;
    UsernodeReact?: Record<string, unknown>;
  };
  if (host.Leaderboard) host.Leaderboard._store = kudosPaneStore;
  if (host.TopochainLeaderboard) host.TopochainLeaderboard._store = topochainStandingsStore;
  const bridge = (host.UsernodeReact ||= {});
  bridge.kudosPane = host.Leaderboard;
  bridge.topochainStandings = host.TopochainLeaderboard;
}
