export type ConversationKind = 'direct' | 'group';
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
  reply?: {
    id: number;
    sender: ConversationUser;
    content: string;
  } | null;
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  objects: SharedObjectCard[];
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
}

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
}
