/**
 * The project page's Discussion tab: the community's channel, whole, in
 * place.
 *
 * The hub shows the discussion's last two messages and a way in
 * (./hub-cards.tsx ChannelCard, compact). The way in used to leave the page
 * for `#messages/app/<slug>`; it is a tab of the page now, so a person
 * reading the hub and a person talking in the room are on the same page with
 * the same coloured header, and Back is the tab strip rather than a screen
 * swap.
 *
 * ── The same room, mounted the way Messages mounts it ─────────────────
 *
 * The pane is group-chat's (AppView.renderGroupChatTab: the stream, the
 * composer, drafts, the @ and # menus), mounted into a host this component
 * renders empty and never writes into again: the one-owner rule satisfied at
 * the host's boundary, as in features/messages/index.tsx AppDiscussionThread,
 * whose effect this copies, timer and teardown order included (#2783: the
 * composer is wired on the line after the portal is published, which cannot
 * happen inside React's commit).
 *
 * ── Homeroom's own room is #general, in place too (#3494) ─────────────
 *
 * Its channel is #general, a conversation of the Messages store rather than
 * an app chat. It used to be a door: the tab opened #general on the Messages
 * screen, which swapped the page's header, its tabs and its colour for
 * Messages' own (#3491). Now the tab turns like every other project's and
 * the room is drawn here, under the same header — Messages' own thread,
 * composer and reply threads (features/messages/index.tsx
 * EmbeddedConversation), holding the store's one route while this page is
 * the screen on show. `generalRoom` reads which conversation it is.
 *
 * ── Every way into the room ends here, at its place (#3653) ───────────
 *
 * A notification, a message link, a `#name` reference or an old address of
 * the room used to open it on a page of its own, with its own back button.
 * They come to this tab now (app.js App.openDiscussionInHub and the
 * router's redirects), carrying what they named in the room as a TARGET
 * (AppView._stashDiscussionTarget): a reply thread, opened beside the room
 * here as it opens beside it in Messages, or a message, brought into view
 * and flashed. The tab takes it when it shows the room, and again when a
 * door is followed while the room is already up. A reply thread opened from
 * the room itself comes the same way (public/js/group-chat.js
 * openReplyThread), with no address of its own: the page's address is the
 * page's, as it is for #general's threads.
 *
 * ── A topic's channel, too (#4417) ───────────────────────────────────
 *
 * A project's channels are #general and its TOPICS: lasting conversations
 * about one part of it, each a channel and a category at once (a category
 * row with origin 'topic'; ./places.ts). The place names which (`channel`,
 * a handle; null or `general` is #general), and a topic's channel is its
 * 'category' thread on the app's own chat, mounted the way a request's or a
 * change's own thread is (GroupChat.mountThread, in a host this component
 * renders empty), under the topic's line (./topic-head.tsx). On Homeroom's
 * own project too, where #general is a Messages conversation and the topics
 * are threads of the app's chat: the list hides the difference.
 *
 * A retired topic (archived, or merged into another) is read-only, with its
 * whole history. A topic that others were merged into draws one card in its
 * history for each, where the merge happened (./merged-topic-card.tsx),
 * handed to the history as markers: nothing was posted for them.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { XIcon } from '@/components/ui/icons';
import { reloadCommunity, type CommunityPayload, type PlaceChannel } from './community-card';
import { AppReplyThreadPane, EmbeddedConversation } from '../../messages';
import { closeThread, embeddedThreadOpen } from '../../messages/store';
import { navStore } from '../../nav/nav-store.js';
import { registerLevel } from '../../workshop/tab-ladder';
import { useStoreState } from '../../../lib/use-store-state';
import { unmountLegacyPortal } from '../../../lib/legacy-portals';
import { devWorkshopStore } from '../card/cards-store';
import type { TranscriptMarker } from '../../group-chat/transcript-store';
import { channelPlace, channelsOf, findChannel, mergedInto, type PlaceKey } from './places';
import { TopicHead } from './topic-head';

type Channel = NonNullable<CommunityPayload['channel']>;

/** What a door asked for in the room (AppView._stashDiscussionTarget). */
export interface DiscussionTarget {
  threadRootId: number | null;
  focusMessageId: number | null;
  conversationId: number | null;
}

/** A channel this page can mount: an app's own, addressed in Messages' app threads. */
function embeddable(channel: Channel | null): boolean {
  return !!channel && channel.handle !== 'general'
    && (!channel.href || channel.href.startsWith('#messages/app/'));
}

/**
 * The conversation a channel is when it is one of Messages' own rooms —
 * #general, on Homeroom's page (`#messages/<id>`) — or null for an app's own
 * channel, and for none.
 */
export function generalRoom(data: CommunityPayload | null | undefined): number | null {
  const channel = data?.channel || null;
  if (!channel || embeddable(channel)) return null;
  const m = /^#messages\/([1-9]\d{0,9})$/.exec(channel.href || '');
  const id = m ? Number(m[1]) : null;
  return id && id <= 2147483647 ? id : null;
}

/** The target waiting for `slug`'s room, taken, or null. */
export function takeDiscussionTarget(slug: string): DiscussionTarget | null {
  const view = (window as unknown as {
    AppView?: { _takeDiscussionTarget?: (slug: string) => Partial<DiscussionTarget> | null };
  }).AppView;
  const t = view?._takeDiscussionTarget?.(slug) || null;
  if (!t) return null;
  return {
    threadRootId: t.threadRootId || null,
    focusMessageId: t.focusMessageId || null,
    conversationId: t.conversationId || null,
  };
}

export function ProjectDiscussion({ slug, name, data, channel = null, onPlace }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
  /** #4417: the channel the place names: a topic's handle, or null for #general. */
  channel?: string | null;
  /** #4417: go to another of the page's places. */
  onPlace?: (key: PlaceKey) => void;
}): ReactNode {
  const handle = channel && channel !== 'general' ? channel : null;
  if (handle) return <TopicChannelPlace slug={slug} data={data} handle={handle} onPlace={onPlace} />;
  return <GeneralChannel slug={slug} name={name} data={data} />;
}

/** #general: the project's own channel, as it always was. */
function GeneralChannel({ slug, name, data }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
}): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const channel = data?.channel || null;
  const mountable = embeddable(channel);
  const room = generalRoom(data);
  const readOnly = !channel?.post_url;
  // The room holds Messages' one route only while this page is the screen
  // on show: #app-view stays mounted, hidden, behind every other screen, and
  // behind the running app on its App tab (the one #app-view route that
  // lights no tab).
  const { screen, tab } = useStoreState(navStore) as { screen: string | null; tab: string | null };
  const onShow = screen === 'app-view' && !!tab;
  // #3653: the reply thread open beside a project's own channel, and the
  // place a door named in #general. `key` makes the same thread asked for
  // again (a second notification for it) a fresh mount: the router's pass
  // on the way here lets go of whatever thread the group chat had.
  const [thread, setThread] = useState<{ rootId: number; key: number } | null>(null);
  const [roomAt, setRoomAt] = useState<{ threadRootId: number | null; focusMessageId: number | null } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !mountable) return undefined;
    const view = (window as any).AppView;
    const chat = (window as any).UsernodeReact?.groupChat;
    let live = true;
    const timer = window.setTimeout(() => {
      if (live) view?.renderGroupChatTab?.({ host: el, slug, name, readOnly, archived: false });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      // The transcript's portal first: it points INTO #gc-messages inside
      // the pane (rule 1 in lib/legacy-portals.tsx).
      const list = el.querySelector('#gc-messages');
      if (list) chat?.unmountTranscript?.(list);
      chat?.unmountGeneralChat?.(el);
      (window as any).GroupChat?.releaseUnreadHold?.(slug);
    };
  }, [slug, name, readOnly, mountable]);

  // A thread belongs to the room it was opened in.
  useEffect(() => { setThread(null); setRoomAt(null); }, [slug]);

  // #3701: A REPLY THREAD IS A LEVEL BELOW THE TAB. The Communities tab,
  // pressed while it is lit, closes it before it goes any higher
  // (../../workshop/tab-ladder.ts): the room is the tab, and the thread
  // beside it is the page below. No address changes, as none did when it
  // opened. #general's thread is the Messages store's; an app's is ours.
  const threadRef = useRef(thread);
  threadRef.current = thread;
  useEffect(() => registerLevel({
    slug,
    below: () => (room ? embeddedThreadOpen(room) : !!threadRef.current),
    up: () => { if (room) closeThread(); else setThread(null); },
    // #4417: a thread is below the channel, which is below the Hub.
    depth: 2,
  }), [slug, room]);

  // THE DOOR'S TARGET, taken once the page knows which room this is (the
  // community record has landed): now, and whenever a door is followed
  // while the tab is up. Declared after the mount above and run in the same
  // commit, so a message to bring into view is asked for before the group
  // chat's first history load (a macrotask later) can answer it.
  const known = !!data;
  useEffect(() => {
    if (!known) return undefined;
    const apply = () => {
      const target = takeDiscussionTarget(slug);
      if (!target) return;
      if (room) {
        // #general's place is the store's to find: its thread opens beside
        // it, its message is read around and flashed (EmbeddedConversation).
        if (target.threadRootId || target.focusMessageId) {
          setRoomAt({ threadRootId: target.threadRootId, focusMessageId: target.focusMessageId });
        }
        return;
      }
      if (!mountable) return;
      if (target.focusMessageId) {
        // The group chat scrolls to it and flashes it once its stream has
        // it, and opens the reply thread it lives in when it is a reply.
        (window as any).GroupChat?.revealMessage?.(slug, target.focusMessageId);
      }
      if (target.threadRootId) {
        const rootId = target.threadRootId;
        setThread((cur) => ({ rootId, key: (cur?.key || 0) + 1 }));
      }
    };
    apply();
    // A door followed while the tab is up: taken a turn later, once the
    // router's own pass (which may render this page afresh) is over — a
    // fresh copy takes it as it mounts instead, and this one lets it be.
    let live = true;
    let timer = 0;
    const onTarget = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string } | null>).detail;
      if (!detail || detail.slug !== slug) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (live) apply(); }, 0);
    };
    window.addEventListener('usernode:workshop-discussion', onTarget);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.removeEventListener('usernode:workshop-discussion', onTarget);
    };
  }, [slug, known, room, mountable]);

  if (!data) return null;
  if (room) {
    return (
      <section
        className="dev-ws-discussion"
        data-ws-discussion=""
        data-ws-discussion-room={channel?.handle || ''}
        aria-label={`${name} discussion`}
      >
        <EmbeddedConversation conversationId={room} active={onShow} at={roomAt} />
      </section>
    );
  }
  if (!mountable) {
    return <p className="dev-ws-week-note" data-ws-discussion-none="">This project has no discussion you can read.</p>;
  }
  // The section's class says whether a thread is beside the room; the
  // host's own never changes, and its subtree stays the group chat's.
  // `data-discussion-app` names the room as Messages' pane does, so the
  // group chat brings a message into view here at once when it is already
  // up (GroupChat.revealMessage).
  return (
    <section
      className={`dev-ws-discussion${thread ? ' dev-ws-discussion-threaded' : ''}`}
      data-ws-discussion=""
      data-discussion-app={slug}
      aria-label={`${name} discussion`}
    >
      <div ref={host} className="dev-ws-discussion-host" />
      {thread ? (
        <AppReplyThreadPane
          key={`${thread.rootId}:${thread.key}`}
          slug={slug}
          rootId={thread.rootId}
          ready
          readOnly={readOnly}
          where={name}
          close={(
            <button
              type="button"
              className="messages-thread-action"
              aria-label="Close thread"
              title="Close thread"
              onClick={() => setThread(null)}
            >
              <XIcon aria-hidden="true" />
            </button>
          )}
        />
      ) : null}
    </section>
  );
}

/**
 * #4417: the place of a topic's channel. Waits for the community record
 * (which says what the handle is), then mounts the channel; a handle the
 * project has no topic for says so, with the way back to the hub.
 */
function TopicChannelPlace({ slug, data, handle, onPlace }: {
  slug: string;
  data: CommunityPayload | null;
  handle: string;
  onPlace?: (key: PlaceKey) => void;
}): ReactNode {
  if (!data) return null;
  const topic = findChannel(data.places, handle);
  if (!topic || topic.kind !== 'topic' || topic.id == null) {
    return (
      <p className="dev-ws-week-note" data-ws-discussion-none="">
        {`This project has no #${handle} channel.`}
      </p>
    );
  }
  // Posting takes collab access (the channel row is only there with it) and
  // membership, which the composer asks for on its first send (join_required).
  const readOnly = !data.channel;
  return <TopicChannel key={topic.id} slug={slug} data={data} topic={topic} readOnly={readOnly} onPlace={onPlace} />;
}

/** How often an open channel tells the server how far it has been read. */
const READ_EVERY_MS = 4000;

/** The newest message loaded in a topic channel, as the group chat holds it. */
function newestLoaded(ref: number): number {
  const chat = (window as any).GroupChat;
  try {
    const st = chat?._threadState?.('category', ref);
    const ids = (st?.messages || [])
      .filter((m: any) => m && !m.deleted && m.id != null && Number.isFinite(Number(m.id)))
      .map((m: any) => Number(m.id));
    return ids.length ? Math.max(...ids) : 0;
  } catch {
    return 0;
  }
}

function TopicChannel({ slug, data, topic, readOnly, onPlace }: {
  slug: string;
  data: CommunityPayload;
  topic: PlaceChannel;
  readOnly: boolean;
  onPlace?: (key: PlaceKey) => void;
}): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const ref = Number(topic.id);
  const closed = topic.state !== 'live';
  // The topic a merged one joined, by its key, for its line and its link.
  const survivor = topic.state === 'merged' && topic.merged_into
    ? channelsOf(data.places).find((c) => c.kind === 'topic' && c.key === topic.merged_into) || null
    : null;
  // The merges into this topic, as cards the history draws at their time.
  const markers = useMemo<TranscriptMarker[]>(() => mergedInto(data.places, topic).map((m) => ({
    key: `merged-${m.key}`,
    at: String(m.merged_at),
    kind: 'merged-topic',
    from: { handle: m.handle, name: m.name, icon: m.icon },
  })), [data.places, topic]);
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const notice = closed
    ? (topic.state === 'merged'
      ? `#${topic.handle} was merged into ${survivor ? `#${survivor.handle}` : 'another topic'}. Its history stays here to read.`
      : `#${topic.handle} is archived. Its history stays here to read.`)
    : 'Join this community to post here.';

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const chat = (window as any).GroupChat;
    let live = true;
    const timer = window.setTimeout(() => {
      if (!live) return;
      chat?.mountThread?.({
        type: 'category',
        ref,
        container: el,
        fullHeight: true,
        readOnly: readOnly || closed,
        placeholder: `Message #${topic.handle}`,
        notice,
        markers: markersRef.current,
      });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      const list = el.querySelector('#gc-thread-messages');
      if (list) (window as any).UsernodeReact?.groupChat?.unmountTranscript?.(list);
      unmountLegacyPortal(el);
      if (chat?.activeThread?.type === 'category' && Number(chat.activeThread.ref) === ref) chat.unmountThread?.();
    };
  }, [slug, ref, readOnly, closed, topic.handle, notice]);

  // A merge that lands while the channel is open draws its card at once.
  useEffect(() => {
    (window as any).GroupChat?.setThreadMarkers?.('category', ref, markers);
  }, [ref, markers]);

  // READ AS IT IS SEEN: while the channel is on screen, the newest message
  // loaded in it is where this reader's reading stands, and the list's
  // count for it goes with it (app_category_chat_reads). A live channel
  // only, and only while the window is in front.
  useEffect(() => {
    if (closed) return undefined;
    let posted = 0;
    let stopped = false;
    const tick = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      const newest = newestLoaded(ref);
      if (!newest || newest <= posted) return;
      posted = newest;
      try {
        // `?demo=1`: a staging demo channel's rows are mock ones, which only
        // the demo branch of the route knows (src/routes/chat.js).
        let demo = '';
        try { demo = new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : ''; } catch { demo = ''; }
        const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/read${demo}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: newest, thread_type: 'category', thread_ref: ref }),
        });
        if (res.ok && Number(topic.unread) > 0) void reloadCommunity(slug);
      } catch { /* the next tick tries again */ }
    };
    const timer = window.setInterval(() => { void tick(); }, READ_EVERY_MS);
    const first = window.setTimeout(() => { void tick(); }, 1200);
    return () => { stopped = true; window.clearInterval(timer); window.clearTimeout(first); };
  }, [slug, ref, closed, topic.unread]);

  const openRequests = () => {
    // All items, narrowed to the topic: the Workshop's own filter by
    // category (AppView.openBoardForTheme), under the theme the grouping
    // drew the topic as.
    const themes = devWorkshopStore.get().themes || [];
    const theme = themes.find((t) => t.topic && t.topic.key === topic.key);
    (window as any).AppView?.openBoardForTheme?.(theme ? theme.id : topic.key);
  };

  return (
    <section
      className="dev-ws-discussion dev-ws-topic-channel"
      data-ws-discussion=""
      data-ws-topic={topic.handle}
      data-ws-topic-state={topic.state}
      aria-label={`#${topic.handle}`}
    >
      <TopicHead
        slug={slug}
        topic={topic}
        survivor={survivor ? survivor.handle : null}
        onRequests={openRequests}
        onSurvivor={survivor && onPlace ? () => onPlace(channelPlace(survivor.handle)) : undefined}
      />
      {/* The host's class string is constant and its subtree is the group
          chat's: the one-owner rule, satisfied at this boundary. */}
      <div ref={host} className="dev-ws-discussion-host dev-ws-topic-host" data-topic-channel={topic.id} />
    </section>
  );
}
