/**
 * The app-context island: the sheet plus its document-level Escape binding.
 *
 * Mirrors ../improve/index.tsx — the sheet body is ./app-context-sheet.tsx,
 * its flag is ./app-context-store.js, and importing ./mount here is what
 * installs the flush and (via the controller's module scope) publishes
 * `window.AppContext` before public/js/** looks for it.
 */

import { useEffect } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { AppContextSheet } from './app-context-sheet';
import { appContextStore, AppContext } from './mount';

export { appContextStore, AppContext } from './mount';

export function AppContextIsland() {
  const open = useStoreState(appContextStore).open;

  // Escape closes the sheet — web presentation only; adopted into a kit
  // sheet the kit's modal stack owns the key. Same rule as the Improve panel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (AppContext._sheet) return;
      AppContext.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return <AppContextSheet />;
}
