/**
 * Download a picture from a chat onto the device (#4055).
 *
 * The viewer's Download used to be the file's own link with `download`. On a
 * computer that saves the file, and still does here. Phones are where it
 * fell short: in a phone browser it lands in Files rather than Photos, and
 * in the installed app the webview opened the bare file with no way back.
 * A chat attachment is served only with the session cookie, so handing its
 * URL to the system browser (`openExternal`) is no answer either: it would
 * 404 there. The page fetches the picture itself and hands the bytes on,
 * by the first road open:
 *
 *   1. the app's `saveImage` bridge method, when the build advertises it
 *      (NATIVE-BRIDGE.md): straight into the phone's photos;
 *   2. the phone's share sheet with the file (`navigator.share`), whose
 *      "Save Image" puts it in Photos: on a touch screen only;
 *   3. a link to the fetched copy with `download`, clicked for the person:
 *      a browser, never the app's webview.
 *
 * In the app with neither 1 nor 2 there is no road, and `canSaveImage`
 * says so, so the controls are hidden rather than dead. A picture on
 * another site (a request's screenshot uploaded to GitHub) cannot be
 * fetched here without CORS; the viewer keeps its "Open original" link for
 * those and nothing here is offered.
 */

import { useEffect, useState } from 'react';

import { t } from '../../lib/i18n/runtime';
import { toast } from '../message-actions/clipboard';

/**
 * Whether `src` is on another site. `download` is ignored there and the
 * browser follows the link instead, which would replace the page under the
 * viewer, and the file cannot be fetched here without CORS; such a file
 * opens in a new tab (or, in the installed app, through nav-link.js to the
 * system browser) rather than being saved.
 */
export function isRemoteFile(src: string): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URL(src, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

export interface SaveableImage {
  src: string;
  name: string;
}

/**
 * What happened: saved by the app, handed to the share sheet, downloaded by
 * the browser, the share sheet dismissed, the share sheet refused because
 * the tap had expired by the time the picture arrived (the next tap opens
 * it), or failed (already said in a toast).
 */
export type SaveOutcome = 'saved' | 'shared' | 'downloaded' | 'dismissed' | 'tap-again' | 'failed';

/** The most image data handed across the bridge; base64 doubles it in flight. */
export const NATIVE_SAVE_MAX_BYTES = 15 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/**
 * The name the saved file gets: the attachment's own, without anything that
 * reads as a path, and with an extension a phone's Files app recognises.
 */
export function fileNameFor(name: string, contentType: string): string {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = EXTENSIONS[type] || 'png';
  let base = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^[.\s]+/, '');
  if (!base) return `image.${ext}`;
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
}

interface Bridge {
  isNative?: boolean;
  getBridgeInfo?: () => Promise<{ capabilities?: string[]; degraded?: boolean } | null>;
  saveImage?: (args: { base64: string; contentType: string; filename: string }) => Promise<unknown>;
}

function bridge(): Bridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { usernode?: Bridge }).usernode || null;
}

/** Inside the Homeroom app's webview, where a download link goes nowhere. */
export function inNativeApp(): boolean {
  return bridge()?.isNative === true;
}

// The app build's answer, once known. A degraded answer (a cold-start
// timeout) is inconclusive and is not kept, so the next open asks again.
let nativeCapability: boolean | null = null;
let nativeProbe: Promise<boolean> | null = null;

/** Whether this app build can save a picture itself (`saveImage`). */
export function nativeSaveSupported(): Promise<boolean> {
  const b = bridge();
  if (!b?.isNative || typeof b.getBridgeInfo !== 'function' || typeof b.saveImage !== 'function') {
    return Promise.resolve(false);
  }
  if (nativeCapability !== null) return Promise.resolve(nativeCapability);
  if (!nativeProbe) {
    nativeProbe = Promise.resolve()
      .then(() => b.getBridgeInfo!())
      .then((info) => {
        if (info?.degraded === true) return false;
        nativeCapability = Array.isArray(info?.capabilities) && info!.capabilities!.includes('saveImage');
        return nativeCapability;
      })
      .catch(() => false)
      .finally(() => { nativeProbe = null; });
  }
  return nativeProbe;
}

/**
 * Whether the app build is known to save pictures itself: a save that needs
 * no tap behind it, unlike the share sheet, which a browser opens only from
 * inside a tap (see the viewer's long press).
 */
export function nativeSaveKnown(): boolean {
  return inNativeApp() && nativeCapability === true;
}

/** For tests: forget the app build's answer. */
export function resetSaveImageProbe(): void {
  nativeCapability = null;
  nativeProbe = null;
}

function touchScreen(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

/** Whether the phone's share sheet takes these files (a touch screen only). */
export function shareFilesSupported(files?: File[]): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function'
    || typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false;
  if (!touchScreen()) return false;
  try {
    return navigator.canShare({ files: files || [new File([''], 'image.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
}

/**
 * Whether Download can be offered for this picture right now: not a file on
 * another site, and, in the app, a road the build has (its own save, known
 * once probed, or the share sheet).
 */
export function canSaveImage(src: string): boolean {
  if (!src || isRemoteFile(src)) return false;
  if (!inNativeApp()) return true;
  return nativeCapability === true || shareFilesSupported();
}

/**
 * `canSaveImage`, kept current: in the app the build's answer arrives after
 * the first render, and a control it allows appears then.
 */
export function useCanSaveImage(src: string): boolean {
  const [can, setCan] = useState(() => canSaveImage(src));
  useEffect(() => {
    const now = canSaveImage(src);
    setCan(now);
    if (now || !src || isRemoteFile(src) || !inNativeApp()) return undefined;
    let live = true;
    void nativeSaveSupported().then((ok) => { if (live && ok) setCan(true); });
    return () => { live = false; };
  }, [src]);
  return can;
}

// The pictures a share sheet refused because the tap had expired while they
// were fetched: the next tap on the same pictures shares them straight away,
// inside its own gesture.
let pending: { key: string; files: File[] } | null = null;

const keyOf = (images: SaveableImage[]) => images.map((i) => i.src).join('\n');

async function fetchFile(image: SaveableImage): Promise<File> {
  const res = await fetch(image.src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const type = blob.type || res.headers.get('content-type') || 'image/png';
  return new File([blob], fileNameFor(image.name, type), { type });
}

async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function share(key: string, files: File[]): Promise<SaveOutcome> {
  try {
    await navigator.share({ files });
    pending = null;
    return 'shared';
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'AbortError') { pending = null; return 'dismissed'; }
    if (name === 'NotAllowedError') { pending = { key, files }; return 'tap-again'; }
    throw err;
  }
}

/**
 * Download every picture in `images` onto the device, by the first road
 * open, and say so when it went wrong. Same-origin pictures only: a file on
 * another site fails here (see `canSaveImage`).
 */
export async function saveImages(images: SaveableImage[]): Promise<SaveOutcome> {
  const list = images.filter((i) => i && i.src);
  if (!list.length) return 'failed';
  const key = keyOf(list);
  try {
    if (pending && pending.key === key) return await share(key, pending.files);
    if (list.some((i) => isRemoteFile(i.src))) throw new Error('cross-origin');
    const files = await Promise.all(list.map(fetchFile));
    const native = inNativeApp();
    if (native) {
      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (total <= NATIVE_SAVE_MAX_BYTES && await nativeSaveSupported()) {
        for (const file of files) {
          await bridge()!.saveImage!({ base64: await toBase64(file), contentType: file.type, filename: file.name });
        }
        toast(t('messages:imageSave.saved', { count: files.length }));
        return 'saved';
      }
    }
    if (shareFilesSupported(files)) return await share(key, files);
    // A download link goes nowhere in the app's webview.
    if (native) throw new Error('no way to save in this app build');
    files.forEach(downloadFile);
    return 'downloaded';
  } catch {
    pending = null;
    toast(t('messages:imageSave.failed'));
    return 'failed';
  }
}

/** The message menu's line for its pictures: "Download image", "Download 3 images". */
export function downloadLabel(count: number): string {
  return t('messages:imageSave.menuDownload', { count });
}

/**
 * The pictures on a message the menu can offer to download: none when any
 * of them cannot be saved here, so the line never covers only some.
 */
export function downloadableImages(images: SaveableImage[]): SaveableImage[] {
  const list = images.filter((i) => i && i.src);
  return list.length && list.every((i) => canSaveImage(i.src)) ? list : [];
}

/** One picture: `saveImages` with a list of one. */
export function saveImage(image: SaveableImage): Promise<SaveOutcome> {
  return saveImages([image]);
}
