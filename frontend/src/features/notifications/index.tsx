/**
 * The Notifications island: the sheet plus its document-level Escape binding.
 *
 * Mirrors ../app-context/index.tsx — importing ./mount here is what installs
 * the two flushes and (via the controller's module scope) publishes
 * `window.NotificationsSheet` before public/js/** looks for it.
 */

import { useEffect } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { NotificationsSheetView } from './notifications-sheet';
import { notificationsSheetStore, NotificationsSheet } from './mount';

export { notificationsSheetStore, NotificationsSheet } from './mount';

export function NotificationsIsland() {
  const open = useStoreState(notificationsSheetStore).open;

  // Escape closes the sheet — web presentation only; adopted into a kit
  // sheet the kit's modal stack owns the key. Same rule as the Improve panel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (NotificationsSheet._sheet) return;
      NotificationsSheet.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return <NotificationsSheetView />;
}
