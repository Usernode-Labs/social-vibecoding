/**
 * `#dc-attachments` — the dev chat composer's pending-upload strip — as the
 * only React writer below that host.
 *
 * The chips and thumbnails are ../attachments/pending-strip.tsx's, the same
 * rows the group chat's composers draw. What differs is the ELEMENT: here it
 * is written by `renderChatView`'s template and portalled into, so it and its
 * `dc-attach-strip-active` class stay dev-chat.js's — the host-is-mine,
 * children-are-React's split. The group chat's strip is part of a React tree
 * and takes the element from the shared file too.
 */

import { PendingStripRows } from '../attachments/pending-strip';
import { useStoreState } from '../../lib/use-store-state';
import { attachStripStore, type AttachStripState } from './attach-strip-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).DevChat : null) || null;
}

export function DevAttachStrip() {
  const { items } = useStoreState<AttachStripState>(attachStripStore);
  return (
    <PendingStripRows
      items={items}
      onRemove={(index) => controller()?._removeAttachment?.(index)}
    />
  );
}
