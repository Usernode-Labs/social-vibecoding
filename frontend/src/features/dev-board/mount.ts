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

import {
  mountLegacyPortal,
  unmountAllLegacyPortals,
  unmountLegacyPortal,
  legacyPortalCount,
} from '../../lib/legacy-portals';
import { DevBoardFrame, type DevBoardFrameProps } from './board-frame';
import { DevChatSubView } from './chat-frame';
import { DevSessionShell } from './session-frame';
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
  mountSessionShell(host: Element | null): void;
  publishViewMode(mode: string): void;
  unmount(host: Element | null): void;
  unmountAll(): void;
  /** Live portal count — the leak assertion in tests reads this. */
  rootCount(): number;
}

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
