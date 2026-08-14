/**
 * The legacy → React seam for the Leaderboard screen's three panes (#1191
 * slice 6 — conversion 5 brought the standings pane, conversion 6 the Kudos
 * pane, conversion 7 the Challenges pane, which completes the screen).
 *
 * `setFlush(flushSync)` for the same reason as ../notifications/mount.ts: both
 * controllers read the DOM on the line after they render. `open()` calls
 * `_renderShell()` and then `loadLeaderboard()`, whose first act is another
 * render; `_openDrill` renders the panel and then scrolls it into view; and the
 * Kudos pane's `_render()` writes the chrome and then immediately the body.
 * Batched, the scroll would measure the previous frame.
 *
 * All three `_store` fields are PLANTS, not imports in the controllers — see
 * the header of ./topochain-standings-store.js for why that dependency points
 * this way (tests/standings-screen.test.js still compiles the standings
 * controller's real source as a classic script, and ./leaderboard.js keeps the
 * same shape so the folder tells one dependency story). For
 * ./topochain-challenges.js it is not a matter of consistency but a hard
 * constraint: tests/challenge-deep-link.test.js runs that file through
 * `vm.runInContext`, where an import statement is a syntax error.
 */

import { flushSync } from 'react-dom';

import './leaderboard.js';
import './topochain-leaderboard.js';
import './topochain-challenges.js';
import { kudosPaneStore } from './kudos-pane-store.js';
import { topochainStandingsStore } from './topochain-standings-store.js';
import { topochainChallengesStore } from './topochain-challenges-store.js';

kudosPaneStore.setFlush(flushSync);
topochainStandingsStore.setFlush(flushSync);
topochainChallengesStore.setFlush(flushSync);

export { kudosPaneStore, topochainStandingsStore, topochainChallengesStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as {
    Leaderboard?: Record<string, unknown>;
    TopochainLeaderboard?: Record<string, unknown>;
    TopochainChallenges?: Record<string, unknown>;
    UsernodeReact?: Record<string, unknown>;
  };
  if (host.Leaderboard) host.Leaderboard._store = kudosPaneStore;
  if (host.TopochainLeaderboard) host.TopochainLeaderboard._store = topochainStandingsStore;
  if (host.TopochainChallenges) host.TopochainChallenges._store = topochainChallengesStore;
  const bridge = (host.UsernodeReact ||= {});
  bridge.kudosPane = host.Leaderboard;
  bridge.topochainStandings = host.TopochainLeaderboard;
  bridge.topochainChallenges = host.TopochainChallenges;
}
