/**
 * The Dev board's locked-app banner, as a view model.
 *
 * `#dev-locked-notice` sits at the top of the card list and says one thing:
 * this app is locked, so an admin has to approve any proposal before it
 * applies. It used to be a leaf host — ./board-frame.tsx rendered the empty
 * div with a constant `className`, and `AppView._renderLockedNotice` toggled
 * `hidden` on it and wrote the banner in. That is two owners of one node's
 * class attribute, tolerated only because the React side never changed it.
 *
 * One boolean removes the arrangement entirely: the module publishes whether
 * the app is locked (from `_proposalsCtx`, which is server truth loaded with
 * the feed) and the frame draws the banner or does not.
 */

import { createStore } from '../../lib/plain-store.js';

export interface LockedNoticeState {
  locked: boolean;
}

export const lockedNoticeStore = createStore<LockedNoticeState>({ locked: false });
