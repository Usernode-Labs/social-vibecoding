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
 * (the thread reads Messages' one route, and its composer's ids are global).
 * So its Discussion tab IS that conversation: pressing it opens #general in
 * Messages, whose back goes to this hub (#3407) (#852 review: it was the
 * hub's channel card, composer and all, which read as a preview rather than
 * the room). `discussionElsewhere` says where, for the page's tab and the hub
 * card's doors.
 *
 * A COLD `?ws=discussion` IS A DOOR, NOT A FORWARD. Forwarding from a deep
 * link raced the router's own "back to where the app was opened from" on a
 * fresh load (measured: a phone landed on Home), and forwarding by a pushed
 * entry would leave the `ws=discussion` address under it, so Back would
 * forward again. The tab press is the one path that goes straight there.
 */

import { useEffect, useRef, type ReactNode } from 'react';

import type { CommunityPayload } from './community-card';
import { callAppView } from '../card/fold';

type Channel = NonNullable<CommunityPayload['channel']>;

/** A channel this page can mount: an app's own, addressed in Messages' app threads. */
function embeddable(channel: Channel | null): boolean {
  return !!channel && channel.handle !== 'general'
    && (!channel.href || channel.href.startsWith('#messages/app/'));
}

/**
 * Where the discussion is when it cannot be mounted here: #general's address
 * in Messages (`#messages/<id>`). Null for a channel the page mounts itself,
 * and for none.
 */
export function discussionElsewhere(data: CommunityPayload | null | undefined): string | null {
  const channel = data?.channel || null;
  return channel && !embeddable(channel) && channel.href ? channel.href : null;
}

/** Go to the discussion's own room; the page reopens on its hub after. */
export function openDiscussionElsewhere(href: string): void {
  callAppView('_setWorkshopTab', 'status');
  try { window.location.hash = href; } catch { /* no window */ }
}

export function ProjectDiscussion({ slug, name, data }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
}): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const channel = data?.channel || null;
  const mountable = embeddable(channel);
  const elsewhere = discussionElsewhere(data);
  const readOnly = !channel?.post_url;

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
  if (elsewhere) {
    const handle = channel?.handle || 'general';
    return (
      <section className="dev-ws-strip" data-ws-discussion-elsewhere="">
        <div className="dev-ws-head">
          <span className="dev-ws-head-title">{`#${handle}`}</span>
        </div>
        <p className="dev-ws-week-note">{`${name}'s discussion is #${handle}, in Messages.`}</p>
        <button
          type="button"
          className="dev-ws-hub-open un-touch-target"
          data-ws-discussion-open=""
          onClick={() => openDiscussionElsewhere(elsewhere)}
        >
          {`Open #${handle}`}
        </button>
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
