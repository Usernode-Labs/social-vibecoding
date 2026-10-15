/**
 * #4417: THE TRAY, the places list on a phone.
 *
 * Opened from the place bar's button (./place-bar.tsx), or by a swipe right
 * that starts at the screen's left edge; a swipe left on it, Escape, the
 * scrim, the button again and the device's Back each close it. It slides in
 * from the left over a scrim, as wide as the list needs (296px, never more
 * than the screen less a strip of the page), and holds the list
 * (./project-places.tsx) with "Switch community" at its foot.
 *
 * Like the community switcher it is rendered only while open, into
 * `document.body`, from state that only ever changes after the first paint:
 * nothing here is in the prerendered shell, and nothing legacy writes into
 * it. Focus moves into it (onto the place you are on) and back to the button
 * that opened it.
 *
 * WHERE THE BROWSER OWNS THE EDGE. Safari on an iPhone (the browser, not an
 * installed app or the native shell) takes a swipe from the left edge for
 * its own Back, so the edge is left to it there and the button is the way
 * in (`edgeSwipeAllowed`).
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { pushDismissible, type Release } from '../../../lib/back-stack';

/** How far from the left edge a swipe must start to open the tray. */
export const EDGE_PX = 24;
/** How far it must travel, mostly sideways, to count. */
export const SWIPE_PX = 48;

/** Whether a swipe that started at `x0,y0` and ended at `x1,y1` is the edge's: right, from the edge, mostly flat. Pure. */
export function isEdgeSwipe(x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = Math.abs(y1 - y0);
  return x0 <= EDGE_PX && dx >= SWIPE_PX && dy < dx * 0.6;
}

/** Whether a swipe from `x0,y0` to `x1,y1` closes the tray: left, mostly flat. Pure. */
export function isCloseSwipe(x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x0 - x1;
  const dy = Math.abs(y1 - y0);
  return dx >= SWIPE_PX && dy < dx * 0.6;
}

/**
 * Whether the page may take the left edge. Not in Safari on an iPhone or
 * iPad in the browser, where the edge is the browser's Back; an installed
 * app (standalone) and the native shell have no such gesture. Pure, given
 * what it reads.
 */
export function edgeSwipeAllowed(env: { ua: string; maxTouchPoints: number; standalone: boolean; native: boolean }): boolean {
  const ios = /iPhone|iPad|iPod/i.test(env.ua) || (/Macintosh/i.test(env.ua) && env.maxTouchPoints > 1);
  if (!ios) return true;
  return env.standalone || env.native;
}

function readEnv() {
  let standalone = false;
  try {
    standalone = !!window.matchMedia?.('(display-mode: standalone)').matches
      || (window.navigator as { standalone?: boolean }).standalone === true;
  } catch { standalone = false; }
  const bridge = (window as { usernode?: { isNative?: boolean } }).usernode;
  return {
    ua: String(window.navigator?.userAgent || ''),
    maxTouchPoints: Number(window.navigator?.maxTouchPoints) || 0,
    standalone,
    native: !!(bridge && bridge.isNative === true),
  };
}

/**
 * Open the tray on a swipe right from the left edge, while `enabled` (a
 * phone's width, the page up, the tray shut). Listens on the document,
 * passively: it never holds a scroll up.
 */
export function useEdgeSwipe(enabled: boolean, onOpen: () => void): void {
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;
    if (!edgeSwipeAllowed(readEnv())) return undefined;
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && e.touches.length === 1 && t.clientX <= EDGE_PX ? { x: t.clientX, y: t.clientY } : null;
    };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (start && t && isEdgeSwipe(start.x, start.y, t.clientX, t.clientY)) openRef.current();
      start = null;
    };
    const cancel = () => { start = null; };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', cancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', cancel);
    };
  }, [enabled]);
}

export function PlacesTray({ id, label, onClose, returnTo, navigating, children }: {
  id: string;
  /** What the tray is, for a screen reader: "Homeroom's places". */
  label: string;
  onClose: () => void;
  /** The button that opened it, which takes focus back. */
  returnTo: () => HTMLElement | null;
  /**
   * Whether it is closing because a place was pressed, which pushes an
   * entry of its own in the same task. Its Back claim is then handed back
   * as a navigating one, so the queued Back that spends it cannot undo the
   * press (lib/back-stack.ts, as useDialog's closeForNavigation).
   */
  navigating?: () => boolean;
  children: ReactNode;
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const returnRef = useRef(returnTo);
  returnRef.current = returnTo;
  const navRef = useRef(navigating);
  navRef.current = navigating;

  // Focus in, onto the place you are on, and back out to the button.
  useEffect(() => {
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[aria-current="page"]')
      || panel?.querySelector<HTMLElement>('a[href], button');
    first?.focus({ preventScroll: true });
    return () => {
      const back = returnRef.current();
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);

  // Escape closes; Tab stays inside while it is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The device's Back closes it, as it does a dialog (lib/back-stack.ts).
  useEffect(() => {
    let release: Release | null = pushDismissible(() => {
      release = null;
      closeRef.current();
      return true;
    });
    return () => {
      const r = release;
      release = null;
      r?.(navRef.current?.() ? { navigating: true } : undefined);
    };
  }, []);

  // A swipe left on the tray closes it.
  const start = useRef<{ x: number; y: number } | null>(null);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="dev-ws-tray-root" data-places-tray="">
      <div className="dev-ws-tray-scrim" aria-hidden="true" onClick={() => closeRef.current()} />
      <div
        ref={panelRef}
        id={id}
        className="dev-ws-tray"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onTouchStart={(e) => {
          const t = e.touches[0];
          start.current = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const t = e.changedTouches[0];
          const s = start.current;
          start.current = null;
          if (s && t && isCloseSwipe(s.x, s.y, t.clientX, t.clientY)) closeRef.current();
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
