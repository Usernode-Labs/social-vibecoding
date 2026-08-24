/**
 * The legacy → React seam for the Dev board's runtime-injected regions
 * (#1084 chunk G; folded into the main React tree by #1085 chunk H).
 *
 * `public/js/app-view.js` is a classic script that runs before this bundle, so
 * it cannot import anything from here. It calls by name instead:
 * `window.UsernodeReact.devBoard.mountBoard(host, props)` where it used to
 * assign `content.innerHTML = …`.
 *
 * ── Why this is published at module scope, not from an effect ───────────
 *
 * ../../lib/legacy-dom.ts's `useLegacyBridge` publishes an island's controller
 * from a mount effect and queues anything the legacy side called first. That
 * shape is wrong here: these functions are not a controller for an already-
 * mounted island, they are what CREATES the mount, so queueing a call would mean
 * the Dev route paints nothing until something else flushed the queue. Publishing
 * at module-evaluation time — main.tsx imports this file above its
 * `hydrateRoot` — means the API exists before hydration, and therefore long
 * before `App.switchTab()` can reach `renderDevView()` on DOMContentLoaded. That
 * is the same ordering guarantee `initOffline()` relies on, for the same reason.
 *
 * The `typeof window !== 'undefined'` guard is not decoration: the SSG prerender
 * pass (frontend/scripts/build-shell.mjs) evaluates the whole module graph in
 * Node, and this file is in it.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';

import {
  mountLegacyPortal,
  unmountAllLegacyPortals,
  unmountLegacyPortal,
  legacyPortalCount,
} from '../../lib/legacy-portals';
import { AttrPopover } from './attr-popover';
import { attrPopoverStore, type AttrPopoverState } from './attr-popover-store';
import { DevBoardFrame, type DevBoardFrameProps } from './board-frame';
import { CardMenu } from './card-menu';
import { cardMenuStore, type CardMenuRowView } from './card-menu-store';
import { DevChatSubView } from './chat-frame';
import { IssueComments } from './issue-comments';
import { issueCommentsStore, type IssueCommentsState } from './issue-comments-store';
import { KanbanFilters } from './kanban-filters';
import { lockedNoticeStore } from './locked-notice-store';
import { kanbanFiltersStore, type KanbanFiltersState } from './kanban-filters-store';
import { DevSessionShell } from './session-frame';
import { VotingHelp, type VotingHelpProps } from './voting-help';
import { DevTopicSubView } from './topic-frame';
import { publishViewMode } from './view-mode-store';

/** What app-view.js passes for the card list. */
export interface MountBoardOptions extends DevBoardFrameProps {
  /** `AppView._getViewMode()`, used to seed the store before the first render. */
  viewMode: string;
  /**
   * Kept in the options shape, and deliberately UNUSED by the frame.
   *
   * The Dev screen drew its own Feed/Kanban tabs and this was their handler.
   * The tabs are the platform header's App/Feed/Kanban toggle now, so nothing
   * in the frame calls it — but app-view.js still passes it, and the store
   * seeding above is still what a cold `?view=kanban` deep link needs, so the
   * option is accepted and dropped here rather than removed from every caller.
   */
  onSelectViewMode?: (mode: string) => void;
}

export interface DevBoardBridge {
  mountBoard(host: Element | null, options: MountBoardOptions): void;
  mountChatSubView(
    host: Element | null,
    options: { backHref: string; onBackClick: (event: MouseEvent) => void },
  ): void;
  mountTopicSubView(
    host: Element | null,
    options: { backHref: string; onBackClick: (event: MouseEvent) => void },
  ): void;
  mountAttrPopover(host: Element | null): void;
  publishAttrPopover(patch: Partial<AttrPopoverState>): void;
  mountCardMenu(host: Element | null): void;
  publishCardMenu(rows: CardMenuRowView[]): void;
  publishLockedNotice(locked: boolean): void;
  mountIssueComments(host: Element | null): void;
  publishIssueComments(state: IssueCommentsState): void;
  mountKanbanFilters(host: Element | null): void;
  publishKanbanFilters(patch: Partial<KanbanFiltersState>): void;
  mountVotingHelp(host: Element | null, props: VotingHelpProps): void;
  mountSessionShell(host: Element | null): void;
  publishViewMode(mode: string): void;
  unmount(host: Element | null): void;
  unmountAll(): void;
  /** Live portal count — the leak assertion in tests reads this. */
  rootCount(): number;
}

/**
 * `setFlush(flushSync)` on the picker's store, and it is load-bearing twice:
 * `_renderAttrPopoverBody` focuses (and sometimes selects) the add box on the
 * line after it publishes, and `_openAttrPopover` re-measures the popover's
 * height once the real body has replaced the "Loading…" line — a popover
 * anchored low in the viewport has to flip above its chip, and a measurement
 * taken against the previous frame would place it off screen.
 */
attrPopoverStore.setFlush(flushSync);

/**
 * And the ⋯ menu's, for two reads on the lines after the publish:
 * `_positionCardMenu` measures the menu's width and height to decide whether
 * it flips above its trigger, and `_toggleCardMenu` focuses the first enabled
 * row. Both would run against an empty menu if the update were batched.
 */
cardMenuStore.setFlush(flushSync);

/**
 * The filter bar's too: `_renderKanbanFilterBar` mounts and publishes, and the
 * kanban entry path reads the bar back — and `_clearKanbanFilters` publishes a
 * new `seq` and then repaints the board, which must not see a half-applied
 * bar.
 */
kanbanFiltersStore.setFlush(flushSync);

export const devBoardBridge: DevBoardBridge = {
  mountBoard(host, options) {
    // Seed before the first render so a cold `?view=kanban` deep link paints
    // kanban immediately rather than list-then-kanban.
    publishViewMode(options.viewMode);
    const {
      viewMode: _viewMode,
      onSelectViewMode: _onSelectViewMode,
      ...rest
    } = options;
    mountLegacyPortal(host, createElement(DevBoardFrame, rest));
  },

  mountChatSubView(host, options) {
    mountLegacyPortal(
      host,
      createElement(DevChatSubView, {
        backHref: options.backHref,
        // React's synthetic event carries `nativeEvent`; NavLink.isNativeClick
        // reads modifier keys and `button`, both of which the synthetic event
        // exposes directly, so either would do. Passing the synthetic one keeps
        // `preventDefault()` on the React side, which is where it belongs.
        onBackClick: (event) => options.onBackClick(event as unknown as MouseEvent),
      }),
    );
  },

  // The same shape as mountChatSubView, and the same note about the synthetic
  // event applies.
  mountTopicSubView(host, options) {
    mountLegacyPortal(
      host,
      createElement(DevTopicSubView, {
        backHref: options.backHref,
        onBackClick: (event) => options.onBackClick(event as unknown as MouseEvent),
      }),
    );
  },

  // The metadata picker a card's chip opens. Its host is created and removed
  // by app-view.js on every open, so this mounts once per open; the previous
  // open's entry is swept by `pruneDetachedLegacyPortals`.
  mountAttrPopover(host) {
    mountLegacyPortal(host, createElement(AttrPopover));
  },

  // A patch, not a whole publish: the typeahead updates `suggestions` and
  // nothing else, and it runs while the rows are already on screen.
  publishAttrPopover(patch) {
    attrPopoverStore.set((s) => ({ ...s, ...patch }));
  },

  // The card's ⋯ menu. Its host is created on open and removed on close, but
  // it SURVIVES a board repaint — see ./card-menu-store.ts — so the rows are a
  // publish rather than a re-mount.
  mountCardMenu(host) {
    mountLegacyPortal(host, createElement(CardMenu));
  },

  publishCardMenu(rows) {
    cardMenuStore.set({ rows });
  },

  // The kanban board's filter strip. Mounted once per kanban entry; the feed
  // has no filters and publishes `mounted: false`, which draws nothing and
  // lets `empty:hidden` collapse the shared action row's host.
  // The issue thread. `_renderTopicHead` rebuilds its host on every
  // WS-driven refresh, so this mounts per fill; the previous host's entry is
  // swept as detached.
  publishLockedNotice(locked) {
    lockedNoticeStore.set({ locked });
  },

  mountIssueComments(host) {
    mountLegacyPortal(host, createElement(IssueComments));
  },

  publishIssueComments(state) {
    issueCommentsStore.set(state);
  },

  mountKanbanFilters(host) {
    mountLegacyPortal(host, createElement(KanbanFilters));
  },

  // A patch, so `_updateKanbanFilterBarUI` can leave one select's options
  // alone while its dropdown is open.
  publishKanbanFilters(patch) {
    kanbanFiltersStore.set((s) => ({ ...s, ...patch }));
  },

  // Read-only, computed once at open: the props ARE the publish.
  mountVotingHelp(host, props) {
    mountLegacyPortal(host, createElement(VotingHelp, props));
  },

  mountSessionShell(host) {
    mountLegacyPortal(host, createElement(DevSessionShell));
  },

  publishViewMode,
  unmount: unmountLegacyPortal,
  unmountAll: unmountAllLegacyPortals,
  rootCount: legacyPortalCount,
};

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.devBoard = devBoardBridge;
}
