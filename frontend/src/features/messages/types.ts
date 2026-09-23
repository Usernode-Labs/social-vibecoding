/**
 * `channel` is a room every user is in (#2783) — today only #general. It has
 * no roster (just a count), no owner and no invitations.
 */
export type ConversationKind = 'direct' | 'group' | 'channel';
export type MembershipStatus = 'invited' | 'member' | 'declined' | 'left' | 'removed';
export type MemberRole = 'owner' | 'member';

export interface ConversationUser {
  id: number;
  username: string;
  avatarUrl?: string | null;
}

export interface ConversationMember extends ConversationUser {
  role: MemberRole;
  status: MembershipStatus;
  joinedAt?: string | null;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reacted: boolean;
  users?: string[];
}

export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  kind?: string | null;
  url: string;
  viewUrl?: string | null;
}

export type SharedObjectType = 'app' | 'issue' | 'proposal' | 'governance' | 'spec';

export interface SharedObjectReference {
  type: SharedObjectType;
  appId?: number;
  appSlug?: string;
  issueNumber?: number;
  sessionId?: number;
  proposalId?: number;
  version?: number;
}

export interface SharedObjectCard extends SharedObjectReference {
  available: boolean;
  title?: string | null;
  subtitle?: string | null;
  state?: string | null;
  author?: string | null;
  href?: string | null;
}

export interface ConversationMessage {
  id: number;
  conversationId: number;
  sender: ConversationUser;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  moderated?: boolean;
  reply?: {
    id: number;
    sender: ConversationUser;
    content: string;
  } | null;
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  objects: SharedObjectCard[];
  /**
   * Whether the VIEWER has saved this message — their own private bookmark,
   * never an aggregate. Hydrated with the page (services/conversations.js), so
   * the row's button renders already filled rather than flashing empty.
   * Optional because an optimistic local echo has no server answer yet.
   */
  saved?: boolean;
  pending?: boolean;
  failed?: boolean;
  clientKey?: string;
}

export interface ConversationSummary {
  id: number;
  kind: ConversationKind;
  title: string;
  avatarUrl?: string | null;
  members: ConversationMember[];
  memberCount: number;
  membershipStatus: MembershipStatus;
  myRole: MemberRole;
  requester?: ConversationUser | null;
  peer?: ConversationUser | null;
  latestMessage?: ConversationMessage | null;
  latestSummary?: string;
  lastActivityAt: string;
  unreadCount: number;
  canSend: boolean;
  canInvite: boolean;
  canManage: boolean;
  archived?: boolean;
  /** A channel's `#handle` (`general`); null for everything else. */
  channelKey?: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  members: ConversationMember[];
}

export interface UserSearchResult extends ConversationUser {}

export interface ConversationEvent {
  type: string;
  conversationId?: number;
  conversation_id?: number;
  conversation?: unknown;
  message?: unknown;
  messageId?: number;
  message_id?: number;
  reactions?: unknown;
  unreadCount?: number;
  unread_count?: number;
  [key: string]: unknown;
}

export interface MessagesRoute {
  open: boolean;
  conversationId: number | null;
  /**
   * #2718 review: an app's general discussion, open as a thread of THIS
   * inbox rather than as the app view's own screen.
   *
   * It is listed here beside the people and the agent chats, so it opens
   * here too — beside the list, at `#messages/app/<slug>`. Addressing it as
   * `#app/<slug>/dev/chat` made a row in this list navigate to a different
   * SCREEN ROOT: no conversation list beside it, and the app view's back
   * slot instead of this screen's. A row in a list opens beside that list.
   *
   * Mutually exclusive with `conversationId` — one thread is open, and the
   * two kinds are addressed differently because one is a conversation row
   * in this database and the other is an app.
   */
  appSlug: string | null;
  /**
   * #2813: an AGENT thread open beside the list on a desktop — a global
   * agent chat (`#messages/agent/<id>`) or an app's dev session
   * (`#messages/session/<slug>/<id>`). Both used to navigate away to a
   * screen of their own (`#chat/<id>`, `#app/<slug>/dev/sessions/<id>`),
   * which is still where a PHONE goes: the router swaps these addresses for
   * those there, so the full-screen behaviour on a narrow viewport is the
   * one it always was.
   *
   * Mutually exclusive with the other two, for the same reason they are
   * with each other: one thread is open.
   */
  agent: MessagesAgentThread | null;
}

/** An agent thread of the inbox (#2813). See `MessagesRoute.agent`. */
export type MessagesAgentThread =
  | { kind: 'chat'; id: string }
  | { kind: 'session'; slug: string; id: number };

/** The app whose discussion is open, once its metadata has landed. */
export interface DiscussionContext {
  slug: string;
  name: string;
  /** `can_collaborate === false` — the composer does not render. */
  readOnly: boolean;
}

import type { AppDiscussion, InboxFilter } from './inbox';

export interface MessagesSnapshot {
  route: MessagesRoute;
  conversations: ConversationSummary[];
  active: ConversationDetail | null;
  messages: ConversationMessage[];
  loadingList: boolean;
  loadingThread: boolean;
  loadingOlder: boolean;
  listLoaded: boolean;
  error: string | null;
  threadError: string | null;
  nextBefore: number | null;
  online: boolean;
  demo: boolean;
  revision: number;
  /**
   * #2718: the other two kinds of thread this screen lists.
   *
   * `discussions` is GET /api/messages/app-discussions — the general thread
   * on each app the viewer is a member of, one row per app. `filter` is which
   * of the four the list is showing. Agent chats are NOT here: they are
   * already in features/global-chat's own store, and a second copy of a list
   * that is loaded, merged and invalidated elsewhere is a copy that drifts.
   */
  discussions: AppDiscussion[];
  discussionsLoaded: boolean;
  /**
   * The open discussion's app, or null while it loads or when the open
   * thread is a conversation. The row carries the name, but not whether the
   * viewer may write — that is `can_collaborate` on the app itself, so it
   * comes from GET /api/apps/<slug> when the thread opens.
   */
  discussionContext: DiscussionContext | null;
  discussionError: string | null;
  filter: InboxFilter;
}
