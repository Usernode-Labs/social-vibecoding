/**
 * The Notifications island: the sheet, presented by the Sheet.
 *
 * Mirrors ../app-context/index.tsx — importing ./mount here is what installs
 * the two flushes and (via the controller's module scope) publishes
 * `window.NotificationsSheet` before public/js/** looks for it.
 *
 * The presentation is lib/sheet.ts's, as every sheet's is: the kit on a
 * phone, Back, Escape (while it is the top panel, #6981, and on a phone with
 * a keyboard too) and the overlay's tap. The Escape listener that was here
 * went with lib/sheet-controller.js.
 */

import { useSheet } from '../../lib/sheet';
import { useStoreState } from '../../lib/use-store-state';
import { NotificationsSheetView } from './notifications-sheet';
import { notificationsSheetStore, NotificationsSheet } from './mount';

export { notificationsSheetStore, NotificationsSheet } from './mount';

export function NotificationsIsland() {
  const open = useStoreState(notificationsSheetStore).open;
  const sheet = useSheet({ open, ...NotificationsSheet.present });
  return <NotificationsSheetView sheet={sheet} />;
}
