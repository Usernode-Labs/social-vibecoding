/**
 * Runtime-injected regions, rendered from the MAIN React tree (#1085 chunk H).
 *
 * ── What this replaces ─────────────────────────────────────────────────
 *
 * Chunk G (#1084) mounted the Dev board and the Dev session chat with their own
 * `createRoot` per host, because `#app-content` ships empty and every Dev
 * surface is written into it at runtime by `AppView.renderDevView()` — there was
 * nothing in the prerendered document for the body root to hydrate. That helper
 * (`lib/interim-root.ts`) said in its own header that chunk H folds these
 * regions into the main tree and its call sites disappear. This is that file.
 *
 * A portal is strictly better than a second root for the same job:
 *
 * - **One reconciler, one tree.** Context, error boundaries and the visibility
 *   store are shared with the rest of the shell instead of being re-provided per
 *   root, and React batches a Dev-board update together with whatever else the
 *   same event touched.
 * - **No `createRoot`-on-a-live-container class of bug.** The "already passed to
 *   createRoot()" warning is a `console.error`, and a console error on any route
 *   fails the platform's proposal checks. There is now exactly one root in the
 *   document (main.tsx's `hydrateRoot`), so that warning is unreachable.
 * - **Nothing to leak.** An orphaned root keeps its effects alive; an unmounted
 *   portal is just an absent child of the main tree.
 *
 * ── The two rules that carry over ──────────────────────────────────────
 *
 * 1. **Unmount BEFORE the `innerHTML` assignment that discards the host.** Every
 *    Dev surface swap replaces `#app-content.innerHTML`, which detaches the host
 *    without telling React. The legacy owner still calls `unmount` /
 *    `unmountAll` first (see `AppView._teardownDevRoots`) so the effects inside
 *    stop when the node they wrote into goes away.
 * 2. **Synchronous mount.** Callers read the DOM on their next line —
 *    `document.getElementById('dev-chat-card').addEventListener(…)`,
 *    `PlatformUI.pullToRefresh(devScroll, …)`, `AppView._repaintDevBody()` —
 *    exactly as they did when the line above was an `innerHTML` assignment.
 *    Publishing inside `flushSync` restores that contract, the same reason
 *    main.tsx wraps the initial hydration in it.
 *
 * `<LegacyPortals/>` renders NO DOM of its own, so adding it to `<Shell/>`
 * changes neither the prerendered document nor what hydration adopts.
 */

import { Fragment, createElement, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';

interface PortalEntry {
  host: Element;
  node: ReactNode;
  /**
   * Stable per host-occupancy, and used as the portal's React key. A host that
   * is re-mounted after an unmount gets a NEW seq, so React treats it as a new
   * child and remounts the subtree rather than reconciling over DOM the legacy
   * owner may have replaced underneath it.
   */
  seq: number;
}

const entries = new Map<Element, PortalEntry>();
const listeners = new Set<() => void>();
let seqCounter = 0;

/** Immutable snapshot — `useSyncExternalStore` compares it by reference. */
let snapshot: PortalEntry[] = [];
const EMPTY: PortalEntry[] = [];

function publish(): void {
  snapshot = [...entries.values()];
  for (const listener of [...listeners]) listener();
}

/**
 * Republish inside `flushSync` so the portal's DOM exists (or is gone) by the
 * time the legacy caller's next statement runs. Updates that originate outside
 * React are batched by default in React 18, which would break rule 2 above.
 */
function commit(): void {
  flushSync(publish);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Render `node` into `host` from the main tree, creating the entry on first call. */
export function mountLegacyPortal(host: Element | null, node: ReactNode): void {
  if (!host) return;
  const existing = entries.get(host);
  // First mount into this host: replace whatever the previous surface left in
  // it. Chunk G's interim `createRoot(host).render()` did this implicitly —
  // React documents that a root's first render replaces the container's
  // existing content — and the Dev surface swaps rely on it: the topic
  // sub-view is still a hand-written innerHTML template, so its markup is
  // what occupies #app-content when the user navigates Back to the board. A
  // portal only APPENDS to its container, so without this clear the new
  // surface mounts BELOW the stale one and the navigation looks dead. On a
  // re-mount (live entry) the children are React-owned — leave them to the
  // reconciler.
  if (!existing) host.replaceChildren();
  entries.set(host, { host, node, seq: existing ? existing.seq : ++seqCounter });
  commit();
}

/** Drop the portal rendered into `host`, if any. Safe for an unknown host. */
export function unmountLegacyPortal(host: Element | null): void {
  if (!host) return;
  if (!entries.delete(host)) return;
  commit();
}

/**
 * Drop every live portal.
 *
 * The Dev surfaces are mutually exclusive and each swap discards whatever the
 * previous one mounted, so the owner calls this once at the top of
 * `renderDevView` rather than tracking which branch ran last.
 */
export function unmountAllLegacyPortals(): void {
  if (!entries.size) return;
  entries.clear();
  commit();
}

/** Live portal count — the leak assertion in tests/dev-board-island.test.js. */
export function legacyPortalCount(): number {
  return entries.size;
}

/** The main tree's mount point for every runtime-injected region. */
export function LegacyPortals(): ReactNode {
  const live = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
  return createElement(
    Fragment,
    null,
    ...live.map((entry) => createPortal(entry.node, entry.host, `legacy-portal-${entry.seq}`)),
  );
}
