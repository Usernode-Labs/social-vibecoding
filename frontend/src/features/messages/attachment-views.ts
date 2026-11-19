/**
 * The message box's staged files as the pending strip's rows (#6862).
 *
 * Messages' composer and the blank thread with Homeroom bot both hand files
 * they hold to the same `PendingStripRows` the group chat draws. An upload
 * that has answered is a `MessageAttachment`; one still in flight is a
 * `PendingUpload` with the File and a local preview URL. This turns either
 * into the strip's one view, and keeps the rules for a chip's tag here so the
 * two boxes cannot disagree.
 */

import type { PendingAttachmentView } from '../attachments/pending-strip';
import { fileSize } from './format';
import type { MessageAttachment } from './types';

/** A file picked, dropped or pasted into a message box, before its upload answers. */
export interface PendingUpload {
  key: string;
  file: File;
  /** A local image preview, revoked when the row goes. Null for anything else. */
  thumbUrl: string | null;
}

/**
 * The tag a file card carries. The extension is the most honest word for
 * what a file is ("PDF", "ZIP", "MD"); a name without one falls back to what
 * the server called it, and then to a plain "FILE".
 */
export function attachmentBadge(name: string, contentType: string): string | null {
  if (contentType.startsWith('image/')) return null;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (ext && ext.length <= 4 && /^[a-z0-9]+$/i.test(ext)) return ext.toUpperCase();
  if (contentType === 'application/pdf') return 'PDF';
  if (contentType === 'application/zip') return 'ZIP';
  if (contentType.startsWith('text/')) return 'TXT';
  return 'FILE';
}

/** One file already uploaded: its picture is the server's, not a blob. */
export function attachmentView(item: MessageAttachment): PendingAttachmentView {
  const image = item.contentType.startsWith('image/');
  return {
    key: item.id,
    name: item.name,
    kind: image ? 'image' : 'file',
    badge: image ? null : attachmentBadge(item.name, item.contentType),
    size: fileSize(item.size),
    thumbUrl: image ? (item.viewUrl || item.url) : null,
    uploading: false,
  };
}

/** One file still uploading: its picture is the local preview until it lands. */
export function pendingUploadView(item: PendingUpload): PendingAttachmentView {
  const image = item.file.type.startsWith('image/');
  return {
    key: item.key,
    name: item.file.name,
    kind: image ? 'image' : 'file',
    badge: image ? null : attachmentBadge(item.file.name, item.file.type),
    size: fileSize(item.file.size),
    thumbUrl: item.thumbUrl,
    uploading: true,
  };
}
