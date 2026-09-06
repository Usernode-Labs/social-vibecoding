import { useEffect, useRef, useState, type ReactNode } from 'react';

import { EllipsisHorizontalIcon, PlusIcon, UserGroupIcon } from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
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
import type { ConversationMessage, ConversationSummary } from './types';

/*
 * ── The screen, in the widget language ─────────────────────────────────
 *
 * Messages is drawn on the dev session's LIFT LADDER (`.dc-lift` and its two
 * plane classes in app.css). The wallpaper is the ground. `.messages-layout`
 * is the frosted STRIP: it carries the screen's title, the New disc and the
 * conversation rows, drawn straight on it. The open conversation is the
 * frosted SHEET rising on the strip — `.messages-thread-pane` — and it
 * carries everything about that conversation: its title row with the
 * actions, the transcript, the typing line and the composer.
 *
 * The same construction at both widths. On a phone the list screen IS the
 * strip, and a thread is the strip's shoulder showing above the sheet; from
 * 768px up both panes render on one strip with the sheet beside the list.
 * That is what makes the two read as one screen at two widths rather than a
 * phone layout and a desktop layout.
 *
 * The transcript has two shapes, which is the language's own split (see
 * @/components/ui/chat.tsx): a DIRECT conversation is a bubble transcript —
 * two participants, one of them you, so side and surface say who is
 * speaking and no name is needed — and a GROUP is a named-row transcript,
 * where with several voices the name is the disambiguator and a bubble
 * would waste the width the text needs. ./message-row.tsx draws both.
 */

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
  const unread = conversation.unreadCount > 0;
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
      <UserAvatar user={conversation.kind === 'direct' ? peer : null} title={conversation.title} size="lg" shape="square" />
      <div className="min-w-0 flex-1">
        {/* Two lines, the row's own geometry: the name with the time on its
            trailing edge, then the preview with the unread count on its. The
            time and the count read as one column, which is what lets an
            unread row state itself three ways — bold name, accent time, count
            pill — without adding a third line. */}
        <div className="messages-row-line">
          <span className="messages-row-name">{conversation.kind === 'direct' && peer ? `@${peer.username}` : conversation.title}{conversation.kind === 'group' ? <span className="messages-group-tag">{conversation.memberCount}</span> : null}</span>
          <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`}>{relativeTime(conversation.lastActivityAt)}</time>
        </div>
        <div className="messages-row-line">
          <span className={`messages-row-preview ${invited ? 'messages-row-preview-invited' : ''}`}>{invited ? `${conversation.kind === 'direct' ? 'Message request' : 'Group invitation'} · Tap to review` : conversation.latestSummary || 'No messages yet'}</span>
          {conversation.unreadCount > 0 ? <span className="messages-unread" aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span> : null}
        </div>
      </div>
    </a>
  );
}

/**
 * The conversation list's loading state, at the ROW's own geometry.
 *
 * It was a spinner beside the words "Loading conversations…" — a fixed mark
 * that says "busy, somewhere" over an empty pane. These say where the
 * conversations are going and roughly how many, so the arriving rows land on
 * their own outlines instead of replacing a centred line of grey text.
 *
 * The wrapper IS `.messages-conversation-row`, not an imitation of it: that
 * class owns the 66px minimum height, the padding, the gap and the inset
 * separator, all in app.css. Borrowing it means the placeholder cannot
 * drift from the row the first time any of those move — and the separator
 * between placeholders is drawn for free, which is most of what makes a list
 * read as a list.
 *
 * Six, because the pane is taller than that on every phone and a list that
 * stops halfway reads as a short list rather than a loading one.
 */
function ConversationRowSkeleton() {
  return (
    <SkeletonGroup label="Loading conversations">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="messages-conversation-row">
          {/* The `lg` square UserAvatar's 44px box. */}
          <Skeleton shape="block" className="w-11 h-11 rounded-xl" />
          <div className="min-w-0 flex-1">
            {/* The name line, with the timestamp's short bar pushed right —
                the real row's trailing <time>. */}
            <div className="flex items-center gap-2">
              <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
              <Skeleton shape="muted" className="ml-auto w-8" />
            </div>
            {/* The preview line under it. */}
            <Skeleton shape="muted" className={`mt-1.5 ${i % 3 ? 'w-3/5' : 'w-2/5'}`} />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

function ConversationList() {
  const snap = useMessagesSnapshot();
  return (
    <section className={`messages-list-pane ${snap.route.conversationId ? 'hidden md:flex' : 'flex'}`} aria-label="Conversations">
      {/* The screen's title, the way Home carries "Your apps", and the New
          disc floating beside it. The header bar's chip already names the
          screen, so this carries no subtitle. */}
      <div className="messages-list-toolbar">
        <div className="messages-list-title"><h2>Messages</h2></div>
        <button type="button" onClick={() => openDialog('messagesCreate')} className="messages-new-button" aria-label="New conversation" title="New conversation"><PlusIcon aria-hidden="true" /></button>
      </div>
      {!snap.online ? <div className="messages-network-banner">Offline. Queued messages retry when you reconnect.</div> : null}
      <div className="messages-list-scroll platform-safe-scroll">
        {snap.loadingList && !snap.listLoaded ? <ConversationRowSkeleton /> : null}
        {snap.error ? <div className="messages-state messages-state-error"><p>{snap.error}</p><button type="button" onClick={() => void loadConversations(true)}>Try again</button></div> : null}
        {!snap.loadingList && !snap.error && snap.listLoaded && !snap.conversations.length ? <div className="messages-empty"><h3>No messages yet</h3><p>Start a direct conversation or bring a group together.</p><button type="button" onClick={() => openDialog('messagesCreate')}>New conversation</button></div> : null}
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

/**
 * The sheet's title row: who this conversation is with, and its actions as
 * floating discs. No back control of its own — on a phone the platform
 * header's back arrow already points at the list (see syncChrome in
 * ./store.ts), and a second one here was the same affordance twice.
 */
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
  const subtitle = active.kind === 'group'
    ? `${active.memberCount} members${active.myRole === 'owner' ? ' · you own this group' : ''}`
    : active.membershipStatus === 'invited' ? 'Invitation pending' : 'Direct message';
  return (
    <header className="messages-thread-header">
      <UserAvatar user={active.kind === 'direct' ? peer : null} title={active.title} shape="square" />
      <button type="button" className="min-w-0 text-left flex-1" onClick={() => active.kind === 'group' && openDialog('messagesMembers')}>
        <div className="messages-thread-name">{active.kind === 'direct' && peer ? `@${peer.username}` : active.title}</div>
        <div className="messages-thread-sub">{subtitle}</div>
      </button>
      {active.kind === 'group' ? <button type="button" onClick={() => openDialog('messagesMembers')} className="messages-thread-action" aria-label="Group members" title="Group members"><UserGroupIcon aria-hidden="true" /></button> : null}
      <div className="relative"><button type="button" onClick={() => setMenu((open) => !open)} className="messages-thread-action" aria-label="Conversation actions" aria-expanded={menu}><EllipsisHorizontalIcon aria-hidden="true" /></button>{menu ? <div className="messages-thread-menu">{active.kind === 'group' ? <button type="button" onClick={() => { setMenu(false); openDialog('messagesMembers'); }}>Members &amp; invitations</button> : <button type="button" disabled={busy || !peer} onClick={() => void blockPeer()} className="text-red-700 dark:text-red-400">Block @{peer?.username}</button>}<button type="button" onClick={() => { setMenu(false); void loadConversations(true); }}>Refresh conversation</button></div> : null}</div>
    </header>
  );
}

/** The day a message was sent, in the viewer's zone, for the separators. */
function dayKey(message: ConversationMessage): string {
  const date = new Date(message.createdAt);
  return Number.isNaN(date.getTime()) ? '' : date.toDateString();
}

function dayLabel(message: ConversationMessage): string {
  const date = new Date(message.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, date.getFullYear() === today.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
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

  if (!conversationId) return <section className="hidden md:flex messages-thread-pane messages-no-selection"><h2>Choose a conversation</h2><p>Your direct and group messages stay here.</p></section>;
  // The shape follows the conversation's kind, and it is on the SECTION so
  // the scroller's class string below stays the one the safe-area test pins.
  const shape = snap.active?.kind === 'group' ? 'row' : 'bubble';
  const rows: ReactNode[] = [];
  let previousDay = '';
  for (const message of snap.messages) {
    const day = dayKey(message);
    if (day && day !== previousDay) {
      rows.push(<div key={`day-${day}`} className="messages-day" aria-hidden="true">{dayLabel(message)}</div>);
      previousDay = day;
    }
    rows.push(<MessageRow key={message.clientKey || message.id} message={message} conversationId={conversationId} shape={shape} />);
  }
  return (
    <section className={`flex messages-thread-pane dc-lift dc-lift-session ${shape === 'bubble' ? 'messages-thread-direct' : 'messages-thread-group'}`} aria-label={snap.active?.title || 'Conversation'}>
      <ThreadHeader />
      <InvitationBanner />
      <div ref={scroller} className="messages-thread-scroll platform-safe-scroll un-kb-avoid" aria-live="polite">
        {snap.loadingThread ? <div className="messages-state"><span className="messages-spinner" />Loading messages…</div> : null}
        {snap.threadError && !snap.messages.length ? <div className="messages-state messages-state-error"><p>{snap.threadError}</p><button type="button" onClick={() => messagesController.route(conversationId)}>Try again</button></div> : null}
        {!snap.loadingThread && !snap.threadError && snap.active && snap.active.membershipStatus === 'member' && !snap.messages.length ? <div className="messages-thread-empty"><span aria-hidden="true">👋</span><p>No messages yet. Say hello.</p></div> : null}
        {snap.nextBefore ? <div className="flex justify-center py-2"><button type="button" disabled={snap.loadingOlder} onClick={() => void older()} className="messages-load-older">{snap.loadingOlder ? 'Loading…' : 'Load earlier messages'}</button></div> : null}
        {rows}
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
  // No background of its own: the route paints the wallpaper (the
  // body:has(#messages-screen) rules in app.css), and the two frosted planes
  // need a transparent ancestor chain to have anything to blur.
  return (
    <>
      <main ref={screenRef} id="messages-screen" className="hidden flex-1 min-h-0 overflow-hidden" style={{ position: 'relative' }}>
        <div className="messages-layout dc-lift dc-lift-strip">
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
