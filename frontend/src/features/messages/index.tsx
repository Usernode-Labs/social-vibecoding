import { useEffect, useRef, useState } from 'react';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import * as api from './api';
import { MessageComposer } from './composer';
import { CreateConversationDialog } from './create-dialog';
import { ConversationMembersDialog } from './members-dialog';
import { relativeTime, UserAvatar } from './format';
import { MessageRow } from './message-row';
import { ShareItemDialog } from './share-dialog';
import {
  initializeMessagesStore,
  finishDirectBlock,
  loadConversations,
  loadOlder,
  messagesController,
  respond,
  selectConversation,
  syncChrome,
  typingUsers,
  useMessagesSnapshot,
} from './store';
import type { ConversationSummary } from './types';

function openDialog(name: 'messagesCreate' | 'messagesMembers' | 'messagesShare') {
  window.UsernodeReact?.dialogs?.[name]?.open();
}

function conversationPeer(conversation: ConversationSummary) {
  const currentUserId = typeof window !== 'undefined' ? Number(window.App?.user?.id) : 0;
  return conversation.peer || (conversation.kind === 'direct'
    ? conversation.members.find((member) => Number(member.id) !== currentUserId) || null
    : null);
}

function ConversationRow({ conversation, active }: { conversation: ConversationSummary; active: boolean }) {
  const peer = conversationPeer(conversation);
  const invited = conversation.membershipStatus === 'invited';
  return (
    <a
      href={`#messages/${conversation.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === `#messages/${conversation.id}`) {
          event.preventDefault(); selectConversation(conversation.id);
        }
      }}
      className={`messages-conversation-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <UserAvatar user={conversation.kind === 'direct' ? peer : null} title={conversation.title} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="font-semibold text-sm truncate text-zinc-800 dark:text-zinc-100">{conversation.kind === 'direct' && peer ? `@${peer.username}` : conversation.title}</span>{conversation.kind === 'group' ? <span className="messages-group-tag">{conversation.memberCount}</span> : null}<time className="ml-auto text-[11px] text-zinc-400 shrink-0">{relativeTime(conversation.lastActivityAt)}</time></div>
        <div className="mt-0.5 flex items-center gap-2"><span className={`text-xs truncate ${invited ? 'text-violet-600 dark:text-violet-400 font-medium' : 'text-zinc-500 dark:text-zinc-400'}`}>{invited ? `${conversation.kind === 'direct' ? 'Message request' : 'Group invitation'} · Tap to review` : conversation.latestSummary || 'No messages yet'}</span>{conversation.unreadCount > 0 ? <span className="messages-unread" aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span> : null}</div>
      </div>
    </a>
  );
}

function ConversationList() {
  const snap = useMessagesSnapshot();
  return (
    <section className={`messages-list-pane ${snap.route.conversationId ? 'hidden md:flex' : 'flex'}`} aria-label="Conversations">
      <div className="messages-list-toolbar">
        <div><h2 className="font-bold text-zinc-900 dark:text-zinc-100">Messages</h2><p className="text-xs text-zinc-500">Direct and group conversations</p></div>
        <button type="button" onClick={() => openDialog('messagesCreate')} className="messages-new-button" aria-label="New conversation" title="New conversation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
      </div>
      {!snap.online ? <div className="messages-network-banner">Offline — queued messages retry when you reconnect.</div> : null}
      <div className="messages-list-scroll platform-safe-scroll">
        {snap.loadingList && !snap.listLoaded ? <div className="messages-state"><span className="messages-spinner" />Loading conversations…</div> : null}
        {snap.error ? <div className="messages-state messages-state-error"><p>{snap.error}</p><button type="button" onClick={() => void loadConversations(true)}>Try again</button></div> : null}
        {!snap.loadingList && !snap.error && snap.listLoaded && !snap.conversations.length ? <div className="messages-empty"><span aria-hidden="true">✦</span><h3>No messages yet</h3><p>Start a direct conversation or bring a group together.</p><button type="button" onClick={() => openDialog('messagesCreate')}>New conversation</button></div> : null}
        {snap.conversations.map((conversation) => <ConversationRow key={conversation.id} conversation={conversation} active={snap.route.conversationId === conversation.id} />)}
      </div>
    </section>
  );
}

function InvitationBanner() {
  const snap = useMessagesSnapshot();
  const active = snap.active;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!active || active.membershipStatus !== 'invited') return null;
  const conversationId = active.id;
  const requesterUser = active.requester;
  const requester = requesterUser?.username ? `@${requesterUser.username}` : 'Someone';
  async function answer(action: 'accept' | 'decline') {
    setBusy(true); setError('');
    try { await respond(action); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t update this invitation.'); }
    finally { setBusy(false); }
  }
  async function declineAndBlock() {
    const requesterId = requesterUser?.id;
    if (!requesterId) return;
    setBusy(true); setError('');
    try {
      // Blocking is also the server-side decline for every still-pending
      // direct/group invitation from this requester. Purge this invitation
      // locally as soon as that consent decision commits.
      await api.setBlock(requesterId, true);
      await finishDirectBlock(conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t decline and block this requester.');
    } finally { setBusy(false); }
  }
  return (
    <div className="messages-invitation">
      <div className="min-w-0 flex-1"><strong>{active.kind === 'direct' ? 'Message request' : 'Group invitation'}</strong><p>{requester} invited you. Accepting gives you access to the complete retained conversation history.</p>{error ? <span role="alert">{error}</span> : null}</div>
      <div className="messages-invite-actions">
        <button type="button" disabled={busy} onClick={() => void answer('decline')} className="messages-invite-decline">Decline</button>
        {requesterUser?.id ? <button type="button" disabled={busy} onClick={() => void declineAndBlock()} className="messages-invite-block">Decline &amp; block @{requesterUser.username}</button> : null}
        <button type="button" disabled={busy} onClick={() => void answer('accept')} className="messages-invite-accept">Accept</button>
      </div>
    </div>
  );
}

function ThreadHeader() {
  const snap = useMessagesSnapshot();
  const active = snap.active;
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const peer = active ? conversationPeer(active) : null;
  if (!active) return null;
  async function blockPeer() {
    if (!peer || !window.confirm(`Block @${peer.username}? They won’t be able to start or send direct messages to you.`)) return;
    const conversationId = active?.id;
    if (!conversationId) return;
    setBusy(true);
    try { await api.setBlock(peer.id, true); await finishDirectBlock(conversationId); }
    catch (err) { window.PlatformUI?.toast?.(err instanceof Error ? err.message : 'Couldn’t block this user.'); }
    finally { setBusy(false); setMenu(false); }
  }
  return (
    <header className="messages-thread-header">
      <a href="#messages" className="md:hidden messages-thread-back" aria-label="Back to conversations"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg></a>
      <UserAvatar user={active.kind === 'direct' ? peer : null} title={active.title} />
      <button type="button" className="min-w-0 text-left flex-1" onClick={() => active.kind === 'group' && openDialog('messagesMembers')}>
        <div className="font-semibold text-sm truncate">{active.kind === 'direct' && peer ? `@${peer.username}` : active.title}</div>
        <div className="text-[11px] text-zinc-500 truncate">{active.kind === 'group' ? `${active.memberCount} members` : active.membershipStatus === 'invited' ? 'Invitation pending' : 'Direct message'}</div>
      </button>
      {active.kind === 'group' ? <button type="button" onClick={() => openDialog('messagesMembers')} className="messages-thread-action" aria-label="Group members" title="Group members"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm8-1a3 3 0 010 6m4 5v-2a4 4 0 00-3-3.9" /></svg></button> : null}
      <div className="relative"><button type="button" onClick={() => setMenu((open) => !open)} className="messages-thread-action" aria-label="Conversation actions" aria-expanded={menu}>•••</button>{menu ? <div className="messages-thread-menu">{active.kind === 'group' ? <button type="button" onClick={() => { setMenu(false); openDialog('messagesMembers'); }}>Members &amp; invitations</button> : <button type="button" disabled={busy || !peer} onClick={() => void blockPeer()} className="text-red-600 dark:text-red-400">Block @{peer?.username}</button>}<button type="button" onClick={() => { setMenu(false); void loadConversations(true); }}>Refresh conversation</button></div> : null}</div>
    </header>
  );
}

function ConversationThread() {
  const snap = useMessagesSnapshot();
  const scroller = useRef<HTMLDivElement>(null);
  const previousLast = useRef<number | null>(null);
  const initialScroll = useRef<number | null>(null);
  const conversationId = snap.route.conversationId;
  const typing = conversationId ? typingUsers(conversationId) : [];

  useEffect(() => {
    if (!conversationId) return;
    previousLast.current = null; initialScroll.current = null;
  }, [conversationId]);

  useEffect(() => {
    const el = scroller.current;
    const last = snap.messages.at(-1)?.id || null;
    if (!el || !last) return;
    if (previousLast.current === null || Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 180) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
    previousLast.current = last;
  }, [snap.messages]);

  async function older() {
    const el = scroller.current;
    if (el) initialScroll.current = el.scrollHeight;
    await loadOlder();
    requestAnimationFrame(() => {
      if (el && initialScroll.current !== null) el.scrollTop += el.scrollHeight - initialScroll.current;
      initialScroll.current = null;
    });
  }

  if (!conversationId) return <section className="hidden md:flex messages-thread-pane messages-no-selection"><span aria-hidden="true">✦</span><h2>Choose a conversation</h2><p>Your direct and group messages stay here.</p></section>;
  return (
    <section className="flex messages-thread-pane" aria-label={snap.active?.title || 'Conversation'}>
      <ThreadHeader />
      <InvitationBanner />
      <div ref={scroller} className="messages-thread-scroll platform-safe-scroll un-kb-avoid" aria-live="polite">
        {snap.loadingThread ? <div className="messages-state"><span className="messages-spinner" />Loading messages…</div> : null}
        {snap.threadError && !snap.messages.length ? <div className="messages-state messages-state-error"><p>{snap.threadError}</p><button type="button" onClick={() => messagesController.route(conversationId)}>Try again</button></div> : null}
        {!snap.loadingThread && !snap.threadError && snap.active && snap.active.membershipStatus === 'member' && !snap.messages.length ? <div className="messages-thread-empty"><span aria-hidden="true">👋</span><p>No messages yet. Say hello.</p></div> : null}
        {snap.nextBefore ? <div className="flex justify-center py-2"><button type="button" disabled={snap.loadingOlder} onClick={() => void older()} className="messages-load-older">{snap.loadingOlder ? 'Loading…' : 'Load earlier messages'}</button></div> : null}
        {snap.messages.map((message) => <MessageRow key={message.clientKey || message.id} message={message} conversationId={conversationId} />)}
      </div>
      <div className="messages-typing" aria-live="polite">{typing.length === 1 ? `${typing[0]} is typing…` : typing.length > 1 ? `${typing.slice(0, 2).join(', ')} are typing…` : ''}</div>
      <MessageComposer />
    </section>
  );
}

export function MessagesScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const snap = useMessagesSnapshot();
  useVisibilityHiddenClass(screenRef, 'messages-screen', false);
  useEffect(() => initializeMessagesStore(), []);
  useEffect(() => { if (snap.route.open) syncChrome(); }, [snap.active?.title, snap.route.open, snap.route.conversationId]);
  return (
    <>
      <main ref={screenRef} id="messages-screen" className="hidden flex-1 min-h-0 overflow-hidden bg-white dark:bg-zinc-950" style={{ position: 'relative' }}>
        <div className="messages-layout">
          <ConversationList />
          <ConversationThread />
        </div>
      </main>
      <CreateConversationDialog />
      <ConversationMembersDialog />
      <ShareItemDialog />
    </>
  );
}

if (typeof window !== 'undefined') {
  const host = (window.UsernodeReact ||= {});
  host.messages = messagesController;
}

export { messagesController };
