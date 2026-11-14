import { useEffect, useSyncExternalStore } from 'react';

import { t } from '../../lib/i18n/runtime';
import { toast } from '../message-actions/clipboard';
import * as api from './api';
import type { SavedDraft } from './api';

/*
 * SAVED DRAFTS, IN THE CHAT WITH HOMEROOM BOT. The agent chats' list
 * (features/agent-session/store.ts "Saved drafts", the dev chat's #798),
 * for the viewer's own chat with the bot and each of its threads.
 *
 * While the bot works on their message the box saves what is typed instead
 * of sending it (./bot-stop.ts). A draft is words only, kept on the server
 * for the account, so it shows on every device; it is sent later, always by
 * a tap, never on its own.
 *
 * THE SERVER'S LIST IS THE TRUTH (routes/conversations.js, the bot-drafts
 * routes): nothing is mirrored on the device. Every write answers with the
 * list and the screen settles on it; the screen updates first. Another tab
 * or device that changed a list says so over the socket
 * (`conversation_drafts_changed`, botDraftsChanged) and the list on screen
 * is read again.
 *
 * WRITES TO ONE LIST GO IN ORDER. Sending or editing a draft with words in
 * the box is two writes (the draft off the list, the typed words on it), and
 * each answers with the whole list: sent side by side, the answer that
 * arrived last could be the older one, and a draft just removed came back.
 * So a place's writes wait for the one before, an answer is drawn only once
 * no later write is waiting, and a read that began before a write is not
 * drawn over it.
 *
 * One list per place: the chat itself, or a thread of it (its root). This
 * module knows nothing of the conversation store, which calls into it for
 * the socket's event.
 */

export type { SavedDraft } from './api';

/** The server's cap (routes/chat-drafts.js MAX_DRAFTS): a full list refuses a save and evicts nothing. */
export const MAX_SAVED_DRAFTS = 20;

const NONE: readonly SavedDraft[] = Object.freeze([]);
const lists = new Map<string, readonly SavedDraft[]>();
/** The places a mounted message box is showing: the ones an event re-reads. */
const shown = new Map<string, number>();
const listeners = new Set<() => void>();
/** Per place: the writes queued or in flight, the last of them, and a count of every write begun. */
const waiting = new Map<string, number>();
const tails = new Map<string, Promise<void>>();
const writes = new Map<string, number>();

function placeKey(conversationId: number, threadRootId: number | null): string {
  return `${conversationId}:${threadRootId || 0}`;
}

function publish(key: string, drafts: readonly SavedDraft[]): void {
  lists.set(key, drafts.length ? drafts : NONE);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function newDraftId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** The drafts of a place as this device last heard them, oldest first. */
export function botDraftsFor(conversationId: number, threadRootId: number | null = null): readonly SavedDraft[] {
  return lists.get(placeKey(conversationId, threadRootId)) || NONE;
}

/** Read a place's list from the server. A read that fails leaves the list as it was. */
export async function loadBotDrafts(conversationId: number, threadRootId: number | null = null): Promise<void> {
  const key = placeKey(conversationId, threadRootId);
  const begun = writes.get(key) || 0;
  try {
    const drafts = await api.listBotDrafts(conversationId, threadRootId);
    // A write began meanwhile, or one is still on its way: its own answer
    // is the newer list.
    if ((writes.get(key) || 0) === begun && !waiting.get(key)) publish(key, drafts);
  } catch { /* the next write or event reads it again */ }
}

/** One write to a place's list, after the ones before it; its answer is drawn unless another write waits. */
function write(key: string, run: () => Promise<SavedDraft[]>): Promise<void> {
  waiting.set(key, (waiting.get(key) || 0) + 1);
  writes.set(key, (writes.get(key) || 0) + 1);
  const settled = (tails.get(key) || Promise.resolve()).then(run).then(
    (drafts) => { waiting.set(key, (waiting.get(key) || 1) - 1); if (!waiting.get(key)) publish(key, drafts); },
    (error) => { waiting.set(key, (waiting.get(key) || 1) - 1); throw error; },
  );
  tails.set(key, settled.catch(() => undefined));
  return settled;
}

/**
 * A message box is drawn for a place: its list is read, and read again when
 * an event says it changed, until the returned function is called.
 */
export function watchBotDrafts(conversationId: number, threadRootId: number | null = null): () => void {
  const key = placeKey(conversationId, threadRootId);
  shown.set(key, (shown.get(key) || 0) + 1);
  void loadBotDrafts(conversationId, threadRootId);
  return () => {
    const left = (shown.get(key) || 1) - 1;
    if (left > 0) shown.set(key, left); else shown.delete(key);
  };
}

/**
 * The saved drafts of the place a message box is drawn for. Empty on the
 * first render (nothing is read until the effect), and always empty with
 * `enabled` false: only the viewer's chat with Homeroom bot has drafts, and
 * nothing is asked of the server for any other conversation.
 */
export function useBotDrafts(conversationId: number, threadRootId: number | null, enabled: boolean): readonly SavedDraft[] {
  const key = enabled && conversationId ? placeKey(conversationId, threadRootId) : '';
  useEffect(() => (key ? watchBotDrafts(conversationId, threadRootId) : undefined), [key, conversationId, threadRootId]);
  return useSyncExternalStore(subscribe, () => (key ? lists.get(key) || NONE : NONE), () => NONE);
}

/** Another tab or device saved, sent or deleted a draft: the list on screen for that place is read again. */
export function botDraftsChanged(event: { conversationId?: unknown; conversation_id?: unknown; threadRootId?: unknown; thread_root_id?: unknown } | null | undefined): void {
  const conversationId = api.strictId(event?.conversationId ?? event?.conversation_id);
  if (!conversationId) return;
  const threadRootId = api.strictId(event?.threadRootId ?? event?.thread_root_id);
  if (shown.has(placeKey(conversationId, threadRootId))) void loadBotDrafts(conversationId, threadRootId);
}

/** The connection came back: every list on screen is read again. */
export function resyncBotDrafts(): void {
  for (const key of shown.keys()) {
    const [conversationId, root] = key.split(':').map(Number);
    void loadBotDrafts(conversationId, root || null);
  }
}

async function park(conversationId: number, threadRootId: number | null, text: string): Promise<boolean> {
  const key = placeKey(conversationId, threadRootId);
  const draft: SavedDraft = { id: newDraftId(), text, savedAt: new Date().toISOString() };
  publish(key, [...(lists.get(key) || NONE), draft]);
  try {
    await write(key, () => api.saveBotDraft(conversationId, threadRootId, draft));
    return true;
  } catch (error) {
    publish(key, (lists.get(key) || NONE).filter((item) => item.id !== draft.id));
    // Another device filled the list first: say the cap, as a local refusal does.
    const full = error instanceof api.MessagesApiError && error.code === 'draft_cap';
    toast(full ? t('messages:drafts.full', { count: MAX_SAVED_DRAFTS }) : t('messages:drafts.saveFailed'));
    void loadBotDrafts(conversationId, threadRootId);
    return false;
  }
}

async function drop(conversationId: number, threadRootId: number | null, draftId: string): Promise<void> {
  const key = placeKey(conversationId, threadRootId);
  publish(key, (lists.get(key) || NONE).filter((item) => item.id !== draftId));
  try {
    await write(key, () => api.deleteBotDraft(conversationId, threadRootId, draftId));
  } catch {
    toast(t('messages:drafts.deleteFailed'));
    void loadBotDrafts(conversationId, threadRootId);
  }
}

/**
 * The box's "Save draft" while Homeroom bot works. False, with the words
 * left in the box, when nothing is typed or the list is full (said in a
 * toast; nothing is evicted). True once the list shows the draft, and the
 * box empties; a save the server then refuses hands the words to
 * `onRefused`, for the box to take back.
 */
export function saveBotDraft(conversationId: number, threadRootId: number | null, text: string, onRefused?: (text: string) => void): boolean {
  const body = text.trim();
  if (!conversationId || !body) return false;
  if (botDraftsFor(conversationId, threadRootId).length >= MAX_SAVED_DRAFTS) {
    toast(t('messages:drafts.full', { count: MAX_SAVED_DRAFTS }));
    return false;
  }
  void park(conversationId, threadRootId, body).then((saved) => { if (!saved) onRefused?.(body); });
  toast(t('messages:drafts.saved'));
  return true;
}

/**
 * Take a draft off the list, to send it or to put it back in the box: its
 * words, or null when it is no longer there. What the box held (`typed`) is
 * kept as a draft of its own first, so emptying the box for the draft never
 * throws away something the viewer wrote (the dev chat's #1962 rule).
 */
export function takeBotDraft(conversationId: number, threadRootId: number | null, draftId: string, typed = ''): string | null {
  const held = botDraftsFor(conversationId, threadRootId);
  const draft = held.find((item) => item.id === draftId);
  if (!conversationId || !draft) return null;
  const parked = typed.trim() === draft.text ? '' : typed.trim();
  // The draft leaving makes the room its words need; a list somehow over
  // the cap keeps both where they are, said as the cap is.
  if (parked && held.length - 1 >= MAX_SAVED_DRAFTS) {
    toast(t('messages:drafts.full', { count: MAX_SAVED_DRAFTS }));
    return null;
  }
  void drop(conversationId, threadRootId, draftId);
  if (parked) {
    void park(conversationId, threadRootId, parked);
    toast(t('messages:drafts.keptTyped'));
  }
  return draft.text;
}

/** The bin on a draft's row. */
export function deleteBotDraft(conversationId: number, threadRootId: number | null, draftId: string): void {
  if (!conversationId || !botDraftsFor(conversationId, threadRootId).some((item) => item.id === draftId)) return;
  void drop(conversationId, threadRootId, draftId);
  toast(t('messages:drafts.deleted'));
}
