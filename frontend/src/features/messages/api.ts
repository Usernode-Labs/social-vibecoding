import type {
  ConversationDetail,
  ConversationMember,
  ConversationMessage,
  ConversationSummary,
  ConversationUser,
  MessageAttachment,
  MessageReaction,
  SharedObjectCard,
  SharedObjectReference,
  UserSearchResult,
} from './types';

const MAX_ID = 2_147_483_647;

type JsonRecord = Record<string, unknown>;

export class MessagesApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MessagesApiError';
    this.status = status;
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function strictId(value: unknown): number | null {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= MAX_ID ? id : null;
}

function dateText(value: unknown): string {
  const candidate = text(value);
  return candidate || new Date(0).toISOString();
}

function pick(source: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

export function normalizeUser(input: unknown): ConversationUser {
  const row = record(input);
  return {
    id: strictId(pick(row, 'id', 'userId', 'user_id')) || 0,
    username: text(pick(row, 'username', 'name'), 'unknown'),
    avatarUrl: text(pick(row, 'avatarUrl', 'avatar_url')) || null,
  };
}

export function normalizeMember(input: unknown): ConversationMember {
  const row = record(input);
  const user = normalizeUser(record(pick(row, 'user') ?? row));
  const status = text(pick(row, 'status', 'membershipStatus', 'membership_status'));
  const role = text(pick(row, 'role', 'memberRole', 'member_role'));
  return {
    ...user,
    role: role === 'owner' ? 'owner' : 'member',
    status: ['invited', 'declined', 'left', 'removed'].includes(status)
      ? status as ConversationMember['status']
      : 'member',
    joinedAt: text(pick(row, 'joinedAt', 'joined_at')) || null,
  };
}

function normalizeReaction(input: unknown): MessageReaction {
  const row = record(input);
  return {
    emoji: text(pick(row, 'emoji', 'reaction')),
    count: Number(pick(row, 'count', 'total')) || 0,
    reacted: bool(pick(row, 'reacted', 'mine', 'hasReacted', 'has_reacted')),
    users: array(pick(row, 'users', 'usernames')).map((name) => text(name)).filter(Boolean),
  };
}

function normalizeAttachment(input: unknown, conversationId: number): MessageAttachment {
  const row = record(input);
  const rawId = text(pick(row, 'id', 'attachmentId', 'attachment_id')).toLowerCase();
  const id = /^[a-f0-9]{32}$/.test(rawId) ? rawId : '';
  const base = `/api/conversations/${conversationId}/attachments/${id}`;
  const rawViewUrl = pick(row, 'viewUrl', 'view_url');
  return {
    id,
    name: text(pick(row, 'name', 'filename', 'originalName', 'original_name'), 'attachment'),
    size: Number(pick(row, 'size', 'sizeBytes', 'size_bytes')) || 0,
    contentType: text(pick(row, 'contentType', 'content_type', 'mimeType', 'mime_type'), 'application/octet-stream'),
    kind: text(pick(row, 'kind', 'fileKind', 'file_kind')) || null,
    url: text(pick(row, 'url', 'downloadUrl', 'download_url'), base),
    // A deliberate null means the backend judged this attachment unsafe to
    // render inline. Never fabricate a preview URL in that case.
    viewUrl: rawViewUrl === null ? null : text(rawViewUrl) || `${base}/view`,
  };
}

function normalizeObject(input: unknown): SharedObjectCard {
  const row = record(input);
  const ref = record(pick(row, 'reference', 'ref') ?? row);
  const type = text(pick(ref, 'type', 'kind')) as SharedObjectReference['type'];
  return {
    type: ['app', 'issue', 'proposal', 'governance', 'spec'].includes(type) ? type : 'app',
    appId: strictId(pick(ref, 'appId', 'app_id')) || undefined,
    appSlug: text(pick(ref, 'appSlug', 'app_slug')) || undefined,
    issueNumber: strictId(pick(ref, 'issueNumber', 'issue_number')) || undefined,
    sessionId: strictId(pick(ref, 'sessionId', 'session_id')) || undefined,
    proposalId: strictId(pick(ref, 'proposalId', 'proposal_id', 'governanceId', 'governance_id')) || undefined,
    version: strictId(pick(ref, 'version', 'specVersion', 'spec_version')) || undefined,
    available: pick(row, 'available') !== false && !bool(pick(row, 'unavailable')),
    title: text(pick(row, 'title', 'name')) || null,
    subtitle: text(pick(row, 'subtitle', 'appName', 'app_name')) || null,
    state: text(pick(row, 'state', 'status')) || null,
    author: text(pick(row, 'author', 'username')) || null,
    href: text(pick(row, 'href', 'url', 'webPath', 'web_path')) || null,
  };
}

export function normalizeMessage(input: unknown, fallbackConversationId = 0): ConversationMessage {
  const row = record(input);
  const conversationId = strictId(pick(row, 'conversationId', 'conversation_id')) || fallbackConversationId;
  const senderSource = pick(row, 'sender', 'user', 'author') ?? {
    id: pick(row, 'senderId', 'sender_id', 'userId', 'user_id'),
    username: pick(row, 'senderUsername', 'sender_username', 'username'),
    avatarUrl: pick(row, 'senderAvatarUrl', 'sender_avatar_url', 'avatar_url'),
  };
  const replyRow = record(pick(row, 'reply', 'replyTo', 'reply_to'));
  const replyId = strictId(pick(replyRow, 'id', 'messageId', 'message_id'));
  return {
    id: strictId(pick(row, 'id', 'messageId', 'message_id')) || 0,
    conversationId,
    sender: normalizeUser(senderSource),
    content: text(pick(row, 'content', 'text')),
    createdAt: dateText(pick(row, 'createdAt', 'created_at')),
    editedAt: text(pick(row, 'editedAt', 'edited_at')) || null,
    reply: replyId ? {
      id: replyId,
      sender: normalizeUser(pick(replyRow, 'sender', 'user', 'author') ?? replyRow),
      content: text(pick(replyRow, 'content', 'text')),
    } : null,
    reactions: array(pick(row, 'reactions')).map(normalizeReaction).filter((reaction) => reaction.emoji),
    attachments: array(pick(row, 'attachments')).map((attachment) => normalizeAttachment(attachment, conversationId)),
    objects: array(pick(row, 'objects', 'objectCards', 'object_cards', 'sharedObjects', 'shared_objects')).map(normalizeObject),
    // This normalizer builds an explicit object rather than spreading the row,
    // so a field the server adds is DROPPED until it is named here — which is
    // exactly what happened to `saved` the first time: the API returned it,
    // the star rendered empty, and nothing anywhere errored.
    saved: pick(row, 'saved', 'bookmarked') === true,
  };
}

export function normalizeConversation(input: unknown): ConversationDetail {
  const row = record(input);
  const id = strictId(pick(row, 'id', 'conversationId', 'conversation_id')) || 0;
  const members = array(pick(row, 'members', 'participants')).map(normalizeMember);
  const kind = text(pick(row, 'kind', 'type')) === 'group' ? 'group' : 'direct';
  const peerRaw = pick(row, 'peer', 'otherUser', 'other_user', 'recipient');
  const peer = peerRaw ? normalizeUser(peerRaw) : null;
  const membershipStatus = text(pick(row, 'membershipStatus', 'membership_status', 'myStatus', 'my_status', 'status'));
  const latestRaw = pick(row, 'latestMessage', 'latest_message', 'lastMessage', 'last_message');
  const latestMessage = latestRaw ? normalizeMessage(latestRaw, id) : null;
  const title = text(pick(row, 'title', 'name'))
    || (kind === 'direct' ? peer?.username || members.find((member) => member.status === 'member')?.username : '')
    || 'Conversation';
  const canSendValue = pick(row, 'canSend', 'can_send');
  return {
    id,
    kind,
    title,
    avatarUrl: text(pick(row, 'avatarUrl', 'avatar_url')) || peer?.avatarUrl || null,
    members,
    memberCount: Number(pick(row, 'memberCount', 'member_count')) || members.filter((member) => member.status === 'member').length,
    membershipStatus: ['invited', 'declined', 'left', 'removed'].includes(membershipStatus)
      ? membershipStatus as ConversationDetail['membershipStatus']
      : 'member',
    myRole: text(pick(row, 'myRole', 'my_role', 'role')) === 'owner' ? 'owner' : 'member',
    requester: pick(row, 'requester', 'inviter') ? normalizeUser(pick(row, 'requester', 'inviter')) : null,
    peer,
    latestMessage,
    latestSummary: text(pick(row, 'latestSummary', 'latest_summary', 'preview')) || latestMessage?.content || '',
    lastActivityAt: dateText(pick(row, 'lastActivityAt', 'last_activity_at', 'updatedAt', 'updated_at', 'createdAt', 'created_at')),
    unreadCount: Number(pick(row, 'unreadCount', 'unread_count')) || 0,
    canSend: typeof canSendValue === 'boolean' ? canSendValue : membershipStatus !== 'invited',
    canInvite: bool(pick(row, 'canInvite', 'can_invite'), kind === 'group' && membershipStatus !== 'invited'),
    canManage: bool(pick(row, 'canManage', 'can_manage'), text(pick(row, 'myRole', 'my_role', 'role')) === 'owner'),
    archived: bool(pick(row, 'archived')) || text(pick(row, 'status')) === 'archived',
  };
}

function demoQuery(path: string): string {
  if (typeof window === 'undefined') return path;
  if (new URLSearchParams(window.location.search).get('demo') !== '1') return path;
  return `${path}${path.includes('?') ? '&' : '?'}demo=1`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !(init.body instanceof Blob)) {
    headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
  }
  headers.set('Accept', 'application/json');
  const response = await fetch(demoQuery(path), { credentials: 'same-origin', ...init, headers });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const body = record(data);
    throw new MessagesApiError(response.status, text(pick(body, 'error', 'message'), `Request failed (${response.status})`));
  }
  return data as T;
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const data = record(await request<unknown>('/api/conversations'));
  return array(pick(data, 'conversations', 'items')).map(normalizeConversation).filter((item) => item.id);
}

export async function getConversation(id: number): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}`));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function createConversation(body: { kind: 'direct'; userId: number } | { kind: 'group'; title: string; memberIds: number[] }): Promise<ConversationDetail> {
  const payload = body.kind === 'direct'
    ? { kind: 'direct', user_id: body.userId }
    : { kind: 'group', title: body.title, member_ids: body.memberIds };
  const data = record(await request<unknown>('/api/conversations', { method: 'POST', body: JSON.stringify(payload) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function updateConversation(id: number, body: { title: string }): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function respondToInvitation(id: number, action: 'accept' | 'decline'): Promise<ConversationDetail | null> {
  const data = record(await request<unknown>(`/api/conversations/${id}/respond`, { method: 'POST', body: JSON.stringify({ action }) }));
  const raw = pick(data, 'conversation');
  if (raw === null || (action === 'decline' && raw === undefined)) return null;
  const conversation = normalizeConversation(raw ?? data);
  return conversation.id ? conversation : null;
}

export async function addMembers(id: number, userIds: number[]): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}/members`, { method: 'POST', body: JSON.stringify({ user_ids: userIds }) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function removeMember(id: number, userId: number): Promise<void> {
  await request<unknown>(`/api/conversations/${id}/members/${userId}`, { method: 'DELETE' });
}

export async function leaveConversation(id: number): Promise<void> {
  await request<unknown>(`/api/conversations/${id}/leave`, { method: 'POST', body: '{}' });
}

export async function listMessages(id: number, before?: number | null): Promise<{ messages: ConversationMessage[]; nextBefore: number | null }> {
  const params = new URLSearchParams({ limit: '50' });
  if (before) params.set('before', String(before));
  const data = record(await request<unknown>(`/api/conversations/${id}/messages?${params}`));
  return {
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextBefore: strictId(pick(data, 'nextBefore', 'next_before')),
  };
}

export async function sendMessage(id: number, input: { content: string; replyToId?: number; attachmentIds?: string[]; object?: SharedObjectReference; idempotencyKey: string }): Promise<ConversationMessage> {
  const payload: JsonRecord = { content: input.content, idempotency_key: input.idempotencyKey };
  if (input.replyToId) payload.reply_to_id = input.replyToId;
  if (input.attachmentIds?.length) payload.attachment_ids = input.attachmentIds;
  if (input.object) payload.object = input.object;
  const data = record(await request<unknown>(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify(payload) }));
  return normalizeMessage(pick(data, 'message') ?? data, id);
}

export async function editMessage(conversationId: number, messageId: number, content: string): Promise<ConversationMessage> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ content }) }));
  return normalizeMessage(pick(data, 'message') ?? data, conversationId);
}

export async function toggleReaction(conversationId: number, messageId: number, emoji: string): Promise<MessageReaction[]> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }));
  return array(pick(data, 'reactions')).map(normalizeReaction);
}

export async function markRead(conversationId: number, messageId: number): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ message_id: messageId }) });
}

export async function setTyping(conversationId: number, typing: boolean): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/typing`, {
    method: 'POST', body: JSON.stringify({ typing }),
  });
}

export async function uploadAttachment(conversationId: number, file: File): Promise<MessageAttachment> {
  const response = await fetch(`/api/conversations/${conversationId}/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' }, body: file,
  });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new MessagesApiError(response.status, text(pick(record(data), 'error', 'message'), `Upload failed (${response.status})`));
  return normalizeAttachment(pick(record(data), 'attachment') ?? data, conversationId);
}

export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const data = record(await request<unknown>(`/api/users/search?q=${encodeURIComponent(query.trim().slice(0, 255))}&scope=messages`));
  return array(pick(data, 'users')).map(normalizeUser).filter((user) => user.id);
}

export async function listApps(): Promise<Array<{ id: number; slug: string; name: string }>> {
  const data = record(await request<unknown>('/api/apps'));
  return array(pick(data, 'apps')).map((item) => {
    const row = record(item);
    return { id: strictId(row.id) || 0, slug: text(row.slug), name: text(row.name, text(row.slug)) };
  }).filter((app) => app.id && app.slug);
}

export async function listAppItems(slug: string, type: 'issue' | 'proposal' | 'governance'): Promise<Array<{ id: number; title: string; status?: string }>> {
  const endpoint = type === 'proposal' ? 'promoted' : 'issues';
  const data = record(await request<unknown>(`/api/apps/${encodeURIComponent(slug)}/${endpoint}`));
  const candidates = type === 'proposal'
    ? array(pick(data, 'proposals', 'sessions', 'items'))
    : array(pick(data, 'issues', 'items'));
  return candidates.map((item) => {
    const row = record(item);
    return {
      id: strictId(pick(row, 'number', 'id')) || 0,
      title: text(pick(row, 'title', 'pr_title', 'session_title'), 'Untitled'),
      status: text(pick(row, 'status')) || undefined,
    };
  }).filter((item) => item.id);
}

export async function reportMessage(
  conversationId: number,
  messageId: number,
  reason: 'harassment' | 'spam' | 'threats' | 'hate' | 'sexual_content' | 'other',
  detail?: string,
): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/report`, {
    method: 'POST', body: JSON.stringify({ reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) }),
  });
}

/**
 * Save or unsave one message — the Messages half of the bookmark app group
 * chat has carried since #1280. PUT saves, DELETE unsaves, matching that
 * surface's verbs so the two behave identically.
 */
export async function setMessageSaved(
  conversationId: number,
  messageId: number,
  saved: boolean,
): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/bookmark`, {
    method: saved ? 'PUT' : 'DELETE', ...(saved ? { body: '{}' } : {}),
  });
}

export async function setBlock(userId: number, blocked: boolean): Promise<void> {
  await request<unknown>(`/api/me/blocks/${userId}`, { method: blocked ? 'PUT' : 'DELETE', ...(blocked ? { body: '{}' } : {}) });
}

export async function listBlocks(): Promise<ConversationUser[]> {
  const data = record(await request<unknown>('/api/me/blocks'));
  return array(pick(data, 'blocks', 'users')).map((entry) => {
    const row = record(entry);
    return normalizeUser(pick(row, 'user', 'blockedUser', 'blocked_user') ?? row);
  }).filter((user) => user.id);
}
