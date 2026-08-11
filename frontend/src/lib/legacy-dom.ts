/**
 * Helpers for React islands that sit inside the legacy shell (#1078).
 *
 * These exist because a converted region is not alone on the page. Two
 * non-React owners still touch its nodes, and both are load-bearing:
 *
 *   1. `PlatformUI`'s static-modal adoption (public/js/platform-ui.js) watches
 *      each modal root's class list with a MutationObserver, and when `hidden`
 *      comes off it LIFTS THE CARD ELEMENT OUT of the root — replacing it with
 *      a comment placeholder — into a native-kit modal shell, adding
 *      `platform-modal-adopted` to the root and `platform-modal-card` to the
 *      card on the way.
 *   2. public/css/app.css keys off classes the kit adds at runtime.
 *
 * That has one hard consequence for every dialog island: **React must never
 * re-render `className` on a node the kit writes classes to.** React writes
 * the whole attribute when the prop changes, so a re-render would silently
 * drop `platform-modal-adopted` mid-presentation. So the class strings on
 * those nodes are CONSTANT props (React writes them once, at hydration, and
 * never again) and the open/close toggle goes through `useHiddenClass` below,
 * which mutates `classList` exactly the way the legacy open/close functions
 * did — the same mutation the observer is watching for.
 *
 * The second consequence: React must never reorder or remove the children of
 * an adopted root. React keeps DOM references in its fiber tree; the card it
 * thinks is there has been swapped for a comment node, so a removal would
 * throw NotFoundError. Every converted dialog therefore renders its full
 * structure unconditionally — always mounted, just hidden — which is what the
 * hand-written markup did anyway.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * `useLayoutEffect` that degrades to `useEffect` during the prerender pass.
 *
 * The build's SSG step (frontend/scripts/build-shell.mjs) calls
 * renderToStaticMarkup, where useLayoutEffect warns to the console. A console
 * error on any route fails proposal checks, and these effects only ever run in
 * the browser, so the swap costs nothing.
 */
export const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Toggle `hidden` on a ref'd element without React ever owning its className.
 *
 * Deliberately a layout effect: the class has to be right before the browser
 * paints, or an opening dialog flashes at its hidden state first. It also
 * skips the very first run when the value already matches the prerendered
 * markup, so hydration doesn't produce a redundant mutation the modal-adoption
 * observer would have to process.
 */
export function useHiddenClass(ref: RefObject<HTMLElement | null>, hidden: boolean): void {
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.classList.contains('hidden') === hidden) return;
    el.classList.toggle('hidden', hidden);
  }, [ref, hidden]);
}

/** Same, for any class the shell toggles on a node React renders once. */
export function useClassToggle(
  ref: RefObject<HTMLElement | null>,
  className: string,
  on: boolean,
): void {
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.classList.contains(className) === on) return;
    el.classList.toggle(className, on);
  }, [ref, className, on]);
}

/**
 * Subscribe to a `window` event for the lifetime of the component.
 *
 * The shell's modules talk to each other with CustomEvents on `window`
 * (`usernode:offline-change`, `usernode:session`, …), and a converted region
 * has to keep listening to the same ones. The handler is held in a ref so a
 * fresh closure each render doesn't churn the listener.
 */
export function useWindowEvent<K extends string>(
  type: K,
  handler: (event: Event) => void,
  target: EventTarget | null = typeof window === 'undefined' ? null : window,
): void {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(() => {
    if (!target) return;
    const listener = (event: Event) => saved.current(event);
    target.addEventListener(type, listener);
    return () => target.removeEventListener(type, listener);
  }, [type, target]);
}

/**
 * Publish an imperative handle onto a global namespace for `public/js/**`.
 *
 * The legacy modules are classic scripts that run BEFORE the deferred React
 * bundle, and they call into converted regions by name (`App.showCreateModal`,
 * `AppSecrets.open`, …). Rather than rewrite every call site to be async, the
 * island registers its controller here on mount and the legacy shim forwards
 * to it — queueing, on the shim side, anything that arrives first.
 */
export interface LegacyBridge {
  [key: string]: unknown;
}

export function useLegacyBridge(name: string, controller: unknown): void {
  useEffect(() => {
    const host = window as unknown as { UsernodeReact?: LegacyBridge };
    const bridge = (host.UsernodeReact ||= {});
    bridge[name] = controller;
    // Anything the legacy side called before hydration is replayed in order.
    const pending = bridge[`${name}:pending`];
    if (Array.isArray(pending)) {
      bridge[`${name}:pending`] = [];
      for (const [method, args] of pending as [string, unknown[]][]) {
        const fn = (controller as Record<string, unknown>)?.[method];
        if (typeof fn === 'function') {
          try {
            (fn as (...a: unknown[]) => unknown).apply(controller, args);
          } catch (err) {
            console.error(`[bridge] queued ${name}.${method} failed`, err);
          }
        }
      }
    }
    return () => {
      if (bridge[name] === controller) delete bridge[name];
    };
  }, [name, controller]);
}
