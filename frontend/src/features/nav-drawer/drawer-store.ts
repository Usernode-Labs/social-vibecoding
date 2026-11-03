/**
 * THE PHONE'S COMMUNITY HEADER: WHETHER IT APPLIES, AND WHAT IT SHOWS.
 *
 * Under 768px a community's page draws its header from here: the arrow (or,
 * on the Hub, the grid that opens all your communities), the community over
 * its place, and the community's colour (./header-drawer.tsx).
 *
 * THE DRAWER IS GONE (Evan, 3 Nov 2026: "lose one layer of sidebar"). Until
 * then a community's page was the deepest of three levels on one strip, your
 * communities at 85% and its places at 80%, which the arrow, the lit tab
 * and a pan slid between, and which held a Back record while off the page.
 * The page is the only level now: a community opens on its Hub, the Hub's
 * rows are the way to its places, the arrow goes up to the Hub, and the
 * Hub's grid to All communities, each an ordinary navigation. The live
 * depth stays (./header-drawer.tsx draws Messages' and the bot tab's header
 * from theirs); Communities' rests on the page.
 *
 * Nothing here touches the DOM.
 */

import { createStore } from '../../lib/plain-store.js';
import { easeOut, REDUCED_MS, SLIDE_MS } from './drawer-math';

/** The community the header shows. */
export interface Shown {
  slug: string | null;
  name: string;
  /** Homeroom's own community, whose name is the logotype. */
  selfHosted: boolean;
  /** The place its page shows (./../dev-board/workshop/places.ts keys). */
  place: string;
}

export interface DrawerState {
  /** It applies: a phone's width, with a community's page on show. */
  on: boolean;
  shown: Shown;
}

const NOTHING_SHOWN: Shown = { slug: null, name: '', selfHosted: false, place: 'status' };

export const drawerStore = createStore<DrawerState>({ on: false, shown: NOTHING_SHOWN });

/* ── The live depth ─────────────────────────────────────────────────── */

/**
 * One drawer's live depth: where its strip is now, which its header draws
 * from. Messages' (./messages-drawer.ts) and the bot tab's (./bot-drawer.ts)
 * run 0 to 1, each on a channel of its own, so two can never draw over each
 * other while one turns off and the other on. Communities' rests at 2, the
 * page's depth in ./drawer-math.ts headerFrame.
 */
export interface DepthChannel {
  live(): number;
  /** Follow it. Returns the undo. */
  on(listener: (f: number) => void): () => void;
  /** A finger sets it. */
  set(f: number): void;
  /** A tap animates it to `target` over the slide, on the slide's curve. */
  slide(target: number): void;
  /** Put it at `target` at once. */
  cut(target: number): void;
}

export function reducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createDepthChannel(rest: number, deepest: number): DepthChannel {
  let depth = rest;
  let frame = 0;
  const listeners = new Set<(f: number) => void>();
  const clamp = (f: number) => (Number.isFinite(f) ? Math.max(0, Math.min(deepest, f)) : rest);
  const draw = (f: number) => {
    depth = clamp(f);
    for (const listener of [...listeners]) listener(depth);
  };
  const stop = () => {
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
  };
  return {
    live: () => depth,
    on(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(f) {
      stop();
      draw(f);
    },
    cut(target) {
      stop();
      draw(target);
    },
    slide(target) {
      stop();
      const from = depth;
      const to = clamp(target);
      if (from === to || typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') {
        draw(to);
        return;
      }
      const ms = reducedMotion() ? REDUCED_MS : SLIDE_MS;
      const t0 = performance.now();
      const tick = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        draw(from + (to - from) * easeOut(k));
        frame = k < 1 ? requestAnimationFrame(tick) : 0;
      };
      frame = requestAnimationFrame(tick);
    },
  };
}

/** Communities' depth: the page's, where it rests. */
export const communitiesDepth = createDepthChannel(2, 2);

export function setShown(shown: Shown): void {
  const was = drawerStore.get().shown;
  if (was.slug === shown.slug && was.name === shown.name && was.selfHosted === shown.selfHosted && was.place === shown.place) return;
  drawerStore.set({ shown });
}

export function setOn(on: boolean): void {
  if (on === drawerStore.get().on) return;
  drawerStore.set({ on });
}
