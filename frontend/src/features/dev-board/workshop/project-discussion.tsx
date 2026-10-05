import { useMessages as useUiLanguage } from "../../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
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
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { XIcon } from '@/components/ui/icons';
import type { CommunityPayload } from './community-card';
import { AppReplyThreadPane, EmbeddedConversation } from '../../messages';
import { navStore } from '../../nav/nav-store.js';
import { useStoreState } from '../../../lib/use-store-state';

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

export function ProjectDiscussion({ slug, name, data }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
}): ReactNode {
  useUiLanguage();
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
      <LocalizedDynamic element={<section
        className="dev-ws-discussion"
        data-ws-discussion=""
        data-ws-discussion-room={channel?.handle || ''}
        aria-label={tr("workshop:value1_discussion_77d181cd", { value1: name })}
      >
        <EmbeddedConversation conversationId={room} active={onShow} at={roomAt} />
      </section>} resolve={() => ({ get "aria-label"() { return tr("workshop:value1_discussion_77d181cd", { value1: name }); } })} />
    );
  }
  if (!mountable) {
    return <p className="dev-ws-week-note" data-ws-discussion-none=""><Message id="workshop:this_project_has_no_discussion_you_can_read_4bad8fd0" /></p>;
  }
  // The section's class says whether a thread is beside the room; the
  // host's own never changes, and its subtree stays the group chat's.
  // `data-discussion-app` names the room as Messages' pane does, so the
  // group chat brings a message into view here at once when it is already
  // up (GroupChat.revealMessage).
  return (
    <LocalizedDynamic element={<section
      className={`dev-ws-discussion${thread ? ' dev-ws-discussion-threaded' : ''}`}
      data-ws-discussion=""
      data-discussion-app={slug}
      aria-label={tr("workshop:value1_discussion_77d181cd", { value1: name })}
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
            <Localized element={<button
              type="button"
              className="messages-thread-action" aria-label={catalogText("workshop:close_thread_5110caa6")} title={catalogText("workshop:close_thread_5110caa6")}
              onClick={() => setThread(null)}
            >
              <XIcon aria-hidden="true" />
            </button>} messages={{"aria-label":"workshop:close_thread_5110caa6","title":"workshop:close_thread_5110caa6"}} />
          )}
        />
      ) : null}
    </section>} resolve={() => ({ get "aria-label"() { return tr("workshop:value1_discussion_77d181cd", { value1: name }); } })} />
  );
}
