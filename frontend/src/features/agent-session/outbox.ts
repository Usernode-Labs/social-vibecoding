// The messages a screen has sent and the server has not yet shown back
// (#2779 follow-up): the "outbox" of a conversation.
//
// A message is drawn the moment it is sent, as a row of the conversation,
// and stays there until the server's own copy replaces it: the transcript row
// that carries the same `clientMessageId`. If the server never took it (the
// connection dropped first, the platform was restarting, the credits ran
// out), it stays, marked Not sent, with Retry: the words are never silently
// dropped, never handed back to the box behind the user's back, and never
// turned into a draft. Retry sends the same client id, so a message that did
// reach the server after all is recognised there and not answered twice.
//
// Kept per conversation in localStorage too, so a reload, or a phone that
// throws the page away mid-send, still finds its unsent words; the next read
// of the conversation decides which of them the server has.

import type { AgentMessage } from './api';

export type OutboxStatus = 'sending' | 'failed';

export interface OutboxItem {
  /** The id the server stores with the message (client_message_id). */
  clientId: string;
  /** What was typed; '' for files alone. */
  message: string;
  /** What the row shows: the text, or "Attached …" for files alone. */
  shown: string;
  status: OutboxStatus;
  /** Why it was not sent, in plain words, for a failed one. */
  error: string;
  createdAt: number;
  /** The tray's files that went with it, while this page holds them. */
  attachmentKeys: string[];
}

const PREFIX = 'agent-session-outbox:';
const MAX_ITEMS = 20;
// A stored message older than this is not offered again: a week-old
// "Not sent" is noise, and its conversation has long moved on.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function newClientId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `c${random}`.slice(0, 40);
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** A conversation's stored outbox. Files are not stored: they are this page's. */
export function readOutbox(id: number): OutboxItem[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(`${PREFIX}${id}`) || '[]');
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter((item) => item && typeof item.clientId === 'string' && typeof item.shown === 'string'
        && Number(item.createdAt) > now - MAX_AGE_MS)
      .slice(-MAX_ITEMS)
      .map((item) => ({
        clientId: item.clientId,
        message: typeof item.message === 'string' ? item.message : '',
        shown: item.shown,
        status: item.status === 'failed' ? 'failed' : 'sending',
        error: typeof item.error === 'string' ? item.error : '',
        createdAt: Number(item.createdAt),
        attachmentKeys: [],
      }));
  } catch {
    return [];
  }
}

export function writeOutbox(id: number, items: OutboxItem[]) {
  const store = storage();
  if (!store) return;
  try {
    if (!items.length) {
      store.removeItem(`${PREFIX}${id}`);
      return;
    }
    const kept = items.slice(-MAX_ITEMS).map(({ attachmentKeys: _files, ...item }) => item);
    store.setItem(`${PREFIX}${id}`, JSON.stringify(kept));
  } catch { /* storage full or refused: the page still holds them */ }
}

/**
 * What is left once the server's rows are in: every item whose message the
 * server shows is gone, whatever this page thought of it (a "Not sent" that
 * reached the server after all is simply sent). The same array comes back
 * when nothing changed, so a publish can tell.
 */
export function withoutLanded(items: OutboxItem[], messages: AgentMessage[]): OutboxItem[] {
  if (!items.length) return items;
  const landed = new Set(messages.map((row) => row.clientMessageId).filter(Boolean));
  if (!landed.size) return items;
  const left = items.filter((item) => !landed.has(item.clientId));
  return left.length === items.length ? items : left;
}

/**
 * Items this page is no longer sending (it was reloaded, or the send ended
 * without the server taking it) that the server does not have: Not sent.
 * `inFlight` is the client ids this page is still waiting on.
 */
export function markStranded(items: OutboxItem[], inFlight: Set<string>, error: string): OutboxItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.status !== 'sending' || inFlight.has(item.clientId)) return item;
    changed = true;
    return { ...item, status: 'failed' as const, error };
  });
  return changed ? next : items;
}

/** Merge rows the server wrote or edited since the last read into the ones held, by id. */
export function mergeRows(held: AgentMessage[], changed: AgentMessage[]): AgentMessage[] {
  if (!changed.length) return held;
  const byId = new Map(held.map((row) => [row.id, row]));
  for (const row of changed) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
