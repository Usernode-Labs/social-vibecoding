/**
 * The device back button, for things that are open rather than navigated to.
 *
 * SCREENS ALREADY WORK. Settings, admin, browse, apps and chats are hash
 * routes — `app.js` writes `location.hash` in seventeen places — so a device
 * back walks the browser history and the shell's own popstate handler
 * (`App._routeFromHash`) rebuilds the screen. Nothing here touches that.
 *
 * DIALOGS AND SHEETS DO NOT. They are React state with no history entry at
 * all, so the press falls past them: on Android it reached the native shell,
 * which had nothing left to pop and did nothing (usernode#1521), and once
 * that shell exits at its root instead, the same press would close the whole
 * app while the viewer was only trying to dismiss a dialog. A dismissible
 * surface has to own a history record for back to mean "close this".
 *
 * ── Why a same-URL record ──────────────────────────────────────────────
 *
 * Opening a dialog pushes a record at the SAME address. It is deliberately
 * not a route: a dialog is not a place, its identity is not in the URL, and
 * making it one would put every dialog in the shell's router and in every
 * shared link. The record exists only to give back something to consume.
 *
 * Popping it must therefore NOT reach the page's own popstate listeners, and
 * the shell's router (`App._routeFromHash`) above all. Re-running it at an
 * unchanged address is not the no-op it looks like: on a dev session page
 * `restoreFromHash` -> `switchTab` -> `renderDevView` rebuilds `#dev-section`
 * from scratch, so the whole transcript blanked for a few hundred ms every
 * time a dialog closed over it (#2811: "after submitting an issue on a dev
 * session page, the screen flickers"). The listener at the bottom of this
 * file runs in the capture phase and stops the event when `handlePopstate`
 * says the traversal was one of ours AND left the address where it was. A
 * traversal that did move the address (something navigated while the
 * surface was open) is passed on, because then there IS a route to restore.
 *
 * ── Dismissing by other means ──────────────────────────────────────────
 *
 * Tapping ✕ or the backdrop closes the surface without a back press, and the
 * record it pushed is still there. Left alone, the NEXT back would spend
 * itself on a dialog that is already gone. So a release consumes its own
 * record with `history.back()`, flagged so the popstate that follows is not
 * mistaken for the user pressing back.
 *
 * Only the TOP entry consumes a record. Releasing one underneath (two
 * surfaces closing out of order) would otherwise eat a record belonging to
 * something still open.
 *
 * ── Refusing to close ──────────────────────────────────────────────────
 *
 * `close()` may answer `false` — a dialog guarding unsaved work. The record
 * is then put back, so the surface keeps its claim on the next press instead
 * of silently handing it to whatever is underneath.
 *
 * ── Closing because something is navigating (QA 2026-09-24 Q16) ────────
 *
 * Sheets and menus close on the way to somewhere: a notification row, a menu
 * row, a link inside the profile editor. The caller closes the surface and
 * then writes the address in the same task. Spending the record there is
 * wrong in both of the ways a browser can order it: `history.back()` is
 * queued, the navigation lands first, and the queued traversal then either
 * undoes the navigation or is dropped and leaves the record behind it. So a
 * release can say `{ navigating: true }`: the entry leaves the stack at once,
 * and the record is spent one task later, and only if the page is still
 * standing on it. If an address was written in between, the record stays
 * where it is, under the new entry.
 *
 * Any release checks the same thing before it spends: a record is only ever
 * spent from on top of it. A dialog that closes after its own caller already
 * navigated (Leave group does exactly that) would otherwise send the viewer
 * back to the page they just left.
 *
 * ── A record nobody owns is a step to pass through ─────────────────────
 *
 * Every record carries an id, so a record whose surface has gone is
 * recognisable when a traversal lands on it. It sits at the same address as
 * the entry below it, so stopping there would cost the viewer a press that
 * does nothing. `handlePopstate` passes through it instead: onward in the
 * direction of travel, which the Navigation API reports where the browser
 * has it and which is otherwise taken to be back (the device button, and the
 * only direction a phone has).
 */

import { isEmbeddedPanel } from './side-panel-mode';

/** What a dismissible surface answers when back reaches it. */
export type DismissResult = boolean | void;

export interface BackStackEntry {
  close: () => DismissResult;
  /** The address the surface opened at — the one its record was pushed at. */
  href?: string | null;
  /** Written into the record, so the page can tell whether it stands on it. */
  id?: string;
  /**
   * The record's Navigation API key, where the browser has one. It survives a
   * `replaceState` over the record (the id in its state does not), so it is
   * the better answer to "is the page standing on it".
   */
  key?: string | null;
}

export interface ReleaseOptions {
  /**
   * The surface is closing because the caller is about to navigate, in this
   * same task. The record is spent a task later, and only if nothing moved.
   */
  navigating?: boolean;
}

/** Hand the claim back. See the header on navigating releases. */
export type Release = (options?: ReleaseOptions) => void;

export interface BackStack {
  /** Claim the next back press. Returns the release for when it closes. */
  push(close: () => DismissResult): Release;
  /** Run one back press. True when a surface consumed it. */
  handlePop(): boolean;
  /**
   * Run one popstate: `handlePop`, plus whether the traversal belonged
   * entirely to a surface — a press it consumed, or a release spending its own
   * record — and left the address unchanged. True means the rest of the page
   * must not see this popstate: nothing was navigated.
   */
  handlePopstate(): boolean;
  readonly size: number;
}

type HistoryLike = {
  state?: unknown;
  pushState(state: unknown, title: string): void;
  back(): void;
  forward?(): void;
};
/** The slice of the Navigation API this uses: which way a traversal went. */
type NavigationLike = {
  currentEntry?: { index: number; key?: string } | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  addEventListener?(
    type: 'currententrychange',
    listener: (event: { navigationType?: string; from?: { index: number; url?: string | null } | null }) => void,
  ): void;
};
type WindowLike = {
  history: HistoryLike;
  location?: { href: string };
  navigation?: NavigationLike | null;
  setTimeout?: (fn: () => void, ms?: number) => unknown;
};

/** The marker on our own records, so they are recognisable in a debugger. */
export const DISMISS_STATE_KEY = '__unDismissDepth';
/** Which surface a record belongs to. Unique per document. */
export const DISMISS_ID_KEY = '__unDismissId';

export function createBackStack(win: WindowLike): BackStack {
  const stack: BackStackEntry[] = [];
  // Set while we spend a record ourselves, so the popstate it causes is not
  // read as a fresh press. Cleared by that popstate, or by a push that
  // overtakes it.
  let selfSpent = false;
  // Where that self-spent traversal started — see handlePopstate.
  let spentFrom: string | null = null;
  // Which way a pass through an unowned record is going, while it goes.
  let skipping: 'back' | 'forward' | null = null;

  // Ids are unique per document: a counter under a per-document prefix, so a
  // record left by an earlier load never matches a surface open in this one.
  const idPrefix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}:`;
  let nextId = 0;

  // The current address, or null where the host has none to report (a test
  // double), in which case no traversal is ever judged to be in place.
  const href = (): string | null => {
    try {
      return win.location?.href ?? null;
    } catch {
      return null;
    }
  };

  // The id of the record the page is standing on, if it is standing on one.
  const currentId = (): string | null => {
    try {
      const state = win.history.state as Record<string, unknown> | null | undefined;
      const id = state && typeof state === 'object' ? state[DISMISS_ID_KEY] : null;
      return typeof id === 'string' ? id : null;
    } catch {
      return null;
    }
  };

  // The direction of the traversal that is landing now, from the Navigation
  // API where there is one — its `currententrychange` fires before popstate.
  const nav = win.navigation || null;
  const currentKey = (): string | null => {
    try {
      return nav?.currentEntry?.key ?? null;
    } catch {
      return null;
    }
  };
  // Keys of records left behind by a surface that has gone. The ids in their
  // state answer the same question, unless something replaced that state.
  const deadKeys = new Set<string>();

  // A record whose surface has gone: released, closed out of order, or left
  // under a navigation.
  const unownedHere = (): boolean => {
    const id = currentId();
    if (id !== null && !stack.some((entry) => entry.id === id)) return true;
    const key = currentKey();
    return key !== null && deadKeys.has(key) && !stack.some((entry) => entry.key === key);
  };

  // Is the page on this entry's record right now?
  const standingOn = (entry: BackStackEntry): boolean => {
    const key = currentKey();
    if (entry.key && key) return key === entry.key;
    return currentId() === entry.id;
  };

  // Left behind: remembered, so a traversal onto it passes through.
  const abandon = (entry: BackStackEntry) => {
    if (entry.key) deadKeys.add(entry.key);
  };
  let traversedFrom: { index: number; url: string | null } | null = null;
  try {
    nav?.addEventListener?.('currententrychange', (event) => {
      traversedFrom = event.navigationType === 'traverse' && event.from
        ? { index: event.from.index, url: event.from.url ?? null }
        : null;
    });
  } catch {
    /* No Navigation API: every pass through goes back. */
  }
  const traversal = (): { dir: 'back' | 'forward'; from: string | null } | null => {
    const from = traversedFrom;
    traversedFrom = null;
    const at = nav?.currentEntry?.index;
    if (!from || typeof at !== 'number' || at === from.index) return null;
    return { dir: at < from.index ? 'back' : 'forward', from: from.url };
  };

  const later = (fn: () => void) => {
    const schedule = win.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
    if (schedule) schedule(fn, 0);
    else fn();
  };

  const record = (entry: BackStackEntry) => {
    try {
      const prev = (win.history.state ?? null) as Record<string, unknown> | null;
      win.history.pushState({
        ...(prev || {}),
        [DISMISS_STATE_KEY]: stack.length,
        [DISMISS_ID_KEY]: entry.id,
      }, '');
      entry.key = currentKey();
    } catch {
      /* A history a sandbox will not let us write is not worth throwing over. */
    }
  };

  // Spend the record the page is standing on, flagged as ours.
  function spend(): void {
    selfSpent = true;
    spentFrom = href();
    try {
      win.history.back();
    } catch {
      selfSpent = false;
    }
  }

  // Keep travelling past an unowned record, flagged as ours.
  function passThrough(dir: 'back' | 'forward'): void {
    // Nowhere to go that way: stay put rather than hold `selfSpent` for a
    // traversal that is never coming.
    if (dir === 'forward' && !(nav?.canGoForward && win.history.forward)) return;
    if (dir === 'back' && nav && nav.canGoBack === false) return;
    selfSpent = true;
    spentFrom = href();
    skipping = dir;
    try {
      if (dir === 'back') win.history.back();
      else win.history.forward?.();
    } catch {
      selfSpent = false;
      skipping = null;
    }
  }

  function push(close: () => DismissResult): Release {
    nextId += 1;
    const entry: BackStackEntry = { close, href: href(), id: `${idPrefix}${nextId}` };
    stack.push(entry);
    selfSpent = false;
    skipping = null;
    record(entry);
    return (options?: ReleaseOptions) => release(entry, options);
  }

  function release(entry: BackStackEntry, options?: ReleaseOptions): void {
    const at = stack.indexOf(entry);
    // Already gone: handlePop took it before the surface's own close ran,
    // which is the ordinary path when the viewer pressed back.
    if (at === -1) return;
    stack.splice(at, 1);
    // Not the top — somebody else's record is newer than ours. Dropping the
    // entry is enough; spending a record here would steal theirs. Ours is now
    // unowned, so a traversal that lands on it later passes through.
    if (at !== stack.length) {
      abandon(entry);
      return;
    }
    if (options?.navigating) {
      // See the header: the caller is about to write an address.
      later(() => {
        if (standingOn(entry)) spend();
        else abandon(entry);
      });
      return;
    }
    // Only ever spent from on top of it. Somewhere else, a back() would take
    // the viewer off the page they are on.
    if (!standingOn(entry)) {
      abandon(entry);
      return;
    }
    spend();
  }

  function handlePop(): boolean {
    if (selfSpent) {
      selfSpent = false;
      return false;
    }
    const top = stack[stack.length - 1];
    if (!top) return false;
    stack.pop();
    // Popped BEFORE close runs, so the surface's own release finds nothing
    // and does not spend a second record.
    if (top.close() === false) {
      stack.push(top);
      record(top);
    }
    return true;
  }

  function handlePopstate(): boolean {
    // Read before handlePop, which clears the flag and pops the entry.
    const from = selfSpent ? spentFrom : (stack[stack.length - 1]?.href ?? null);
    const ours = selfSpent || stack.length > 0;
    const passing = skipping;
    skipping = null;
    const travelled = traversal();
    spentFrom = null;
    const consumed = handlePop();
    let inPlace = ours && from !== null && href() === from;
    // Landed on a record whose surface has gone (QA 2026-09-24 Q16). A press
    // a surface just consumed was a step back; a pass already under way keeps
    // its direction; otherwise the browser says which way, or it is back.
    if (unownedHere()) {
      const dir = consumed ? 'back' : (passing || travelled?.dir || 'back');
      // Arriving from the entry below it, at the same address: nothing moved.
      if (!ours && travelled?.from && travelled.from === href()) inPlace = true;
      passThrough(dir);
    }
    return inPlace;
  }

  return {
    push,
    handlePop,
    handlePopstate,
    get size() {
      return stack.length;
    },
  };
}

// ── The shell's one instance ────────────────────────────────────────────
//
// Registered here rather than per surface: the order listeners run in decides
// who sees a press first, and one subscription keeps that answerable.

let shared: BackStack | null = null;

/** The shell's back stack, created on first use. */
export function backStack(): BackStack | null {
  return shared;
}

/**
 * Claim the next back press for a surface that is open now.
 *
 * A no-op returning a no-op where there is no window (the SSG prerender pass
 * evaluates this module's graph in Node), so callers need no guard.
 */
export function pushDismissible(close: () => DismissResult): Release {
  if (!shared) return () => {};
  return shared.push(close);
}

// NOT IN THE SIDE PANEL'S DOCUMENT (`?panel=1`, framed beside a running app).
// A frame's history entries are the top window's, so a record pushed there is
// a Back press the top window inherits, and the release's history.back() would
// move the TOP document. The panel is a desktop surface with no device back
// button to claim; its dialogs close by their own controls, and
// `pushDismissible` is a no-op there.
if (typeof window !== 'undefined' && !isEmbeddedPanel()) {
  shared = createBackStack(window);
  (window as unknown as { UsernodeBackStack?: BackStack }).UsernodeBackStack = shared;
  // Capture phase, so this runs before the shell router's own (bubble-phase)
  // popstate listener on the same target, whichever registered first; a
  // traversal that only closed a surface stops here (#2811).
  window.addEventListener('popstate', (event) => {
    if (shared?.handlePopstate()) event.stopImmediatePropagation();
  }, true);
}
