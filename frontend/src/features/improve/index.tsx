/**
 * The Improve island: the panel plus the one effect that binds its
 * document-level behaviour.
 *
 * The panel body is ./improve-panel.tsx and its state is ./improve-store.js.
 * This file exists to keep both of those free of side effects, and because the
 * controller has to be IMPORTED somewhere for `window.Improve` to exist before
 * `public/js/app.js` looks for it — the same reason every other feature folder
 * imports its classic-side module from the island rather than from main.tsx.
 */

import { useEffect } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { ImprovePanel } from './improve-panel';
import { improveStore, Improve } from './mount';

export { improveStore, Improve } from './mount';

export function ImproveIsland() {
  const open = useStoreState(improveStore).open;

  // Escape closes the panel — but only on the web presentation. Adopted into a
  // kit sheet the kit's own modal stack owns the key (it dismisses the topmost
  // surface, which may be a dialog opened above this one), so double-handling
  // it would close two things with one press. Same rule the hamburger's
  // keydown handler runs under.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (Improve._sheet) return;
      Improve.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // #1038's live session store drives the panel's session rows: a turn that
  // starts or finishes in this tab, another tab, or on another device moves
  // them without a refetch. Subscribed from the island rather than at module
  // scope because `window.SessionState` is installed by a classic script that
  // runs before the bundle but after it is imported.
  useEffect(() => {
    const sessionState = (window as unknown as {
      SessionState?: { subscribe(fn: () => void): (() => void) | void };
    }).SessionState;
    if (!sessionState?.subscribe) return undefined;
    const unsubscribe = sessionState.subscribe(() => Improve.onSessionStateChanged());
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  return <ImprovePanel />;
}
