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
}

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
};

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.devChat = devChatBridge;
}
