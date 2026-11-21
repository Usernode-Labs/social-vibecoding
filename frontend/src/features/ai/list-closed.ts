/**
 * THE THREAD LIST HIDDEN (#6963): on a wide screen the bot page's list can be
 * dragged away, and the thread takes the room. One small store, because three
 * places need the answer: the divider that closes and reopens it, the head
 * button that brings the list back, and the page that lays itself out one
 * pane or two.
 *
 * `closed` is this device's choice, remembered beside the divider's width
 * (../side-panel/resize.ts). `docked` is whether the page is the split at all
 * right now (wide, a thread in the column, no preview beside it), published
 * by the page itself, so a thread drawn anywhere else never offers the
 * button.
 *
 * The server snapshot is false, so the prerender and the first client render
 * carry today's split markup and hydration has nothing to disagree about.
 */

import { useSyncExternalStore } from 'react';

import { readListClosed, writeListClosed } from '../side-panel/resize';

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

/** The page says whether the split is up (wide, a thread open, no preview). */
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
