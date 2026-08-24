import { useSyncExternalStore } from 'react';

import * as api from './api';
import type {
  ConversationDetail,
  ConversationEvent,
  ConversationMessage,
  ConversationSummary,
  MessagesSnapshot,
  SharedObjectReference,
} from './types';

const MAX_ID = 2_147_483_647;

interface PendingSend {
  content: string;
  replyToId?: number;
  attachmentIds?: string[];
  object?: SharedObjectReference;
  idempotencyKey: string;
}

interface InternalState extends MessagesSnapshot {
  typing: Record<number, string[]>;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: InternalState = {
  route: { open: false, conversationId: null },
  conversations: [],
  active: null,
  messages: [],
  loadingList: false,
  loadingThread: false,
  loadingOlder: false,
  listLoaded: false,
  error: null,
  threadError: null,
  nextBefore: null,
  online: true,
  demo: false,
  revision: 0,
  typing: {},
};

const drafts = new Map<number, string>();
const replyTargets = new Map<number, ConversationMessage>();
const pendingByConversation = new Map<number, PendingSend[]>();
const typingSentAt = new Map<number, number>();
const typingExpiry = new Map<string, number>();
let pendingShare: SharedObjectReference | null | undefined;
let listRequest = 0;
let threadRequest = 0;

function browserDemo(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === '1';
}

function publish(next: Partial<InternalState>): void {
  state = { ...state, ...next, revision: state.revision + 1 };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): InternalState {
  return state;
}

export function useMessagesSnapshot(): InternalState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function sortConversations(items: ConversationSummary[]): ConversationSummary[] {
  return [...items].sort((a, b) => {
    const time = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    return time || b.id - a.id;
  });
}

function upsertConversation(conversation: ConversationSummary): void {
  const items = state.conversations.filter((item) => item.id !== conversation.id);
  items.push(conversation);
  const active = state.active?.id === conversation.id
    ? { ...state.active, ...conversation }
    : state.active;
  publish({ conversations: sortConversations(items), active });
}

function currentUser(): { id: number; username: string; avatarUrl?: string | null } {
  const user = typeof window !== 'undefined' ? window.App?.user : null;
  return {
    id: Number(user?.id) || 0,
    username: typeof user?.username === 'string' ? user.username : 'You',
    avatarUrl: typeof user?.avatarUrl === 'string' ? user.avatarUrl : null,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof api.MessagesApiError) {
    if (error.status === 404) return 'This conversation is no longer available.';
    if (error.status === 429) return 'You’re doing that too quickly. Try again in a moment.';
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function loadConversations(force = false): Promise<void> {
  // A forced reconciliation must supersede an older request. This matters
  // after block/removal: the pre-revocation response may still contain the
  // now-inaccessible direct conversation and must never win the race.
  if (state.loadingList && !force) return;
  if (state.listLoaded && !force) return;
  const request = ++listRequest;
  publish({ loadingList: true, error: null, demo: browserDemo() });
  try {
    const conversations = await api.listConversations();
    if (request !== listRequest) return;
    publish({
      conversations: sortConversations(conversations),
      loadingList: false,
      listLoaded: true,
      online: true,
    });
  } catch (error) {
    if (request !== listRequest) return;
    publish({
      loadingList: false,
      listLoaded: true,
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      error: errorMessage(error, 'Couldn’t load your conversations.'),
    });
  }
}

export async function loadThread(conversationId: number, force = false): Promise<void> {
  if (!validId(conversationId)) return;
  if (!force && state.active?.id === conversationId && state.messages.length) return;
  const request = ++threadRequest;
  const preserveVisibleThread = force && state.active?.id === conversationId;
  publish({
    loadingThread: true,
    threadError: null,
    active: preserveVisibleThread ? state.active : null,
    messages: preserveVisibleThread ? state.messages : [],
    nextBefore: preserveVisibleThread ? state.nextBefore : null,
  });
  try {
    // Invitation metadata is deliberately readable before acceptance, but
    // retained history is not. Resolve membership first and never request
    // message bytes for an invitee.
    const active = await api.getConversation(conversationId);
    const page = active.membershipStatus === 'member'
      ? await api.listMessages(conversationId)
      : { messages: [], nextBefore: null };
    if (request !== threadRequest || state.route.conversationId !== conversationId) return;
    const messages = [...page.messages].sort((a, b) => a.id - b.id);
    publish({ active, messages, nextBefore: page.nextBefore, loadingThread: false, online: true });
    upsertConversation(active);
    const last = messages.at(-1);
    if (last && active.membershipStatus === 'member') void markRead(last.id);
  } catch (error) {
    if (request !== threadRequest) return;
    publish({ loadingThread: false, threadError: errorMessage(error, 'Couldn’t load this conversation.') });
  }
}

async function refreshActiveAfterMembershipChange(conversationId: number): Promise<void> {
  await loadThread(conversationId, true);
  if (state.route.conversationId !== conversationId) return;
  if (state.threadError === 'This conversation is no longer available.') {
    await finishDirectBlock(conversationId);
  }
}

export async function loadOlder(): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId || !state.nextBefore || state.loadingOlder) return;
  publish({ loadingOlder: true });
  try {
    const page = await api.listMessages(conversationId, state.nextBefore);
    if (state.route.conversationId !== conversationId) return;
    const known = new Set(state.messages.map((message) => message.id));
    const older = page.messages.filter((message) => !known.has(message.id));
    publish({
      messages: [...older, ...state.messages].sort((a, b) => a.id - b.id),
      nextBefore: page.nextBefore,
      loadingOlder: false,
    });
  } catch (error) {
    publish({ loadingOlder: false, threadError: errorMessage(error, 'Couldn’t load older messages.') });
  }
}

function validId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= MAX_ID;
}

function syncDrawerBadge(): void {
  if (typeof document === 'undefined') return;
  const count = state.conversations.reduce((sum, item) => sum + Math.max(0, item.unreadCount || 0), 0);
  // Streamlined Concept: the hamburger's red number sums Messages in, and
  // notifications.js (import-free) paints it — publish the count on the
  // window seam and nudge a repaint when it changes.
  const host = window as unknown as {
    __usernodeMessagesUnread?: number;
    Notifications?: { _renderBadge?: () => void };
  };
  if (host.__usernodeMessagesUnread !== count) {
    host.__usernodeMessagesUnread = count;
    host.Notifications?._renderBadge?.();
  }
  const badge = document.getElementById('drawer-messages-badge');
  if (!badge) return;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('hidden', count === 0);
}

listeners.add(syncDrawerBadge);

export function route(conversationId?: number | null): void {
  const nextId = validId(conversationId) ? conversationId : null;
  if (state.route.open && state.route.conversationId === nextId) {
    if (!state.listLoaded) void loadConversations();
    if (nextId && (!state.active || state.active.id !== nextId)) void loadThread(nextId);
    return;
  }
  publish({ route: { open: true, conversationId: nextId }, threadError: null });
  void loadConversations();
  if (nextId) void loadThread(nextId);
  else publish({ active: null, messages: [], nextBefore: null, loadingThread: false });
}

export function close(): void {
  threadRequest += 1;
  // An external share waiting on the bare list is navigation intent, not a
  // durable draft. Leaving Messages cancels it instead of surprising the user
  // in an unrelated conversation later.
  pendingShare = undefined;
  publish({ route: { open: false, conversationId: null }, active: null, messages: [], loadingThread: false, threadError: null });
}

export function isOpen(): boolean {
  return state.route.open;
}

export function handleBack(): boolean {
  if (!state.route.open || !state.route.conversationId || !isMobile()) return false;
  const current = typeof location !== 'undefined' ? location.hash : '';
  if (current.startsWith('#messages/') && typeof history !== 'undefined') {
    try { history.replaceState(null, '', '#messages'); } catch { /* non-fatal */ }
  }
  route(null);
  syncChrome();
  return true;
}

export function isMobile(): boolean {
  try { return typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches; }
  catch { return false; }
}

export function syncChrome(): void {
  const app = typeof window !== 'undefined' ? window.App : undefined;
  if (!app) return;
  const thread = isMobile() && !!state.route.conversationId;
  app.setBackIcon?.(thread ? 'arrow' : 'home', thread ? '#messages' : undefined);
  app.setHeaderTitle?.(thread ? state.active?.title || 'Messages' : 'Messages');
}

export function open(conversationId?: number | null): void {
  if (typeof window === 'undefined') return;
  const target = validId(conversationId) ? `#messages/${conversationId}` : '#messages';
  if (window.location.hash === target) route(conversationId || null);
  else window.location.hash = target;
}

export function selectConversation(conversationId: number): void {
  if (!validId(conversationId) || typeof window === 'undefined') return;
  window.location.hash = `#messages/${conversationId}`;
}

export async function createDirect(userId: number): Promise<ConversationDetail> {
  const conversation = await api.createConversation({ kind: 'direct', userId });
  upsertConversation(conversation);
  open(conversation.id);
  return conversation;
}

export async function createGroup(title: string, memberIds: number[]): Promise<ConversationDetail> {
  const conversation = await api.createConversation({ kind: 'group', title, memberIds });
  upsertConversation(conversation);
  open(conversation.id);
  return conversation;
}

export async function respond(action: 'accept' | 'decline'): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  const conversation = await api.respondToInvitation(id, action);
  if (action === 'accept' && conversation) {
    upsertConversation(conversation);
    await loadThread(id, true);
  } else {
    publish({ conversations: state.conversations.filter((item) => item.id !== id) });
    open(null);
  }
}

export async function inviteMembers(userIds: number[]): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  const conversation = await api.addMembers(id, userIds);
  upsertConversation(conversation);
}

export async function removeMember(userId: number): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  await api.removeMember(id, userId);
  await loadThread(id, true);
}

export async function leave(): Promise<void> {
  const id = state.route.conversationId;
  if (!id) return;
  await api.leaveConversation(id);
  publish({ conversations: state.conversations.filter((item) => item.id !== id) });
  open(null);
}

/**
 * Apply the local half of a successful direct-message block. The server has
 * already made this conversation inaccessible; remove every retained byte
 * before refreshing the authoritative list and returning to level 1.
 */
export async function finishDirectBlock(conversationId: number): Promise<void> {
  if (!validId(conversationId)) return;
  threadRequest += 1;
  publish({
    conversations: state.conversations.filter((item) => item.id !== conversationId),
    active: null,
    messages: [],
    loadingThread: false,
    threadError: null,
    nextBefore: null,
  });
  open(null);
  await loadConversations(true);
}

export function draftFor(conversationId: number): string {
  if (drafts.has(conversationId)) return drafts.get(conversationId) || '';
  try {
    const value = localStorage.getItem(`usernode:messages-draft:${conversationId}`) || '';
    drafts.set(conversationId, value);
    return value;
  } catch { return ''; }
}

export function setDraft(conversationId: number, value: string): void {
  drafts.set(conversationId, value);
  try {
    if (value) localStorage.setItem(`usernode:messages-draft:${conversationId}`, value);
    else localStorage.removeItem(`usernode:messages-draft:${conversationId}`);
  } catch { /* storage unavailable */ }
  publish({});
}

export function replyFor(conversationId: number): ConversationMessage | null {
  return replyTargets.get(conversationId) || null;
}

export function setReply(conversationId: number, message: ConversationMessage | null): void {
  if (message) replyTargets.set(conversationId, message);
  else replyTargets.delete(conversationId);
  publish({});
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function send(input: { content: string; attachmentIds?: string[]; object?: SharedObjectReference }): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const content = input.content.slice(0, 8000);
  const reply = replyFor(conversationId);
  const pending: PendingSend = {
    content,
    attachmentIds: input.attachmentIds,
    object: input.object,
    replyToId: reply?.id,
    idempotencyKey: idempotencyKey(),
  };
  const optimisticId = -Date.now();
  const optimistic: ConversationMessage = {
    id: optimisticId,
    conversationId,
    sender: currentUser(),
    content,
    createdAt: new Date().toISOString(),
    reply: reply ? { id: reply.id, sender: reply.sender, content: reply.content } : null,
    reactions: [], attachments: [], objects: [], pending: true, clientKey: pending.idempotencyKey,
  };
  setDraft(conversationId, '');
  setReply(conversationId, null);
  publish({ messages: [...state.messages, optimistic], threadError: null });
  try {
    const message = await api.sendMessage(conversationId, pending);
    if (state.route.conversationId === conversationId) {
      // The member-scoped WS event can win the race with this HTTP response
      // and refresh the real row into the thread first. Remove both the
      // optimistic placeholder and any already-present server id before the
      // authoritative POST response is inserted.
      const messages = state.messages
        .filter((item) => item.id !== optimisticId && item.id !== message.id)
        .concat(message)
        .sort((a, b) => a.id - b.id);
      publish({ messages });
    }
    await loadConversations(true);
  } catch (error) {
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    if (offline) {
      const queue = pendingByConversation.get(conversationId) || [];
      queue.push(pending);
      pendingByConversation.set(conversationId, queue.slice(-50));
    }
    publish({
      online: !offline,
      messages: state.messages.map((item) => item.id === optimisticId ? { ...item, pending: false, failed: true } : item),
      threadError: offline ? 'Message queued. It will retry when you reconnect.' : errorMessage(error, 'Your message wasn’t sent.'),
    });
  }
}

export async function retryPending(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  publish({ online: true });
  for (const [conversationId, queue] of [...pendingByConversation]) {
    const remaining: PendingSend[] = [];
    for (const pending of queue) {
      try { await api.sendMessage(conversationId, pending); }
      catch { remaining.push(pending); }
    }
    if (remaining.length) pendingByConversation.set(conversationId, remaining);
    else pendingByConversation.delete(conversationId);
  }
  if (state.route.conversationId) await loadThread(state.route.conversationId, true);
  await loadConversations(true);
}

export async function edit(messageId: number, content: string): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const message = await api.editMessage(conversationId, messageId, content.slice(0, 8000));
  publish({ messages: state.messages.map((item) => item.id === message.id ? message : item) });
}

export async function react(messageId: number, emoji: string): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const reactions = await api.toggleReaction(conversationId, messageId, emoji);
  publish({ messages: state.messages.map((item) => item.id === messageId ? { ...item, reactions } : item) });
}

export async function markRead(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const items = state.conversations.map((item) => item.id === conversationId ? { ...item, unreadCount: 0 } : item);
  publish({ conversations: items });
  try { await api.markRead(conversationId, messageId); } catch { /* next open reconciles */ }
}

function eventConversationId(event: ConversationEvent): number | null {
  return api.strictId(event.conversationId ?? event.conversation_id);
}

export function handleEvent(raw: ConversationEvent): void {
  const event = raw || { type: '' };
  const conversationId = eventConversationId(event);
  if (!conversationId) return;
  switch (event.type) {
    case 'conversation_message_created': {
      // Realtime deliberately carries ids only: hydrated messages and shared
      // object cards must be resolved under this viewer's REST permissions.
      if (state.route.open && state.route.conversationId === conversationId) {
        void loadThread(conversationId, true);
      }
      void loadConversations(true);
      break;
    }
    case 'conversation_message_updated': {
      if (state.route.open && state.route.conversationId === conversationId) {
        void loadThread(conversationId, true);
      }
      void loadConversations(true);
      break;
    }
    case 'conversation_reaction_updated': {
      const messageId = api.strictId(event.messageId ?? event.message_id);
      if (!messageId) break;
      // Like message create/edit, reaction realtime is intentionally id-only.
      // Rehydrate under this viewer's current membership/block permissions.
      if (state.route.open && state.route.conversationId === conversationId) {
        void loadThread(conversationId, true);
      }
      break;
    }
    case 'conversation_read':
      void loadConversations(true);
      break;
    case 'conversation_membership_changed':
      void loadConversations(true);
      if (state.route.conversationId === conversationId) {
        // A removal, departure, or either-side block can make the active
        // conversation 404. Treat that as revocation: discard retained local
        // content and return to the list instead of showing a stale thread.
        void refreshActiveAfterMembershipChange(conversationId);
      }
      break;
    case 'conversation_typing': {
      const userId = api.strictId(event.userId ?? event.user_id);
      // The wire event carries no profile data. Resolve the active member
      // locally so a typing event cannot smuggle a stale/unauthorized name.
      const username = state.active?.id === conversationId
        ? state.active.members.find((member) => member.id === userId && member.status === 'member')?.username || ''
        : '';
      if (!userId || userId === currentUser().id || !username) break;
      const current = new Set(state.typing[conversationId] || []);
      const expiryKey = `${conversationId}:${userId}`;
      const existingExpiry = typingExpiry.get(expiryKey);
      if (existingExpiry && typeof window !== 'undefined') window.clearTimeout(existingExpiry);
      typingExpiry.delete(expiryKey);
      if (event.typing === false) current.delete(username); else current.add(username);
      publish({ typing: { ...state.typing, [conversationId]: [...current] } });
      if (event.typing !== false && typeof window !== 'undefined') {
        typingExpiry.set(expiryKey, window.setTimeout(() => {
          typingExpiry.delete(expiryKey);
          const next = new Set(state.typing[conversationId] || []);
          if (!next.delete(username)) return;
          publish({ typing: { ...state.typing, [conversationId]: [...next] } });
        }, 6000));
      }
      break;
    }
  }
}

export function typingUsers(conversationId: number): string[] {
  return state.typing[conversationId] || [];
}

export function notifyTyping(typing: boolean): void {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const now = Date.now();
  if (typing && now - (typingSentAt.get(conversationId) || 0) < 1800) return;
  typingSentAt.set(conversationId, typing ? now : 0);
  void api.setTyping(conversationId, typing).catch(() => { /* ephemeral */ });
}

export async function share(reference?: SharedObjectReference): Promise<void> {
  if (typeof window === 'undefined') return;
  const conversationId = state.route.conversationId;
  pendingShare = reference || null;
  open(conversationId || null);
  // With a current destination the mounted composer consumes this event
  // synchronously. On the bare list, retain pendingShare until selecting or
  // creating a conversation changes the composer route to a nonzero id.
  if (conversationId) {
    window.dispatchEvent(new CustomEvent('usernode:messages-share', { detail: pendingShare }));
  }
}

export function takePendingShare(): SharedObjectReference | null | undefined {
  const value = pendingShare;
  pendingShare = undefined;
  return value;
}

export const messagesController = {
  open,
  route,
  close,
  isOpen,
  handleBack,
  syncChrome,
  handleEvent,
  share,
  refresh: () => loadConversations(true),
};

export function initializeMessagesStore(): () => void {
  const onOnline = () => { void retryPending(); };
  const onOffline = () => publish({ online: false });
  const onAuthed = () => { void loadConversations(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  // The store is always mounted, but the endpoint is session-gated. Seed the
  // drawer badge as soon as an already-resolved user exists, or wait for the
  // shell's one-shot authenticated boot event on an anonymous document.
  if (window.App?.user) void loadConversations();
  else document.addEventListener('sv:authed', onAuthed, { once: true });
  publish({ online: navigator.onLine, demo: browserDemo() });
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('sv:authed', onAuthed);
  };
}
