/**
 * THE PHONE'S NAVIGATION DRAWER: WHERE IT IS, AND THE ONE WAY TO MOVE IT.
 *
 * Under the Communities tab a phone shows your communities, a community's
 * places and the place's page as three levels of one strip (./drawer-math.ts,
 * ./nav-drawer.tsx). Three things move it and three draw from it:
 *
 *   moves:  the header's back arrow (`back`), the lit Communities tab
 *           (`pressTab`, ../workshop/tab-ladder.ts) and the drawer's own
 *           presses and pans (`go`);
 *   draws:  the drawer itself (the strip and the page under it, through the
 *           surface it registers), and the header's arrow, titles and colour
 *           (./header-drawer.tsx), which follow the LIVE DEPTH frame by frame.
 *
 * The live depth is not React state: a pan sets it on every pointer move and
 * a tap animates it over the slide, and the header writes its own nodes'
 * transforms from it (`onDepth`). React state is the level it rests on.
 *
 * THE DEVICE'S BACK. While the drawer is off the page (levels 0 and 1) it
 * holds a record in lib/back-stack.ts, as a sheet does, so Back on Android
 * returns to the page rather than leaving it. A press that navigates (a
 * place, another community) lets it go as a navigating release. The drawer
 * hands the push over (`setBackRecords`): back-stack listens on the window
 * the moment it loads, and the tab bar's tests load this store without one.
 *
 * Nothing here touches the DOM: the drawer registers the surface that does.
 */

import { createStore } from '../../lib/plain-store.js';
import { easeOut, REDUCED_MS, SLIDE_MS, type Level } from './drawer-math';

/** The community the drawer shows: its places are level 1, its page level 2. */
export interface Shown {
  slug: string | null;
  name: string;
  /** Homeroom's own community, whose name is the logotype. */
  selfHosted: boolean;
  /** The place its page shows (./../dev-board/workshop/places.ts keys). */
  place: string;
}

/** A community picked on level 0, from the press until its page is up. */
export interface Pending {
  slug: string;
  name: string;
  selfHosted: boolean;
  place: string;
}

export interface DrawerState {
  /** The drawer applies: a phone's width, with a community's page on show (or on its way). */
  on: boolean;
  /** The level it rests on. */
  level: Level;
  /** Level 0 is widened to the whole screen for its search. */
  searching: boolean;
  /** Out of its rest: a finger on it, or a slide back to the page still running. */
  moving: boolean;
  pending: Pending | null;
  shown: Shown;
}

const NOTHING_SHOWN: Shown = { slug: null, name: '', selfHosted: false, place: 'status' };

export const drawerStore = createStore<DrawerState>({
  on: false, level: 2, searching: false, moving: false, pending: null, shown: NOTHING_SHOWN,
});

/* ── The live depth ─────────────────────────────────────────────────── */

/**
 * One drawer's live depth: where its strip is now, which its header draws
 * from. Communities' runs 0 to 2; Messages' (./messages-drawer.ts) 0 to 1,
 * on a channel of its own, so the two can never draw over each other while
 * one turns off and the other on.
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

/** Communities' depth. */
export const communitiesDepth = createDepthChannel(2, 2);

/** Where the strip is now, between 0 and 2. */
export function liveDepth(): number {
  return communitiesDepth.live();
}

/** Follow the live depth. Returns the undo. */
export function onDepth(listener: (f: number) => void): () => void {
  return communitiesDepth.on(listener);
}

/** A finger sets it. */
export function setDepth(f: number): void {
  communitiesDepth.set(f);
}

/* ── The surface that moves ─────────────────────────────────────────── */

export interface Surface {
  /** Put the strip, and the page under it, at `level`: sliding, or at once (`cut`). */
  place(level: Level, cut: boolean): void;
  /** Level 0's list, which the lit tab scrolls to its top. */
  outerList(): HTMLElement | null;
}

let surface: Surface | null = null;

/** The drawer says how it moves, while it is mounted. Returns the undo. */
export function registerSurface(next: Surface): () => void {
  surface = next;
  return () => { if (surface === next) surface = null; };
}

/* ── The device's Back ──────────────────────────────────────────────── */

/** lib/back-stack.ts's Release: give the record back, as a navigating press or not. */
export type Release = (options?: { navigating?: boolean }) => void;
type PushRecord = (close: () => boolean) => Release;

let pushRecord: PushRecord | null = null;
let release: Release | null = null;

/** The drawer's island hands over lib/back-stack.ts's `pushDismissible`. */
export function setBackRecords(push: PushRecord): void {
  pushRecord = push;
}

/** While the drawer is off the page, Back returns to it. */
export function holdBack(): void {
  if (release || !pushRecord) return;
  release = pushRecord(() => {
    release = null;
    go(2, { viaBack: true });
    return true;
  });
}

/**
 * Give the record back. `navigating`: a press that is about to push an entry
 * of its own (a place, another community, a tab), so the record is left
 * under it rather than spent (lib/back-stack.ts, "Closing because something
 * is navigating").
 */
export function letGoBack(navigating = false): void {
  const r = release;
  release = null;
  r?.(navigating ? { navigating: true } : undefined);
}

/* ── Moving it ──────────────────────────────────────────────────────── */

export interface GoOptions {
  /** No slide: the strip and the header are put there at once. */
  cut?: boolean;
  /** The device's Back did it, and spent the record already. */
  viaBack?: boolean;
  /** A press that navigates did it (see letGoBack). */
  navigating?: boolean;
}

/** To `level`, sliding unless told otherwise. */
export function go(to: number, opts: GoOptions = {}): void {
  const s = drawerStore.get();
  if (!s.on) return;
  const level = Math.max(0, Math.min(2, Math.round(Number(to) || 0))) as Level;
  if (level < 2) holdBack();
  else if (!opts.viaBack) letGoBack(!!opts.navigating);
  const cut = !!opts.cut;
  drawerStore.set({
    level,
    searching: level === 0 ? s.searching : false,
    // Off the page the drawer is drawn anyway; back onto it, it is drawn
    // until the slide has run (the surface says when).
    moving: level === 2 && !cut,
  });
  surface?.place(level, cut || reducedMotion());
  if (cut) communitiesDepth.cut(level);
  else communitiesDepth.slide(level);
}

/**
 * The header's arrow: up one level; on your communities, back to the page.
 * A widened search narrows first.
 */
export function back(): void {
  const s = drawerStore.get();
  if (!s.on) return;
  if (s.searching) {
    setSearching(false);
    return;
  }
  // Level 0's is the way out: the page it came from, as the device's Back.
  if (s.level === 0) {
    go(2);
    return;
  }
  go(s.level - 1);
}

/**
 * The lit Communities tab (../workshop/tab-ladder.ts): one level at a time,
 * the page to its places, the places to your communities. On your
 * communities it narrows a widened search, else takes the list to its top.
 */
export function pressTab(): 'up' | 'top' | 'none' {
  const s = drawerStore.get();
  if (!s.on) return 'none';
  if (s.searching) {
    setSearching(false);
    return 'up';
  }
  if (s.level > 0) {
    go(s.level - 1);
    return 'up';
  }
  const list = surface?.outerList() || null;
  if (!list || list.scrollTop <= 2) return 'none';
  try {
    list.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  } catch {
    list.scrollTop = 0;
  }
  return 'top';
}

/** Level 0 widens while you search, and narrows again on Cancel or a pick. */
export function setSearching(searching: boolean): void {
  const s = drawerStore.get();
  const next = searching && s.on && s.level === 0;
  if (next === s.searching) return;
  drawerStore.set({ searching: next });
  surface?.place(s.level, reducedMotion());
}

/** The strip is out of its rest (a pan), or back in it (a slide ended). */
export function setMoving(moving: boolean): void {
  const s = drawerStore.get();
  if (s.moving !== moving) drawerStore.set({ moving });
  // Settled: whatever a slide did, the header lands on the resting frame.
  if (!moving && communitiesDepth.live() !== s.level) communitiesDepth.cut(s.level);
}

export function setPending(pending: Pending | null): void {
  drawerStore.set({ pending });
}

export function setShown(shown: Shown): void {
  const was = drawerStore.get().shown;
  if (was.slug === shown.slug && was.name === shown.name && was.selfHosted === shown.selfHosted && was.place === shown.place) return;
  drawerStore.set({ shown });
}

/**
 * The drawer applies, or stops applying (another tab, a wide window, a card
 * opened from the page). Either way it starts again on the page, at once: a
 * record still held is let go as a navigating release, because whatever
 * turned the drawer off has usually pushed an entry of its own.
 */
export function setOn(on: boolean): void {
  const s = drawerStore.get();
  if (on === s.on) return;
  letGoBack(true);
  communitiesDepth.cut(2);
  drawerStore.set({ on, level: 2, searching: false, moving: false, ...(on ? {} : { pending: null }) });
}
