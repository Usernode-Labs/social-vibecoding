/**
 * THE PLACE ON SHOW, for everything that is not the page (#4417).
 *
 * The project page (./workshop.tsx DevWorkshop) owns which of its places is
 * up — Hub, Needs you, Workshop, #general or a topic's channel — as its own
 * state, because a press there also pushes a history entry, scrolls the page
 * and remembers where it was. Several things outside that component draw the
 * place or move it: the places list in the section column beside the strip
 * on desktop (../../nav/section-column.tsx), the card a merged topic leaves
 * in a channel's history (./merged-topic-card.tsx), and a topic's head line.
 *
 * So the page publishes the place it shows here, and registers the one way
 * to move it (`openTab`), and they read and call those. When the page is not
 * mounted for that project, `openPlace` goes the way every door goes: it
 * remembers the place (AppView._landOnTab) and routes to the page.
 */

import { createStore } from '../../../lib/plain-store.js';
import { cachedCommunity, communityInflight, reloadCommunity } from './community-card';
import { channelPlace, channelsOf, topicHandleMap, type PlaceKey } from './places';

export interface PlaceState {
  /** The project whose page is mounted, or null. */
  slug: string | null;
  /** The place it shows. */
  place: PlaceKey;
  /** The votes waiting on the viewer there, less the ones seen (the page's own count). */
  owed: number;
  /**
   * An item's page is open in the panel beside the list (./side-panel.tsx).
   * Under 1296px the places column steps aside for it
   * (../../nav/section-column.tsx).
   */
  side: boolean;
}

export const placeStore = createStore<PlaceState>({ slug: null, place: 'status', owed: 0, side: false });

let opener: { slug: string; open: (key: PlaceKey) => void } | null = null;

/** The page says how to move it, while it is mounted. Returns the undo. */
export function registerPlaceOpener(slug: string, open: (key: PlaceKey) => void): () => void {
  const mine = { slug, open };
  opener = mine;
  return () => { if (opener === mine) opener = null; };
}

/** The page says where it is. */
export function publishPlace(slug: string | null, place: PlaceKey, owed: number): void {
  const was = placeStore.get();
  placeStore.set({ slug, place, owed: Math.max(0, Number(owed) || 0), side: was.slug === slug && was.side });
}

/** The page says whether an item's page is open beside its list. */
export function publishSide(slug: string, side: boolean): void {
  const was = placeStore.get();
  if (was.slug === slug && was.side !== side) placeStore.set({ ...was, side });
}

/** The page is gone (unmounted, or another project is on it). */
export function clearPlace(slug: string): void {
  if (placeStore.get().slug === slug) placeStore.set({ slug: null, place: 'status', owed: 0, side: false });
}

type ViewApi = {
  _landOnTab?: (slug: string, tab: string) => void;
  _stashDiscussionTarget?: (slug: string, target: Record<string, unknown>) => void;
};
type AppApi = { _hubHref?: (slug: string) => string };

/**
 * Go to `key` on `slug`'s page: in place when the page is up for it (a press
 * on its list), else as a door (the place remembered, then the page's
 * address). True when it moved the page in place.
 */
export function openPlace(slug: string, key: PlaceKey, opts: { replace?: boolean } = {}): boolean {
  if (opener && opener.slug === slug && placeStore.get().slug === slug) {
    opener.open(key);
    return true;
  }
  const w = window as unknown as { AppView?: ViewApi; App?: AppApi };
  try { w.AppView?._landOnTab?.(slug, key); } catch { /* the page opens on what it remembers */ }
  let href = '';
  try { href = w.App?._hubHref?.(slug) || ''; } catch { href = ''; }
  const to = href || `#app/${encodeURIComponent(slug)}/workshop`;
  // A redirect (an old address the router is turning into this one) takes
  // its entry's place, so Back does not land on it and redirect again.
  if (opts.replace) window.location.replace(to.startsWith('#') ? to : `#${to}`);
  else window.location.hash = to;
  return false;
}

/** What a door names in a channel: a message to bring into view, a reply thread to open. */
export interface ChannelTarget {
  focusMessageId?: number | null;
  threadRootId?: number | null;
}

/**
 * A topic's channel by its registry row (a notification's address names the
 * thread, `#messages/app/<slug>/c/<id>/m/<id>`): the channel's place once the
 * project's record says which topic that is, replacing the address it came
 * from. A row the record does not know opens #general.
 *
 * #4417 follow-up: and the place in it the address named (`m/<id>`, a
 * message; `thread/<root>`, a reply thread), handed to the channel the way
 * #general's door hands it hers (AppView._stashDiscussionTarget), named for
 * this topic so only its place takes it (project-discussion.tsx
 * TopicChannel): the message brought into view and marked, the thread
 * opened beside the channel.
 */
export async function openTopicRef(slug: string, ref: number, target: ChannelTarget | null = null): Promise<void> {
  if (!slug) return;
  let record = cachedCommunity(slug);
  const known = () => channelsOf(record?.places).some((c) => c.kind === 'topic' && Number(c.id) === Number(ref));
  if (!known()) {
    try { await reloadCommunity(slug); } catch { /* #general below */ }
    record = cachedCommunity(slug);
  }
  const topic = channelsOf(record?.places).find((c) => c.kind === 'topic' && Number(c.id) === Number(ref)) || null;
  if (topic && target && (target.focusMessageId || target.threadRootId)) {
    const w = window as unknown as { AppView?: ViewApi };
    try {
      w.AppView?._stashDiscussionTarget?.(slug, {
        focusMessageId: target.focusMessageId || null,
        threadRootId: target.threadRootId || null,
        topicRef: Number(topic.id),
      });
    } catch { /* the channel opens at its newest */ }
  }
  openPlace(slug, topic ? channelPlace(topic.handle) : 'discussion', { replace: true });
}

/**
 * #4417 follow-up: a topic's channel was read (or marked unread) in the
 * group chat's pane (public/js/group-chat.js markRead / markUnread). The
 * places list's count for it is the project's record, read again when it
 * showed one, or when the reader asked for one back (`unread`).
 * #4647: `ref` null names #general, matched by its `kind: 'general'` row in
 * the same record.
 */
export function channelRead(slug: string, ref: number | null, unread = false): void {
  if (!slug) return;
  const record = cachedCommunity(slug);
  const channels = channelsOf(record?.places);
  const channel = ref == null
    ? channels.find((c) => c.kind === 'general') || null
    : channels.find((c) => c.kind === 'topic' && Number(c.id) === Number(ref)) || null;
  if (unread || (channel && Number(channel.unread) > 0)) void reloadCommunity(slug);
}

/*
 * `#name` IN A PROJECT'S CHAT (#4417). A channel reference resolves the
 * project's topic handles and aliases inside that project, beside the
 * platform's own channels. The chat renderer is legacy (public/js/group-chat.js
 * renderChannelChips), so it asks here, by the project's slug: the handles it
 * can link, each to the handle the topic has now. The first ask for a project
 * whose record is not read yet starts the read and answers nothing; the
 * next render links them.
 */
const askedFor = new Set<string>();
export function topicHandles(slug: string | null | undefined): Record<string, string> {
  const s = String(slug || '');
  if (!s) return {};
  const record = cachedCommunity(s);
  if (!record && !askedFor.has(s) && !communityInflight(s)) {
    askedFor.add(s);
    void reloadCommunity(s);
  }
  return topicHandleMap(record?.places);
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { UsernodeReact?: Record<string, unknown> };
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.places = { topicHandles, openPlace, openTopicRef, channelRead };
}
