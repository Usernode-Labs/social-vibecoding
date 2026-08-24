/**
 * The legacy → React seam for the dev chat.
 *
 * ── Why a bridge, when dev-chat.js is in this very bundle ─────────────
 *
 * It could import directly — it is an ES module a few files away — and the
 * first attempt did. It cost 194 tests: a dozen test files load
 * `features/dev-chat/dev-chat.js` into a `vm` context as a SCRIPT, with
 * `vm.runInContext(SRC)`, so they can drive `DevChat` against a DOM stub, and
 * a top-level `import` is a syntax error there.
 *
 * So the module stays import-free and reaches React by name, exactly as the
 * classic scripts in public/js/** do. That is a real constraint on this file's
 * neighbour rather than a stylistic choice, and it will hold for every further
 * piece of the dev chat's conversion.
 *
 * Published at module-evaluation time, like ../dev-board/mount.ts, so the API
 * exists before hydration and therefore long before anything can reach the
 * chat. The `typeof window` guard is not decoration: the SSG prerender pass
 * evaluates this module graph in Node.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { DevAttachStrip } from './attach-strip';
import { attachStripStore, type AttachStripState } from './attach-strip-store';
import { BudgetPill } from './budget-pill';
import { budgetPillStore, type BudgetPillState } from './budget-pill-store';
import { QuickReplies, RunnerControls } from './composer-chrome';
import {
  quickRepliesStore,
  runnerStore,
  type QuickRepliesState,
  type RunnerState,
} from './composer-chrome-store';
import { DevChatBanners } from './banners';
import { bannersStore, type BannersState } from './banners-store';
import { SessionHeader } from './session-header';
import { sessionHeaderStore, type SessionHeaderState } from './session-header-store';
import { SessionList } from './session-list';
import { sessionListStore, type SessionListState } from './session-list-store';

export interface DevChatBridge {
  mountAttachStrip(host: Element | null): void;
  unmountAttachStrip(host: Element | null): void;
  publishAttachStrip(state: AttachStripState): void;
  mountBudgetPill(host: Element | null): void;
  publishBudgetPill(state: BudgetPillState): void;
  mountQuickReplies(host: Element | null): void;
  publishQuickReplies(state: QuickRepliesState): void;
  mountRunnerControls(host: Element | null): void;
  publishRunner(state: RunnerState): void;
  mountSessionList(host: Element | null, state: SessionListState): void;
  publishSessionList(state: SessionListState): void;
  mountSessionHeader(host: Element | null, state: SessionHeaderState): void;
  publishSessionHeader(state: SessionHeaderState): void;
  mountBanners(host: Element | null, state: BannersState): void;
  publishBanners(state: BannersState): void;
}

// Both of `renderChatView`'s converted STRIPS flush synchronously, and for the
// same reason the dev board's stores do: the line that used to publish them
// was an `innerHTML` or an `outerHTML` assignment, so every caller was written
// against a DOM that had already changed by the next statement.
// `_maybeOpenShotVenueSheet` resolves `#dc-venue-select` on the line after the
// header mounts, and every `_apply*Banner` inherited a caller that could do the
// same. Restoring the contract costs a synchronous render of one small strip.
sessionHeaderStore.setFlush(flushSync);
bannersStore.setFlush(flushSync);

export const devChatBridge: DevChatBridge = {
  // `renderChatView` rebuilds `#dc-attachments` on every chat-view render, so
  // this mounts per publish; the previous host's entry is swept as detached
  // (lib/legacy-portals.tsx). Only the ROWS are React's — the element and its
  // `dc-attach-strip-active` class stay the module's, because the template
  // writes the element.
  mountAttachStrip(host) {
    if (!host) return;
    mountLegacyPortal(host, createElement(DevAttachStrip));
  },

  unmountAttachStrip(host) {
    if (!host) return;
    unmountLegacyPortal(host);
  },

  publishAttachStrip(state) {
    attachStripStore.set(state);
  },

  // The credit meter. `#dc-budget` is written by `renderChatView`'s template
  // and a dapp.json check selects it as a SIBLING of `#dc-venue-detail`, so
  // the element stays the module's and only its children are React's.
  mountBudgetPill(host) {
    if (!host) return;
    mountLegacyPortal(host, createElement(BudgetPill));
  },

  publishBudgetPill(state) {
    budgetPillStore.set(state);
  },

  // The suggestion pills. The bar and its active class stay the module's —
  // one delegated click is bound on that element per `renderChatView`.
  mountQuickReplies(host) {
    if (!host) return;
    mountLegacyPortal(host, createElement(QuickReplies));
  },

  publishQuickReplies(state) {
    quickRepliesStore.set(state);
  },

  // The "Run on" strip, which draws nothing at all in the common case.
  mountRunnerControls(host) {
    if (!host) return;
    mountLegacyPortal(host, createElement(RunnerControls));
  },

  publishRunner(state) {
    runnerStore.set(state);
  },

  // The app's own session list. `renderChatView` writes `#dc-session-list`
  // (the element carries the pane's scroll geometry) and calls the renderer
  // on the very next line, so the rows ride in WITH the mount: publishing
  // after it would paint an empty list for one frame on every render.
  mountSessionList(host, state) {
    if (!host) return;
    sessionListStore.set(state);
    mountLegacyPortal(host, createElement(SessionList));
  },

  publishSessionList(state) {
    sessionListStore.set(state);
  },

  // The session header strip. Same shape as the session list above — the
  // element is `renderChatView`'s and the children are ours, and the state
  // rides in with the mount so the one row that is constant on this screen
  // never paints empty.
  mountSessionHeader(host, state) {
    if (!host) return;
    sessionHeaderStore.set(state);
    mountLegacyPortal(host, createElement(SessionHeader));
  },

  // `_patchHeaderStatusPill` — the mid-turn lifecycle repaint. It wrote
  // `#dc-status-pill.innerHTML` in place precisely so a live stream was not
  // disturbed by a full `renderChatView`; a publish here re-renders the
  // header alone and leaves the transcript's portal untouched.
  publishSessionHeader(state) {
    sessionHeaderStore.set(state);
  },

  // The four banners. `#dc-banners` is a `display: contents` host, so what
  // mounts here are still `#dc-view`'s own flex children.
  mountBanners(host, state) {
    if (!host) return;
    bannersStore.set(state);
    mountLegacyPortal(host, createElement(DevChatBanners));
  },

  // Every `_apply*Banner` lands here. They were three copies of an
  // outerHTML-swap / remove / insertAdjacentHTML dance whose whole purpose was
  // to change a strip WITHOUT re-rendering the transcript under an in-flight
  // stream; a publish does that by construction.
  publishBanners(state) {
    bannersStore.set(state);
  },
};

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.devChat = devChatBridge;
}
