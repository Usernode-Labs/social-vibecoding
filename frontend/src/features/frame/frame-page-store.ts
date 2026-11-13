/**
 * What a page drawn in the kit tells the frame's bar about itself.
 *
 * The bar (./frame-app.tsx) says where you are from the shell's own header
 * and router. A kit page that has places of its own the router does not
 * know (Home's All apps, All communities) publishes its breadcrumb here,
 * and where its back arrow goes; the bar prefers what is published while
 * the page is up.
 */
import { useEffect } from 'react';

import { createStore } from '../../lib/plain-store.js';

/**
 * `phoneUp`: on a phone, where the bar has room for one word, it says the
 * crumb BEFORE the last. For a page whose own title already says the last
 * one (Challenges under You), so the same word is not said twice.
 */
export type FramePage = { crumb: string[] | null; onBack: (() => void) | null; phoneUp?: boolean };
export const framePageStore = createStore<FramePage>({ crumb: null, onBack: null });

/** Publish this page's breadcrumb (last entry is where you are) and back, while it is mounted. */
export function useFramePage(crumb: string[] | null, onBack: (() => void) | null, phoneUp = false): void {
  const key = crumb ? crumb.join('\u0000') : '';
  useEffect(() => {
    if (!crumb) return undefined;
    framePageStore.set(phoneUp ? { crumb, onBack, phoneUp } : { crumb, onBack });
    return () => framePageStore.set({ crumb: null, onBack: null });
    // The crumb's words are the dependency; a new array of the same words is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onBack, phoneUp]);
}
