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
 */

import { isEmbeddedPanel } from './side-panel-mode';

/** What a dismissible surface answers when back reaches it. */
export type DismissResult = boolean | void;

export interface BackStackEntry {
  close: () => DismissResult;
  /** The address the surface opened at — the one its record was pushed at. */
  href?: string | null;
}

export interface BackStack {
  /** Claim the next back press. Returns the release for when it closes. */
  push(close: () => DismissResult): () => void;
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
};
type WindowLike = { history: HistoryLike; location?: { href: string } };

/** The marker on our own records, so they are recognisable in a debugger. */
export const DISMISS_STATE_KEY = '__unDismissDepth';

export function createBackStack(win: WindowLike): BackStack {
  const stack: BackStackEntry[] = [];
  // Set while we spend a record ourselves, so the popstate it causes is not
  // read as a fresh press. Cleared by that popstate, or by a push that
  // overtakes it.
  let selfSpent = false;
  // Where that self-spent traversal started — see handlePopstate.
  let spentFrom: string | null = null;

  // The current address, or null where the host has none to report (a test
  // double), in which case no traversal is ever judged to be in place.
  const href = (): string | null => {
    try {
      return win.location?.href ?? null;
    } catch {
      return null;
    }
  };

  const record = () => {
    try {
      const prev = (win.history.state ?? null) as Record<string, unknown> | null;
      win.history.pushState({ ...(prev || {}), [DISMISS_STATE_KEY]: stack.length }, '');
    } catch {
      /* A history a sandbox will not let us write is not worth throwing over. */
    }
  };

  function push(close: () => DismissResult): () => void {
    const entry: BackStackEntry = { close, href: href() };
    stack.push(entry);
    selfSpent = false;
    record();
    return () => release(entry);
  }

  function release(entry: BackStackEntry): void {
    const at = stack.indexOf(entry);
    // Already gone: handlePop took it before the surface's own close ran,
    // which is the ordinary path when the viewer pressed back.
    if (at === -1) return;
    stack.splice(at, 1);
    // Not the top — somebody else's record is newer than ours. Dropping the
    // entry is enough; spending a record here would steal theirs.
    if (at !== stack.length) return;
    selfSpent = true;
    spentFrom = href();
    try {
      win.history.back();
    } catch {
      selfSpent = false;
    }
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
      record();
    }
    return true;
  }

  function handlePopstate(): boolean {
    // Read before handlePop, which clears the flag and pops the entry.
    const from = selfSpent ? spentFrom : (stack[stack.length - 1]?.href ?? null);
    const ours = selfSpent || stack.length > 0;
    spentFrom = null;
    handlePop();
    return ours && from !== null && href() === from;
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
export function pushDismissible(close: () => DismissResult): () => void {
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
