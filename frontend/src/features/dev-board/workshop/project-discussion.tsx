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
 * ── Homeroom's own hub is the exception ───────────────────────────────
 *
 * Its channel is #general, which is a conversation of the Messages store
 * rather than an app chat, and has no pane that can be mounted elsewhere
 * (the general chat's ids are global, and Messages owns that one). So its
 * Discussion tab is the channel card in full, composer and all, with the way
 * to the room itself. So is any project whose channel the viewer may not
 * read.
 */

import { useEffect, useRef, type ReactNode } from 'react';

import type { CommunityPayload } from './community-card';
import { ChannelCard } from './hub-cards';

export function ProjectDiscussion({ slug, name, data }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
}): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const channel = data?.channel || null;
  // #general, or no channel to mount: the card, whole.
  const embeddable = !!channel && channel.handle !== 'general'
    && (!channel.href || channel.href.startsWith('#messages/app/'));
  const readOnly = !channel?.post_url;

  useEffect(() => {
    const el = host.current;
    if (!el || !embeddable) return undefined;
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
  }, [slug, name, readOnly, embeddable]);

  if (!data) return null;
  if (!embeddable) {
    return channel
      ? <ChannelCard slug={slug} name={name} data={data} />
      : <p className="dev-ws-week-note" data-ws-discussion-none="">This project has no discussion you can read.</p>;
  }
  return (
    <section className="dev-ws-discussion" data-ws-discussion="" aria-label={`${name} discussion`}>
      <div ref={host} className="dev-ws-discussion-host" />
    </section>
  );
}
