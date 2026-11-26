/**
 * THE HUB'S DISCUSSION (owner, 26 Nov 2026): a project's #general, drawn on
 * its hub as posts with replies.
 *
 *   ┌ Discussion ─────────────────────────────────────────────┐
 *   │ Posts and replies from everyone in Lakeside Book Club    │
 *   │ (Y) [ Start a post…                               (↑) ]  │
 *   │ Sort by: Newest · Most replies                           │
 *   │ ┌──────────────────────────────────────────────────────┐ │
 *   │ │ (P) Priya  1:32 PM  •                  ◇ 2 replies    │ │
 *   │ │ I can host on the 14th if we start at 7. Who is in?   │ │
 *   │ │ [👍 4] [🎉 1]                                          │ │
 *   │ └─┬────────────────────────────────────────────────────┤ │
 *   │   │ (D) Dev  1:40 PM   In. I can bring four chairs.     │ │
 *   │   │ [ Reply in thread…                            (↑) ] │ │
 *   │   └─────────────────────────────────────────────────────┘ │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Each post is its own outlined box: one header line (face, name, time, a
 * blue dot when it is new to the viewer, and at the far end "N replies" in
 * the accent or a grey "Reply"), the words at body size, then its reaction
 * pills. Its replies hang in a second box joined under it, faintly tinted
 * and stepped in from the left: "View N earlier replies" when the thread is
 * long, the newest few as ordinary chat rows, then the reply field. A post
 * with no replies has no second box until somebody presses Reply.
 *
 * Reactions have no button of their own on the post: a pointer gets the
 * platform's hover bar (../../message-actions/action-bar.tsx) and a touch
 * screen the long-press sheet (../../message-actions/action-sheet.tsx), the
 * same two every chat row has.
 *
 * Three drawings of one feed (./discussion-feed.ts):
 *   - `full`, the hub's card: on a wide window the right of the hub's two
 *     columns, under 1024px the card after For you (app.css, THE HUB IN TWO
 *     COLUMNS);
 *   - `preview`, a phone's card: the newest few posts, a line each, with their
 *     reply counts; it opens the page;
 *   - `page`, the Discussion whole: the place the places list's Discussion
 *     row opens (`posts`, ./places.ts) and the phone's card goes to.
 *
 * Discussion takes #general's place on the hub, so For you has no #general
 * row while this card is drawn (./hub-cards.tsx ForYouCard `discussionHere`).
 *
 * ── #general IS THE DISCUSSION (part 2, 26 Nov 2026) ──────────────────
 *
 * The places list's #general row is the Discussion row, which opens the
 * page. A door that names a message or a reply thread in #general (a
 * notification, a message link: AppView._landOnDiscussion) lands on the
 * page, which opens the post it is in, brings the message into view and
 * marks it (DiscussionFeed.place). What the posts do not show, an old
 * message's own thread or a message further back than PLACE_PAGES pages,
 * goes on to #general's chat with the same target (`onMissing`). The chat
 * is still the room's other drawing, one stream oldest to newest with files,
 * formatting and editing: the page's "Open as chat", and the channel's own
 * address. Its topics are untouched.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The hub mounts client-side and reads in effects: the first render is the
 * card's frame and its loading rows, never data.
 *
 * ── Live, and Most replies across the room (part 2) ───────────────────
 *
 * While it is on screen the feed holds the room's live events
 * (DiscussionSource.live): a project's chat socket, whose frames carry what
 * was said, or for Homeroom's #general the page's events socket, which
 * names what changed and is read again. A dropped socket, a tab away or the
 * browser offline reads it again (../../../lib/live-reads.ts), and so does
 * the window coming back into focus; REFRESH_MS is only a safety net.
 * "Most replies" is the server's ranking of every post since the fold
 * (DiscussionFeed.rankTo), not only the posts a page of the stream read.
 */

import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
} from 'react';

import { Button } from '@/components/ui/button';
import { ReactionPill } from '@/components/ui/feed';
import {
  ArrowUpIcon, BoldIcon, ChatsIcon, ChevronRightIcon, HeadingIcon, ItalicIcon, LinkIcon, ListBulletIcon, PaperClipIcon, QuoteIcon,
  ReplyArrowIcon, StrikethroughIcon, ThreadIcon, UnderlineIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { messageStamp, shortDate } from '../../../lib/timestamp';
import { enterSends, isTouchInput } from '../../../lib/enter-sends';
import { watch as watchLiveReads } from '../../../lib/live-reads';
import { cardRunLabel, cardRunStarts } from '../../../lib/card-runs';
import { useStoreState } from '../../../lib/use-store-state';
import { MAX_ATTACHMENTS, stageFiles } from '../../attachments/limits';
import { PendingStripRows, type PendingAttachmentView } from '../../attachments/pending-strip';
import { openReport } from '../../dialogs/report';
import { MessageActionBar, MessageMenu, placementFor, type MenuItem } from '../../message-actions/action-bar';
import { MessageActionSheet, useLongPress } from '../../message-actions/action-sheet';
import { toast } from '../../message-actions/clipboard';
import { messageMenu, messageSheet } from '../../message-actions/message-menu';
import { EmojiPicker } from '../../message-actions/emoji-picker';
import { emojiName } from '../../message-actions/emoji-data';
import { rememberReaction, useRecentReactions } from '../../message-actions/recents';
import { useDismiss } from '../../message-actions/use-dismiss';
import { Attachments } from '../../group-chat/transcript';
import type { Attachment } from '../../group-chat/transcript-store';
import { attachmentBadge } from '../../messages/attachment-views';
import { openAppTarget } from '../../messages/bot-shared';
import { CardHomeContext, MessageMarkdown, ObjectCard, UserAvatar, fileSize } from '../../messages/format';
import { applyFormat, type FormatKind } from '../../messages/composer-format';
import { LinkEmbeds } from '../../messages/link-cards';
import { channelHandles, setUserBlocked } from '../../messages/store';
import type { ConversationUser } from '../../messages/types';
import type { CommunityPayload } from './community-card';
import { ChannelMute } from './channel-head';
import {
  POSTS_SHOWN, PREVIEW_POSTS, REPLIES_SHOWN, appSource, publicSource, assemble, conversationSource, earlierFold, inEarlier, isNewTo, shownReplies,
  sortItems, toggledReactions,
  type DiscussionItem, type DiscussionPerson, type DiscussionSort, type DiscussionSource, type DiscussionSummary,
  type DiscussionReaction, type EarlierFold, type LiveEvent, type Said, type SharedSpec,
} from './discussion-feed';
import { takeDiscussionTarget, type DiscussionTarget } from './project-discussion';

/**
 * How often the card reads the room again while it is on screen: a safety
 * net, since the room's live events (DiscussionSource.live) bring what is
 * said as it is said, and a dropped socket or a page away reads it again.
 */
export const REFRESH_MS = 5 * 60_000;
/** Live events this close together are read again once. */
const STALE_MS = 300;
/** At most this many older posts with a new reply are brought in by one read. */
const ACTIVE_ROOTS_READ = 5;
/** Older pages of the room a door's message is looked for in; past them the page opens at its top. */
export const PLACE_PAGES = 10;
/** How long a message a door named stays marked. */
const FOCUS_MS = 2400;

/** Where a door's message is on the Discussion: the post it is drawn in. */
export interface Placed { key: string; messageId: number }

type Channel = NonNullable<CommunityPayload['channel']>;

// ── The feed: what one room has read, shared by the card and the page ──

interface FeedState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  messages: ReadonlyMap<number, Said>;
  /** The oldest main-stream message read: where the next older page starts. */
  oldest: number | null;
  /** The room has older messages than `oldest`. */
  more: boolean;
  /** Where the viewer's reading stood when the room was first read. */
  readId: number | null;
  /** Threads read whole (a post's "View N earlier replies"). */
  opened: ReadonlySet<number>;
  /** A read of older posts, or of a thread, is under way. */
  busy: boolean;
  /** "Most replies": the posts the server ranked so far, busiest first, read in. */
  ranked: readonly number[];
  /** The ranking has more posts after `ranked`. */
  rankedMore: boolean;
  /** The Earlier post's reactions as the viewer last changed them; null: as the summary says. */
  earlierReactions: DiscussionReaction[] | null;
}

const EMPTY: FeedState = {
  status: 'idle', messages: new Map(), oldest: null, more: false, readId: null, opened: new Set(), busy: false,
  ranked: [], rankedMore: true, earlierReactions: null,
};

export class DiscussionFeed {
  source: DiscussionSource;
  summary: DiscussionSummary | null;
  /** The viewer's username, which the room's reactions are read against. */
  viewer: { current: string | null };
  private state: FeedState = EMPTY;
  private listeners = new Set<() => void>();
  private holders = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private marked = 0;
  /** The first read, while it runs and once it has: what a door waits for. */
  private loaded: Promise<void> | null = null;
  /** The room's live events, and the page's own "read it again", while the feed is held. */
  private stopLive: (() => void) | null = null;
  private stale: ReturnType<typeof setTimeout> | null = null;
  private staleRoots = new Set<number>();
  /** A "Most replies" read under way. */
  private ranking: Promise<void> | null = null;

  constructor(source: DiscussionSource, summary: DiscussionSummary | null, viewer: { current: string | null }) {
    this.source = source;
    this.summary = summary;
    this.viewer = viewer;
  }

  get me(): string | null {
    return this.viewer.current;
  }

  get = (): FeedState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(next: Partial<FeedState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  private merge(list: ReadonlyArray<Said>, extra: Partial<FeedState> = {}): void {
    const messages = new Map(this.state.messages);
    for (const said of list) messages.set(said.id, said);
    this.set({ ...extra, messages });
  }

  fold(): EarlierFold | null {
    const fold = earlierFold(this.summary);
    return fold && this.state.earlierReactions ? { ...fold, reactions: this.state.earlierReactions } : fold;
  }

  /** Toggle the viewer's reaction on the Earlier post (its own anchor): drawn at once, then as the server answers. */
  async reactEarlier(emoji: string): Promise<void> {
    const fold = this.fold();
    if (!fold) return;
    const was = fold.reactions;
    const on = !was.some((r) => r.emoji === emoji && r.reacted);
    this.set({ earlierReactions: toggledReactions(was, emoji, this.me) });
    const answer = await this.source.reactEarlier(emoji, on).catch(() => null);
    this.set({ earlierReactions: answer || was });
  }

  /** The posts, as read so far. */
  items(): DiscussionItem[] {
    const fold = this.fold();
    const earlierRead = fold ? [...this.state.messages.values()].filter((m) => m.rootId == null && m.id <= fold.lastId).length : 0;
    return assemble([...this.state.messages.values()], fold, !!fold && earlierRead < fold.count && this.state.more);
  }

  /** Whether "Show more posts" can read further back. */
  morePosts(): boolean {
    const fold = this.fold();
    if (!this.state.more) return false;
    return !(fold && this.state.oldest != null && this.state.oldest <= fold.lastId);
  }

  /**
   * Hold the feed while a card shows it: it is read once, then kept as the
   * room says things (its live events), read again after a gap (the page's
   * live reads: a dropped socket, a tab away) and every REFRESH_MS.
   */
  hold(): () => void {
    this.holders += 1;
    if (this.state.status === 'idle' || this.state.status === 'error') void this.load();
    if (!this.timer && typeof window !== 'undefined') {
      this.timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        void this.refresh();
      }, REFRESH_MS);
      const stopSource = this.source.live((event) => this.heard(event));
      const stopReads = watchLiveReads(() => this.refresh());
      this.stopLive = () => { stopSource(); stopReads(); };
    }
    return () => {
      this.holders -= 1;
      if (this.holders <= 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.stopLive?.();
        this.stopLive = null;
      }
    };
  }

  /**
   * What the room said live, drawn as it lands: a post or a reply (its
   * post's count moves with it), a thread's count, an edit, the reactions
   * on a message, a message taken back. A room that says only what changed
   * (`stale`) is read again, once for a burst.
   */
  heard(event: LiveEvent): void {
    if (this.state.status !== 'ready') return;
    const messages = this.state.messages;
    switch (event.kind) {
      case 'said': {
        const known = messages.has(event.said.id);
        const updates: Said[] = [known ? { ...messages.get(event.said.id) as Said, content: event.said.content } : event.said];
        const root = event.said.rootId != null ? messages.get(event.said.rootId) : null;
        if (root && !known) updates.push({ ...root, replyCount: root.replyCount + 1, lastReplyAt: event.said.at });
        this.merge(updates);
        return;
      }
      case 'thread': {
        const root = messages.get(event.rootId);
        if (root) this.merge([{ ...root, replyCount: event.replyCount, lastReplyAt: event.lastReplyAt }]);
        return;
      }
      case 'edit': {
        const said = messages.get(event.id);
        if (said) this.merge([{ ...said, content: event.content }]);
        return;
      }
      case 'reactions': {
        const said = messages.get(event.id);
        if (said) this.merge([{ ...said, reactions: event.reactions }]);
        return;
      }
      case 'gone': {
        const said = messages.get(event.id);
        if (said) this.merge([{ ...said, deleted: true, content: '', reactions: [] }]);
        return;
      }
      default: {
        const said = event.messageId != null ? messages.get(event.messageId) : null;
        const root = event.rootId ?? said?.rootId ?? null;
        if (root != null && messages.has(root)) this.staleRoots.add(root);
        if (this.stale) return;
        this.stale = setTimeout(() => {
          this.stale = null;
          const roots = [...this.staleRoots];
          this.staleRoots.clear();
          void Promise.all([this.refresh(), ...roots.map((id) => this.readThread(id, this.state.opened.has(id)))]);
        }, STALE_MS);
      }
    }
  }

  /**
   * "Most replies" across the whole room: the server's ranking of the posts
   * since the fold, read in until `count` of them are here (each one's
   * thread, so its newest replies show). Where the ranking cannot be read,
   * the posts already here are sorted as they are.
   */
  rankTo(count: number): Promise<void> {
    if (this.ranking) return this.ranking;
    this.ranking = (async () => {
      const fold = this.fold();
      while (this.state.status === 'ready' && this.state.rankedMore && this.state.ranked.length < count) {
        let page: { ids: number[]; more: boolean };
        try {
          page = await this.source.ranked(fold ? fold.lastId : 0, this.state.ranked.length, POSTS_SHOWN);
        } catch {
          this.set({ rankedMore: false });
          break;
        }
        const all = [...this.state.messages.values()];
        const missing = page.ids.filter((id) => {
          const said = this.state.messages.get(id);
          if (!said) return true;
          const have = all.filter((m) => m.rootId === id).length;
          return have < Math.min(said.replyCount, REPLIES_SHOWN);
        });
        await Promise.all(missing.map((id) => this.readThread(id, false)));
        this.set({ ranked: [...this.state.ranked, ...page.ids], rankedMore: page.more && page.ids.length > 0 });
      }
    })().finally(() => { this.ranking = null; });
    return this.ranking;
  }

  load(): Promise<void> {
    this.loaded = this.readFirst();
    return this.loaded;
  }

  private async readFirst(): Promise<void> {
    this.set({ status: 'loading' });
    try {
      const page = await this.source.page(null);
      if (page.summary) this.summary = page.summary;
      const readId = page.readId ?? await this.source.readPosition();
      this.state = { ...EMPTY, opened: this.state.opened, status: 'ready', readId };
      this.staleRoots.clear();
      this.merge(page.messages, { oldest: oldestMain(page.messages), more: page.more, status: 'ready' });
      await this.fillIn();
    } catch {
      this.set({ status: 'error' });
    }
  }

  /** Read the room's newest page again, keeping what is already read. */
  async refresh(): Promise<void> {
    if (this.state.status !== 'ready') return;
    try {
      const page = await this.source.page(null);
      this.merge(page.messages);
      await this.fillIn(true);
    } catch { /* the next read tries again */ }
  }

  /**
   * What a page of the stream does not carry by itself: the newest old
   * messages of a folded history, the replies of the posts on show (a room
   * whose stream holds no replies), what was written into the Earlier post,
   * and an older post that has a new reply.
   */
  private async fillIn(again = false): Promise<void> {
    const fold = this.fold();
    const all = [...this.state.messages.values()];
    const reads: Promise<unknown>[] = [];
    if (fold && !all.some((m) => m.rootId == null && m.id <= fold.lastId)) {
      reads.push(this.source.page(fold.lastId + 1).then((page) => {
        this.merge(page.messages, { oldest: Math.min(this.state.oldest ?? Infinity, oldestMain(page.messages) ?? Infinity), more: page.more });
      }).catch(() => {}));
    }
    if (fold && (!again || !this.source.streamHoldsReplies)) reads.push(this.readThread(fold.lastId, false));
    if (!this.source.streamHoldsReplies) {
      const roots = all.filter((m) => m.rootId == null && m.replyCount > 0 && !inEarlier(m, fold))
        .sort((a, b) => b.id - a.id).slice(0, POSTS_SHOWN);
      for (const root of roots) {
        const have = all.filter((m) => m.rootId === root.id).length;
        if (!again || have < root.replyCount) reads.push(this.readThread(root.id, false));
      }
    } else {
      const known = new Set(all.filter((m) => m.rootId == null).map((m) => m.id));
      const missing = [...new Set(all.filter((m) => m.rootId != null && !known.has(m.rootId) && !inEarlier(m, fold)).map((m) => m.rootId as number))]
        .sort((a, b) => b - a).slice(0, ACTIVE_ROOTS_READ);
      for (const rootId of missing) reads.push(this.readThread(rootId, false));
    }
    await Promise.all(reads);
  }

  /** Reads a post's thread into the feed; answers the id of the root it read, or null. */
  private async readThread(rootId: number, open: boolean, all = false): Promise<number | null> {
    try {
      const thread = await this.source.thread(rootId, all);
      const list = thread.root ? [thread.root, ...thread.replies] : thread.replies;
      const opened = open ? new Set([...this.state.opened, rootId]) : this.state.opened;
      this.merge(list, { opened });
      return thread.root?.id ?? rootId;
    } catch { return null; /* drawn as it was */ }
  }

  /** "View N earlier replies" on a post: its thread, opened; `all` ("Show all replies") reads a very long one whole. */
  async openThread(rootId: number, all = false): Promise<void> {
    this.set({ busy: true });
    await this.readThread(rootId, true, all);
    this.set({ busy: false });
  }

  /**
   * An older message's own replies, inside the Earlier post: shown under it
   * (read the first time), or hidden again. There is no chat to open them in.
   */
  async toggleOld(rootId: number): Promise<void> {
    if (this.state.opened.has(rootId)) {
      const opened = new Set(this.state.opened);
      opened.delete(rootId);
      this.set({ opened });
      return;
    }
    await this.readThread(rootId, true);
  }

  /** The live replies under one message, oldest first. */
  repliesOf(rootId: number): Said[] {
    return [...this.state.messages.values()].filter((m) => m.rootId === rootId && !m.deleted).sort((a, b) => a.id - b.id);
  }

  /** "View N earlier replies" on the Earlier post: the next older page of the history. */
  async openEarlier(): Promise<void> {
    const fold = this.fold();
    if (!fold) return;
    const oldestEarlier = Math.min(...[...this.state.messages.values()].filter((m) => m.rootId == null && m.id <= fold.lastId).map((m) => m.id));
    this.set({ busy: true, opened: new Set([...this.state.opened, fold.lastId]) });
    try {
      const page = await this.source.page(Number.isFinite(oldestEarlier) ? oldestEarlier : fold.lastId + 1);
      this.merge(page.messages, { oldest: Math.min(this.state.oldest ?? Infinity, oldestMain(page.messages) ?? Infinity), more: page.more });
    } catch { /* drawn as it was */ }
    this.set({ busy: false });
  }

  /** "Show more posts": the next older page of the stream. */
  async morePostsRead(): Promise<void> {
    if (!this.morePosts() || this.state.oldest == null) return;
    this.set({ busy: true });
    try {
      const page = await this.source.page(this.state.oldest);
      this.merge(page.messages, { oldest: oldestMain(page.messages) ?? this.state.oldest, more: page.more });
      await this.fillIn(true);
    } catch { /* drawn as it was */ }
    this.set({ busy: false });
  }

  /** Write a post or a reply, with the files already taken in; it is on the card when the answer lands. */
  async write(content: string, rootId: number | null, attachmentIds: string[] = []): Promise<void> {
    const said = await this.source.post(content, rootId, attachmentIds);
    if (!said) { await this.refresh(); return; }
    const updates: Said[] = [said];
    if (rootId) {
      const root = this.state.messages.get(rootId);
      if (root) updates.push({ ...root, replyCount: root.replyCount + 1, lastReplyAt: said.at });
    }
    this.merge(updates);
  }

  /** Edit your own message: the room's words once it has kept them. */
  async edit(messageId: number, content: string): Promise<void> {
    const words = await this.source.edit(messageId, content);
    const said = this.state.messages.get(messageId);
    if (said) this.merge([{ ...said, content: words }]);
  }

  /** Delete your own message: a post stays as "deleted" while it has replies, a reply leaves. */
  async remove(messageId: number): Promise<void> {
    await this.source.remove(messageId);
    const said = this.state.messages.get(messageId);
    if (said) this.merge([{ ...said, deleted: true, content: '', reactions: [] }]);
  }

  /** Toggle the viewer's reaction: drawn at once, then as the room answers. */
  async react(messageId: number, emoji: string): Promise<void> {
    const said = this.state.messages.get(messageId);
    if (!said) return;
    const was = said.reactions.find((r) => r.emoji === emoji);
    const on = !(was && was.reacted);
    this.merge([{ ...said, reactions: toggledReactions(said.reactions, emoji, this.me) }]);
    const answer = await this.source.react(messageId, emoji, on);
    const now = this.state.messages.get(messageId);
    if (!now) return;
    this.merge([{ ...now, reactions: answer || said.reactions }]);
  }

  /**
   * Where the message a door named is on the Discussion, read far enough
   * back to draw it: its post, with the replies box open when it is a reply
   * or the door named the thread. Null when the posts do not show it (an old
   * message's own thread, one further back than PLACE_PAGES pages, one gone),
   * for #general's chat to take.
   */
  async place(target: Pick<DiscussionTarget, 'threadRootId' | 'focusMessageId'>): Promise<Placed | null> {
    await (this.loaded || this.load());
    if (this.state.status !== 'ready') return null;
    const rootId = target.threadRootId || null;
    let wanted = target.focusMessageId || rootId;
    if (!wanted) return null;
    const have = () => this.state.messages.get(wanted as number) || null;
    if (rootId && !have()) {
      // The server may answer a demo address's thread by its stored root
      // (staging's fixtures), whose id is then the one to find.
      const read = await this.readThread(rootId, false);
      if (read && wanted === rootId) wanted = read;
    }
    for (let i = 0; !have() && i < PLACE_PAGES && this.state.more && this.state.oldest != null; i += 1) {
      try {
        const page = await this.source.page(this.state.oldest);
        this.merge(page.messages, { oldest: oldestMain(page.messages) ?? this.state.oldest, more: page.more });
      } catch { break; }
    }
    const said = have();
    if (!said) return null;
    if (said.rootId != null && !this.state.messages.has(said.rootId)) await this.readThread(said.rootId, false);
    const item = this.items().find((it) => (it.kind === 'post' && it.root.id === said.id) || it.replies.some((r) => r.id === said.id));
    if (!item) {
      // A reply to an older message: it is under that message inside the
      // Earlier post, which opens, and so do the older message's replies.
      const fold = this.fold();
      const root = said.rootId != null ? this.state.messages.get(said.rootId) : null;
      const earlier = this.items().find((it) => it.kind === 'earlier');
      if (!fold || !root || root.rootId != null || root.id > fold.lastId || !earlier) return null;
      this.set({ opened: new Set([...this.state.opened, fold.lastId, root.id]) });
      return { key: earlier.key, messageId: said.id };
    }
    const asReply = item.kind === 'earlier' || item.root.id !== said.id;
    if (asReply || rootId) {
      const open = item.kind === 'post' ? item.root.id : item.fold.lastId;
      if (item.kind === 'post' && item.replies.length < item.replyCount) await this.readThread(open, true);
      else this.set({ opened: new Set([...this.state.opened, open]) });
    }
    // A link to an older message's own thread: its replies open under it,
    // inside the Earlier post (they were read above).
    if (item.kind === 'earlier' && rootId && said.rootId == null) this.set({ opened: new Set([...this.state.opened, said.id]) });
    return { key: item.key, messageId: said.id };
  }

  /** The viewer has seen the room up to its newest post: their reading moves there, once. */
  markSeen(): void {
    const newest = Math.max(0, ...[...this.state.messages.values()].filter((m) => m.rootId == null).map((m) => m.id));
    if (!newest || newest <= (this.state.readId || 0) || newest <= this.marked) return;
    this.marked = newest;
    void this.source.markRead(newest).catch(() => {});
  }
}

function oldestMain(list: ReadonlyArray<Said>): number | null {
  const ids = list.filter((m) => m.rootId == null).map((m) => m.id);
  return ids.length ? Math.min(...ids) : null;
}

const feeds = new Map<string, DiscussionFeed>();

/** The source a channel is read from: Homeroom's #general conversation, or the app's own chat. */
export function sourceFor(slug: string, channel: Channel, viewer: { current: string | null }): DiscussionSource {
  if (isVisitorChannel(channel)) return publicSource(slug);
  const conversationId = Number((channel as { conversation_id?: unknown }).conversation_id) || null;
  return conversationId ? conversationSource(conversationId, slug) : appSource(slug, viewer);
}

function sourceKey(slug: string, channel: Channel): string {
  if (isVisitorChannel(channel)) return `public:${slug}`;
  const conversationId = Number((channel as { conversation_id?: unknown }).conversation_id) || null;
  return conversationId ? `conversation:${conversationId}` : `app:${slug}`;
}

/** The channel a visitor's page hands the card (visitorData): read through the public routes. */
function isVisitorChannel(channel: Channel): boolean {
  return !!(channel as { visitor?: unknown }).visitor;
}

/**
 * What the signed-out project page hands the card in place of a member's
 * community record: a channel to read through the public routes, whose
 * summary rides with the first page.
 */
export function visitorData(slug: string): CommunityPayload {
  return { slug, channel: { visitor: true, discussion: null } } as unknown as CommunityPayload;
}

/** The one feed of a channel, shared by its hub card and its page. */
export function feedFor(slug: string, channel: Channel, me: string | null): DiscussionFeed {
  const summary = (channel as { discussion?: DiscussionSummary | null }).discussion || null;
  let feed = feeds.get(sourceKey(slug, channel));
  if (!feed) {
    const viewer = { current: me };
    feed = new DiscussionFeed(sourceFor(slug, channel, viewer), summary, viewer);
    feeds.set(feed.source.key, feed);
  } else {
    // A visitor's summary rides with the first page, not the record.
    if (!isVisitorChannel(channel)) feed.summary = summary;
    feed.viewer.current = me;
  }
  return feed;
}

/** For tests: forget every feed. */
export function resetDiscussionFeedsForTest(): void {
  feeds.clear();
}

/** The phone's card asked for the page with its box ready to write in. */
let focusOnOpen = false;

// ── The viewer ─────────────────────────────────────────────────────────

interface Viewer { username: string; avatarUrl: string | null }

/** Who is reading, once the page has said (read in an effect: the first render has nobody). */
function useViewer(visitor = false): { viewer: Viewer | null; known: boolean } {
  const [seen, setSeen] = useState<{ viewer: Viewer | null; known: boolean }>({ viewer: null, known: false });
  useEffect(() => {
    // A visitor's page reads as nobody, whoever the shell may hold.
    if (visitor) { setSeen({ viewer: null, known: true }); return; }
    const user = (window as unknown as { App?: { user?: { username?: string; avatarUrl?: string | null } | null } }).App?.user;
    setSeen({ viewer: user && user.username ? { username: user.username, avatarUrl: user.avatarUrl || null } : null, known: true });
  }, [visitor]);
  return seen;
}

function asUser(who: DiscussionPerson): ConversationUser {
  return { id: who.id || 0, username: who.username, avatarUrl: who.avatarUrl || null, bot: !!who.bot, displayName: who.displayName };
}

function nameOf(who: DiscussionPerson): string {
  return who.bot && who.displayName ? who.displayName : who.username;
}

// ── The card ───────────────────────────────────────────────────────────

export interface DiscussionCardProps {
  slug: string;
  /** The project's name, for the line under the heading. */
  name: string;
  data: CommunityPayload | null;
  mode: 'full' | 'preview' | 'page';
  /** The phone's card: open the page. */
  onOpenPage?: () => void;
  /**
   * The signed-out project page (../../guest/guest-discussion.tsx): read
   * only, through the public routes (`data` is visitorData), and "Start a
   * post…" asks the visitor to sign in.
   */
  visitor?: { onSignIn: () => void } | null;
}

export function DiscussionCard({ slug, name, data, mode, onOpenPage, visitor = null }: DiscussionCardProps): ReactNode {
  const t = useMessages('project');
  useMessages('messages');
  const headId = useId();
  const { viewer, known } = useViewer(!!visitor);
  const channel = data?.channel || null;
  const me = viewer ? viewer.username : null;
  const feed = useMemo(() => (channel ? feedFor(slug, channel, me) : null), [slug, channel, me]);
  const host = useRef<HTMLElement | null>(null);
  const [focus, setFocus] = useState<Placed | null>(null);
  const focused = useCallback(() => setFocus(null), []);
  const signIn = useRef(visitor?.onSignIn);
  signIn.current = visitor?.onSignIn;
  const isVisitor = !!visitor;
  const homeroom = !!Number((channel as { conversation_id?: unknown } | null)?.conversation_id);
  const room = useMemo<Room>(() => ({ slug, visitor: isVisitor, signIn: () => signIn.current?.(), homeroom }), [slug, isVisitor, homeroom]);

  // Read once the viewer is known, so their own reactions read as theirs.
  useEffect(() => (feed && known ? feed.hold() : undefined), [feed, known]);
  useEffect(() => {
    if (!feed) return undefined;
    const again = () => { if (document.visibilityState !== 'hidden') void feed.refresh(); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [feed]);
  // The page takes a door's target (AppView._stashDiscussionTarget): when it
  // mounts, and when a door is followed while it is up.
  useEffect(() => {
    if (mode !== 'page' || !feed || !known) return undefined;
    let gone = false;
    const room = Number((channel as { conversation_id?: unknown } | null)?.conversation_id) || null;
    const take = () => {
      const target = takeDiscussionTarget(slug, null);
      if (!target || !(target.threadRootId || target.focusMessageId)) return;
      // A message of another room than the one this page reads (an old
      // conversation, a demo's) has no post here: the page opens at its top.
      if (target.conversationId && room && target.conversationId !== room) return;
      void feed.place(target).then((found) => {
        if (!gone && found) setFocus(found);
      });
    };
    take();
    const heard = (event: Event) => {
      if ((event as CustomEvent<{ slug?: string }>).detail?.slug === slug) take();
    };
    window.addEventListener('usernode:workshop-discussion', heard);
    return () => { gone = true; window.removeEventListener('usernode:workshop-discussion', heard); };
  }, [mode, feed, known, slug, channel]);

  if (!channel || !feed) {
    // The place itself says why there is nothing: still reading the project,
    // or a viewer who may not read its Discussion.
    if (mode !== 'page') return null;
    return (
      <div className="dev-ws-discussion-page" data-ws-discussion-page="">
        {data ? (
          <p className="dh-empty" data-ws-discussion-none="">{t('project:discussion.none')}</p>
        ) : (
          <section className="dev-ws-hub-section dev-ws-hub-discussion" data-ws-hub-discussion="page">
            <FeedLoading status="loading" onRetry={() => {}} rows={3} />
          </section>
        )}
      </div>
    );
  }
  const card = (
    <section
      ref={host}
      className="dev-ws-hub-section dev-ws-hub-discussion"
      data-ws-hub-discussion={mode}
      aria-labelledby={headId}
    >
      <RoomContext.Provider value={room}>
      <FeedView
        feed={feed}
        slug={slug}
        name={name}
        channel={channel}
        data={data}
        mode={mode}
        headId={headId}
        host={host}
        viewer={viewer}
        focus={focus}
        onFocused={focused}
        onOpenPage={onOpenPage}
      />
      </RoomContext.Provider>
    </section>
  );
  if (mode !== 'page') return card;
  return <div className="dev-ws-discussion-page" data-ws-discussion-page="">{card}</div>;
}

function FeedView({ feed, slug, name, channel, data, mode, headId, host, viewer, focus, onFocused, onOpenPage }: {
  feed: DiscussionFeed;
  slug: string;
  name: string;
  channel: Channel;
  /** The project's record, which says whether its Discussion is muted (Mute, in the page's head). */
  data: CommunityPayload | null;
  mode: DiscussionCardProps['mode'];
  headId: string;
  host: RefObject<HTMLElement | null>;
  viewer: Viewer | null;
  /** The message a door named, to bring into view and mark once. */
  focus: Placed | null;
  onFocused: () => void;
  onOpenPage?: () => void;
}): ReactNode {
  const t = useMessages('project');
  const room = useContext(RoomContext);
  const state = useStoreState(feed);
  const [sort, setSort] = useState<DiscussionSort>('newest');
  const [limit, setLimit] = useState(POSTS_SHOWN);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(() => sortItems(feed.items(), mode === 'preview' ? 'newest' : sort), [feed, state, sort, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const startRef = useRef<HTMLTextAreaElement | null>(null);

  // Seen once it is on screen: the viewer's reading moves to its newest post.
  useEffect(() => {
    if (state.status !== 'ready' || mode === 'preview') return undefined;
    const node = host.current;
    if (!node || typeof IntersectionObserver !== 'function') { feed.markSeen(); return undefined; }
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) feed.markSeen();
    });
    watch.observe(node);
    return () => watch.disconnect();
  }, [feed, state, mode, host]);

  // "Most replies" ranks the whole room: the server's busiest posts are read
  // in as far down as the list shows.
  useEffect(() => {
    if (sort !== 'replies' || mode === 'preview' || state.status !== 'ready') return;
    void feed.rankTo(limit);
  }, [feed, sort, mode, limit, state.status]);

  // The phone's card asked for the box: it is ready to write in.
  useEffect(() => {
    if (mode !== 'page' || !focusOnOpen) return;
    focusOnOpen = false;
    startRef.current?.focus({ preventScroll: false });
  }, [mode]);

  // A door's message: its post drawn (the list grows to it), then brought
  // into view and marked for a moment.
  const [marked, setMarked] = useState<number | null>(null);
  useEffect(() => {
    if (!focus) return;
    const at = items.findIndex((item) => item.key === focus.key);
    if (at >= limit) { setLimit(at + 1); return; }
    const node = host.current?.querySelector(`[data-ws-discussion-message="${focus.messageId}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: 'center' });
    setMarked(focus.messageId);
    onFocused();
  }, [focus, items, limit, host, onFocused]);
  useEffect(() => {
    if (marked == null) return undefined;
    const clear = setTimeout(() => setMarked(null), FOCUS_MS);
    return () => clearTimeout(clear);
  }, [marked]);

  const head = (
    <div className="dev-ws-hub-discussion-head">
      <h2 id={headId} className="dev-ws-hub-discussion-title">{t('project:hub.discussion.title')}</h2>
      <p className="dev-ws-hub-discussion-about">{t('project:hub.discussion.about', { project: name })}</p>
      {/* #5303: Mute, at the end of the page's head (./channel-head.tsx). */}
      {mode === 'page' && !room.visitor ? <ChannelMute slug={slug} data={data} /> : null}
    </div>
  );

  if (mode === 'preview') {
    const open = (focus: boolean) => { focusOnOpen = focus; onOpenPage?.(); };
    const shown = items.slice(0, PREVIEW_POSTS);
    return (
      <>
        <button type="button" className="dh-preview-head" data-ws-discussion-open="" onClick={() => open(false)}>
          {head}
          <ChevronRightIcon className="dh-preview-go" aria-hidden="true" />
        </button>
        {state.status === 'ready' ? (
          shown.length ? (
            <ul className="dh-preview-list">
              {shown.map((item) => (
                <li key={item.key}>
                  <button type="button" className="dh-preview-row" data-ws-discussion-preview={item.key} onClick={() => open(false)}>
                    <PostHeader item={item} readId={state.readId} me={viewer?.username || null} />
                    <PostWords item={item} clamp />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="dh-empty" data-ws-discussion-empty="">{t('project:hub.discussion.empty')}</p>
        ) : <FeedLoading status={state.status} onRetry={() => void feed.load()} rows={2} />}
        {room.visitor ? <SignInDoor preview /> : (
          <button type="button" className="dh-composer dh-composer-door" data-ws-discussion-start-door="" onClick={() => open(true)}>
            <ViewerFace viewer={viewer} />
            <span className="dh-composer-hint">{t('project:hub.discussion.start.placeholder')}</span>
            <span className="dh-send" aria-hidden="true"><ArrowUpIcon /></span>
          </button>
        )}
      </>
    );
  }

  const shown = items.slice(0, limit);
  const runs = cardRunStarts(shown, isCardPost);
  const canMore = items.length > limit || (sort === 'replies' ? state.rankedMore : feed.morePosts());
  return (
    <>
      {head}
      {room.visitor ? <SignInDoor /> : (
        <Composer
          kind="post"
          boxRef={startRef}
          viewer={viewer}
          placeholder={t('project:hub.discussion.start.placeholder')}
          label={t('project:hub.discussion.start.label', { project: name })}
          sendLabel={t('project:hub.discussion.start.send')}
          onSend={(words, ids) => feed.write(words, null, ids)}
          upload={(file) => feed.source.upload(file)}
        />
      )}
      <div className="dh-sort" role="group" aria-label={t('project:hub.discussion.sort.label')} data-ws-discussion-sort={sort}>
        <span className="dh-sort-label" aria-hidden="true">{t('project:hub.discussion.sort.label')}</span>
        <button type="button" aria-pressed={sort === 'newest'} data-ws-discussion-sort-by="newest" onClick={() => setSort('newest')}>
          {t('project:hub.discussion.sort.newest')}
        </button>
        <button type="button" aria-pressed={sort === 'replies'} data-ws-discussion-sort-by="replies" onClick={() => setSort('replies')}>
          {t('project:hub.discussion.sort.replies')}
        </button>
      </div>
      {state.status !== 'ready' ? (
        <FeedLoading status={state.status} onRetry={() => void feed.load()} rows={3} />
      ) : shown.length ? (
        <div className="dh-list" data-ws-discussion-posts={String(shown.length)}>
          {shown.map((item, at) => {
            // #2884, as the chat drew it: a run of posts that only share a
            // card is its first card and "… N more", until opened.
            const runAt = [...runs.entries()].find(([start, length]) => at > start && at < start + length);
            if (runAt && !openRuns.has(shown[runAt[0]].key)) return null;
            const run = runs.get(at);
            const thread = <Thread key={item.key} item={item} feed={feed} slug={slug} channel={channel} viewer={viewer} readId={state.readId} busy={state.busy} opened={state.opened} marked={marked} />;
            if (!run || openRuns.has(item.key)) return thread;
            return (
              <div key={item.key} className="dh-card-run" data-ws-discussion-card-run={String(run)}>
                {thread}
                <Button
                  type="button"
                  variant="unstyled"
                  size="none"
                  ink="none"
                  className="dh-card-run-more"
                  data-ws-discussion-card-run-more=""
                  onClick={() => setOpenRuns((was) => new Set([...was, item.key]))}
                >
                  {cardRunLabel(run - 1)}
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="dh-empty" data-ws-discussion-empty="">{t('project:hub.discussion.empty')}</p>
      )}
      {state.status === 'ready' && canMore ? (
        <Button
          type="button"
          variant="unstyled"
          size="none"
          ink="none"
          className="dh-more-posts"
          data-ws-discussion-more=""
          disabled={state.busy}
          onClick={() => {
            setLimit((n) => n + POSTS_SHOWN);
            if (sort === 'newest' && items.length <= limit + POSTS_SHOWN) void feed.morePostsRead();
          }}
        >
          {t('project:hub.discussion.morePosts')}
        </Button>
      ) : null}
    </>
  );
}

function FeedLoading({ status, onRetry, rows }: { status: FeedState['status']; onRetry: () => void; rows: number }): ReactNode {
  const t = useMessages('project');
  if (status === 'error') {
    return (
      <p className="dh-failed" data-ws-discussion-failed="">
        <span>{t('project:hub.discussion.failed')}</span>
        <button type="button" className="dh-link" onClick={onRetry}>{t('project:hub.discussion.retry')}</button>
      </p>
    );
  }
  return (
    <div className="dh-list" aria-busy="true" data-ws-discussion-loading="">
      <span className="sr-only" role="status">{t('project:hub.discussion.loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="dh-post dh-post-bone" aria-hidden="true">
          <span className="dh-bone dh-bone-head" />
          <span className="dh-bone dh-bone-line" />
        </div>
      ))}
    </div>
  );
}

function ViewerFace({ viewer }: { viewer: Viewer | null }): ReactNode {
  if (!viewer) return <span className="dh-face-blank" aria-hidden="true" />;
  return <UserAvatar user={{ id: 1, username: viewer.username, avatarUrl: viewer.avatarUrl }} size="sm" />;
}

// ── A post and its replies ─────────────────────────────────────────────

function Thread({ item, feed, slug, channel, viewer, readId, busy, opened, marked }: {
  item: DiscussionItem;
  feed: DiscussionFeed;
  slug: string;
  channel: Channel;
  viewer: Viewer | null;
  readId: number | null;
  busy: boolean;
  opened: ReadonlySet<number>;
  /** The message a door named, marked for a moment. */
  marked: number | null;
}): ReactNode {
  const t = useMessages('project');
  const [replying, setReplying] = useState(false);
  const replyBox = useRef<HTMLTextAreaElement | null>(null);
  const rootId = item.kind === 'post' ? item.root.id : item.fold.lastId;
  const open = opened.has(rootId);
  const { shown, hidden } = shownReplies(item, open);
  // A member always has the reply field under a post; a visitor reads the replies there are.
  const room = useContext(RoomContext);
  const canReply = !room.visitor && !!viewer;
  const hasBox = item.replyCount > 0 || canReply || replying;
  const startReply = () => {
    setReplying(true);
    // The box is drawn on the next render; focus it once it is there.
    setTimeout(() => replyBox.current?.focus({ preventScroll: false }), 0);
  };
  const more = () => {
    if (item.kind === 'earlier') {
      if (item.olderToRead || !open) void feed.openEarlier();
      return;
    }
    void feed.openThread(item.root.id, open);
  };
  const me = viewer?.username || null;
  return (
    <div className="dh-thread" data-ws-discussion-thread={item.key}>
      {item.kind === 'post' ? (
        <Message said={item.root} feed={feed} me={me} className="dh-post" marked={marked === item.root.id} onReply={startReply}>
          <PostHeader item={item} readId={readId} me={me} />
          <PostWords item={item} />
          <Pills said={item.root} feed={feed} me={me} />
        </Message>
      ) : (
        <EarlierPost item={item} feed={feed} me={me} readId={readId} canReact={canReply} onReply={startReply} />
      )}
      {hasBox ? (
        <div className="dh-replies" data-ws-discussion-replies={String(item.replyCount)}>
          {hidden > 0 && (item.kind === 'post' || item.olderToRead || !open) ? (
            <button type="button" className="dh-earlier" data-ws-discussion-view-earlier={String(hidden)} disabled={busy} onClick={more}>
              {item.kind === 'post' && open
                ? t('project:hub.discussion.wholeThread')
                : t('project:hub.discussion.earlierReplies', { count: hidden })}
            </button>
          ) : null}
          {shown.map((reply) => (
            <Message key={reply.id} said={reply} feed={feed} me={me} className="dh-reply" marked={marked === reply.id} onReply={startReply}>
              <ReplyRow said={reply}>
                <Pills said={reply} feed={feed} me={me} small />
                {item.kind === 'earlier' && reply.rootId == null && oldThreadCount(item, reply) > 0 ? (
                  <Button
                    type="button"
                    variant="unstyled"
                    size="none"
                    ink="none"
                    className="dh-old-thread"
                    data-ws-discussion-old-thread={String(reply.id)}
                    aria-expanded={opened.has(reply.id)}
                    onClick={() => void feed.toggleOld(reply.id)}
                  >
                    <ThreadIcon aria-hidden="true" />
                    {opened.has(reply.id)
                      ? t('project:hub.discussion.oldThreadHide')
                      : t('project:hub.discussion.oldThread', { count: oldThreadCount(item, reply) })}
                  </Button>
                ) : null}
              </ReplyRow>
              {item.kind === 'earlier' && reply.rootId == null && opened.has(reply.id) && oldThreadCount(item, reply) > 0 ? (
                <div className="dh-old-replies" data-ws-discussion-old-replies={String(reply.id)}>
                  {feed.repliesOf(reply.id).filter((r) => !item.replies.includes(r)).map((old) => (
                    <Message key={old.id} said={old} feed={feed} me={me} className="dh-reply" marked={marked === old.id} onReply={startReply}>
                      <ReplyRow said={old}>
                        <Pills said={old} feed={feed} me={me} small />
                      </ReplyRow>
                    </Message>
                  ))}
                </div>
              ) : null}
            </Message>
          ))}
          {canReply ? (
            <Composer
              kind="reply"
              boxRef={replyBox}
              viewer={viewer}
              placeholder={t('project:hub.discussion.reply.placeholder')}
              label={item.kind === 'post'
                ? t('project:hub.discussion.reply.label', { username: nameOf(item.root.who) })
                : t('project:hub.discussion.reply.labelEarlier')}
              sendLabel={t('project:hub.discussion.reply.send')}
              onSend={(words, ids) => feed.write(words, rootId, ids)}
              upload={(file) => feed.source.upload(file)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Earlier post: not a message, but reacted to and replied to as one.
 * Its reactions hang on its project's own anchor (DiscussionFeed.reactEarlier),
 * through the same hover bar and long-press sheet a post has; its replies
 * box is the one under it.
 */
function EarlierPost({ item, feed, me, readId, canReact, onReply }: {
  item: DiscussionItem;
  feed: DiscussionFeed;
  me: string | null;
  readId: number | null;
  canReact: boolean;
  onReply: () => void;
}): ReactNode {
  const tm = useMessages('messages');
  const t = useMessages('project');
  const recents = useRecentReactions();
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const bar = useRef<HTMLDivElement | null>(null);
  const pickerButton = useRef<HTMLButtonElement | null>(null);
  useDismiss(picking, [bar], () => setPicking(false));
  const press = useLongPress(() => setSheet(true), { disabled: !canReact });
  if (item.kind !== 'earlier') return null;
  const reactions = item.fold.reactions;
  const reacted = (emoji: string) => reactions.some((r) => r.emoji === emoji && r.reacted);
  const react = (emoji: string) => { rememberReaction(emoji); void feed.reactEarlier(emoji); };
  return (
    <article className="dh-post dh-post-earlier dh-msg" data-ws-discussion-earlier="" {...(canReact ? press : {})}>
      <PostHeader item={item} readId={readId} me={me} />
      <PostWords item={item} />
      {reactions.length ? (
        <div className="dh-pills" data-ws-discussion-earlier-reactions="">
          {reactions.map((r) => (
            <ReactionPill
              key={r.emoji}
              emoji={r.emoji}
              count={r.count}
              tone={r.reacted ? 'accent' : 'neutral'}
              className="dh-pill"
              title={r.users.join(', ')}
              aria-pressed={r.reacted}
              aria-label={r.reacted
                ? tm('messages:actions.removeReaction', { emoji: emojiName(r.emoji) })
                : tm('messages:actions.reactWith', { emoji: emojiName(r.emoji) })}
              disabled={!canReact}
              data-emoji={r.emoji}
              onClick={() => react(r.emoji)}
            />
          ))}
        </div>
      ) : null}
      {canReact ? (
        <MessageActionBar
          className="dh-actions"
          barRef={bar}
          recents={recents}
          reacted={reacted}
          onReact={react}
          pickerOpen={picking}
          onTogglePicker={() => setPicking((v) => !v)}
          pickerButtonRef={pickerButton}
          onReply={onReply}
        >
          {picking ? (
            <EmojiPicker
              placement="below"
              autoFocus={!isTouchInput()}
              onPick={(emoji) => { setPicking(false); react(emoji); }}
              onClose={() => setPicking(false)}
            />
          ) : null}
        </MessageActionBar>
      ) : null}
      {canReact ? (
        <MessageActionSheet
          open={sheet}
          onClose={() => setSheet(false)}
          recents={recents}
          reacted={reacted}
          onReact={(emoji) => { setSheet(false); react(emoji); }}
          onPick={react}
          items={messageSheet({ reply: () => { setSheet(false); onReply(); } }, [])}
          preview={{ who: t('project:hub.discussion.earlier.title'), text: t('project:hub.discussion.earlier.body') }}
        />
      ) : null}
    </article>
  );
}

/**
 * An older message's own replies, inside the Earlier post: how many it has.
 * The last older message's thread also holds what was written into the
 * Earlier post since, which the post shows itself.
 */
function oldThreadCount(item: DiscussionItem, said: Said): number {
  if (item.kind !== 'earlier' || said.id !== item.fold.lastId) return said.replyCount;
  return Math.max(0, said.replyCount - item.replies.filter((r) => r.rootId === said.id).length);
}

/** A post's one header line: face, name, time, the new dot, and the replies at its far end. */
function PostHeader({ item, readId, me }: {
  item: DiscussionItem;
  readId: number | null;
  me: string | null;
}): ReactNode {
  const t = useMessages('project');
  const fresh = isNewTo(item, readId, me);
  const count = item.replyCount;
  // Its replies, counted, at the far end; a post with none says nothing
  // there: a member's reply field is always under it.
  const tail = count > 0 ? (
    <span className="dh-tail">
      <span className="dh-count">
        <ThreadIcon aria-hidden="true" />
        {t('project:hub.discussion.replies', { count })}
      </span>
    </span>
  ) : null;
  if (item.kind === 'earlier') {
    const { from, to } = item.fold;
    const range = from && to ? t('project:hub.discussion.earlier.range', { from: shortDate(from), to: shortDate(to) }) : '';
    return (
      <div className="dh-head">
        <span className="dh-earlier-mark" aria-hidden="true"><ChatsIcon /></span>
        <b className="dh-name">{t('project:hub.discussion.earlier.title')}</b>
        {range ? <span className="dh-time">{range}</span> : null}
        {fresh ? <NewDot /> : null}
        {tail}
      </div>
    );
  }
  const stamp = messageStamp(item.root.at);
  return (
    <div className="dh-head">
      <UserAvatar user={asUser(item.root.who)} />
      <b className="dh-name">{nameOf(item.root.who)}</b>
      <span className="dh-time" title={stamp.title}>{stamp.text}</span>
      {fresh ? <NewDot /> : null}
      {tail}
    </div>
  );
}

function NewDot(): ReactNode {
  const t = useMessages('project');
  return (
    <span className="dh-new" data-ws-discussion-new="">
      <span className="sr-only">{t('project:hub.discussion.new')}</span>
    </span>
  );
}

function PostWords({ item, clamp = false }: { item: DiscussionItem; clamp?: boolean }): ReactNode {
  const t = useMessages('project');
  if (item.kind === 'earlier') return <p className={clamp ? 'dh-words dh-clamp' : 'dh-words'}>{t('project:hub.discussion.earlier.body')}</p>;
  return <Words said={item.root} clamp={clamp} className="dh-words" />;
}

/** A post that only shares a card (a plan, a request, a change): no words, no files, no replies. */
export function isCardPost(item: DiscussionItem): boolean {
  if (item.kind !== 'post' || item.replyCount > 0) return false;
  const said = item.root;
  return !said.deleted && !said.content.trim() && !said.attachments.length && (!!said.spec || said.cards.length > 0);
}

/** Which project the room is, and whether its reader may only read (a visitor): for what the rows draw. */
interface Room {
  slug: string;
  visitor: boolean;
  signIn?: () => void;
  /** Homeroom's own room (#general, a Messages channel): `#name` in a post links to that channel, as in Messages. */
  homeroom?: boolean;
}
const RoomContext = createContext<Room>({ slug: '', visitor: false });

/**
 * A visitor's "Start a post…": the box as a member sees it, its far end
 * "Sign in to post", the whole of it asking them to sign in.
 */
function SignInDoor({ preview = false }: { preview?: boolean }): ReactNode {
  const t = useMessages('project');
  const room = useContext(RoomContext);
  return (
    <Button
      type="button"
      variant="unstyled"
      size="none"
      ink="none"
      className={`dh-composer dh-composer-door dh-sign-in-door${preview ? '' : ' dh-composer-post'}`}
      data-ws-discussion-sign-in=""
      onClick={() => room.signIn?.()}
    >
      <span className="dh-face-blank" aria-hidden="true" />
      <span className="dh-composer-hint">{t('project:hub.discussion.start.placeholder')}</span>
      <span className="dh-sign-in">{t('project:hub.discussion.signInToPost')}</span>
    </Button>
  );
}

/**
 * A message's words, as the chat draws them (the same markdown, with `#N`
 * chips for the project's requests), then what rides on it: a plan it
 * shares, the cards it shares, its files (images in place, any other file
 * as the chat's chip). Clamped to two lines in the phone's preview.
 */
function Words({ said, clamp = false, className }: { said: Said; clamp?: boolean; className: string }): ReactNode {
  const t = useMessages('project');
  const tc = useMessages('chat');
  const room = useContext(RoomContext);
  const editing = useContext(EditingContext);
  if (editing && editing.id === said.id) return <EditBox editing={editing} />;
  if (said.deleted) return <p className={`${className} dh-deleted`}>{t('project:hub.discussion.deleted')}</p>;
  const words = said.content.trim();
  if (clamp) {
    const line = words ? said.content.replace(/\s+/g, ' ').trim()
      : said.spec ? said.spec.title
        : said.cards.length ? (said.cards[0].title || t('project:hub.discussion.shared'))
          : t('project:hub.discussion.files', { count: Math.max(1, said.files) });
    return <p className={`${className} dh-clamp${words ? '' : ' dh-quiet'}`}>{line}</p>;
  }
  const files: Attachment[] = said.attachments.map((a) => ({
    id: a.id,
    kind: a.image ? 'image' : a.kind === 'html' && a.viewUrl ? 'html' : 'binary',
    name: a.name || tc('chat:group.attachment.unnamed'),
    unnamed: !a.name,
    url: a.url,
    size: a.size ? fileSize(a.size) : '',
    badge: attachmentBadge(a.name, ''),
  }));
  return (
    <div className={className}>
      {words ? <MessageMarkdown content={said.content} channels={room.homeroom ? channelHandles() : undefined} appSlug={room.slug || null} /> : null}
      {said.spec ? <SpecCard spec={said.spec} slug={room.slug} /> : null}
      {/* #4238: Homeroom bot's first-version post opens the app it made. */}
      {said.openApp && !clamp ? (
        <Button
          type="button"
          data-ws-discussion-open-app=""
          variant="pillAccent"
          size="sm"
          className="mt-2 font-semibold"
          onClick={() => openAppTarget(said.openApp?.target)}
        >
          {said.openApp.label}
        </Button>
      ) : null}
      {/* A Homeroom link in the words: its card, as every room draws it (a visitor reads the words alone). */}
      {words && !clamp && !room.visitor ? <LinkEmbeds text={said.content} exclude={said.cards} inboxOnly /> : null}
      {said.cards.length ? (
        <div className="messages-object-list dh-cards" data-ws-discussion-cards={String(said.cards.length)}>
          {/* #5303: a card from another project says which one it is from. */}
          <CardHomeContext.Provider value={room.slug || null}>
            {said.cards.map((card, at) => <ObjectCard key={`${card.type}:${at}`} object={card} compact />)}
          </CardHomeContext.Provider>
        </div>
      ) : null}
      {files.length ? <div className="dh-files" data-ws-discussion-files={String(files.length)}><Attachments items={files} /></div> : null}
    </div>
  );
}

/** A plan shared into a project's chat: its title, and a way to the change it became. */
function SpecCard({ spec, slug }: { spec: SharedSpec; slug: string }): ReactNode {
  const t = useMessages('project');
  const body = (
    <>
      <span className="dh-spec-label">{t('project:hub.discussion.sharedPlan')}</span>
      <span className="dh-spec-title">{spec.title || t('project:hub.discussion.sharedPlanUntitled')}</span>
    </>
  );
  return spec.prNumber && slug
    ? <a className="dh-spec" data-ws-discussion-spec="" href={`#app/${encodeURIComponent(slug)}/dev/changes/${spec.prNumber}`}>{body}</a>
    : <div className="dh-spec" data-ws-discussion-spec="">{body}</div>;
}

/** A reply, drawn as a chat row is: a small face, the name and time, the words. */
function ReplyRow({ said, children }: { said: Said; children?: ReactNode }): ReactNode {
  const stamp = messageStamp(said.at);
  return (
    <>
      <UserAvatar user={asUser(said.who)} size="sm" />
      <div className="dh-reply-body">
        <div className="dh-reply-who">
          <b>{nameOf(said.who)}</b>
          <span title={stamp.title}>{stamp.text}</span>
        </div>
        <Words said={said} className="dh-reply-words" />
        {children}
      </div>
    </>
  );
}

function Pills({ said, feed, me, small = false }: { said: Said; feed: DiscussionFeed; me: string | null; small?: boolean }): ReactNode {
  const t = useMessages('messages');
  if (!said.reactions.length) return null;
  return (
    <div className={small ? 'dh-pills dh-pills-small' : 'dh-pills'}>
      {said.reactions.map((r) => (
        <ReactionPill
          key={r.emoji}
          emoji={r.emoji}
          count={r.count}
          tone={r.reacted ? 'accent' : 'neutral'}
          className="dh-pill"
          title={r.users.join(', ')}
          aria-pressed={r.reacted}
          aria-label={r.reacted
            ? t('messages:actions.removeReaction', { emoji: emojiName(r.emoji) })
            : t('messages:actions.reactWith', { emoji: emojiName(r.emoji) })}
          disabled={!me}
          data-emoji={r.emoji}
          onClick={() => void feed.react(said.id, r.emoji)}
        />
      ))}
    </div>
  );
}

/** A message being edited in place: what its words draw instead of themselves. */
interface Editing {
  id: number;
  value: string;
  busy: boolean;
  error: string;
  change: (value: string) => void;
  save: () => void;
  cancel: () => void;
}
const EditingContext = createContext<Editing | null>(null);

/** The platform's in-place editor (as Messages' row draws it): Enter saves, Escape cancels. */
function EditBox({ editing }: { editing: Editing }): ReactNode {
  const t = useMessages('messages');
  const tc = useMessages('core');
  const box = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [editing.value]);
  return (
    <div className="dh-edit" data-ws-discussion-editing={String(editing.id)}>
      <textarea
        ref={box}
        className="dh-box"
        dir="auto"
        rows={2}
        maxLength={8000}
        aria-label={t('messages:row.editLabel')}
        value={editing.value}
        onChange={(event) => editing.change(event.target.value.slice(0, 8000))}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); editing.cancel(); } else if (enterSends(event.nativeEvent)) { event.preventDefault(); editing.save(); }
        }}
      />
      <div className="dh-edit-acts">
        <button type="button" className="dh-edit-save" disabled={editing.busy || !editing.value.trim()} onClick={editing.save}>{tc('core:common.save')}</button>
        <button type="button" className="dh-edit-cancel" onClick={editing.cancel}>{tc('core:common.cancel')}</button>
      </div>
      {editing.error ? <p className="dh-send-failed" role="alert">{editing.error}</p> : null}
    </div>
  );
}

/**
 * A message that can be reacted to, replied to and acted on: the hover bar
 * on a pointer (its reactions, Reply, and the ⋯ menu every chat's rows
 * open: ../../message-actions/message-menu.ts), the long-press sheet on a
 * touch screen (Reply, then the same menu). Your own: Edit, in place, and
 * Delete, once confirmed; somebody else's: Report and Block. Nobody signed
 * in, or a deleted message: none of it.
 */
function Message({ said, feed, me, className, marked = false, onReply, children }: {
  said: Said;
  feed: DiscussionFeed;
  me: string | null;
  className: string;
  marked?: boolean;
  onReply: () => void;
  children: ReactNode;
}): ReactNode {
  const t = useMessages('project');
  useMessages('messages');
  const tc = useMessages('chat');
  const recents = useRecentReactions();
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<ReturnType<typeof placementFor> | null>(null);
  const [sheet, setSheet] = useState(false);
  const [edit, setEdit] = useState<{ value: string; busy: boolean; error: string } | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const pickerButton = useRef<HTMLButtonElement | null>(null);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const can = !!me && !said.deleted;
  const mine = can && said.who.username === me;
  useDismiss(picking, [bar], () => setPicking(false));
  const press = useLongPress(() => setSheet(true), { disabled: !can || !!edit });
  const reacted = (emoji: string) => said.reactions.some((r) => r.emoji === emoji && r.reacted);
  const react = (emoji: string) => { rememberReaction(emoji); void feed.react(said.id, emoji); };
  const who = said.who;
  const items: MenuItem[] = can ? messageMenu({
    edit: mine && said.content.trim() ? () => setEdit({ value: said.content, busy: false, error: '' }) : null,
    text: said.content || null,
    pictures: said.attachments.filter((a) => a.image).map((a) => ({ src: a.url, name: a.name })),
    link: feed.source.address(said),
    remove: mine ? () => feed.remove(said.id) : null,
    report: !mine && who.id ? () => openReport(feed.source.kind === 'app'
      ? { targetType: 'app_message', target: said.id, label: tc('chat:group.report.label', { username: who.username }), userId: who.id || undefined }
      : { targetType: 'conversation_message', target: said.id, label: t('messages:row.reportLabel', { name: nameOf(who) }), userId: who.id || undefined }) : null,
    block: !mine && who.id && !who.bot ? { who: { name: `@${who.username}` }, run: () => setUserBlocked(who.id as number, true) } : null,
    failed: (_error, fallback) => toast(fallback),
  }) : [];
  const sheetItems = messageSheet({ reply: () => { setSheet(false); onReply(); } }, items);
  const editing: Editing | null = edit ? {
    id: said.id,
    ...edit,
    change: (value) => setEdit((was) => (was ? { ...was, value } : was)),
    cancel: () => setEdit(null),
    save: () => {
      const value = edit.value.trim();
      if (!value || edit.busy) return;
      setEdit({ ...edit, busy: true, error: '' });
      feed.edit(said.id, value).then(() => setEdit(null), () => {
        setEdit((was) => (was ? { ...was, busy: false, error: t('project:hub.discussion.editFailed') } : was));
      });
    },
  } : null;
  const Tag = className === 'dh-post' ? 'article' : 'div';
  return (
    <Tag
      className={`${className} dh-msg`}
      data-ws-discussion-message={String(said.id)}
      data-ws-discussion-marked={marked ? '' : undefined}
      {...(can && !edit ? press : {})}
    >
      <EditingContext.Provider value={editing}>{children}</EditingContext.Provider>
      {can && !edit ? (
        <MessageActionBar
          className="dh-actions"
          barRef={bar}
          recents={recents}
          reacted={reacted}
          onReact={react}
          pickerOpen={picking}
          onTogglePicker={() => { setMenu(null); setPicking((v) => !v); }}
          pickerButtonRef={pickerButton}
          onReply={onReply}
          moreOpen={!!menu}
          moreButtonRef={moreButton}
          onToggleMore={() => { setPicking(false); setMenu((open) => (open ? null : placementFor(moreButton.current, items.length * 38 + 24))); }}
        >
          {picking ? (
            <EmojiPicker
              placement="below"
              autoFocus={!isTouchInput()}
              onPick={(emoji) => { setPicking(false); react(emoji); }}
              onClose={() => setPicking(false)}
            />
          ) : null}
          {menu ? <MessageMenu items={items} placement={menu} onClose={() => { setMenu(null); moreButton.current?.focus({ preventScroll: true }); }} /> : null}
        </MessageActionBar>
      ) : null}
      {can ? (
        <MessageActionSheet
          open={sheet}
          onClose={() => setSheet(false)}
          recents={recents}
          reacted={reacted}
          onReact={(emoji) => { setSheet(false); react(emoji); }}
          onPick={react}
          items={sheetItems}
          preview={{ who: nameOf(said.who), text: said.content.replace(/\s+/g, ' ').trim().slice(0, 120) }}
        />
      ) : null}
    </Tag>
  );
}

// ── The boxes ──────────────────────────────────────────────────────────

/**
 * The platform's message box, as the hub draws it: "Start a post…" with the
 * viewer's face, or a thread's "Reply in thread…". Enter sends on a device
 * with a keyboard and Shift + Enter is a new line; on a touch screen the
 * button sends (../../../lib/enter-sends.ts). What it says is the server's
 * to refuse: somebody who has not joined is asked to join and the send goes
 * through (../../../lib/join-required.ts), and any other refusal is said under
 * the box with what was typed kept.
 */
/** The formatting row a post's box wears, as a channel's composer did (#6035): the chat's own buttons and rules. */
const FORMAT_BUTTONS: Array<{ kind: FormatKind; label: string; Icon: typeof BoldIcon }> = [
  { kind: 'bold', label: 'messages:composer.format.bold', Icon: BoldIcon },
  { kind: 'italic', label: 'messages:composer.format.italic', Icon: ItalicIcon },
  { kind: 'underline', label: 'messages:composer.format.underline', Icon: UnderlineIcon },
  { kind: 'strike', label: 'messages:composer.format.strike', Icon: StrikethroughIcon },
  { kind: 'heading', label: 'messages:composer.format.heading', Icon: HeadingIcon },
  { kind: 'quote', label: 'messages:composer.format.quote', Icon: QuoteIcon },
  { kind: 'bullet', label: 'messages:composer.format.bullets', Icon: ListBulletIcon },
  { kind: 'link', label: 'messages:composer.format.link', Icon: LinkIcon },
];

/** A file picked for the next post or reply, before it is sent. */
interface Staged { key: string; file: File; thumb: string | null }

let stagedSeq = 0;

/**
 * The box a post or a reply is written in. Files ride along as they do in
 * the chat: the paperclip (or a drop) stages up to four, under the room's
 * own limits (../../attachments/limits.ts), shown as the chat's strip; they
 * are taken in through the room's own upload route when the post is sent.
 * A post's box wears the formatting row; Ctrl/Cmd + B and I work in both.
 */
function Composer({ kind, boxRef, viewer, placeholder, label, sendLabel, onSend, upload }: {
  kind: 'post' | 'reply';
  boxRef: RefObject<HTMLTextAreaElement | null>;
  viewer: Viewer | null;
  placeholder: string;
  label: string;
  sendLabel: string;
  onSend: (words: string, attachmentIds: string[]) => Promise<void>;
  upload: (file: File) => Promise<string>;
}): ReactNode {
  const t = useMessages('project');
  const tm = useMessages('messages');
  const [words, setWords] = useState('');
  const [staged, setStaged] = useState<Staged[]>([]);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const empty = !words.trim() && !staged.length;
  const grow = () => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 240)}px`;
    if (caret.current) {
      box.setSelectionRange(caret.current.start, caret.current.end);
      caret.current = null;
    }
  };
  useEffect(grow, [words]); // eslint-disable-line react-hooks/exhaustive-deps
  // A picture's preview is the browser's own copy until it is sent.
  useEffect(() => () => { for (const item of staged) if (item.thumb) URL.revokeObjectURL(item.thumb); }, [staged]);
  const stage = (files: File[]) => {
    const { upload: take, refused } = stageFiles(files, staged.length, tm);
    setFailed(refused || null);
    if (!take.length) return;
    setStaged((held) => [...held, ...take.map((file) => ({
      key: `f${stagedSeq += 1}`,
      file,
      thumb: file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null,
    }))]);
  };
  const format = (how: FormatKind) => {
    const box = boxRef.current;
    if (!box) return;
    const result = applyFormat(box.value.slice(0, 8000), box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, how);
    caret.current = { start: result.start, end: result.end };
    box.focus({ preventScroll: true });
    setWords(result.value);
  };
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (empty || sending) return;
    setSending(true);
    setFailed(null);
    let ids: string[];
    try {
      ids = await Promise.all(staged.map((item) => upload(item.file)));
    } catch (error) {
      setFailed(error instanceof Error && error.message ? error.message : tm('messages:composer.uploadFailed'));
      setSending(false);
      return;
    }
    try {
      await onSend(words.trim(), ids);
      setWords('');
      setStaged([]);
    } catch (error) {
      const said = error instanceof Error && error.message ? error.message : '';
      setFailed(said || t('project:hub.discussion.sendFailed'));
    } finally {
      setSending(false);
    }
  };
  const onKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && (event.key === 'b' || event.key === 'i')) {
      event.preventDefault();
      format(event.key === 'b' ? 'bold' : 'italic');
      return;
    }
    if (enterSends(event.nativeEvent)) {
      event.preventDefault();
      void send();
    }
  };
  const pending: PendingAttachmentView[] = staged.map((item) => ({
    key: item.key,
    name: item.file.name,
    kind: item.thumb ? 'image' : 'binary',
    badge: attachmentBadge(item.file.name, item.file.type),
    size: fileSize(item.file.size),
    thumbUrl: item.thumb,
    uploading: sending,
  }));
  return (
    <form
      className={kind === 'post' ? 'dh-composer dh-composer-post' : 'dh-composer dh-composer-reply'}
      data-ws-discussion-compose={kind}
      onSubmit={send}
      onDragOver={(event) => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return;
        event.preventDefault();
        stage(files);
      }}
    >
      {kind === 'post' ? (
        <div className="dh-format-bar messages-format-bar" role="toolbar" aria-label={tm('messages:composer.format.bar')} data-ws-discussion-format="">
          {FORMAT_BUTTONS.map(({ kind: how, label: name, Icon }) => (
            <button
              key={how}
              type="button"
              className="messages-format-btn"
              data-format={how}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => format(how)}
              disabled={sending}
              aria-label={tm(name)}
              title={tm(name)}
            >
              <Icon aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
      {kind === 'post' ? <ViewerFace viewer={viewer} /> : null}
      <textarea
        ref={boxRef}
        className="dh-box"
        rows={1}
        dir="auto"
        maxLength={8000}
        value={words}
        placeholder={placeholder}
        aria-label={label}
        disabled={sending}
        onChange={(event) => setWords(event.currentTarget.value)}
        onKeyDown={onKey}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files || []);
          if (!files.length) return;
          event.preventDefault();
          stage(files);
        }}
      />
      <button
        type="button"
        className="dh-attach"
        data-ws-discussion-attach=""
        disabled={sending || staged.length >= MAX_ATTACHMENTS}
        aria-label={tm('messages:composer.attachFiles')}
        title={tm('messages:composer.attachFiles')}
        onClick={() => picker.current?.click()}
      >
        <PaperClipIcon aria-hidden="true" />
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => { stage(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }}
      />
      <button type="submit" className="dh-send" disabled={empty || sending} aria-label={sendLabel} title={sendLabel}>
        <ArrowUpIcon aria-hidden="true" />
      </button>
      {pending.length ? (
        <div className="dh-staged" data-ws-discussion-staged={String(pending.length)}>
          <PendingStripRows items={pending} onRemove={(at) => setStaged((held) => held.filter((_, i) => i !== at))} />
        </div>
      ) : null}
      {failed ? <p className="dh-send-failed" role="alert" data-ws-discussion-send-failed="">{failed}</p> : null}
    </form>
  );
}
