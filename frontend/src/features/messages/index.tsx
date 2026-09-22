import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  ChatIcon, EllipsisHorizontalIcon, PlusIcon, SearchIcon, SparklesIcon, UserGroupIcon,
} from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { agoStamp } from '../../lib/timestamp';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import * as api from './api';
import { MessageComposer } from './composer';
import { CreateConversationDialog } from './create-dialog';
import { ConversationMembersDialog } from './members-dialog';
import { UserAvatar } from './format';
import { MessageRow } from './message-row';
import { ShareItemDialog } from './share-dialog';
import {
  initializeMessagesStore,
  finishDirectBlock,
  loadConversations,
  loadOlder,
  messagesController,
  open as openConversation,
  respond,
  selectConversation,
  syncChrome,
  setFilter,
  typingUsers,
  useMessagesSnapshot,
} from './store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { initializeGlobalChat, startNewGlobalChat, useGlobalChatState } from '../global-chat/store';
import {
  INBOX_FILTERS, buildInbox,
  type AgentChat, type AppDiscussion, type InboxFilter,
} from './inbox';
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
  // #1808: the shared ago ladder, which stops being relative at a week — a
  // conversation last spoken in during March read "412d", which is a duration
  // and not information. `title` carries the unelided instant either way.
  const activity = agoStamp(conversation.lastActivityAt);
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
          <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`} dateTime={conversation.lastActivityAt} title={activity.title}>{activity.text}</time>
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
 * The mark that says what KIND of thread a row is (#2718).
 *
 * People get none, and that is the whole design of it: they are the
 * overwhelming majority of an inbox and a pill on every row is a pill that
 * says nothing. The two that are NOT a person say so — which is the
 * arrangement Slack and Teams land on with a channel, a DM and a bot thread
 * in one sidebar, and the one thing that makes a single list readable.
 */
function KindPill({ kind }: { kind: 'app' | 'agent' }) {
  return (
    <span className="messages-kind-pill" data-kind={kind}>
      {kind === 'app' ? 'App' : 'Agent'}
    </span>
  );
}

/**
 * An app's own discussion — the general thread on its board.
 *
 * It carries NO unread count, and its absence is honest rather than an
 * omission: `chat_messages` has no per-viewer read cursor, so a number here
 * would be invented. What the row says instead is when the last thing was
 * said and who said it, which is what makes it worth a tap.
 *
 * An anchor at the app's own discussion address, so a modified click opens
 * it in a tab the way every other row on this screen does.
 */
function AppDiscussionRow({ discussion }: { discussion: AppDiscussion }) {
  const activity = discussion.lastAt ? agoStamp(discussion.lastAt) : null;
  const record = {
    icon_url: discussion.iconUrl,
    icon_emoji: discussion.iconEmoji,
    name: discussion.name,
  };
  return (
    <a
      href={`#app/${encodeURIComponent(discussion.slug)}/dev/chat`}
      data-inbox-app={discussion.slug}
      className="messages-conversation-row"
    >
      <span
        data-icon={appIconKind(record as never)}
        className="app-icon-tile messages-inbox-tile"
      >
        <AppIconContent app={record as never} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{discussion.name}<KindPill kind="app" /></span>
          {activity
            ? <time className="messages-row-time" dateTime={discussion.lastAt || undefined} title={activity.title}>{activity.text}</time>
            : null}
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {discussion.lastMessage
              ? (discussion.lastBy ? `@${discussion.lastBy}: ${discussion.lastMessage}` : discussion.lastMessage)
              : 'No messages yet'}
          </span>
        </div>
      </div>
    </a>
  );
}

/**
 * An agent chat — a thread with the AI that builds.
 *
 * Read from features/global-chat's own store rather than copied into this
 * one: that list is already loaded, merged on every thread event and
 * invalidated by the chat itself, and a second copy of it is a copy that
 * drifts. The row's address is the same `#chat/<id>` the Improve panel's own
 * list uses.
 */
function AgentChatRow({ chat }: { chat: AgentChat }) {
  const at = chat.updatedAt || chat.createdAt || null;
  const activity = at ? agoStamp(at) : null;
  return (
    <a
      href={`#chat/${encodeURIComponent(chat.id)}`}
      data-inbox-agent={chat.id}
      className="messages-conversation-row"
    >
      <span className="messages-inbox-tile messages-inbox-agent-tile" aria-hidden="true">
        <SparklesIcon className="w-5 h-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{chat.title || 'Untitled chat'}<KindPill kind="agent" /></span>
          {activity
            ? <time className="messages-row-time" dateTime={at || undefined} title={activity.title}>{activity.text}</time>
            : null}
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {chat.busy ? 'Working…' : (chat.summary || 'No messages yet')}
          </span>
        </div>
      </div>
    </a>
  );
}

/**
 * The filter row — a SEGMENTED STRIP, the same one the app Workshop wears.
 *
 * THE PLUS IS NOT ON IT ANY MORE (#2718 review). It sat at the far end on
 * the reading that a row which narrows what is shown is where the thing that
 * adds to it belongs. That put one control saying "new" beside four saying
 * "show", and it could only ever mean ONE of the three things this inbox now
 * holds — it opened the people dialog, on the Agents tab as readily as on
 * People. What starts something is below, per tab, where it can say which.
 *
 * STYLED AS THE WORKSHOP'S STRIP IS: a track with the segments inside it and
 * the selected one tinted with a hairline ring, which is the shell's one
 * segmented control rather than this screen's own. The Workshop's slides a
 * measured marker between segments; this does not, because that measurement
 * is against a DOM that screen owns. At rest they are the same object.
 */
function InboxFilters({ filter }: { filter: InboxFilter }) {
  return (
    <div id="messages-filters" className="messages-filters">
      <div className="messages-filter-track" role="group" aria-label="Show">
        {INBOX_FILTERS.map(([key, label]) => (
          <button
            key={key}
            id={`messages-filter-${key}`}
            type="button"
            data-messages-filter={key}
            aria-current={filter === key ? 'page' : 'false'}
            className="messages-filter"
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * What starts something, under the strip and answering to it.
 *
 * ── One control, or two, or none ──────────────────────────────────────
 *
 * The inbox holds three kinds and only two of them can be STARTED: a
 * conversation with people, and a chat with the agent. An app's discussion
 * is the app's, and exists already — so the Apps tab offers nothing, which
 * is the honest answer rather than a button that would have to invent one.
 *
 * Under ALL it is both, side by side, because All is the tab with no answer
 * to "which" — the split says the two are peers rather than making one the
 * default and the other a menu item behind it.
 *
 * ── The agent half only when there IS an agent ────────────────────────
 *
 * Agent chats are gated on the same two flags their rows are (see the list
 * below): a shell with the feature off shows no Agents rows, no Agents tab
 * doing anything, and no way to start one. `agentsOn` is passed in rather
 * than read again here, so one answer drives all three.
 */
function InboxCompose({ filter, agentsOn }: { filter: InboxFilter; agentsOn: boolean }) {
  const people = filter === 'all' || filter === 'people';
  const agent = agentsOn && (filter === 'all' || filter === 'agents');
  if (!people && !agent) return null;
  return (
    <div id="messages-compose" className="messages-compose">
      {people ? (
        <button
          type="button"
          id="messages-new"
          className="messages-compose-btn"
          onClick={() => openDialog('messagesCreate')}
        >
          <PlusIcon className="w-4 h-4" aria-hidden="true" />
          <span>New message</span>
        </button>
      ) : null}
      {agent ? (
        <button
          type="button"
          id="messages-new-agent"
          className="messages-compose-btn"
          onClick={() => { void startNewGlobalChat(); }}
        >
          <SparklesIcon className="w-4 h-4" aria-hidden="true" />
          <span>New agent chat</span>
        </button>
      ) : null}
    </div>
  );
}

/**
 * Narrow the inbox by what a row SAYS, not by what it is.
 *
 * A CLIENT-SIDE MATCH over the three lists already in memory, so it answers
 * on every keystroke and adds no endpoint. What it matches is the text each
 * row draws — a person's name or a group's title, an app's name, a chat's
 * title — because a search that found rows by a field the reader cannot see
 * would return results they cannot explain.
 *
 * It composes with the filter rather than replacing it: the strip says which
 * kinds, this says which of them, and an empty query is every row.
 */
function inboxMatches(text: string | null | undefined, query: string): boolean {
  if (!query) return true;
  return String(text || '').toLowerCase().includes(query);
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
  // Agent chats come from the chat's OWN store (#2718): that list is already
  // loaded, merged on every thread event and invalidated by the chat itself,
  // and a second copy in this store is a copy that drifts. Gated on the same
  // two flags the Improve panel's list is, so a shell where the feature is
  // off sees no Agents rows and no Agents filter doing nothing.
  // EPHEMERAL, AND DELIBERATELY NOT IN THE STORE. Nothing else reads what
  // was typed here, and a query that survived leaving the screen would greet
  // the next visit with a list that is missing rows for a reason no longer on
  // screen. The filter IS in the store, because the thread pane and the
  // deep-link router both read it.
  const [query, setQuery] = useState('');
  const chat = useGlobalChatState();
  const agentsOn = !!chat.bootstrap?.parityReady
    && chat.bootstrap.profiles.globalChat.enabled === true;
  const agents: AgentChat[] = agentsOn ? (chat.threads as AgentChat[]) : [];
  const inbox = buildInbox({
    conversations: snap.conversations,
    discussions: snap.discussions,
    agents,
    filter: snap.filter,
  });
  const byConversation = new Map(snap.conversations.map((item) => [String(item.id), item]));
  const byApp = new Map(snap.discussions.map((item) => [item.slug, item]));
  const byAgent = new Map(agents.map((item) => [item.id, item]));

  const q = query.trim().toLowerCase();
  const matches = (entry: { kind: string; key: string }) => {
    if (!q) return true;
    if (entry.kind === 'person') {
      const c = byConversation.get(entry.key.slice('person:'.length));
      if (!c) return false;
      const peer = conversationPeer(c);
      return inboxMatches(c.title, q)
        || inboxMatches(peer?.username, q)
        || inboxMatches(peer?.displayName, q);
    }
    if (entry.kind === 'app') {
      const a = byApp.get(entry.key.slice('app:'.length));
      return !!a && (inboxMatches(a.name, q) || inboxMatches(a.slug, q));
    }
    const g = byAgent.get(entry.key.slice('agent:'.length));
    return !!g && inboxMatches(g.title, q);
  };
  const shown = inbox.filter(matches);

  return (
    <section className={`messages-list-pane ${snap.route.conversationId ? 'hidden md:flex' : 'flex'}`} aria-label="Conversations">
      {/* THE SCREEN NAMES ITSELF ONCE (#2718 review). An <h2> reading
          "Messages" sat here, under a bar already reading Messages — two
          titles, one word, an inch apart. The bar is the title now, which is
          what it is for on every other screen in the shell.

          A SEARCH TAKES ITS PLACE, because a list that can run to hundreds of
          rows and holds three kinds of thing needs a way to name one. */}
      <div className="messages-search">
        <SearchIcon className="messages-search-glyph w-5 h-5" aria-hidden="true" />
        <input
          id="messages-search"
          type="search"
          className="messages-search-input"
          placeholder="Search messages…"
          aria-label="Search messages"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <InboxFilters filter={snap.filter} />
      <InboxCompose filter={snap.filter} agentsOn={agentsOn} />
      {!snap.online ? <div className="messages-network-banner">Offline. Queued messages retry when you reconnect.</div> : null}
      {/* #1953: a click on the list's own blank space — below the last row,
          not on a row or a button — closes the open conversation, as it
          would in a desktop mail client. Only the list itself counts
          (`target === currentTarget`), so no row, empty state or retry
          button is affected. On a phone the list is hidden while a thread is
          open, so this is a two-pane (md+) gesture. */}
      <div
        className="messages-list-scroll platform-safe-scroll"
        onClick={(e) => {
          if (e.target === e.currentTarget && snap.route.conversationId) openConversation(null);
        }}
      >
        {snap.loadingList && !snap.listLoaded ? <ConversationRowSkeleton /> : null}
        {snap.error ? <div className="messages-state messages-state-error"><p>{snap.error}</p><button type="button" onClick={() => void loadConversations(true)}>Try again</button></div> : null}
        {/* THE EMPTY STATE IS STILL THE CONVERSATIONS', and that is the
            correct reading: "no messages yet" offers to start one, which is
            an answer about people. An inbox that is empty only because a
            FILTER is narrow says something else, below. */}
        {!snap.loadingList && !snap.error && snap.listLoaded && !snap.conversations.length && !inbox.length
          ? <div className="messages-empty"><h3>No messages yet</h3><p>Start a direct conversation or bring a group together.</p><button type="button" onClick={() => openDialog('messagesCreate')}>New conversation</button></div>
          : null}
        {!snap.loadingList && !snap.error && snap.listLoaded && !inbox.length && snap.filter !== 'all'
          ? <div id="messages-filter-empty" className="messages-state"><p>Nothing here under this filter.</p></div>
          : null}
        {/* A QUERY THAT MATCHED NOTHING is not an empty inbox, and must not
            borrow the empty inbox's offer to start a conversation: the rows
            are there, this one word is what hid them. */}
        {!snap.loadingList && !snap.error && snap.listLoaded && inbox.length && !shown.length
          ? <div id="messages-search-empty" className="messages-state"><p>No messages match “{query.trim()}”.</p></div>
          : null}
        {/* ONE LIST, THREE KINDS. ./inbox.ts orders them on one clock and
            returns DESCRIPTORS rather than rows, so each kind is still drawn
            by the component that knows how — which is what keeps a
            conversation row byte-identical to the one this screen has always
            drawn while the list it sits in grew two more kinds. */}
        {shown.map((entry) => {
          if (entry.kind === 'person') {
            const conversation = byConversation.get(entry.key.slice('person:'.length));
            return conversation
              ? <ConversationRow key={entry.key} conversation={conversation} active={snap.route.conversationId === conversation.id} />
              : null;
          }
          if (entry.kind === 'app') {
            const discussion = byApp.get(entry.key.slice('app:'.length));
            return discussion ? <AppDiscussionRow key={entry.key} discussion={discussion} /> : null;
          }
          const agent = byAgent.get(entry.key.slice('agent:'.length));
          return agent ? <AgentChatRow key={entry.key} chat={agent} /> : null;
        })}
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
    <section className={`flex messages-thread-pane platform-kb-column dc-lift dc-lift-session ${shape === 'bubble' ? 'messages-thread-direct' : 'messages-thread-group'}`} aria-label={snap.active?.title || 'Conversation'}>
      <ThreadHeader />
      <InvitationBanner />
      {/* No `un-kb-avoid` here: the column reserves the keyboard inset now
          (`platform-kb-column` above), and the kit's class would pad the
          inside of this scroller on top of that — the inset twice over, as
          dead space under the last message. */}
      <div ref={scroller} className="messages-thread-scroll platform-safe-scroll" aria-live="polite">
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
  // THE AGENT HALF OF THIS INBOX HAS TO ASK FOR ITSELF (#2718 review).
  //
  // `useGlobalChatState()` below reads a store that nothing on this screen
  // was filling: the ONLY caller of initializeGlobalChat outside Settings
  // was the Improve panel's own New chat button. So an inbox opened without
  // ever having opened Improve saw `bootstrap: null`, which reads as "the
  // feature is off" — no agent rows in the list, and no way to start one
  // under the Agents tab. The tab was there and did nothing, which is what
  // "there is no new agent button under agents" is.
  //
  // The same shape that button uses, and for the same reason: a boot-time
  // 401 is expected before app.js has established the session, so `sv:authed`
  // asks again. The call is idempotent — it returns the bootstrap it already
  // has unless forced — so two surfaces asking costs one request.
  useEffect(() => {
    void initializeGlobalChat();
    const retry = () => { void initializeGlobalChat({ force: true }); };
    window.addEventListener('sv:authed', retry);
    return () => window.removeEventListener('sv:authed', retry);
  }, []);
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
