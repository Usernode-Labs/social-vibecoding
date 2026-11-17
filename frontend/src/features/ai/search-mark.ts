/**
 * WHERE THE SEARCH LEFT ITS MARKS (17 Nov 2026, request #6738). A person
 * searched the tab for a word, opened one of the messages found, and the
 * message glowed for about two seconds and then looked like any other: the
 * flash says where the message is, not where the word is. So the words a
 * result was opened by stay marked in that message while it is read and
 * scrolled (../../features/messages/format.tsx `MessageMarkdown` marks them),
 * until the search is cleared or changed.
 *
 * The words travel BESIDE the address, not in it: the search box is never
 * kept in the address (./index.tsx SEARCH), and every address a found row
 * already has stays exactly as it was. One mark at a time: the message a
 * search result opened, and the query that opened it.
 */
import { useSyncExternalStore } from 'react';

/** The message a search result opened, and the query it was found by. */
export interface SearchMark {
  messageId: number;
  /** The query, as the search asked it (./search.ts cleanQuery). */
  q: string;
}

let mark: SearchMark | null = null;
const listeners = new Set<() => void>();

function publish(next: SearchMark | null): void {
  if (mark === next) return;
  mark = next;
  for (const fn of listeners) fn();
}

/** Pure: a mark that can be drawn, or none. */
function clean(mark: Partial<SearchMark> | null | undefined): SearchMark | null {
  const messageId = Number(mark?.messageId);
  const q = typeof mark?.q === 'string' ? mark.q : '';
  return Number.isSafeInteger(messageId) && messageId > 0 && q ? { messageId, q } : null;
}

/** Mark `q` in the message a found result opens, before its address is followed. */
export function setSearchMark(next: Partial<SearchMark> | null | undefined): void {
  publish(clean(next));
}

/** The search was cleared or changed: no message is marked any more. */
export function clearSearchMark(): void {
  publish(null);
}

/** The mark as it stands, for the page that clears it when the search moves on. */
export function currentSearchMark(): SearchMark | null {
  return mark;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The query to mark in this message, or null: the id gates the read, so only
 * the message the search opened is marked, and its other rows are not. The
 * server snapshot is null, so a prerender draws no marks.
 */
export function useSearchMark(messageId: number): string | null {
  const found = useSyncExternalStore(subscribe, currentSearchMark, () => null);
  return found && found.messageId === messageId ? found.q : null;
}
