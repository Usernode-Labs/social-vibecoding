/**
 * The experimental switch for the new Needs you review flow (Settings ›
 * Experimental, "New Needs you"). Off by default. While it is on, the
 * Communities tab's Needs you draws ./review-flow.tsx instead of the reel
 * (../workshop/needs-reel.tsx).
 *
 * Kept on the DEVICE (localStorage), like Comment on the page
 * (../improve/suggest-settings.ts): trying a new way to review is a choice
 * about the screen in front of you, and there is nothing to save or fail.
 *
 * settings.js (a classic module that cannot import) paints and saves the
 * switch through `window.UsernodeReact.reviewFlow`, published below; a screen
 * that draws differently subscribes with `useReviewFlowEnabled`.
 */

import { useSyncExternalStore } from 'react';

/** Where the switch is kept: `'1'` when on, absent when off (the default). */
export const REVIEW_FLOW_STORAGE_KEY = 'usernode:review-flow';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Whether this device has the new review flow turned on. Off when storage is unreadable. */
export function reviewFlowEnabled(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return !!storage && storage.getItem(REVIEW_FLOW_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setReviewFlowEnabled(on: boolean, storage: StorageLike | null = defaultStorage()): void {
  if (storage) {
    try {
      if (on) storage.setItem(REVIEW_FLOW_STORAGE_KEY, '1');
      else storage.removeItem(REVIEW_FLOW_STORAGE_KEY);
    } catch { /* private mode: the switch simply does not stick */ }
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Another tab turning it on or off is the same change.
  const onStorage = (e: StorageEvent) => { if (e.key === REVIEW_FLOW_STORAGE_KEY) fn(); };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** The switch, live: a screen re-renders when it is turned on or off. */
export function useReviewFlowEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => reviewFlowEnabled(), () => false);
}

/** The bridge settings.js reads and saves the switch through. */
export function installReviewFlowBridge(win: Window & { UsernodeReact?: Record<string, unknown> } = window as never): void {
  const bridge = (win.UsernodeReact ||= {});
  bridge.reviewFlow = {
    enabled: () => reviewFlowEnabled(),
    setEnabled: (on: boolean) => setReviewFlowEnabled(!!on),
  };
}

if (typeof window !== 'undefined') installReviewFlowBridge();
