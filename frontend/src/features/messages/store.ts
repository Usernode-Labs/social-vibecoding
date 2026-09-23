import { useSyncExternalStore } from 'react';

import { navStore } from '../nav/nav-store.js';
import * as api from './api';
import { channelDirectory, normalizeHandle, type ChannelRef } from './channels';
import type { AppDiscussion, InboxFilter } from './inbox';
import type {
  ConversationDetail,
  DiscussionContext,
  ConversationEvent,
  ConversationMessage,
  ConversationSummary,
  MessagesAgentThread,
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
  route: { open: false, conversationId: null, appSlug: null, agent: null },
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
  discussions: [],
  discussionsLoaded: false,
  discussionContext: null,
  discussionError: null,
  filter: 'all',
};

const drafts = new Map<number, string>();
const replyTargets = new Map<number, ConversationMessage>();
const pendingByConversation = new Map<number, PendingSend[]>();
/*
 * THE SENDER'S OWN ROWS OUTLIVE A REFRESH (#2907). A send draws its message
 * at once, faded, and nothing else: no spinner, no "sending…" line. The
 * realtime echo of that same send re-reads the thread, and the page it reads
 * back must not take the row away (it is still in flight) nor draw it twice
 * (the server already has it). `unsent` holds each local row's payload by its
 * client key — what a failed row's Retry sends again, under the same
 * idempotency key so the server never stores it twice — and `sentKeys` maps a
 * confirmed server id back to the client key the row was drawn under, so the
 * row keeps its React key and is updated in place rather than remounted.
 */
const unsent = new Map<string, { conversationId: number; payload: PendingSend }>();
const sentKeys = new Map<number, string>();
const typingSentAt = new Map<number, number>();
const typingExpiry = new Map<string, number>();
let pendingShare: SharedObjectReference | null | undefined;
/** A `#messages/channel/<handle>` link followed before the lists landed. */
let pendingChannel: string | null = null;
let listRequest = 0;
let threadRequest = 0;

function browserDemo(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('demo') === '1';
}

function publish(next: Partial<InternalState>): void {
  state = { ...state, ...next, revision: state.revision + 1 };
  for (const listener of [...listeners]) listener();
  if (next.conversations) syncTabBadge();
}

/**
 * The Messages tab's badge (#2794): how many conversations have something
 * unread, i.e. how many rows on this screen draw a count.
 *
 * Derived here, from every write to `conversations`, rather than from each
 * caller, because every path that changes an unread count already ends in
 * one: the boot load, a socket event's reload, markRead's local zeroing, a
 * leave or a block. The nav store drops a patch that changes nothing, so the
 * common case — a reload with the same unread rows — notifies no one.
 */
function syncTabBadge(): void {
  navStore.set({ messages: state.conversations.filter((item) => item.unreadCount > 0).length });
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

/**
 * Which of the four kinds the list is showing (#2718).
 *
 * Presentation, so it is not persisted and not in the route: a filter that
 * survives a reload is a filter somebody has to remember turning on, and the
 * one thing this screen must always be able to say is "here is everything".
 */
export function setFilter(next: InboxFilter): void {
  if (state.filter === next) return;
  publish({ filter: next });
}

/**
 * The channels the viewer can name — #general and their apps' (#2783).
 *
 * Memoised on the two arrays it is built from, so a caller that asks on
 * every render (a transcript row, the legacy app chat) gets the same object
 * until one of them actually changes.
 */
let directoryCache: { conversations: unknown; discussions: unknown; value: ChannelRef[] } | null = null;
export function channels(): ChannelRef[] {
  if (!directoryCache || directoryCache.conversations !== state.conversations
      || directoryCache.discussions !== state.discussions) {
    directoryCache = {
      conversations: state.conversations,
      discussions: state.discussions,
      value: channelDirectory(state.conversations, state.discussions),
    };
  }
  return directoryCache.value;
}

/** The handles alone, for the renderers that chip `#name`. */
export function useChannelHandles(): ReadonlySet<string> {
  useMessagesSnapshot();
  const list = channels();
  return handleSetFor(list);
}
const handleSets = new WeakMap<ChannelRef[], ReadonlySet<string>>();
function handleSetFor(list: ChannelRef[]): ReadonlySet<string> {
  let set = handleSets.get(list);
  if (!set) { set = new Set(list.map((item) => item.handle)); handleSets.set(list, set); }
  return set;
}

/**
 * Follow a `#handle` link: `#messages/channel/<handle>` becomes the address
 * of the channel it names, in place (the link's own entry is replaced, so
 * Back does not bounce through it).
 *
 * The lists may not have landed yet — a chip clicked in an app's chat on a
 * cold Messages store — so an unknown handle waits for both reads and then
 * resolves, or falls back to the bare inbox when nothing answers to it.
 */
export function openChannel(raw: string): void {
  if (typeof window === 'undefined') return;
  const handle = normalizeHandle(raw);
  if (!handle) { window.location.replace('#messages'); return; }
  pendingChannel = handle;
  void loadConversations();
  void loadAppDiscussions();
  resolvePendingChannel();
}

function resolvePendingChannel(): void {
  if (!pendingChannel || typeof window === 'undefined') return;
  const found = channels().find((item) => item.handle === pendingChannel);
  if (found) {
    pendingChannel = null;
    window.location.replace(found.target);
    return;
  }
  if (state.listLoaded && state.discussionsLoaded) {
    pendingChannel = null;
    window.location.replace('#messages');
  }
}

/**
 * The app discussions beside the conversations.
 *
 * FAILS QUIETLY. The conversations are this screen's reason to exist and the
 * discussions are an addition to it; a list that refuses to draw because a
 * second request failed is worse than one that draws what it has. The Apps
 * filter then shows nothing, which is the honest report of what arrived.
 */
export async function loadAppDiscussions(): Promise<void> {
  try {
    const query = browserDemo() ? '?demo=1' : '';
    const response = await fetch(`/api/messages/app-discussions${query}`);
    if (!response.ok) return;
    const data = await response.json().catch(() => null);
    if (!data || !Array.isArray(data.discussions)) return;
    publish({ discussions: data.discussions as AppDiscussion[], discussionsLoaded: true });
  } catch {
    // Offline is a state, not a crash.
  } finally {
    // A failed read still settles a waiting `#handle`: it falls back to the
    // inbox rather than leaving the link going nowhere.
    if (pendingChannel && !state.discussionsLoaded) publish({ discussionsLoaded: true });
    resolvePendingChannel();
  }
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
    resolvePendingChannel();
  } catch (error) {
    if (request !== listRequest) return;
    publish({
      loadingList: false,
      listLoaded: true,
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      error: errorMessage(error, 'Couldn’t load your conversations.'),
    });
    resolvePendingChannel();
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
    const messages = withLocalRows(conversationId, [...page.messages].sort((a, b) => a.id - b.id));
    publish({ active, messages, nextBefore: page.nextBefore, loadingThread: false, online: true });
    upsertConversation(active);
    const last = messages.at(-1);
    if (last && active.membershipStatus === 'member') void markRead(last.id);
  } catch (error) {
    if (request !== threadRequest) return;
    publish({ loadingThread: false, threadError: errorMessage(error, 'Couldn’t load this conversation.') });
  }
}

/**
 * A page read from the server, with the viewer's still-local rows kept.
 *
 * Confirmed rows get back the client key they were first drawn under. A
 * local row (pending or failed) stays at the end unless the page already
 * holds it: the realtime echo can land before the POST that caused it
 * returns, and then the server's copy — the viewer's, same words, not yet
 * claimed by another local row — IS that row, so it takes its key and the
 * local one goes.
 */
function withLocalRows(conversationId: number, page: ConversationMessage[]): ConversationMessage[] {
  const me = currentUser().id;
  const claimed = new Set(sentKeys.values());
  const messages = page.map((item) => {
    const key = sentKeys.get(item.id);
    return key ? { ...item, clientKey: key } : item;
  });
  const local: ConversationMessage[] = [];
  for (const row of state.messages) {
    if (row.id >= 0 || row.conversationId !== conversationId || !row.clientKey || claimed.has(row.clientKey)) continue;
    const match = messages.find((item) => !item.clientKey && item.sender.id === me && item.content === row.content);
    if (match && row.pending) {
      sentKeys.set(match.id, row.clientKey);
      match.clientKey = row.clientKey;
      continue;
    }
    local.push(row);
  }
  return messages.concat(local);
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

/**
 * Tell the bell that a conversation has been read.
 *
 * `POST /api/conversations/:id/read` clears that conversation's notification
 * rows server-side; this is the same clearing applied to the copy the open
 * document is holding, so the badge falls when you read rather than at the
 * next refresh. See Notifications.markConversationRead for why it is a window
 * seam rather than an import (that module loads as a classic script in two
 * test harnesses and cannot carry one).
 *
 * A no-op wherever the shell has not booted — the notifications module
 * publishes itself on load, and the first refresh reconciles anything missed.
 */
function notifyConversationRead(conversationId: number): void {
  if (typeof window === 'undefined') return;
  window.Notifications?.markConversationRead?.(conversationId);
}

export function route(
  conversationId?: number | null,
  appSlug?: string | null,
  agent?: MessagesAgentThread | null,
): void {
  const nextId = validId(conversationId) ? conversationId : null;
  // ONE THREAD IS OPEN (#2718 review). An app's discussion and a conversation
  // are both threads of this inbox, addressed differently because one is an
  // app and the other a row in this database — so naming one clears the
  // other rather than leaving two panes' worth of state half-set. #2813's
  // agent threads join the same rule, last in precedence.
  const nextSlug = nextId ? null : validSlug(appSlug);
  const nextAgent = nextId || nextSlug ? null : validAgentThread(agent);
  if (state.route.open && state.route.conversationId === nextId
      && state.route.appSlug === nextSlug && sameAgentThread(state.route.agent, nextAgent)) {
    if (!state.listLoaded) void loadConversations();
    if (!state.discussionsLoaded) void loadAppDiscussions();
    if (nextId && (!state.active || state.active.id !== nextId)) void loadThread(nextId);
    if (nextSlug && state.discussionContext?.slug !== nextSlug) void loadDiscussion(nextSlug);
    return;
  }
  publish({
    route: { open: true, conversationId: nextId, appSlug: nextSlug, agent: nextAgent },
    threadError: null,
    discussionError: null,
    // The previous thread's app, if there was one. Held until the next one
    // lands and cleared outright when the next thread is a conversation, so
    // the pane never draws one app's name over another's transcript.
    discussionContext: nextSlug && state.discussionContext?.slug === nextSlug
      ? state.discussionContext : null,
  });
  void loadConversations();
  // #2718: beside the conversations, never instead of them. It is a separate
  // request with its own failure, so a slow or broken discussions read costs
  // the Apps filter and nothing else — see loadAppDiscussions.
  void loadAppDiscussions();
  if (nextId) void loadThread(nextId);
  else publish({ active: null, messages: [], nextBefore: null, loadingThread: false });
  if (nextSlug) void loadDiscussion(nextSlug);
}

/**
 * An agent thread out of the address bar (#2813). A global chat's id is a
 * UUID and a session's a serial; anything else is not a thread this inbox
 * can open, and the pane falls back to "choose a conversation".
 */
export function validAgentThread(agent?: MessagesAgentThread | null): MessagesAgentThread | null {
  if (!agent || typeof agent !== 'object') return null;
  if (agent.kind === 'chat') {
    const id = typeof agent.id === 'string' ? agent.id.trim() : '';
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? { kind: 'chat', id } : null;
  }
  if (agent.kind === 'session') {
    const slug = validSlug(agent.slug);
    return slug && validId(agent.id) ? { kind: 'session', slug, id: agent.id } : null;
  }
  return null;
}

function sameAgentThread(a: MessagesAgentThread | null, b: MessagesAgentThread | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'chat' && b.kind === 'chat') return a.id === b.id;
  if (a.kind === 'session' && b.kind === 'session') return a.slug === b.slug && a.id === b.id;
  return false;
}

/**
 * The inbox's own address for an agent thread (#2813). The rows link here on
 * every viewport; on a phone the router swaps it for `fullScreenAddress`.
 */
export function agentThreadAddress(agent: MessagesAgentThread): string {
  return agent.kind === 'chat'
    ? `#messages/agent/${encodeURIComponent(agent.id)}`
    : `#messages/session/${encodeURIComponent(agent.slug)}/${agent.id}`;
}

/** Where the same thread lives as a screen of its own — a phone's destination. */
export function fullScreenAddress(agent: MessagesAgentThread): string {
  return agent.kind === 'chat'
    ? `#chat/${encodeURIComponent(agent.id)}`
    : `#app/${encodeURIComponent(agent.slug)}/dev/sessions/${agent.id}`;
}

/**
 * A slug out of the address bar. Same shape the platform mints (#2718) —
 * `<name>-<hex>` — and nothing here builds a URL from it without encoding,
 * but a route segment is viewer input and the pane renders its name.
 */
function validSlug(slug?: string | null): string | null {
  if (typeof slug !== 'string') return null;
  const trimmed = slug.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(trimmed) ? trimmed : null;
}

/**
 * The open discussion's app.
 *
 * The inbox row already carries the name, but not whether this viewer may
 * WRITE: that is `can_collaborate`, a fact about the app rather than about
 * its last message, so it comes from the app itself. Getting it wrong either
 * way is worse than waiting — a composer that cannot send, or no composer
 * where there should be one — so the pane holds until this lands.
 */
export async function loadDiscussion(slug: string): Promise<void> {
  const want = validSlug(slug);
  if (!want) return;
  try {
    const response = await fetch(`/api/apps/${encodeURIComponent(want)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json().catch(() => null);
    const app = (data && (data.app || data)) || null;
    if (!app || !app.slug) throw new Error('No such app');
    // A slower request for a thread the reader has already left must not
    // paint over the one they are looking at.
    if (state.route.appSlug !== want) return;
    publish({
      discussionContext: {
        slug: app.slug,
        name: app.name || app.slug,
        readOnly: app.can_collaborate === false,
        // The header tile's artwork when the inbox has no row for this app.
        // `/api/apps/:slug` sends the raw row, so the image is its
        // `icon_image_id` at the platform's own `/app-icons/<id>` address —
        // the one spelling src/routes/messages-overview.js uses for the row.
        iconUrl: app.icon_url || (app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null),
        iconEmoji: app.icon_emoji || null,
      },
      discussionError: null,
    });
  } catch {
    if (state.route.appSlug !== want) return;
    publish({ discussionContext: null, discussionError: 'This discussion could not be opened.' });
  }
}

export function close(): void {
  threadRequest += 1;
  // An external share waiting on the bare list is navigation intent, not a
  // durable draft. Leaving Messages cancels it instead of surprising the user
  // in an unrelated conversation later.
  pendingShare = undefined;
  publish({
    route: { open: false, conversationId: null, appSlug: null, agent: null },
    active: null, messages: [], loadingThread: false, threadError: null,
    discussionContext: null, discussionError: null,
  });
}

export function isOpen(): boolean {
  return state.route.open;
}

export function handleBack(): boolean {
  const onThread = !!state.route.conversationId || !!state.route.appSlug || !!state.route.agent;
  if (!state.route.open || !onThread || !isMobile()) return false;
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
  // A DISCUSSION IS A THREAD OF THIS SCREEN (#2718 review), so it answers the
  // chrome the same way: the list's chevron on a phone, nothing on a desktop
  // where the list is still beside it. It used to be a route into #app-view,
  // which is why backing out of one landed wherever that screen's slot
  // pointed — the Workshop, when that is where the app had been opened from.
  const thread = isMobile() && !!(state.route.conversationId || state.route.appSlug || state.route.agent);
  // 'none' ON THE INBOX (#2718 review). This is a second writer over the
  // slot App._BACK_SLOT already set for #messages-screen, and it was
  // publishing the house — so Messages was the one tab root still offering
  // a jump to a screen its own bar already reaches. A THREAD is a level
  // inside this screen and keeps its chevron up to the list.
  app.setBackIcon?.(thread ? 'arrow' : 'none', thread ? '#messages' : undefined);
  app.setHeaderTitle?.(thread
    ? (state.route.appSlug
      ? state.discussionContext?.name || 'Discussion'
      : state.route.agent ? 'Messages' : state.active?.title || 'Messages')
    : 'Messages');
}

/**
 * THE SIDE PANEL (desktop): while an app is running on its App tab, a
 * conversation opened from outside the inbox — a notification, a saved
 * message — goes to a panel beside the app instead of replacing it
 * (frontend/src/features/side-panel/). False whenever that is not the moment,
 * and the caller navigates as it always has.
 */
function sidePanelTakes(target: string): boolean {
  const panel = (window as unknown as {
    UsernodeReact?: { sidePanel?: { take?: (route: string) => boolean } };
  }).UsernodeReact?.sidePanel;
  try {
    return !!panel?.take?.(target.replace(/^#/, ''));
  } catch {
    return false;
  }
}

export function open(conversationId?: number | null): void {
  if (typeof window === 'undefined') return;
  const target = validId(conversationId) ? `#messages/${conversationId}` : '#messages';
  if (sidePanelTakes(target)) return;
  if (window.location.hash === target) route(conversationId || null);
  else window.location.hash = target;
}

/** The same, for the app-discussion half of the inbox (#2718 review). */
export function openDiscussion(slug: string): void {
  if (typeof window === 'undefined') return;
  const safe = validSlug(slug);
  if (!safe) return;
  const target = `#messages/app/${encodeURIComponent(safe)}`;
  if (sidePanelTakes(target)) return;
  if (window.location.hash === target) route(null, safe);
  else window.location.hash = target;
}

/**
 * The same, for an agent thread (#2813). The rows are ordinary links to
 * `agentThreadAddress`; this is for the callers that are not a link — and
 * for re-selecting the thread already open, which a link cannot do.
 */
export function openAgentThread(agent: MessagesAgentThread): void {
  if (typeof window === 'undefined') return;
  const safe = validAgentThread(agent);
  if (!safe) return;
  const target = agentThreadAddress(safe);
  if (window.location.hash === target) route(null, null, safe);
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

/** Reconcile the open thread and inbox after changing a sender block. */
export async function setUserBlocked(userId: number, blocked: boolean): Promise<void> {
  await api.setBlock(userId, blocked);
  await refreshBlockedView(userId, blocked);
}

async function refreshBlockedView(userId: number, blocked: boolean): Promise<void> {
  void loadAppDiscussions();
  (window as any).GroupChat?.refreshAfterBlock?.();
  const active = state.active;
  if (blocked && active?.kind === 'direct'
      && (active.peer?.id === userId || active.requester?.id === userId
        || active.members.some((member) => member.id === userId))) {
    await finishDirectBlock(active.id);
    return;
  }
  const conversationId = state.route.conversationId;
  if (blocked) publish({ messages: [] });
  await Promise.all([
    loadConversations(true),
    ...(conversationId ? [loadThread(conversationId, true)] : []),
  ]);
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

export async function send(input: { content: string; attachmentIds?: string[]; object?: SharedObjectReference; attachments?: ConversationMessage['attachments'] }): Promise<void> {
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
  const optimistic: ConversationMessage = {
    id: -Date.now(),
    conversationId,
    sender: currentUser(),
    content,
    createdAt: new Date().toISOString(),
    reply: reply ? { id: reply.id, sender: reply.sender, content: reply.content } : null,
    // The files already uploaded draw with the row, so a file-only send is
    // not an empty line while it is in flight.
    reactions: [], attachments: input.attachments || [], objects: [], pending: true, clientKey: pending.idempotencyKey,
  };
  unsent.set(pending.idempotencyKey, { conversationId, payload: pending });
  setDraft(conversationId, '');
  setReply(conversationId, null);
  publish({ messages: [...state.messages, optimistic], threadError: null });
  await deliver(conversationId, pending);
}

/**
 * Send a local row's payload and settle the row: the server's message in its
 * place (same client key, so it is updated rather than remounted), or the
 * row marked failed with its Retry. The row is found by client key, not by
 * its temporary id, because a refresh can have re-read the thread meanwhile.
 */
async function deliver(conversationId: number, pending: PendingSend): Promise<void> {
  const key = pending.idempotencyKey;
  try {
    const message = await api.sendMessage(conversationId, pending);
    unsent.delete(key);
    sentKeys.set(message.id, key);
    if (state.route.conversationId === conversationId) {
      // The member-scoped WS event can win the race with this HTTP response
      // and refresh the real row into the thread first. Remove both the
      // local row and any already-present server id before the
      // authoritative POST response is inserted.
      const messages = state.messages
        .filter((item) => item.clientKey !== key && item.id !== message.id)
        .concat({ ...message, clientKey: key })
        // Server rows by id; local rows (negative ids) stay after them in
        // the order they were sent.
        .sort((a, b) => (a.id < 0 || b.id < 0 ? Number(a.id < 0) - Number(b.id < 0) : a.id - b.id));
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
      messages: state.messages.map((item) => item.clientKey === key ? { ...item, pending: false, failed: true } : item),
      threadError: offline ? 'Message queued. It will retry when you reconnect.' : errorMessage(error, 'Your message wasn’t sent.'),
    });
  }
}

/** Send a failed row again, in place (#2907). */
export async function retrySend(clientKey: string): Promise<void> {
  const entry = unsent.get(clientKey);
  if (!entry) return;
  const queue = pendingByConversation.get(entry.conversationId);
  if (queue) pendingByConversation.set(entry.conversationId, queue.filter((item) => item.idempotencyKey !== clientKey));
  publish({
    threadError: null,
    messages: state.messages.map((item) => item.clientKey === clientKey ? { ...item, pending: true, failed: false } : item),
  });
  await deliver(entry.conversationId, entry.payload);
}

/** Drop a failed row the sender no longer wants to send. */
export function discardFailed(clientKey: string): void {
  const entry = unsent.get(clientKey);
  unsent.delete(clientKey);
  if (entry) {
    const queue = pendingByConversation.get(entry.conversationId);
    if (queue) pendingByConversation.set(entry.conversationId, queue.filter((item) => item.idempotencyKey !== clientKey));
  }
  publish({ messages: state.messages.filter((item) => !(item.clientKey === clientKey && item.failed)) });
}

export async function retryPending(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  publish({ online: true });
  for (const [conversationId, queue] of [...pendingByConversation]) {
    const remaining: PendingSend[] = [];
    for (const pending of queue) {
      try {
        const message = await api.sendMessage(conversationId, pending);
        unsent.delete(pending.idempotencyKey);
        sentKeys.set(message.id, pending.idempotencyKey);
      }
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

/**
 * Toggle the viewer's save on one message.
 *
 * OPTIMISTIC, and for the reason app group chat's toggle is (see
 * GroupChat.toggleBookmark): a save is a personal, instantly reversible act,
 * and a spinner on a bookmark reads as breakage. The flip is published first
 * and reverted if the server refuses, so the button never sits in a state the
 * server disagrees with — and the error is rethrown so the row can say so.
 *
 * The drawer's pinned "Saved" section is fed by the notifications payload, so
 * it only learns about this through a refresh. Notifications is published on
 * `window` by the React bundle; guard for the harnesses where it is absent.
 */
export async function toggleSaved(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const current = state.messages.find((item) => item.id === messageId);
  if (!current) return;
  const next = !current.saved;
  const paint = (saved: boolean) => publish({
    messages: state.messages.map((item) => item.id === messageId ? { ...item, saved } : item),
  });
  paint(next);
  try {
    await api.setMessageSaved(conversationId, messageId, next);
    const host = window as unknown as { Notifications?: { refresh?: () => void } };
    host.Notifications?.refresh?.();
  } catch (err) {
    paint(!next);
    throw err;
  }
}

export async function markRead(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const items = state.conversations.map((item) => item.id === conversationId ? { ...item, unreadCount: 0 } : item);
  publish({ conversations: items });
  notifyConversationRead(conversationId);
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
      // The reader's OWN other tabs, and only those: the event goes to every
      // member, and someone else reaching the end of the thread has cleared
      // nothing of this viewer's.
      if (api.strictId(event.userId ?? event.user_id) === currentUser().id) {
        notifyConversationRead(conversationId);
      }
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
  // "Stopped typing" is only news after "typing" was sent. The composer
  // says it on blur and on unmount, and its unmount for one conversation
  // runs after the route has already moved to the next one — so without
  // this a hop between threads pinged a conversation nobody had typed in,
  // which the demo routes answer with a 404 and the check harness counts
  // as a console error.
  if (!typing && !typingSentAt.get(conversationId)) return;
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

/**
 * Repaint one message's save state from OUTSIDE this feature.
 *
 * The notifications drawer can unsave a message from its pinned section, and
 * when that conversation happens to be open the star behind it must stop being
 * filled. This is the Messages twin of GroupChat._paintBookmark, and it works
 * the same way: it writes the MODEL and lets the component re-render, rather
 * than reaching for the button — the row is React's, and a direct DOM write
 * would be a second author that the next publish silently reverted.
 *
 * A no-op when that message is not on screen, which is the common case.
 */
function paintSaved(messageId: number, saved: boolean): void {
  if (!state.messages.some((item) => item.id === messageId)) return;
  publish({
    messages: state.messages.map((item) => (
      item.id === messageId ? { ...item, saved } : item
    )),
  });
}

export const messagesController = {
  open,
  openDiscussion,
  openAgentThread,
  route,
  close,
  isOpen,
  handleBack,
  syncChrome,
  handleEvent,
  refreshBlockedView: (userId: number, blocked: boolean) => { void refreshBlockedView(userId, blocked); },
  share,
  paintSaved,
  // #2783: the channel directory, for the app chat's `#name` chips and its
  // `#` autocomplete (public/js/group-chat.js), and the link resolver.
  channels,
  openChannel,
  refresh: () => {
    void loadAppDiscussions();
    return loadConversations(true);
  },
};

export function initializeMessagesStore(): () => void {
  const onOnline = () => { void retryPending(); };
  const onOffline = () => publish({ online: false });
  // #2783: the app channels too, so a `#name` for one chips in any chat — an
  // app's own discussion included — before Messages has ever been opened.
  const onAuthed = () => { void loadConversations(); void loadAppDiscussions(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  // The store is always mounted, but the endpoint is session-gated. Seed the
  // conversation list as soon as an already-resolved user exists, or wait for
  // the shell's one-shot authenticated boot event on an anonymous document.
  //
  // It also seeds the Messages tab's unread badge (#2794, see syncTabBadge),
  // which is why it runs on every signed-in load and not only when the
  // screen opens — and a warm list is the difference between Messages
  // opening populated and opening on a spinner.
  if (window.App?.user) void loadConversations();
  else document.addEventListener('sv:authed', onAuthed, { once: true });
  if (window.App?.user) void loadAppDiscussions();
  publish({ online: navigator.onLine, demo: browserDemo() });
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('sv:authed', onAuthed);
  };
}
