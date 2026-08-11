/**
 * Interim React roots — chunk A's mechanism 4, implemented here for the first
 * time (#1084 chunk G).
 *
 * ── Why a second root at all ───────────────────────────────────────────
 *
 * Chunks A–F converted regions that are PRESENT IN THE PRERENDERED DOCUMENT:
 * `<Shell/>` renders them, `hydrateRoot(document.body, …)` adopts them, and the
 * legacy module that used to own the markup keeps only its subtree host. The
 * Dev board and the Dev session chat are not like that. `#app-content` ships
 * EMPTY (frontend/src/Shell.tsx) and every Dev surface is written into it at
 * runtime by `AppView.renderDevView()` — there is nothing in the document for
 * the body root to hydrate, and there cannot be, because which surface exists
 * depends on the route.
 *
 * So a runtime-injected region gets its own `createRoot` mounted by the
 * still-legacy owner at the point where that owner used to assign `innerHTML`.
 * The root is INTERIM: chunk H (#1085) folds these regions into the main tree
 * once `#app-content`'s router is itself React, and then this helper's call
 * sites disappear. Nothing here should grow features in the meantime.
 *
 * ── The three rules this file exists to enforce ────────────────────────
 *
 * 1. **One root per host, ever.** `createRoot` on a container that already has
 *    a root logs "You are calling ReactDOMClient.createRoot() on a container
 *    that has already been passed to createRoot() before" — a `console.error`,
 *    and a console error on any route fails the platform's proposal checks. The
 *    WeakMap below is keyed by the host NODE, so a re-entrant mount against a
 *    live host updates the existing root's props instead of creating a second
 *    one. WeakMap rather than Map because hosts are discarded wholesale when
 *    their parent's `innerHTML` is replaced, and we must not pin them.
 *
 * 2. **Unmount on host tear-down.** Every Dev surface swap replaces
 *    `#app-content.innerHTML`, which detaches the host without telling React.
 *    An orphaned root keeps its effects, subscriptions and store listeners
 *    alive, so the owner calls `unmountInterimRoot` (or
 *    `unmountAllInterimRoots`) BEFORE the assignment that discards the node.
 *    Unmounting a root whose container is already gone is safe but pointless —
 *    the effects have already leaked for the lifetime of the swap.
 *
 * 3. **Synchronous mount.** `root.render()` schedules work in a concurrent lane
 *    that can land in a later task. Every caller here reads the DOM on the next
 *    line — `document.getElementById('dev-chat-card').addEventListener(…)`,
 *    `PlatformUI.pullToRefresh(devScroll, …)`, `AppView._repaintDevBody()` —
 *    exactly as it did when the line above was an `innerHTML` assignment, which
 *    is synchronous. `flushSync` restores that contract, for the same reason
 *    main.tsx wraps the initial hydration in it.
 *
 * `unmount()` is already synchronous for a `createRoot` root, so it is NOT
 * wrapped: `flushSync` around it would add a redundant scheduler flush and, if
 * a caller ever reached this from inside a React lifecycle, the warning that
 * comes with it. The next-line-reads-the-DOM guarantee rule 3 is about is
 * satisfied either way.
 */

import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

/**
 * Live roots, keyed by their host element.
 *
 * WeakMap holds the roots; the `Set` holds the same hosts strongly ONLY so
 * `unmountAllInterimRoots()` can enumerate them, and entries are deleted on
 * unmount so the set never outlives a surface swap. That is a bounded handful
 * of nodes (at most one board frame, one chat frame, one session frame at a
 * time), not a growing leak — `interimRootCount()` exists so a test can say so.
 */
const roots = new WeakMap<Element, Root>();
const hosts = new Set<Element>();

/**
 * Render `element` into `host`, creating the root on first call.
 *
 * Returns the root, so a caller that wants to keep a handle can, though every
 * current call site addresses it by host instead.
 */
export function mountInterimRoot(host: Element | null, element: ReactNode): Root | null {
  if (!host) return null;
  let root = roots.get(host);
  if (!root) {
    root = createRoot(host);
    roots.set(host, root);
    hosts.add(host);
  }
  // See rule 3 — the legacy caller reads this subtree on its next line.
  flushSync(() => {
    (root as Root).render(element);
  });
  return root;
}

/** Tear down the root on `host`, if any. Safe to call for an unmounted host. */
export function unmountInterimRoot(host: Element | null): void {
  if (!host) return;
  const root = roots.get(host);
  if (!root) return;
  roots.delete(host);
  hosts.delete(host);
  root.unmount();
}

/**
 * Tear down every live interim root.
 *
 * The Dev surfaces are mutually exclusive and each swap discards whatever the
 * previous one mounted, so the owner calls this once at the top of
 * `renderDevView` rather than tracking which of the four branches ran last.
 */
export function unmountAllInterimRoots(): void {
  for (const host of [...hosts]) unmountInterimRoot(host);
}

/** Live root count — for the leak assertion in tests/dev-board-island.test.js. */
export function interimRootCount(): number {
  return hosts.size;
}
