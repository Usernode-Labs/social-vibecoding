/**
 * Is the window at least `px` wide? For an island that draws different
 * markup at a width (the Communities page's cards from 768px, the brand
 * look's from 1280px), where CSS alone cannot swap one element for another.
 *
 * `false` in the prerender and while a prerendered island hydrates (the
 * server snapshot), so the first client render is the shipped document's;
 * the live answer follows at once, and every crossing of the width after
 * it. A window without matchMedia reads as narrow.
 */
import { useSyncExternalStore } from 'react';

function query(px: number): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try { return window.matchMedia(`(min-width: ${px}px)`); } catch { return null; }
}

export function useMinWidth(px: number): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = query(px);
      if (!mql) return () => {};
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
      }
      (mql as any).addListener?.(onChange);
      return () => (mql as any).removeListener?.(onChange);
    },
    () => !!query(px)?.matches,
    () => false,
  );
}
