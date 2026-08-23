/**
 * The Leaderboard screen's shared event bar, as a view model.
 *
 * `#leaderboard-event-bar` was the LAST innerHTML host on this screen — the
 * three panes went in #1191 slice 6 — and it is a fourth host rather than part
 * of any of them for the reason ./topochain-event-context.js exists at all:
 * the standings pane and the challenges pane share ONE event selection, sitting
 * above both.
 *
 * ./topochain-event-context.js keeps everything that is not markup: the two
 * fetches, the default pick, the picked id, the subscriber list both panes
 * register with, and the stale-response guards. It pushes this;
 * ./event-bar.tsx renders it.
 *
 * PLANTED, not imported, like ./kudos-pane-store.js and
 * ./topochain-standings-store.js — see their headers. The modules on this
 * screen reach their stores through `window`, and keeping the shape uniform
 * means the screen has one dependency story rather than two.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The initial value is the PRERENDER state: the hand-written shell shipped
 * `#leaderboard-event-bar` EMPTY (visible, but with nothing in it — the bar's
 * interior was written by `_renderShell()` on the screen's first open), so
 * `mounted: false` has to render nothing at all.
 *
 * ── The three shapes inside ────────────────────────────────────────────
 *
 * `options` / `placeholder` are the picker. A placeholder is the ONLY entry
 * when there is nothing to pick between, and it carries the reason: `Loading…`
 * before the list lands, `No events` when the server has no public ones. They
 * are separate fields rather than one list because a placeholder is not
 * selectable and an event is.
 *
 * `hero` is a tagged union: `null` before any detail fetch (the shipped
 * `#tc-ev-hero` was an empty div), then `loading` / `error` / `empty` /
 * `event`. Every branch of the old `_renderHero` is one tag, so the component
 * has no conditions of its own to get wrong.
 */
export const eventBarStore = createStore({
  /** Flipped by `_renderShell()`, i.e. the first time an event section opens. */
  mounted: false,
  /** Selectable events, in server order. Empty while `placeholder` stands. */
  options: [],
  /** `'Loading…'` / `'No events'`, or null once there is a real list. */
  placeholder: 'Loading…',
  /** The picked `season_event_id`, or null before one resolves. */
  selectedId: null,
  /** See above — null renders an empty `#tc-ev-hero`. */
  hero: null,
});

// Published for the same reason its siblings are: ./topochain-event-context.js
// is a classic-shaped module that reaches its collaborators by name. Guarded
// because the SSG prerender evaluates this graph in Node.
if (typeof window !== 'undefined') window.LeaderboardEventBarStore = eventBarStore;
