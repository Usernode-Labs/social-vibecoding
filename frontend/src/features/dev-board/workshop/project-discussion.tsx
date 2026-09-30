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
 */

import { useEffect, useRef, type ReactNode } from 'react';

import type { CommunityPayload } from './community-card';
import { EmbeddedConversation } from '../../messages';
import { navStore } from '../../nav/nav-store.js';
import { useStoreState } from '../../../lib/use-store-state';

type Channel = NonNullable<CommunityPayload['channel']>;

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

export function ProjectDiscussion({ slug, name, data }: {
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

  if (!data) return null;
  if (room) {
    return (
      <section
        className="dev-ws-discussion"
        data-ws-discussion=""
        data-ws-discussion-room={channel?.handle || ''}
        aria-label={`${name} discussion`}
      >
        <EmbeddedConversation conversationId={room} active={onShow} />
      </section>
    );
  }
  if (!mountable) {
    return <p className="dev-ws-week-note" data-ws-discussion-none="">This project has no discussion you can read.</p>;
  }
  return (
    <section className="dev-ws-discussion" data-ws-discussion="" aria-label={`${name} discussion`}>
      <div ref={host} className="dev-ws-discussion-host" />
    </section>
  );
}
