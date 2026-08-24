/**
 * The bell drawer's rendered state (#1191 slice 6, conversion 2).
 *
 * ── Why the controller does not import this file ───────────────────────
 *
 * ./notifications.js is deliberately still an import-free module: nine test
 * harnesses (tests/devchat-alerts.test.js, tests/social-push-web.test.js)
 * evaluate its real shipped source with `vm.runInNewContext`, which compiles a
 * CLASSIC script. The moment it grows a static `import`, all nine die with
 * "Cannot use import statement outside a module" — the exact breakage
 * tests/helpers/bundle-module.js was written to paper over for the modules
 * that genuinely need a seam.
 *
 * The controller does not need one. It reaches this store through
 * `Notifications._store`, planted by ./mount.ts, and no-ops when it is absent
 * — which is precisely the state those sandboxes run in, and the reason they
 * did not have to change.
 *
 * ── Why the VIEW is computed in the controller, not here ───────────────
 *
 * The per-kind row copy had two renderers for a while: this island's React
 * rows, and an HTML string the cog drawer spliced into #work-drawer-list. Both
 * were built from ONE descriptor — `rowView` in ./notifications.js — so the
 * copy had a single source while the two coexisted. Slice 6's fourth
 * conversion made the drawer render the React rows, and THE UI OVERHAUL then
 * retired the drawer outright, so there is one renderer left.
 *
 * The descriptor split stays, because it is what keeps
 * ./notifications-list.tsx purely presentational: it imports nothing from the
 * controller and never reaches for `window`. That is also what let the list be
 * lifted wholesale into the hamburger — see features/header/header-menu.tsx —
 * without the module noticing.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The initial value is the PRERENDER state, and it has to be: the SSG pass in
 * frontend/scripts/build-shell.mjs renders this island in Node, and the
 * hand-written shell shipped all three containers empty (with #notifications-
 * empty carrying `hidden`). `list: null` and `invites: null` mean "nothing has
 * been fetched yet", which renders exactly that.
 */
export const notificationsStore = createStore({
  /** #1280: null until the first _renderSaved; else saved-message descriptors. */
  saved: null,
  /** null until the first _renderInvites; else an array of invite descriptors. */
  invites: null,
  /**
   * null until the first _renderList; else the flat, newest-first array of row
   * descriptors (#1385). It carried a mix of `{type:'row'}` and `{type:'group'}`
   * entries while the list nested; there is one shape now.
   */
  list: null,
  /**
   * The full-screen Notifications view's list (Streamlined Concept): EVERY
   * fetched row, read and unread, in the same newest-first order — the
   * screen's All | Unread tabs and Today/Earlier sections partition it
   * client-side, so it never depends on the drawer's `showOlder` reveal.
   * Published from the same _renderList pass that fills `list`.
   */
  screenList: null,
  /** The "you'll get pinged here" hint. Hidden in the shipped markup. */
  empty: false,
  /**
   * Caught up: nothing unread, but there ARE read ones behind "See older"
   * (#1367 follow-up). Distinct from `empty`, which still means "you have
   * never had a notification" — telling a viewer that when they have a month
   * of history reads as the drawer having lost it.
   */
  caughtUp: false,
  /** How many read notifications the older view would reveal. */
  olderCount: 0,
  /** Whether the older ones are currently revealed. Per drawer open. */
  showOlder: false,
  /**
   * Whether the server has older pages behind the keyset cursor, i.e. whether
   * the list's foot pager is offered (#1385). Distinct from `olderCount`, which
   * counts READ rows already fetched and sitting behind the show-older toggle:
   * one reveals what is in hand, the other goes and gets more.
   */
  canLoadMore: false,
  /** A page is in flight — the pager says so and stops taking clicks. */
  loadingMore: false,
  /** PlatformUI.isTouch() at render time — gates the swipe-action wiring. */
  touch: false,
  /**
   * Streamlined Concept: ids of dev sessions with an UNREAD session-kind
   * notification, published by Notifications._renderBadge. The app-context
   * sheet's change rows read it to draw their unread dot.
   */
  sessionUnreadIds: [],
});
