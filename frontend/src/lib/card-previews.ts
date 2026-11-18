/**
 * When a project card's animated preview may play, and which one does.
 *
 * A card can carry a short, silent loop of the real app over its picture
 * (the featured-illustration record's `preview`, served at /app-previews/).
 * Motion that starts by itself is what people complained about most in
 * autoplaying previews elsewhere, so the rules are narrow:
 *
 *  - It plays only when the person chooses it: on a device that points and
 *    hovers, after HOVER_DELAY_MS of pointing at the card or keyboard focus
 *    on it, looping until the pointer or focus leaves. A phone, or any
 *    device without a hover, never plays it and shows the picture: a play
 *    nobody asked for can open a phone's full screen player.
 *  - One at a time, everywhere: starting one stops the other.
 *  - Never under `prefers-reduced-motion: reduce`, never with Data Saver
 *    (`navigator.connection.saveData`), and never when the person turned
 *    "Play previews" off (Settings › Accessibility). The picture shows
 *    instead.
 *  - A loop that fails to load is not asked for again on this page.
 *
 * The setting lives on the device (localStorage), like the text size and
 * contrast beside it, so a visitor with no account has it too. Every read
 * is guarded: storage can be missing or throw.
 */

import { reducedMotion } from './reduced-motion';

export const HOVER_DELAY_MS = 150;

const PREF_KEY = 'usernode:cardPreviews';
const PREF_EVENT = 'usernode:card-previews';

function storage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** Whether the person wants previews: on unless they turned it off. */
export function previewsOn(): boolean {
  try { return storage()?.getItem(PREF_KEY) !== 'off'; } catch { return true; }
}

/** Turn previews on or off on this device. */
export function setPreviewsOn(on: boolean): void {
  try {
    const s = storage();
    if (on) s?.removeItem(PREF_KEY); else s?.setItem(PREF_KEY, 'off');
  } catch { /* storage unavailable: the setting simply does not stick */ }
  try { window.dispatchEvent(new Event(PREF_EVENT)); } catch { /* no window */ }
}

/** Call `fn` when the setting changes here or in another tab; returns the unsubscribe. */
export function onPreviewsPref(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const storageFn = (e: StorageEvent) => { if (e.key === PREF_KEY || e.key === null) fn(); };
  window.addEventListener(PREF_EVENT, fn);
  window.addEventListener('storage', storageFn);
  return () => { window.removeEventListener(PREF_EVENT, fn); window.removeEventListener('storage', storageFn); };
}

function matches(query: string): boolean {
  try { return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches; } catch { return false; }
}

/** Whether a preview may play at all right now: the setting, reduced motion and Data Saver. */
export function previewsAllowed(): boolean {
  if (!previewsOn()) return false;
  if (reducedMotion()) return false;
  try {
    const connection = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
    if (connection && connection.saveData) return false;
  } catch { /* no navigator */ }
  return true;
}

/** Whether this device points and hovers (a mouse or trackpad), so previews follow the pointer. */
export function canHover(): boolean {
  return matches('(hover: hover) and (pointer: fine)');
}

// ── One at a time ────────────────────────────────────────────────────────

let active: string | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const fn of [...listeners]) fn(); };

/** The card whose preview is playing, if one is. */
export function activePreview(): string | null { return active; }

/** Start `id`'s preview, stopping any other. */
export function claimPreview(id: string): void {
  if (active === id) return;
  active = id;
  notify();
}

/** Stop `id`'s preview, if it is the one playing. */
export function releasePreview(id: string): void {
  if (active !== id) return;
  active = null;
  notify();
}

/** Call `fn` whenever the playing preview changes; returns the unsubscribe. */
export function onActivePreview(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── Loops that failed ────────────────────────────────────────────────────

const failed = new Set<string>();
export function previewFailed(src: string): boolean { return failed.has(src); }
export function markPreviewFailed(src: string): void { failed.add(src); }

/** Tests: forget every failure and the playing preview. */
export function _resetCardPreviews(): void {
  active = null;
  failed.clear();
  listeners.clear();
}
