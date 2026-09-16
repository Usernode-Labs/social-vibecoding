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
 * The cost is that popping it also runs the shell's popstate handler at an
 * unchanged address. That is already a supported path rather than a new one:
 * `_routeFromHash` guards its previous-route bookkeeping on a real change
 * precisely because "one history traversal fires popstate AND hashchange, so
 * this runs twice in a tick with the address already settled".
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

/** What a dismissible surface answers when back reaches it. */
export type DismissResult = boolean | void;

export interface BackStackEntry {
  close: () => DismissResult;
}

export interface BackStack {
  /** Claim the next back press. Returns the release for when it closes. */
  push(close: () => DismissResult): () => void;
  /** Run one back press. True when a surface consumed it. */
  handlePop(): boolean;
  readonly size: number;
}

type HistoryLike = {
  state?: unknown;
  pushState(state: unknown, title: string): void;
  back(): void;
};
type WindowLike = { history: HistoryLike };

/** The marker on our own records, so they are recognisable in a debugger. */
export const DISMISS_STATE_KEY = '__unDismissDepth';

export function createBackStack(win: WindowLike): BackStack {
  const stack: BackStackEntry[] = [];
  // Set while we spend a record ourselves, so the popstate it causes is not
  // read as a fresh press. Cleared by that popstate, or by a push that
  // overtakes it.
  let selfSpent = false;

  const record = () => {
    try {
      const prev = (win.history.state ?? null) as Record<string, unknown> | null;
      win.history.pushState({ ...(prev || {}), [DISMISS_STATE_KEY]: stack.length }, '');
    } catch {
      /* A history a sandbox will not let us write is not worth throwing over. */
    }
  };

  function push(close: () => DismissResult): () => void {
    const entry: BackStackEntry = { close };
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

  return {
    push,
    handlePop,
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

if (typeof window !== 'undefined') {
  shared = createBackStack(window);
  (window as unknown as { UsernodeBackStack?: BackStack }).UsernodeBackStack = shared;
  window.addEventListener('popstate', () => {
    shared?.handlePop();
  });
}
