/**
 * The legacy → React seam for the staging-preview and visual-compare overlays
 * (#1085 chunk H, step 1).
 *
 * `public/js/app-view.js` is a classic script that runs before this bundle, so
 * it calls by name: `AppView._staging().setLoader(…)` resolves
 * `window.UsernodeReact.staging`. Published at module scope (main.tsx imports
 * this above `hydrateRoot`) for the same reason the Dev board's bridge is —
 * these calls must not queue, because the overlay is opened from a user gesture
 * that reads the DOM on its next line.
 *
 * app-view.js keeps an equivalent DOM adapter (`AppView._stagingDom`) for
 * contexts where this bundle is not present at all — the Node-side render tests
 * load app-view.js as a classic script into a stubbed document. Both adapters
 * implement the API below; exactly one of them is live in any given context, so
 * there is never a second writer for these nodes.
 *
 * The `typeof window !== 'undefined'` guard is load-bearing: the SSG prerender
 * pass evaluates this whole module graph in Node.
 */

import { flushSync } from 'react-dom';

import {
  stagingHandlers,
  stagingRefs,
  stagingStore,
  visualCompareHandlers,
  visualCompareStore,
} from './staging-store.js';

// Legacy callers read the DOM on their next statement (`_watchStagingIframeLoad`
// straight after `open()`), so store writes must land synchronously — the same
// contract an `innerHTML` assignment used to give them.
stagingStore.setFlush(flushSync);
visualCompareStore.setFlush(flushSync);

/** Counts genuine `src` assignments — the identity test asserts on this. */
let navigations = 0;

export interface StagingLoaderPatch {
  /** An EXPLICIT '' clears the line; `undefined` leaves it alone (#816). */
  title?: string;
  sub?: string;
}

export const stagingBridge = {
  open(): void {
    stagingStore.set({ open: true });
  },
  close(): void {
    stagingStore.set({
      open: false,
      loaderVisible: false,
      testBtnHidden: true,
      testPanelHidden: true,
      testHtml: '',
      fsBtnHidden: true,
    });
  },
  isOpen(): boolean {
    return stagingStore.get().open;
  },

  /** #771 — 'docked' | 'fullscreen'. Never touches the iframe. */
  setMode(mode: string): void {
    const docked = mode === 'docked';
    stagingStore.set(docked ? { mode: 'docked' } : { mode: 'fullscreen', dockRect: null });
  },
  mode(): string {
    return stagingStore.get().mode;
  },
  /** Pin the docked overlay over the dev-chat slot's rect (or release it). */
  setDockRect(rect: { top: number; left: number; width: number; height: number } | null): void {
    const next = rect
      ? { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }
      : null;
    const current = stagingStore.get().dockRect;
    if (next && current
      && current.top === next.top && current.left === next.left
      && current.width === next.width && current.height === next.height) return;
    stagingStore.set({ dockRect: next });
  },

  setUrlLabel(text: string): void {
    stagingStore.set({ urlLabel: text || '' });
  },

  setLoader(visible: boolean, patch: StagingLoaderPatch = {}): void {
    const next: Record<string, unknown> = { loaderVisible: !!visible };
    if (patch.title !== undefined) next.loaderTitle = patch.title;
    if (patch.sub !== undefined) next.loaderSub = patch.sub;
    stagingStore.set(next);
  },

  setTestBtn({ hidden, title }: { hidden: boolean; title?: string }): void {
    stagingStore.set({ testBtnHidden: !!hidden, testBtnTitle: title || '' });
  },
  setTestHtml(html: string): void {
    stagingStore.set({ testHtml: html || '' });
  },
  setTestPanelHidden(hidden: boolean): void {
    stagingStore.set({ testPanelHidden: !!hidden });
  },
  isTestPanelHidden(): boolean {
    return stagingStore.get().testPanelHidden;
  },

  setFullscreenBtn({ hidden, text, title }: { hidden: boolean; text?: string; title?: string }): void {
    stagingStore.set({
      fsBtnHidden: !!hidden,
      fsBtnText: text === undefined ? stagingStore.get().fsBtnText : text,
      fsBtnTitle: title || '',
    });
  },

  /** The live iframe element, or null before hydration. */
  frame(): HTMLIFrameElement | null {
    return stagingRefs.iframe as HTMLIFrameElement | null;
  },
  /**
   * Point the preview at `src`. The ONLY way its `src` ever changes, and an
   * imperative write by design — see staging-store.js.
   */
  setSrc(src: string): boolean {
    const el = stagingRefs.iframe as HTMLIFrameElement | null;
    if (!el || !src) return false;
    navigations += 1;
    el.src = src;
    return true;
  },
  /** `iframe.src = ''` — drops the previous preview without touching the element. */
  clearSrc(): void {
    const el = stagingRefs.iframe as HTMLIFrameElement | null;
    if (el) el.src = '';
  },

  setHandlers(patch: Record<string, unknown>): void {
    Object.assign(stagingHandlers, patch);
  },

  /** Diagnostics for tests/staging-iframe-identity.test.js. */
  stats(): { navigations: number } {
    return { navigations };
  },
};

export const visualCompareBridge = {
  open({ label, bodyHtml, openedAt }: { label: string; bodyHtml: string; openedAt: number }): void {
    visualCompareStore.set({
      open: true,
      openedAt: openedAt || 0,
      label: label || '',
      bodyHtml: bodyHtml || '',
    });
  },
  close(): void {
    // Clearing the body (rather than only hiding the overlay) is what stops a
    // looping <video> inside a comparison — see #353.
    visualCompareStore.set({ open: false, bodyHtml: '', label: '' });
  },
  openedAt(): number {
    return visualCompareStore.get().openedAt;
  },
  setHandlers(patch: Record<string, unknown>): void {
    Object.assign(visualCompareHandlers, patch);
  },
};

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.staging = stagingBridge;
  bridge.visualCompare = visualCompareBridge;
}
