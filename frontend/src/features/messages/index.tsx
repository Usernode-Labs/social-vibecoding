import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { groupsWithPrevious } from '@/components/ui/chat';
import {
  ChatIcon, DraftTrashIcon, EllipsisHorizontalIcon, PlusIcon, SearchIcon, SparklesIcon, UserGroupIcon,
} from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { placeUnderAnchor, type AnchorRect } from '../../lib/anchor-popover';
import { anchorRectOf, useAnchoredDismiss } from '../../lib/popover-dismiss';
import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import * as api from './api';
import { AgentAppDialog } from './agent-dialog';
import { MessageComposer } from './composer';
import { CreateConversationDialog } from './create-dialog';
import { ConversationMembersDialog } from './members-dialog';
import { UserAvatar } from './format';
import { MessageRow } from './message-row';
import { ShareItemDialog } from './share-dialog';
import {
  agentThreadAddress,
  fullScreenAddress,
  initializeMessagesStore,
  finishDirectBlock,
  loadConversations,
  loadOlder,
  messagesController,
  open as openConversation,
  openAgentThread,
  respond,
  setUserBlocked,
  selectConversation,
  syncChrome,
  setFilter,
  typingUsers,
  useChannelHandles,
  useMessagesSnapshot,
} from './store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { GlobalChatPanel } from '../global-chat';
import {
  deactivateGlobalChat,
  getGlobalChatState,
  initializeGlobalChat,
  openGlobalChat,
  removeGlobalChatThread,
  useGlobalChatState,
} from '../global-chat/store';
import { Improve } from '../improve/improve-controller.js';
import { improveStore } from '../improve/improve-store.js';
import { SessionRow, type SessionRowView } from '../improve/session-row';
import {
  INBOX_FILTERS, buildInbox,
  type AgentChat, type AppDiscussion, type InboxFilter, type InboxSection,
} from './inbox';
import type { ConversationMessage, ConversationSummary, MessagesAgentThread } from './types';

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
 * The transcript has ONE shape now, Discord's (#2783): every conversation —
 * a DM, a group, #general — is a named-row transcript, with consecutive
 * messages from one person grouped under a single name. DMs lost their
 * bubbles so that a chat reads the same whichever section it sits in.
 * ./message-row.tsx draws it.
 *
 * The LIST is Discord's too: the chats (people and agents) on top, newest
 * first, then the channels — #general and one per app you are a member of.
 */

function openDialog(name: 'messagesCreate' | 'messagesMembers' | 'messagesShare' | 'messagesAgent', payload?: unknown) {
  window.UsernodeReact?.dialogs?.[name]?.open(payload);
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
function KindPill({ kind }: { kind: 'agent' }) {
  // Only an agent wears one now (#2783): the channels have a section of
  // their own, headed, so an "App" pill on each of them said it twice.
  return (
    <span className="messages-kind-pill" data-kind={kind}>
      Agent
    </span>
  );
}

/**
 * #general, the room every user is in (#2783).
 *
 * A `channel` conversation, so unlike an app's channel it DOES carry an
 * unread count: it lives in the conversations domain, which keeps a read
 * cursor per member. The tile is the `#` a channel is named with, where a
 * person's row has their face.
 */
function GeneralChannelRow({ conversation, active }: { conversation: ConversationSummary; active: boolean }) {
  const unread = conversation.unreadCount > 0;
  const activity = agoStamp(conversation.lastActivityAt);
  const by = conversation.latestMessage?.sender?.username;
  const handle = conversation.channelKey || conversation.title;
  return (
    <a
      href={`#messages/${conversation.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === `#messages/${conversation.id}`) {
          event.preventDefault(); selectConversation(conversation.id);
        }
      }}
      data-inbox-channel={handle}
      className={`messages-conversation-row messages-channel-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="messages-inbox-tile messages-channel-tile" aria-hidden="true">#</span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{handle}</span>
          <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`} dateTime={conversation.lastActivityAt} title={activity.title}>{activity.text}</time>
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {conversation.latestSummary
              ? (by ? `@${by}: ${conversation.latestSummary}` : conversation.latestSummary)
              : 'Everyone on Homeroom'}
          </span>
          {unread ? <span className="messages-unread" aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span> : null}
        </div>
      </div>
    </a>
  );
}

/**
 * An app's channel — the general thread on its board, one per app the
 * viewer is a member of, including one nobody has spoken in yet (#2783).
 *
 * It carries NO unread count, and its absence is honest rather than an
 * omission: `chat_messages` has no per-viewer read cursor, so a number here
 * would be invented. What the row says instead is when the last thing was
 * said and who said it, which is what makes it worth a tap.
 *
 * An anchor at the channel's address in this inbox, so a modified click
 * opens it in a tab the way every other row on this screen does.
 */
function AppChannelRow({ discussion, active }: { discussion: AppDiscussion; active: boolean }) {
  const activity = discussion.lastAt ? agoStamp(discussion.lastAt) : null;
  const record = {
    icon_url: discussion.iconUrl,
    icon_emoji: discussion.iconEmoji,
    name: discussion.name,
  };
  const handle = discussion.channel || discussion.slug;
  return (
    <a
      href={`#messages/app/${encodeURIComponent(discussion.slug)}`}
      data-inbox-app={discussion.slug}
      data-inbox-channel={handle}
      className={`messages-conversation-row messages-channel-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span
        data-icon={appIconKind(record as never)}
        className="app-icon-tile messages-inbox-tile"
      >
        <AppIconContent app={record as never} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{discussion.name}<span className="messages-channel-handle">#{handle}</span></span>
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
/**
 * An agent chat, as a row of this inbox.
 *
 * ── It can be DELETED here (#2718 review) ─────────────────────────────
 *
 * The Improve panel's own list of these could, and the panel is retired: it
 * had become a drawer you opened to press one of two buttons, so the buttons
 * moved into the mark's menu and the drawer went. Everything else in it was
 * already somewhere better — the sessions in the Workshop, GitHub and Share
 * in About, these chats in this list — except the delete, which existed
 * nowhere else. So it comes here rather than going away, because retiring a
 * surface is not a reason to retire what only that surface offered.
 *
 * The confirm is a row rather than a dialog, which is what it was: a chat is
 * cheap to lose and a modal over a list to delete one row from it is the
 * heavier gesture.
 */
function AgentChatRow({ chat, active }: { chat: AgentChat; active: boolean }) {
  const at = chat.updatedAt || chat.createdAt || null;
  const activity = at ? agoStamp(at) : null;
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function remove() {
    if (removing) return;
    setRemoving(true);
    try {
      await removeGlobalChatThread(chat.id);
    } catch {
      setRemoving(false);
      window.PlatformUI?.toast?.('Could not delete this chat.');
    }
  }

  if (confirming) {
    return (
      <div className="messages-conversation-row messages-row-confirm" data-inbox-agent={chat.id}>
        <span className="min-w-0 flex-1">Delete this chat?</span>
        <button
          type="button"
          className="messages-row-confirm-cancel"
          disabled={removing}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="messages-row-confirm-delete"
          disabled={removing}
          onClick={() => void remove()}
        >
          {removing ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    );
  }
  // #2813: the inbox's own address, so on a desktop the chat opens in the
  // pane beside this list. On a phone the router swaps it for `#chat/<id>`,
  // the full-screen chat this row always led to there.
  const thread: MessagesAgentThread = { kind: 'chat', id: chat.id };
  const href = agentThreadAddress(thread);
  return (
    <a
      href={href}
      data-inbox-agent={chat.id}
      className={`messages-conversation-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === href) { event.preventDefault(); openAgentThread(thread); }
      }}
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
      {/* Inside the anchor, so it rides the row's own layout — and it stops
          the navigation itself, the way the Discover row's Add button does. */}
      <button
        type="button"
        className="messages-row-delete"
        aria-label={`Delete ${chat.title || 'this chat'}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirming(true); }}
      >
        <DraftTrashIcon className="w-4 h-4" aria-hidden="true" />
      </button>
    </a>
  );
}

/**
 * A change in flight, as a row of this inbox (#2770, #2772).
 *
 * ── A change IS an agent conversation ─────────────────────────────────
 *
 * A dev session is the viewer talking to the agent that builds, which is
 * what an agent chat is too — so it is listed under Agents beside them, and
 * New change lands on one. Until now Messages → Agents held only the global
 * chats, and a change somebody had just started was findable from the
 * Workshop and the bell's Agents tab but not from here.
 *
 * ── The same row, from the same list ──────────────────────────────────
 *
 * The bell's Agents tab already draws these, with ../improve/session-row.tsx
 * from the Improve store's own list (`sessions` + `otherSessions`, one
 * fetch of /api/me/active-sessions). So this reads that store and draws that
 * row: a second copy of the list would drift, and a second row would let a
 * change's Working / Ready state say two things in two places. The store is
 * also what `Improve.onSessionCreated` publishes into, which is what makes a
 * change started a moment ago appear here at once.
 *
 * NOT GATED ON THE GLOBAL-CHAT FLAGS. Those decide whether the experimental
 * chat exists; a change is not that chat, and every collaborator has one.
 *
 * ── Where the row goes ────────────────────────────────────────────────
 *
 * The session itself, the conversation, rather than the change's card page
 * the bell links. Since #2813 that is `#messages/session/<slug>/<id>`: on a
 * desktop the session opens in the pane beside this list. On a phone the
 * router swaps that address for `#app/<slug>/dev/sessions/<id>`, the
 * full-screen session, which lights the Messages tab and hangs its chevron
 * off this inbox. The router records that (`Improve.enterSessionFrom`) as
 * it swaps, because the route being left is not an app route and the
 * Improve store cannot tell. A work order has no conversation here, so it
 * keeps its own destination.
 */
function inboxSessionView(session: SessionRowView): SessionRowView {
  if (session.kind !== 'session' || !session.appSlug) return session;
  return {
    ...session,
    // #2813: the inbox's own address for the session, so on a desktop it
    // opens in the pane beside this list. On a phone the router swaps it for
    // `#app/<slug>/dev/sessions/<id>` — and records `Improve.enterSessionFrom`
    // there, which this row's click used to — so the session is still the
    // full-screen conversation it was, with its chevron back to this inbox.
    href: agentThreadAddress({ kind: 'session', slug: session.appSlug, id: session.id }),
  };
}

function AgentSessionRow({ session, active }: { session: SessionRowView; active: boolean }) {
  return (
    <div
      className={`messages-inbox-session ${active ? 'messages-inbox-session-active' : ''}`}
      data-inbox-session={session.key}
      aria-current={active ? 'page' : undefined}
    >
      <SessionRow session={session} showApp onNavigate={() => {}} />
    </div>
  );
}

/**
 * The filter row — a SEGMENTED STRIP, the same one the app Workshop wears —
 * with the "+" that starts something at its trailing end (#2778).
 *
 * THE PLUS IS BACK ON IT. #2718's review took it off because one control
 * saying "new" could only ever mean one of the things this inbox holds — it
 * opened the people dialog on the Agents tab as readily as on People. It
 * comes back as a CHOICE rather than a guess: pressing it opens a small
 * popover, the vote picker's kind rather than a dialog, offering the three
 * things that can be started — a direct message, a group chat, an agent
 * chat. A channel is not among them: #general and each app's exist already.
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
      <NewMessageButton />
    </div>
  );
}

/** The three things the "+" can start, in the order the popover lists them. */
const NEW_CHOICES = [
  { key: 'direct', label: 'Direct message', hint: 'Talk to one person' },
  { key: 'group', label: 'Group chat', hint: 'Bring a few people together' },
  { key: 'agent', label: 'Agent chat', hint: 'Start a change on one of your apps' },
] as const;
type NewChoice = typeof NEW_CHOICES[number]['key'];

function startNew(choice: NewChoice) {
  // DM and group are the create dialog, opened on the matching tab. Agent
  // asks which app first (./agent-dialog.tsx), then opens a new dev session
  // there — for now; a platform-wide agent session will take its place.
  if (choice === 'agent') openDialog('messagesAgent');
  else openDialog('messagesCreate', choice);
}

/**
 * The "+" and its popover (#2778).
 *
 * The popover is placed and dismissed exactly as the vote picker's desktop
 * home is — lib/anchor-popover.ts and lib/popover-dismiss.ts are that code,
 * shared — and portalled to
 * the body so the list's own scroller cannot clip it. On touch it is the
 * kit's action sheet instead, which is what a three-row menu is on a phone.
 *
 * Nothing is rendered until the button is pressed, so the prerendered
 * document holds the button alone and hydration has nothing to disagree
 * about.
 */
function NewMessageButton() {
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const open = !!rect;
  const shut = () => setRect(null);
  useAnchoredDismiss(open, [btnRef, popRef], shut);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (open) { shut(); return; }
    const pu = (window as any).PlatformUI;
    if (pu && typeof pu.isTouch === 'function' && pu.isTouch() && typeof pu.actionSheet === 'function') {
      pu.actionSheet({
        actions: NEW_CHOICES.map((item) => ({ label: item.label, handler: () => startNew(item.key) })),
      });
      return;
    }
    setRect(anchorRectOf(event.currentTarget));
  };
  const choose = (choice: NewChoice) => { shut(); startNew(choice); };
  const pos = rect
    ? placeUnderAnchor(rect, { width: 240, height: 164 }, { width: window.innerWidth, height: window.innerHeight })
    : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id="messages-new"
        className="messages-new-btn"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-label="New message"
        title="New message"
        onClick={toggle}
      >
        <PlusIcon aria-hidden="true" />
      </button>
      {open && pos ? createPortal(
        <div
          ref={popRef}
          id="messages-new-menu"
          className="messages-new-pop"
          role="menu"
          aria-label="Start a new conversation"
          style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          {NEW_CHOICES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              data-new-choice={item.key}
              className="messages-new-option"
              onClick={() => choose(item.key)}
            >
              {item.key === 'direct' ? <ChatIcon aria-hidden="true" /> : null}
              {item.key === 'group' ? <UserGroupIcon aria-hidden="true" /> : null}
              {item.key === 'agent' ? <SparklesIcon aria-hidden="true" /> : null}
              <span className="min-w-0">
                <span className="messages-new-option-label">{item.label}</span>
                <span className="messages-new-option-hint">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** The heading over each part of the list (#2783). */
const SECTION_LABELS: Record<InboxSection, string> = {
  chats: 'Chats',
  channels: 'Channels',
};

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
  // The viewer's changes in flight (#2770) — see AgentSessionRow. AFTER
  // MOUNT ONLY: app.js can have filled the Improve store before this island
  // hydrates, and rows the prerendered document did not have are a hydration
  // mismatch on every route. The first client render therefore matches the
  // prerender, and the rows arrive one commit later.
  const improve = useStoreState(improveStore) as {
    sessions?: SessionRowView[];
    otherSessions?: SessionRowView[];
  };
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const sessions: SessionRowView[] = mounted
    ? [...(improve.sessions || []), ...(improve.otherSessions || [])].map(inboxSessionView)
    : [];
  const inbox = buildInbox({
    conversations: snap.conversations,
    discussions: snap.discussions,
    agents,
    sessions,
    filter: snap.filter,
  });
  const byConversation = new Map(snap.conversations.map((item) => [String(item.id), item]));
  const byApp = new Map(snap.discussions.map((item) => [item.slug, item]));
  const byAgent = new Map(agents.map((item) => [item.id, item]));
  const bySession = new Map(sessions.map((item) => [item.key, item]));

  const q = query.trim().toLowerCase();
  const matches = (entry: { kind: string; key: string }) => {
    if (!q) return true;
    if (entry.kind === 'channel') {
      const c = byConversation.get(entry.key.slice('channel:'.length));
      return !!c && (inboxMatches(c.title, q) || inboxMatches(c.channelKey, q));
    }
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
      return !!a && (inboxMatches(a.name, q) || inboxMatches(a.slug, q) || inboxMatches(a.channel, q));
    }
    if (entry.kind === 'session') {
      const c = bySession.get(entry.key.slice('session:'.length));
      return !!c && (inboxMatches(c.title, q) || inboxMatches(c.appName, q));
    }
    const g = byAgent.get(entry.key.slice('agent:'.length));
    return !!g && inboxMatches(g.title, q);
  };
  const shown = inbox.filter(matches);

  return (
    <section className={`messages-list-pane ${snap.route.conversationId || snap.route.appSlug || snap.route.agent ? 'hidden md:flex' : 'flex'}`} aria-label="Conversations">
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
        {/* ONE LIST, TWO SECTIONS (#2783). ./inbox.ts orders them — the
            chats on one clock, then the channels — and returns DESCRIPTORS
            rather than rows, so each kind is still drawn by the component
            that knows how. Under All each section is headed, the way Discord
            heads its DMs and its channels; under a filter the strip already
            says which one this is. */}
        {shown.map((entry, i) => {
          const head = snap.filter === 'all' && (i === 0 || shown[i - 1].section !== entry.section)
            ? <h3 key={`head-${entry.section}`} className="messages-section-head" data-inbox-section={entry.section}>{SECTION_LABELS[entry.section]}</h3>
            : null;
          const row = inboxRow(entry);
          return head ? [head, row] : row;
        })}
      </div>
    </section>
  );

  function inboxRow(entry: { kind: string; key: string }) {
    if (entry.kind === 'channel') {
      const conversation = byConversation.get(entry.key.slice('channel:'.length));
      return conversation
        ? <GeneralChannelRow key={entry.key} conversation={conversation} active={snap.route.conversationId === conversation.id} />
        : null;
    }
    if (entry.kind === 'person') {
      const conversation = byConversation.get(entry.key.slice('person:'.length));
      return conversation
        ? <ConversationRow key={entry.key} conversation={conversation} active={snap.route.conversationId === conversation.id} />
        : null;
    }
    if (entry.kind === 'app') {
      const discussion = byApp.get(entry.key.slice('app:'.length));
      return discussion ? <AppChannelRow key={entry.key} discussion={discussion} active={snap.route.appSlug === discussion.slug} /> : null;
    }
    if (entry.kind === 'session') {
      const session = bySession.get(entry.key.slice('session:'.length));
      const open = snap.route.agent;
      return session
        ? <AgentSessionRow key={entry.key} session={session} active={open?.kind === 'session' && open.id === session.id} />
        : null;
    }
    const agent = byAgent.get(entry.key.slice('agent:'.length));
    const open = snap.route.agent;
    return agent
      ? <AgentChatRow key={entry.key} chat={agent} active={open?.kind === 'chat' && open.id === agent.id} />
      : null;
  }
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
    if (!peer || !window.confirm(`Block @${peer.username}? Their messages in shared chats and app discussions will be hidden, and they won’t be able to message you directly.`)) return;
    const conversationId = active?.id;
    if (!conversationId) return;
    setBusy(true);
    try { await setUserBlocked(peer.id, true); }
    catch (err) { window.PlatformUI?.toast?.(err instanceof Error ? err.message : 'Couldn’t block this user.'); }
    finally { setBusy(false); setMenu(false); }
  }
  const channel = active.kind === 'channel';
  const subtitle = channel
    ? `Everyone on Homeroom · ${active.memberCount} ${active.memberCount === 1 ? 'member' : 'members'}`
    : active.kind === 'group'
      ? `${active.memberCount} members${active.myRole === 'owner' ? ' · you own this group' : ''}`
      : active.membershipStatus === 'invited' ? 'Invitation pending' : 'Direct message';
  return (
    <header className="messages-thread-header">
      {channel
        ? <span className="messages-inbox-tile messages-channel-tile messages-thread-channel-tile" aria-hidden="true">#</span>
        : <UserAvatar user={active.kind === 'direct' ? peer : null} title={active.title} shape="square" />}
      <button type="button" className="min-w-0 text-left flex-1" onClick={() => active.kind === 'group' && openDialog('messagesMembers')}>
        <div className="messages-thread-name">{active.kind === 'direct' && peer ? `@${peer.username}` : channel ? `#${active.channelKey || active.title}` : active.title}</div>
        <div className="messages-thread-sub">{subtitle}</div>
      </button>
      {active.kind === 'group' ? <button type="button" onClick={() => openDialog('messagesMembers')} className="messages-thread-action" aria-label="Group members" title="Group members"><UserGroupIcon aria-hidden="true" /></button> : null}
      <div className="relative"><button type="button" onClick={() => setMenu((open) => !open)} className="messages-thread-action" aria-label="Conversation actions" aria-expanded={menu}><EllipsisHorizontalIcon aria-hidden="true" /></button>{menu ? <div className="messages-thread-menu">{active.kind === 'group' ? <button type="button" onClick={() => { setMenu(false); openDialog('messagesMembers'); }}>Members &amp; invitations</button> : active.kind === 'direct' ? <button type="button" disabled={busy || !peer} onClick={() => void blockPeer()} className="text-red-700 dark:text-red-400">Block @{peer?.username}</button> : null}<button type="button" onClick={() => { setMenu(false); void loadConversations(true); }}>Refresh conversation</button></div> : null}</div>
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

/**
 * An app's general discussion, as a thread of this inbox (#2718 review).
 *
 * ── Why it is mounted rather than rendered ────────────────────────────
 *
 * The transcript, its composer, the @mention and #ref autocompletes, the
 * spec side panel, the drafts and the attachment wiring are all
 * public/js/group-chat.js and features/group-chat/. That is one surface
 * with one owner, and re-implementing it here would be a second copy of a
 * thing that is loaded, merged and invalidated elsewhere — the same reason
 * the agent chats are read from their own store rather than copied into
 * this one. So this renders a HOST and asks the owner to fill it.
 *
 * ── The app travels with the mount ────────────────────────────────────
 *
 * `AppView.renderGroupChatTab` used to read the app out of AppView.appData,
 * which is the app view's state. This screen is not the app view and does
 * not open one, so it passes the app in instead — see that function's note
 * and GroupChat._app. Nothing here writes AppView's state.
 *
 * ── It waits for `readOnly` ───────────────────────────────────────────
 *
 * The row carries the app's name but not whether this viewer may write; the
 * store fetches that (`discussionContext`). Mounting before it lands would
 * draw a composer and then take it away, or the reverse — so the pane holds
 * on a skeleton until the answer is here.
 */
function AppDiscussionThread({ slug }: { slug: string }) {
  const snap = useMessagesSnapshot();
  const host = useRef<HTMLDivElement | null>(null);
  const context = snap.discussionContext;
  const ready = !!context && context.slug === slug;
  const name = ready ? context.name : slug;
  const readOnly = ready ? context.readOnly : false;
  // The channel's `#handle`, from the list row when the viewer is a member.
  const handle = snap.discussions.find((item) => item.slug === slug)?.channel || null;

  useEffect(() => {
    const el = host.current;
    if (!el || !ready) return undefined;
    const view = (window as any).AppView;
    const chat = (window as any).UsernodeReact?.groupChat;
    // OUT OF REACT'S COMMIT (#2783). renderGroupChatTab mounts the chat as a
    // portal and then, on its next line, looks up `#gc-input` to wire the
    // composer — send on Enter, drafts, the @ and # menus. The portal is
    // published inside flushSync, which cannot flush while React is still
    // committing this effect, so the input did not exist yet and the
    // composer of a channel opened here was never wired: nothing typed in it
    // sent. A macrotask later the commit is over and the portal lands at once.
    let live = true;
    const timer = window.setTimeout(() => {
      if (live) view?.renderGroupChatTab?.({ host: el, slug, name, readOnly });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      // BOTH PORTALS, and the transcript's first: it points INTO #gc-messages
      // inside the pane, and a portal left pointing at a detached node keeps
      // its subtree and its store subscription alive (rule 1 in
      // lib/legacy-portals.tsx, and the same order renderGroupChatTab
      // observes when it re-renders).
      const list = el.querySelector('#gc-messages');
      if (list) chat?.unmountTranscript?.(list);
      chat?.unmountGeneralChat?.(el);
    };
  }, [slug, ready, name, readOnly]);

  if (snap.discussionError) {
    return (
      <section className="flex messages-thread-pane messages-no-selection" aria-label={name}>
        <h2>This discussion could not be opened.</h2>
        <p>It may have been removed, or you may not be a member of that app.</p>
      </section>
    );
  }
  return (
    <section
      className="flex messages-thread-pane messages-thread-discussion"
      aria-label={name}
      data-discussion-app={slug}
    >
      {/* THE PANE SAYS WHOSE DISCUSSION IT IS. On the app view this screen
          did not need one — the bar above it named the app — but here the
          bar says "Messages", and the group chat's own intro banner shows
          once per browser and then never again. The conversation pane beside
          it carries the same row (ThreadHeader). */}
      <header className="messages-thread-header">
        <span
          data-icon={appIconKind({ name } as never)}
          className="app-icon-tile messages-inbox-tile"
          aria-hidden="true"
        >
          <AppIconContent app={{ name } as never} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="messages-thread-name block">{name}</span>
          <span className="messages-thread-sub block">{handle ? `#${handle} · ` : ''}Everyone building this app</span>
        </span>
      </header>
      {/* NO `dc-lift dc-lift-session` HERE, unlike the conversation pane
          beside it: features/group-chat/general-chat.tsx opens with exactly
          that pair, so the sheet is drawn once, inside. What this section
          contributes is the BOX — `.messages-thread-pane`'s margins put the
          sheet on the strip with the shoulder showing, the same geometry a
          conversation gets. `platform-kb-column` is inside too, on the chat
          pane, for the same reason.

          The host's class string is constant and its subtree is entirely
          group-chat's: the one-owner rule satisfied at this boundary rather
          than at a node within it. */}
      <div ref={host} className="messages-discussion-host flex-1 min-h-0" />
    </section>
  );
}

/**
 * A global agent chat, as a thread of this inbox (#2813).
 *
 * ── Rendered, not mounted ─────────────────────────────────────────────
 *
 * Unlike an app's discussion and a dev session, this chat is React already:
 * features/global-chat is a store and a component tree, so the pane draws
 * the chat's own panel (`GlobalChatPanel`) rather than hosting a legacy
 * surface. It is the SAME panel the chat's screen draws, reading the same
 * store — one transcript, loaded and invalidated in one place.
 *
 * ── The store is told who is drawing it ───────────────────────────────
 *
 * `host: 'messages'` is what makes New, delete-and-move-on and Close write
 * inbox addresses (`#messages/agent/<id>`, `#messages`) instead of taking
 * the viewer to the chat's own screen, and what hides that screen's copy of
 * the transcript while this one is up. Leaving the pane deactivates the chat
 * exactly as leaving its screen does — but only if the pane still owns it:
 * following a `#chat/<id>` link from here reopens the store for the screen
 * before this unmounts, and that open is not this pane's to undo.
 */
function AgentChatThread({ id }: { id: string }) {
  useEffect(() => {
    void openGlobalChat({ threadId: id, host: 'messages' });
    return () => {
      const current = getGlobalChatState();
      if (current.open && current.host === 'messages') deactivateGlobalChat();
    };
  }, [id]);
  return (
    <section
      className="flex messages-thread-pane dc-lift dc-lift-session messages-thread-agent"
      aria-label="Agent chat"
      data-agent-chat={id}
    >
      <GlobalChatPanel embedded />
    </section>
  );
}

/**
 * An app's dev session, as a thread of this inbox (#2813).
 *
 * ── Mounted, like a discussion ────────────────────────────────────────
 *
 * The session view — transcript, composer, header, venue, drafts, the spec
 * and staging panes — is DevChat's (features/dev-chat/dev-chat.js), one
 * surface with fixed ids and one owner. So the pane renders a HOST and asks
 * AppView to fill it (`AppView.mountSessionInHost`), the same arrangement
 * `AppDiscussionThread` makes with the group chat. The host's class string is
 * constant and React renders nothing inside it: its whole subtree is
 * DevChat's, which is the one-owner rule satisfied at this boundary.
 *
 * ── The side panes stay inside ────────────────────────────────────────
 *
 * The spec viewer and the staging preview are slots INSIDE the session view,
 * so they open inside this pane, docked beside the transcript, exactly as
 * they do in the app view. A viewer who wants the whole window for them has
 * the "Open full view" link in the pane's head, which is the session's own
 * address in the app.
 *
 * ── It says when it cannot open ───────────────────────────────────────
 *
 * The app view's fallback is its Board, which is not on this screen. A
 * session this viewer cannot open — and that has no published chat to read
 * instead — says so here, with the full-view link to try the app itself.
 */
function AgentSessionThread({ slug, id }: { slug: string; id: number }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const full = fullScreenAddress({ kind: 'session', slug, id });

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const view = (window as any).AppView;
    let live = true;
    setPhase('loading');
    // A macrotask later, for the reason AppDiscussionThread gives: the
    // session view is published into portals inside flushSync, which cannot
    // flush while React is still committing this effect.
    const timer = window.setTimeout(() => {
      if (!live || !view?.mountSessionInHost) return;
      Promise.resolve(view.mountSessionInHost(el, { slug, sessionId: id }))
        .then((result: string) => {
          if (!live || result === 'stale') return;
          setPhase(result === 'ready' ? 'ready' : 'unavailable');
        })
        .catch(() => { if (live) setPhase('unavailable'); });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      view?.unmountSessionHost?.(el);
    };
  }, [slug, id]);

  return (
    <section
      className="flex messages-thread-pane messages-thread-session"
      aria-label="Agent session"
      data-agent-session={`${slug}/${id}`}
    >
      <div className="messages-session-bar">
        <a className="messages-session-full" href={full}>Open full view</a>
      </div>
      {phase === 'unavailable' ? (
        <div className="messages-state messages-state-error">
          <p>This session could not be opened here.</p>
          <a href={full}>Open it in the app</a>
        </div>
      ) : null}
      {phase === 'loading' ? (
        <div className="messages-state"><span className="messages-spinner" />Loading session…</div>
      ) : null}
      <div ref={host} className="messages-session-host flex-1 min-h-0" hidden={phase === 'unavailable'} />
    </section>
  );
}

function ConversationThread() {
  const snap = useMessagesSnapshot();
  const channels = useChannelHandles();
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

  if (snap.route.appSlug) return <AppDiscussionThread slug={snap.route.appSlug} />;
  if (snap.route.agent?.kind === 'chat') return <AgentChatThread key={snap.route.agent.id} id={snap.route.agent.id} />;
  if (snap.route.agent?.kind === 'session') {
    const { slug, id } = snap.route.agent;
    return <AgentSessionThread key={`${slug}/${id}`} slug={slug} id={id} />;
  }
  if (!conversationId) return <section className="hidden md:flex messages-thread-pane messages-no-selection"><h2>Choose a conversation</h2><p>Your chats and channels open here.</p></section>;
  // The kind is on the SECTION — `messages-thread-direct`, `-group` or
  // `-channel` — so the scroller's class string below stays the one the
  // safe-area test pins. It no longer changes the rows' shape: every kind is
  // the same named-row transcript (#2783).
  const kind = snap.active?.kind || 'direct';
  const rows: ReactNode[] = [];
  let previousDay = '';
  let previous: ConversationMessage | null = null;
  for (const message of snap.messages) {
    const day = dayKey(message);
    if (day && day !== previousDay) {
      rows.push(<div key={`day-${day}`} className="messages-day" aria-hidden="true">{dayLabel(message)}</div>);
      previousDay = day;
    }
    // A failed or unsent row is its own line: it carries a status of its own.
    const grouped = !!previous && !previous.failed && !message.failed
      && groupsWithPrevious(
        { author: previous.sender.id, at: previous.createdAt },
        { author: message.sender.id, at: message.createdAt, reply: !!message.reply },
      );
    rows.push(<MessageRow key={message.clientKey || message.id} message={message} conversationId={conversationId} grouped={grouped} channels={channels} />);
    previous = message;
  }
  return (
    <section className={`flex messages-thread-pane platform-kb-column dc-lift dc-lift-session messages-thread-${kind}`} aria-label={snap.active?.title || 'Conversation'}>
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
  // THE CHANGES HALF ASKS FOR ITSELF TOO (#2770). The Improve store's list
  // is prefetched once per page when an app target is published, which a
  // viewer who lands on Messages first may not have had — and a list read
  // once at boot is stale by the time the inbox is opened. So opening
  // Messages reads it again; while it stays open, Improve's own
  // onSessionStateChanged keeps it fresh (it asks whether Messages is on
  // screen). Signed-in only: the endpoint is per-user, and a 401 in the
  // network log is a console error on the route.
  useEffect(() => {
    if (!snap.route.open || !window.App?.user) return;
    void Promise.resolve(Improve.loadSessions()).catch(() => {});
  }, [snap.route.open]);
  useEffect(() => { if (snap.route.open) syncChrome(); },
    // The DISCUSSION's two facts belong here for the same reason the
    // conversation's title does: on a phone this is what names the thread in
    // the bar and puts the chevron back to the list. Without them, opening a
    // discussion kept the previous thread's name.
    [snap.active?.title, snap.route.open, snap.route.conversationId,
      snap.route.appSlug, snap.route.agent, snap.discussionContext?.name]);
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
      <AgentAppDialog />
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
