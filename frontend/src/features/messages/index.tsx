import { useEffect, useRef, useState } from 'react';

import { ChevronLeftInsetIcon, PlusIcon, UserGroupIcon, XIcon } from '@/components/ui/icons';
import { flushSync } from 'react-dom';

import { useStoreState } from '../../lib/use-store-state';
import { messagesSheetStore } from './sheet-store.js';
import { MessagesSheet } from './sheet-controller.js';

// The kit measures the sheet's content height ONCE, at present time, and
// `MessagesSheet.open()` publishes `open: true` immediately before handing it
// over — so that publish has to be synchronous. Same reason the app-context
// and notifications stores install it. See lib/sheet-controller.js.
messagesSheetStore.setFlush(flushSync);
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
  handleBack,
  respond,
  selectConversation,
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
        // A modified click keeps the anchor's href, which deep-links this
        // conversation in a new tab. A plain one routes inside the sheet —
        // there used to be a hash-equality branch here because selecting a
        // row wrote the address and the router came back round; it does not
        // any more (see store.ts `selectConversation`).
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        selectConversation(conversation.id);
      }}
      className={`messages-conversation-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <UserAvatar user={conversation.kind === 'direct' ? peer : null} title={conversation.title} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="font-semibold text-sm truncate text-zinc-800 dark:text-zinc-100">{conversation.kind === 'direct' && peer ? `@${peer.username}` : conversation.title}</span>{conversation.kind === 'group' ? <span className="messages-group-tag">{conversation.memberCount}</span> : null}<time className="ml-auto text-[11px] text-zinc-500 shrink-0 dark:text-zinc-400">{relativeTime(conversation.lastActivityAt)}</time></div>
        <div className="mt-0.5 flex items-center gap-2"><span className={`text-xs truncate ${invited ? 'text-violet-700 dark:text-violet-400 font-medium' : 'text-zinc-500 dark:text-zinc-400'}`}>{invited ? `${conversation.kind === 'direct' ? 'Message request' : 'Group invitation'} · Tap to review` : conversation.latestSummary || 'No messages yet'}</span>{conversation.unreadCount > 0 ? <span className="messages-unread" aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span> : null}</div>
      </div>
    </a>
  );
}

function ConversationList() {
  const snap = useMessagesSnapshot();
  return (
    <section className={`messages-list-pane ${snap.route.conversationId ? 'hidden' : 'flex'}`} aria-label="Conversations">
      {!snap.online ? <div className="messages-network-banner">Offline. Queued messages retry when you reconnect.</div> : null}
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
      {/* Thread -> list, INSIDE the sheet. It was an <a href="#messages">, from
          when Messages was a screen and its two levels were two addresses.
          The sheet is not an address, so this is the button it always was in
          behaviour. */}
      <button
        type="button"
        className="messages-thread-back"
        aria-label="Back to conversations"
        onClick={() => handleBack()}
      >
        <ChevronLeftInsetIcon aria-hidden="true" />
      </button>
      <UserAvatar user={active.kind === 'direct' ? peer : null} title={active.title} />
      <button type="button" className="min-w-0 text-left flex-1" onClick={() => active.kind === 'group' && openDialog('messagesMembers')}>
        <div className="font-semibold text-sm truncate">{active.kind === 'direct' && peer ? `@${peer.username}` : active.title}</div>
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{active.kind === 'group' ? `${active.memberCount} members` : active.membershipStatus === 'invited' ? 'Invitation pending' : 'Direct message'}</div>
      </button>
      {active.kind === 'group' ? <button type="button" onClick={() => openDialog('messagesMembers')} className="messages-thread-action" aria-label="Group members" title="Group members"><UserGroupIcon aria-hidden="true" /></button> : null}
      <div className="relative"><button type="button" onClick={() => setMenu((open) => !open)} className="messages-thread-action" aria-label="Conversation actions" aria-expanded={menu}>•••</button>{menu ? <div className="messages-thread-menu">{active.kind === 'group' ? <button type="button" onClick={() => { setMenu(false); openDialog('messagesMembers'); }}>Members &amp; invitations</button> : <button type="button" disabled={busy || !peer} onClick={() => void blockPeer()} className="text-red-700 dark:text-red-400">Block @{peer?.username}</button>}<button type="button" onClick={() => { setMenu(false); void loadConversations(true); }}>Refresh conversation</button></div> : null}</div>
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

  // The "Choose a conversation" placeholder was the second pane's resting
  // state, and there is no second pane: a sheet is 24rem at its widest, so
  // the list IS what shows until a row is picked.
  if (!conversationId) return null;
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

/**
 * The Messages SHEET.
 *
 * It was `<main id="messages-screen">`, a screen root revealed by
 * App.navigateToMessages. The chat bubble is in the header on every route,
 * so that screen's back arrow had to answer "back to where?" — and it
 * answered home. It had a second back level of its own on top of that (a
 * thread went up to the list, the list went home), driven by writing the
 * platform header from ./store.ts. As a sheet the outer level is just
 * dismissal and the inner one is a button in the thread header, which is
 * what it always was in behaviour.
 *
 * The three dialogs stay siblings and stay `useDialog`-owned: a dialog over
 * a sheet is the kit's own stacking, not something this file arranges.
 */
export function MessagesSheetView() {
  const { open } = useStoreState(messagesSheetStore) as { open: boolean };
  useEffect(() => initializeMessagesStore(), []);
  return (
    <>
      <div
        id="messages-sheet-overlay"
        aria-hidden="true"
        {...(open ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40 bg-black/40"
        onClick={() => MessagesSheet.close()}
      >
      </div>
      <div
        id="messages-sheet"
        role="dialog"
        aria-label="Messages"
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className={'fixed z-50 flex flex-col bg-white dark:bg-zinc-900 '
          + 'border-zinc-200 dark:border-zinc-700 shadow-2xl nav-sheet-transition'}
      >
        {/* The surface's persistent head. The list used to carry a toolbar of
            its own with a second "Messages" heading in it — two titles, one
            above the other, once the sheet grew a head. Its one ACTION lives
            here instead, where it stays reachable from a thread too. */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3 shrink-0 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Messages</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Direct and group conversations</p>
          </div>
          <button
            type="button"
            onClick={() => openDialog('messagesCreate')}
            className="messages-new-button shrink-0"
            aria-label="New conversation"
            title="New conversation"
          >
            <PlusIcon aria-hidden="true" />
          </button>
          <button
            id="messages-sheet-close"
            type="button"
            className={'shrink-0 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 '
              + 'dark:hover:text-zinc-200 un-touch-target'}
            aria-label="Close"
            onClick={() => MessagesSheet.close()}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden" style={{ position: 'relative' }}>
          <div className="messages-layout">
            <ConversationList />
            <ConversationThread />
          </div>
        </div>
      </div>
      <CreateConversationDialog />
      <ConversationMembersDialog />
      <ShareItemDialog />
    </>
  );
}

if (typeof window !== 'undefined') {
  const host = (window.UsernodeReact ||= {});
  host.messages = messagesController;
  host.messagesSheet = MessagesSheet;
}

export { messagesController };

/**
 * The Messages island: the sheet plus its document-level Escape binding.
 * Mirrors ../app-context/index.tsx and ../notifications/index.tsx.
 */
export function MessagesIsland() {
  const { open } = useStoreState(messagesSheetStore) as { open: boolean };
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Adopted into a kit sheet the kit's modal stack owns the key; and a
      // thread open on mobile takes Escape as "back to the list" first, the
      // same order a nested surface always resolves it in.
      if (MessagesSheet._sheet) return;
      if (handleBack()) return;
      MessagesSheet.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return <MessagesSheetView />;
}
