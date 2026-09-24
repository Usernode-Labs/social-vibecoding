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
  ReplyThreadState,
  SharedObjectReference,
} from './types';

const MAX_ID = 2_147_483_647;

interface PendingSend {
  content: string;
  replyToId?: number;
  /** #2387: a reply inside this thread rather than the conversation's own transcript. */
  threadRootId?: number;
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
  route: { open: false, conversationId: null, appSlug: null, agent: null, threadRootId: null, focusMessageId: null },
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
  thread: null,
  nextAfter: null,
  listCollapsed: false,
  showMoreChannels: false,
};

/*
 * DRAFTS AND STAGED REPLIES ARE PER COMPOSER, not per conversation (#2387):
 * a conversation's own composer and the composer of a thread open beside it
 * each keep their own half-typed words and their own quoted reply. A scope is
 * the conversation id alone, or `<id>:t<root>` for a thread — the first is the
 * key the drafts were always stored under, so existing drafts survive.
 */
export type ComposerScope = number | string;
export function scopeKey(conversationId: number, threadRootId?: number | null): ComposerScope {
  return threadRootId ? `${conversationId}:t${threadRootId}` : conversationId;
}
function scopeConversation(scope: ComposerScope): number {
  return typeof scope === 'number' ? scope : Number(String(scope).split(':')[0]);
}
function scopeThread(scope: ComposerScope): number | null {
  if (typeof scope === 'number') return null;
  const match = /:t(\d+)$/.exec(scope);
  return match ? Number(match[1]) : null;
}

const drafts = new Map<ComposerScope, string>();
const replyTargets = new Map<ComposerScope, ConversationMessage>();
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
let replyThreadRequest = 0;
/**
 * The conversation the viewer just marked unread (#2387), which stays unread
 * while it is still the open one: opening a thread normally reads it to the
 * end, and doing that here would undo the act a second after it was done.
 * Leaving the conversation lifts it.
 */
let unreadHold: number | null = null;

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
  const focus = state.route.conversationId === conversationId ? state.route.focusMessageId : null;
  if (!force && !focus && state.active?.id === conversationId && state.messages.length) return;
  const request = ++threadRequest;
  const preserveVisibleThread = force && state.active?.id === conversationId;
  // A refresh of a linked page (#2387) re-reads the same window rather than
  // snapping to the present: the realtime echo of a reaction would otherwise
  // take the reader away from the message they followed a link to.
  const reading = preserveVisibleThread && state.nextAfter ? state.messages.find((item) => item.id > 0)?.id || null : null;
  publish({
    loadingThread: true,
    threadError: null,
    active: preserveVisibleThread ? state.active : null,
    messages: preserveVisibleThread ? state.messages : [],
    nextBefore: preserveVisibleThread ? state.nextBefore : null,
    nextAfter: preserveVisibleThread ? state.nextAfter : null,
  });
  try {
    // Invitation metadata is deliberately readable before acceptance, but
    // retained history is not. Resolve membership first and never request
    // message bytes for an invitee.
    const active = await api.getConversation(conversationId);
    const member = active.membershipStatus === 'member';
    const anchor = focus || reading;
    const page: { messages: ConversationMessage[]; nextBefore: number | null; nextAfter: number | null; threadRootId?: number | null } = !member
      ? { messages: [], nextBefore: null, nextAfter: null }
      : anchor
        ? await api.listMessagesAround(conversationId, anchor).then((around) => ({
          messages: around.messages, nextBefore: around.nextBefore, nextAfter: around.nextAfter, threadRootId: around.focus.threadRootId,
        })).catch(() => api.listMessages(conversationId).then((latest) => ({ ...latest, nextAfter: null })))
        : { ...(await api.listMessages(conversationId)), nextAfter: null };
    if (request !== threadRequest || state.route.conversationId !== conversationId) return;
    const messages = withLocalRows(conversationId, [...page.messages].sort((a, b) => a.id - b.id));
    publish({ active, messages, nextBefore: page.nextBefore, nextAfter: page.nextAfter, loadingThread: false, online: true });
    upsertConversation(active);
    // A link to a reply inside a thread opens that thread beside it.
    if (focus && page.threadRootId && state.route.threadRootId !== page.threadRootId) {
      publish({ route: { ...state.route, threadRootId: page.threadRootId } });
    }
    if (state.route.threadRootId) void loadReplyThread(conversationId, state.route.threadRootId);
    const last = messages.at(-1);
    // Read up to the newest message DRAWN — and only once the transcript
    // reaches the present, or a message link would mark everything after it
    // read. Never straight after "Mark unread" (#2387): the reader asked for
    // this conversation to stay unread, and it is still open.
    if (last && member && !page.nextAfter && unreadHold !== conversationId) void markRead(last.id);
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

/**
 * #2387: the newer half of a transcript a message link opened part-way back.
 * Reaching the present marks it read, as opening it normally would have.
 */
export async function loadNewer(): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId || !state.nextAfter || state.loadingOlder) return;
  publish({ loadingOlder: true });
  try {
    const page = await api.listMessagesAfter(conversationId, state.nextAfter);
    if (state.route.conversationId !== conversationId) return;
    const known = new Set(state.messages.map((message) => message.id));
    const newer = page.messages.filter((message) => !known.has(message.id));
    const messages = [...state.messages, ...newer].sort((a, b) => a.id - b.id);
    publish({ messages, nextAfter: page.nextAfter, loadingOlder: false });
    const last = messages.at(-1);
    if (!page.nextAfter && last && unreadHold !== conversationId) void markRead(last.id);
  } catch (error) {
    publish({ loadingOlder: false, threadError: errorMessage(error, 'Couldn’t load newer messages.') });
  }
}

/** #2387: leave a linked page for the newest messages. */
export function jumpToPresent(): void {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  publish({ route: { ...state.route, focusMessageId: null }, nextAfter: null });
  void loadThread(conversationId, true);
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
  extras: { threadRootId?: number | null; focusMessageId?: number | null } = {},
): void {
  const nextId = validId(conversationId) ? conversationId : null;
  // #2387: a reply thread and a message link ride on a conversation or an
  // app channel, never on an agent thread or the bare list.
  const nextRoot = (nextId || validSlug(appSlug)) && validId(extras.threadRootId) ? extras.threadRootId : null;
  const nextFocus = (nextId || validSlug(appSlug)) && validId(extras.focusMessageId) ? extras.focusMessageId : null;
  if (unreadHold && unreadHold !== nextId) unreadHold = null;
  // ONE THREAD IS OPEN (#2718 review). An app's discussion and a conversation
  // are both threads of this inbox, addressed differently because one is an
  // app and the other a row in this database — so naming one clears the
  // other rather than leaving two panes' worth of state half-set. #2813's
  // agent threads join the same rule, last in precedence.
  const nextSlug = nextId ? null : validSlug(appSlug);
  const nextAgent = nextId || nextSlug ? null : validAgentThread(agent);
  if (state.route.open && state.route.conversationId === nextId
      && state.route.appSlug === nextSlug && sameAgentThread(state.route.agent, nextAgent)) {
    const threadChanged = state.route.threadRootId !== nextRoot;
    const focusChanged = !!nextFocus && state.route.focusMessageId !== nextFocus;
    if (threadChanged || focusChanged) {
      publish({ route: { ...state.route, threadRootId: nextRoot, focusMessageId: nextFocus || state.route.focusMessageId } });
      if (!nextRoot) publish({ thread: null });
    }
    if (!state.listLoaded) void loadConversations();
    if (!state.discussionsLoaded) void loadAppDiscussions();
    if (nextId && (!state.active || state.active.id !== nextId || focusChanged)) void loadThread(nextId, focusChanged);
    else if (nextId && nextRoot && threadChanged) void loadReplyThread(nextId, nextRoot);
    if (nextSlug && state.discussionContext?.slug !== nextSlug) void loadDiscussion(nextSlug);
    return;
  }
  publish({
    route: { open: true, conversationId: nextId, appSlug: nextSlug, agent: nextAgent, threadRootId: nextRoot, focusMessageId: nextFocus },
    thread: null,
    nextAfter: null,
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
  if (agent.kind === 'agent') {
    if (agent.id === 'new') return { kind: 'agent', id: 'new' };
    return validId(agent.id) ? { kind: 'agent', id: agent.id } : null;
  }
  return null;
}

function sameAgentThread(a: MessagesAgentThread | null, b: MessagesAgentThread | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'chat' && b.kind === 'chat') return a.id === b.id;
  if (a.kind === 'session' && b.kind === 'session') return a.slug === b.slug && a.id === b.id;
  if (a.kind === 'agent' && b.kind === 'agent') return a.id === b.id;
  return false;
}

/**
 * The inbox's own address for an agent thread (#2813). The rows link here on
 * every viewport; on a phone the router swaps it for `fullScreenAddress`.
 */
export function agentThreadAddress(agent: MessagesAgentThread): string {
  if (agent.kind === 'agent') return `#messages/agent/${agent.id}`;
  return agent.kind === 'chat'
    ? `#messages/agent/${encodeURIComponent(agent.id)}`
    : `#messages/session/${encodeURIComponent(agent.slug)}/${agent.id}`;
}

/** Where the same thread lives as a screen of its own — a phone's destination. */
export function fullScreenAddress(agent: MessagesAgentThread): string {
  if (agent.kind === 'agent') return `#agent/${agent.id}`;
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
  replyThreadRequest += 1;
  unreadHold = null;
  publish({
    route: { open: false, conversationId: null, appSlug: null, agent: null, threadRootId: null, focusMessageId: null },
    active: null, messages: [], loadingThread: false, threadError: null,
    discussionContext: null, discussionError: null, thread: null, nextAfter: null,
  });
}

export function isOpen(): boolean {
  return state.route.open;
}

export function handleBack(): boolean {
  const onThread = !!state.route.conversationId || !!state.route.appSlug || !!state.route.agent;
  if (!state.route.open || !onThread || !isMobile()) return false;
  // #2387: on a phone a reply thread is a level of its own over the
  // conversation, so Back closes it first.
  if (state.route.threadRootId) {
    const parent = state.route.appSlug
      ? `#messages/app/${encodeURIComponent(state.route.appSlug)}`
      : `#messages/${state.route.conversationId}`;
    try { history.replaceState(null, '', parent); } catch { /* non-fatal */ }
    route(state.route.conversationId, state.route.appSlug, null);
    syncChrome();
    return true;
  }
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
  // #2387: a reply thread, on a phone, is a level over its conversation: the
  // chevron goes back to the conversation, and the bar says "Thread".
  if (isMobile() && state.route.threadRootId && (state.route.conversationId || state.route.appSlug)) {
    app.setBackIcon?.('arrow', state.route.appSlug
      ? `#messages/app/${encodeURIComponent(state.route.appSlug)}`
      : `#messages/${state.route.conversationId}`);
    app.setHeaderTitle?.('Thread');
    return;
  }
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

export function draftFor(scope: ComposerScope): string {
  if (drafts.has(scope)) return drafts.get(scope) || '';
  try {
    const value = localStorage.getItem(`usernode:messages-draft:${scope}`) || '';
    drafts.set(scope, value);
    return value;
  } catch { return ''; }
}

export function setDraft(scope: ComposerScope, value: string): void {
  drafts.set(scope, value);
  try {
    if (value) localStorage.setItem(`usernode:messages-draft:${scope}`, value);
    else localStorage.removeItem(`usernode:messages-draft:${scope}`);
  } catch { /* storage unavailable */ }
  publish({});
}

export function replyFor(scope: ComposerScope): ConversationMessage | null {
  return replyTargets.get(scope) || null;
}

export function setReply(scope: ComposerScope, message: ConversationMessage | null): void {
  if (message) replyTargets.set(scope, message);
  else replyTargets.delete(scope);
  publish({});
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function send(input: { content: string; attachmentIds?: string[]; object?: SharedObjectReference; attachments?: ConversationMessage['attachments']; threadRootId?: number | null }): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const threadRootId = input.threadRootId && state.thread?.rootId === input.threadRootId ? input.threadRootId : null;
  const scope = scopeKey(conversationId, threadRootId);
  const content = input.content.slice(0, 8000);
  const reply = replyFor(scope);
  const pending: PendingSend = {
    content,
    attachmentIds: input.attachmentIds,
    object: input.object,
    replyToId: reply?.id,
    ...(threadRootId ? { threadRootId } : {}),
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
    threadRootId,
  };
  unsent.set(pending.idempotencyKey, { conversationId, payload: pending });
  setDraft(scope, '');
  setReply(scope, null);
  if (threadRootId && state.thread) {
    publish({ thread: { ...state.thread, messages: [...state.thread.messages, optimistic], error: null } });
  } else {
    publish({ messages: [...state.messages, optimistic], threadError: null });
  }
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
  if (pending.threadRootId) { await deliverToThread(conversationId, pending); return; }
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

/**
 * A reply sent into the thread open beside the conversation (#2387). The
 * same optimistic row and idempotency key as a send into the conversation,
 * settled in the thread's own page; the conversation's transcript is then
 * re-read for the reply count on the message the thread hangs off.
 */
async function deliverToThread(conversationId: number, pending: PendingSend): Promise<void> {
  const key = pending.idempotencyKey;
  const rootId = pending.threadRootId as number;
  try {
    const message = await api.sendMessage(conversationId, pending);
    unsent.delete(key);
    sentKeys.set(message.id, key);
    const thread = state.thread;
    if (thread && thread.conversationId === conversationId && thread.rootId === rootId) {
      const messages = thread.messages
        .filter((item) => item.clientKey !== key && item.id !== message.id)
        .concat({ ...message, clientKey: key })
        .sort((a, b) => (a.id < 0 || b.id < 0 ? Number(a.id < 0) - Number(b.id < 0) : a.id - b.id));
      publish({ thread: { ...thread, messages } });
    }
    if (state.route.conversationId === conversationId) void loadThread(conversationId, true);
  } catch (error) {
    const thread = state.thread;
    if (thread && thread.rootId === rootId) {
      publish({
        thread: {
          ...thread,
          messages: thread.messages.map((item) => item.clientKey === key ? { ...item, pending: false, failed: true } : item),
          error: errorMessage(error, 'Your reply wasn’t sent.'),
        },
      });
    }
  }
}

/** Apply `fn` to the matching rows of the conversation AND of the open thread. */
function mapRows(fn: (item: ConversationMessage) => ConversationMessage): void {
  const thread = state.thread;
  publish({
    messages: state.messages.map(fn),
    ...(thread ? { thread: { ...thread, root: thread.root ? fn(thread.root) : null, messages: thread.messages.map(fn) } } : {}),
  });
}

/** Every row this store is drawing, wherever it is drawn. */
function findRow(messageId: number): ConversationMessage | undefined {
  return state.messages.find((item) => item.id === messageId)
    || (state.thread?.root?.id === messageId ? state.thread.root : undefined)
    || state.thread?.messages.find((item) => item.id === messageId);
}

/** Send a failed row again, in place (#2907). */
export async function retrySend(clientKey: string): Promise<void> {
  const entry = unsent.get(clientKey);
  if (!entry) return;
  const queue = pendingByConversation.get(entry.conversationId);
  if (queue) pendingByConversation.set(entry.conversationId, queue.filter((item) => item.idempotencyKey !== clientKey));
  publish({ threadError: null });
  mapRows((item) => item.clientKey === clientKey ? { ...item, pending: true, failed: false } : item);
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
  const keep = (item: ConversationMessage) => !(item.clientKey === clientKey && item.failed);
  const thread = state.thread;
  publish({
    messages: state.messages.filter(keep),
    ...(thread ? { thread: { ...thread, messages: thread.messages.filter(keep) } } : {}),
  });
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
  // The server's copy of the edited row, keeping what the row already knew
  // that an edit response does not carry (its thread summary, its client key).
  mapRows((item) => item.id === message.id ? { ...item, ...message, thread: item.thread, clientKey: item.clientKey } : item);
}

export async function react(messageId: number, emoji: string): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const reactions = await api.toggleReaction(conversationId, messageId, emoji);
  mapRows((item) => item.id === messageId ? { ...item, reactions } : item);
}

/**
 * Delete your own message (#2387). The row becomes the placeholder at once —
 * the server keeps the same placeholder — and comes back if it refuses.
 */
export async function deleteMessage(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const before = findRow(messageId);
  if (!before) return;
  const placeholder = (item: ConversationMessage): ConversationMessage => ({
    ...item, deleted: true, content: '', attachments: [], objects: [], reactions: [], editedAt: null, saved: false,
  });
  mapRows((item) => item.id === messageId ? placeholder(item) : item);
  try {
    const message = await api.deleteMessage(conversationId, messageId);
    if (message) mapRows((item) => item.id === messageId ? { ...placeholder(item), ...message, thread: item.thread } : item);
    void loadConversations(true);
  } catch (error) {
    mapRows((item) => item.id === messageId ? before : item);
    throw error;
  }
}

/**
 * Make a message and everything after it unread (#2387). The conversation's
 * row takes its count back, and it stays unread while it is open (unreadHold)
 * — on a phone the list comes back, the way a mail client leaves a message
 * you have just marked unread.
 */
export async function markUnread(messageId: number): Promise<void> {
  const conversationId = state.route.conversationId;
  if (!conversationId) return;
  const { unreadCount } = await api.markUnread(conversationId, messageId);
  unreadHold = conversationId;
  publish({ conversations: state.conversations.map((item) => item.id === conversationId ? { ...item, unreadCount } : item) });
  void loadConversations(true);
  if (isMobile()) open(null);
}

/** The address a message link opens (#2387): the conversation, scrolled to it. */
export function messageAddress(conversationId: number, messageId: number): string {
  return `#messages/${conversationId}/m/${messageId}`;
}

/** The address of a reply thread beside its conversation (#2387). */
export function threadAddress(conversationId: number, rootId: number): string {
  return `#messages/${conversationId}/thread/${rootId}`;
}

/** Open the thread that hangs off a message of the open conversation. */
export function openThread(rootId: number): void {
  const conversationId = state.route.conversationId;
  if (typeof window === 'undefined' || !conversationId || !validId(rootId)) return;
  const target = threadAddress(conversationId, rootId);
  if (window.location.hash === target) route(conversationId, null, null, { threadRootId: rootId });
  else window.location.hash = target;
}

/** Close the thread beside the conversation, keeping the conversation open. */
export function closeThread(): void {
  const conversationId = state.route.conversationId;
  replyThreadRequest += 1;
  publish({ thread: null, route: { ...state.route, threadRootId: null } });
  if (typeof window === 'undefined' || !conversationId) return;
  const target = `#messages/${conversationId}`;
  if (window.location.hash !== target) {
    try { history.replaceState(null, '', target); } catch { window.location.hash = target; }
  }
}

/**
 * A reply thread's page (#2387): the message it hangs off and its replies.
 * Its own request counter, so a slow thread cannot paint over the next one.
 */
export async function loadReplyThread(conversationId: number, rootId: number, force = false): Promise<void> {
  if (!validId(conversationId) || !validId(rootId)) return;
  const current = state.thread;
  const same = current && current.conversationId === conversationId && current.rootId === rootId;
  if (same && !force && current.messages.length && !current.error) return;
  const request = ++replyThreadRequest;
  publish({
    thread: same && current
      ? { ...current, loading: true, error: null }
      : { conversationId, rootId, root: findRow(rootId) || null, messages: [], loading: true, error: null, nextBefore: null },
  });
  try {
    const page = await api.listThread(conversationId, rootId);
    if (request !== replyThreadRequest || state.route.threadRootId !== rootId) return;
    const local = (state.thread?.messages || []).filter((item) => item.id < 0 && item.threadRootId === rootId
      && !page.messages.some((row) => row.sender.id === item.sender.id && row.content === item.content));
    const known = page.messages.map((item) => {
      const key = sentKeys.get(item.id);
      return key ? { ...item, clientKey: key } : item;
    });
    publish({
      thread: {
        conversationId, rootId, root: page.root || findRow(rootId) || null,
        messages: [...known.sort((a, b) => a.id - b.id), ...local],
        loading: false, error: null, nextBefore: page.nextBefore,
      },
    });
  } catch (error) {
    if (request !== replyThreadRequest) return;
    const thread = state.thread;
    publish({
      thread: thread ? { ...thread, loading: false, error: errorMessage(error, 'Couldn’t load this thread.') } : null,
    });
  }
}

/** The thread's earlier replies. */
export async function loadOlderReplies(): Promise<void> {
  const thread = state.thread;
  if (!thread || !thread.nextBefore || thread.loading) return;
  publish({ thread: { ...thread, loading: true } });
  try {
    const page = await api.listThread(thread.conversationId, thread.rootId, thread.nextBefore);
    const now = state.thread;
    if (!now || now.rootId !== thread.rootId) return;
    const known = new Set(now.messages.map((item) => item.id));
    publish({
      thread: {
        ...now,
        loading: false,
        messages: [...page.messages.filter((item) => !known.has(item.id)), ...now.messages].sort((a, b) => (a.id < 0 || b.id < 0 ? Number(a.id < 0) - Number(b.id < 0) : a.id - b.id)),
        nextBefore: page.nextBefore,
      },
    });
  } catch (error) {
    const now = state.thread;
    if (now) publish({ thread: { ...now, loading: false, error: errorMessage(error, 'Couldn’t load earlier replies.') } });
  }
}

/** #2387: fold the list pane away on a desktop, or bring it back. Remembered per device. */
export function setListCollapsed(collapsed: boolean): void {
  if (state.listCollapsed === collapsed) return;
  try { localStorage.setItem('usernode:messages-list-collapsed', collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
  publish({ listCollapsed: collapsed });
}

/** #2967: show or hide the channels outside Your apps. Remembered per device. */
export function setShowMoreChannels(show: boolean): void {
  if (state.showMoreChannels === show) return;
  try { localStorage.setItem('usernode:messages-more-channels', show ? '1' : '0'); } catch { /* storage unavailable */ }
  publish({ showMoreChannels: show });
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
  const current = findRow(messageId);
  if (!current) return;
  const next = !current.saved;
  const paint = (saved: boolean) => mapRows((item) => item.id === messageId ? { ...item, saved } : item);
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
    case 'conversation_message_created':
    case 'conversation_message_updated': {
      // Realtime deliberately carries ids only: hydrated messages and shared
      // object cards must be resolved under this viewer's REST permissions.
      // A reply inside a thread (#2387) re-reads that thread when it is the
      // one open, and the conversation either way — the reply count on the
      // message the thread hangs off is the conversation's to draw.
      const rootId = api.strictId(event.threadRootId ?? event.thread_root_id);
      if (state.route.open && state.route.conversationId === conversationId) {
        void loadThread(conversationId, true);
        if (rootId && state.thread?.rootId === rootId) void loadReplyThread(conversationId, rootId, true);
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
      // …and not when the reader marked it UNREAD (#2387): that moved the
      // cursor back, and nothing in the bell was read by it.
      if (api.strictId(event.userId ?? event.user_id) === currentUser().id && event.unread !== true) {
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
  openThread,
  closeThread,
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
  // #2387 / #2967: the two layout preferences, read after mount so the first
  // render matches the prerendered shell.
  let listCollapsed = false;
  let showMoreChannels = false;
  try {
    listCollapsed = localStorage.getItem('usernode:messages-list-collapsed') === '1';
    showMoreChannels = localStorage.getItem('usernode:messages-more-channels') === '1';
  } catch { /* storage unavailable */ }
  publish({ online: navigator.onLine, demo: browserDemo(), listCollapsed, showMoreChannels });
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('sv:authed', onAuthed);
  };
}
