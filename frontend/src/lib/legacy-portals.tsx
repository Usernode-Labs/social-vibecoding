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
 * 1. **Unmount BEFORE the assignment that discards the host.** A legacy owner
 *    that replaces a host's contents detaches it without telling React, and an
 *    entry pointing at a detached node keeps its subtree — and its store
 *    subscriptions — alive for the life of the page. Callers still do this
 *    where they know about it (`AppView._teardownDevRoots`,
 *    `GroupChat.mountThread` dropping the transcript before re-rendering the
 *    shell). `pruneDetachedLegacyPortals` below is the backstop for the hosts
 *    nobody is in a position to know about: a Dev sub-view swap re-renders
 *    `#app-content`'s portal, and React discards `#dev-chat-body`,
 *    `#dev-topic-thread` and everything beneath them without telling any of
 *    their owners either.
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

import { Island } from './island-boundary';

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

/**
 * Drop every entry whose host has left the document.
 *
 * A detached host can never render anything a reader sees, but its entry keeps
 * the subtree — and every store subscription and effect inside it — alive for
 * the life of the page. Rule 1 above is the caller's obligation to unmount
 * BEFORE discarding a host; this is the backstop for the hosts a caller does
 * not know about, which on the Dev screen is most of them: swapping sub-views
 * re-renders `#app-content`'s portal, and React discards `#dev-chat-body`,
 * `#dev-topic-thread` and everything under them without any of their owners
 * being told.
 *
 * Safe as a sweep rather than a decision, because it is not a heuristic: an
 * entry whose `host.isConnected` is false is unreachable by definition. A host
 * that is detached and later re-attached simply re-mounts, with a new `seq` —
 * which is the conservative outcome anyway (reconciling over DOM the legacy
 * owner may have replaced is the thing `seq` exists to prevent).
 *
 * `keep` is the host currently being mounted, which a caller may legitimately
 * hand over before attaching it.
 */
export function pruneDetachedLegacyPortals(keep?: Element | null): boolean {
  let dropped = false;
  for (const host of [...entries.keys()]) {
    if (host === keep || host.isConnected) continue;
    entries.delete(host);
    dropped = true;
  }
  return dropped;
}

/** Render `node` into `host` from the main tree, creating the entry on first call. */
export function mountLegacyPortal(host: Element | null, node: ReactNode): void {
  if (!host) return;
  // Every mount is a surface swap, which is exactly when the previous
  // surface's inner hosts have just been discarded. Sweeping here means no
  // caller has to enumerate them.
  pruneDetachedLegacyPortals(host);
  const existing = entries.get(host);
  // First mount into this host: replace whatever the previous surface left in
  // it. Chunk G's interim `createRoot(host).render()` did this implicitly —
  // React documents that a root's first render replaces the container's
  // existing content — and it is still what a host filled by a legacy
  // template needs, because a portal only APPENDS to its container: without
  // the clear the new surface mounts BELOW the stale markup and the
  // navigation looks dead. On a re-mount (live entry) the children are
  // React-owned — leave them to the reconciler.
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
    ...live.map((entry) => createPortal(
      // Per ENTRY, not around the whole map: without it one portalled region
      // throwing takes every other portal down with it, and then the root —
      // see ./island-boundary.tsx for what "and then the root" costs when the
      // root is `document.body`.
      createElement(Island, { name: `portal:${entry.host.id || 'anonymous'}` }, entry.node),
      entry.host,
      `legacy-portal-${entry.seq}`,
    )),
  );
}
