/**
 * Files attached in the agent-session composer (#2779 follow-up): what can be
 * picked, and how a picked file is described before and after it uploads.
 *
 * The limits are the dev chat's (dev-chat.js ATTACH_LIMITS), which mirror the
 * server's classifier (src/services/attachments.js validateUpload) closely
 * enough to refuse an obvious mistake at once. The server stays the judge:
 * it decides the kind from the name and the bytes, and a zip's safety is
 * checked there only.
 */

export const MAX_FILES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/** How the composer treats a picked file before the server has classified it. */
export type PickedKind = 'image' | 'zip' | 'file';

/**
 * One file in the tray above the box. `local` has not been uploaded yet (a
 * conversation that is still unsent has nowhere to upload to), `uploading` is
 * on its way, and `ready` has the server's id and kind.
 */
export interface PendingFile {
  key: string;
  file: Blob;
  name: string;
  kind: string;
  size: number;
  thumbUrl: string | null;
  status: 'local' | 'uploading' | 'ready';
  id: string | null;
}

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

export function pickedKind(name: string): PickedKind {
  const ext = extensionOf(name);
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'zip') return 'zip';
  return 'file';
}

function megabytes(bytes: number) {
  return Math.round(bytes / 1024 / 1024);
}

/** Why a file cannot be attached, in the dev chat's words, or null when it can. */
export function refusal(name: string, size: number): string | null {
  const kind = pickedKind(name);
  if (kind === 'image' && size > MAX_IMAGE_BYTES) return `"${name}" is too big. Images max ${megabytes(MAX_IMAGE_BYTES)} MB.`;
  if (kind === 'zip' && size > MAX_ZIP_BYTES) return `"${name}" is too big. Zip archives max ${megabytes(MAX_ZIP_BYTES)} MB.`;
  if (kind === 'file' && size > MAX_FILE_BYTES) return `"${name}" is too big. Files max ${megabytes(MAX_FILE_BYTES)} MB.`;
  if (size <= 0) return `"${name}" is empty.`;
  return null;
}

/**
 * Which of `files` fit beside the `already` in the tray, and the first reason
 * one did not. Files past the fourth are refused whole, not truncated
 * silently.
 */
export function acceptFiles<T extends { name: string; size: number }>(already: number, files: T[]): { accepted: T[]; error: string | null } {
  const accepted: T[] = [];
  let error: string | null = null;
  for (const file of files) {
    if (already + accepted.length >= MAX_FILES) {
      error = error || `You can attach up to ${MAX_FILES} files to one message.`;
      break;
    }
    const why = refusal(file.name, file.size);
    if (why) { error = error || why; continue; }
    accepted.push(file);
  }
  return { accepted, error };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The chip's tag: none for an image (it shows a thumbnail), ZIP, or the file's extension. */
export function badgeFor(kind: string, name: string): string | null {
  if (kind === 'image') return null;
  if (kind === 'zip') return 'ZIP';
  const ext = extensionOf(name);
  return ext ? ext.toUpperCase().slice(0, 4) : 'FILE';
}

/**
 * A pasted screenshot arrives as "image.png" or with no name at all; give it
 * one a person would recognise in the tray and in the transcript.
 */
export function pastedName(file: { name?: string; type?: string }, index: number, now = new Date()): string {
  const name = String(file.name || '').trim();
  if (name && name !== 'image.png') return name;
  const ext = String(file.type || '').split('/')[1] || 'png';
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `pasted-${stamp}${index ? `-${index + 1}` : ''}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`;
}
