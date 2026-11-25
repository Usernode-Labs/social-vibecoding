/**
 * THE THREAD LIST HIDDEN (#6963): on a wide screen the bot page's list can be
 * dragged away, and the thread takes the room. One small store, because three
 * places need the answer: the divider that closes and reopens it, the head
 * button that brings the list back, and the page that lays itself out one
 * pane or two.
 *
 * `closed` is this device's choice, remembered beside the divider's width
 * (../side-panel/resize.ts). `docked` is whether the page is the split at all
 * right now (wide, a thread in the column, and, with a preview beside it, a
 * window with room for three columns), published by the page itself, so a
 * thread drawn anywhere else never offers the button. Beside a preview the
 * list put away leaves the thread and the preview in halves; the choice is
 * the same one, kept whether a preview is open or not (24 Nov 2026).
 *
 * The server snapshot is false, so the prerender and the first client render
 * carry today's split markup and hydration has nothing to disagree about.
 */

import { useSyncExternalStore } from 'react';

import { readListClosed, writeListClosed } from '../side-panel/resize';
import type { DetailLayout } from './detail';

interface ListClosedState {
  closed: boolean;
  docked: boolean;
}

let state: ListClosedState | null = null;
const listeners = new Set<() => void>();

function read(): ListClosedState {
  if (!state) state = { closed: readListClosed(), docked: false };
  return state;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Listen for the choice changing, from outside React (the panel's controller
 *  marks the page in its frame when the list hides or comes back). */
export function subscribeListClosed(listener: () => void): () => void {
  return subscribe(listener);
}

/** Hide the list, or bring it back, and keep that on this device. */
export function setListClosed(closed: boolean): void {
  const now = read();
  if (now.closed === closed) return;
  state = { ...now, closed };
  writeListClosed(closed);
  emit();
}

/** The page says whether the split is up (wide, a thread open, and room for
 *  three columns if a preview is beside it). */
export function setDocked(docked: boolean): void {
  const now = read();
  if (now.docked === docked) return;
  state = { ...now, docked };
  emit();
}

/** Is the thread list hidden? */
export function isListClosed(): boolean {
  return read().closed;
}

/** Does a thread's head offer the button that brings the list back — only
 *  while the page is the split and the list is hidden? */
export function showsListButton(): boolean {
  const now = read();
  return now.closed && now.docked;
}

/** The page's own hooks; the server snapshot is the split, as the prerender is. */
export function useListClosed(): boolean {
  return useSyncExternalStore(subscribe, isListClosed, () => false);
}

export function useShowListButton(): boolean {
  return useSyncExternalStore(subscribe, showsListButton, () => false);
}

/**
 * What the choice makes of the page (24 Nov 2026). `fits` is what the
 * window's width makes of a preview (./detail.ts detailLayout); `layout` is
 * what is drawn. The list's bar snaps beside no preview, or beside one where
 * three columns fit. Put away there, the list leaves the thread and the
 * preview in halves, as a narrower window draws them. Where the width makes
 * halves, or on a phone, the choice changes nothing and waits.
 */
export function listLayout({ closed, open, preview, fits, phone }: {
  /** The choice: the list is hidden. */
  closed: boolean;
  /** Something is open beside the list on a wide screen. */
  open: boolean;
  /** A preview is beside the thread. */
  preview: boolean;
  fits: DetailLayout;
  phone: boolean;
}): { snaps: boolean; oneUp: boolean; layout: DetailLayout } {
  const snaps = !preview || fits === 'three';
  const oneUp = closed && open && snaps && !phone;
  return { snaps, oneUp, layout: preview && oneUp ? 'halves' : fits };
}
