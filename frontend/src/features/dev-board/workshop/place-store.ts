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
}

export const placeStore = createStore<PlaceState>({ slug: null, place: 'status', owed: 0 });

let opener: { slug: string; open: (key: PlaceKey) => void } | null = null;

/** The page says how to move it, while it is mounted. Returns the undo. */
export function registerPlaceOpener(slug: string, open: (key: PlaceKey) => void): () => void {
  const mine = { slug, open };
  opener = mine;
  return () => { if (opener === mine) opener = null; };
}

/** The page says where it is. */
export function publishPlace(slug: string | null, place: PlaceKey, owed: number): void {
  placeStore.set({ slug, place, owed: Math.max(0, Number(owed) || 0) });
}

/** The page is gone (unmounted, or another project is on it). */
export function clearPlace(slug: string): void {
  if (placeStore.get().slug === slug) placeStore.set({ slug: null, place: 'status', owed: 0 });
}

type ViewApi = { _landOnTab?: (slug: string, tab: string) => void };
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

/**
 * A topic's channel by its registry row (a notification's address names the
 * thread, `#messages/app/<slug>/c/<id>/m/<id>`): the channel's place once the
 * project's record says which topic that is, replacing the address it came
 * from. A row the record does not know opens #general.
 */
export async function openTopicRef(slug: string, ref: number): Promise<void> {
  if (!slug) return;
  let record = cachedCommunity(slug);
  const known = () => channelsOf(record?.places).some((c) => c.kind === 'topic' && Number(c.id) === Number(ref));
  if (!known()) {
    try { await reloadCommunity(slug); } catch { /* #general below */ }
    record = cachedCommunity(slug);
  }
  const topic = channelsOf(record?.places).find((c) => c.kind === 'topic' && Number(c.id) === Number(ref)) || null;
  openPlace(slug, topic ? channelPlace(topic.handle) : 'discussion', { replace: true });
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
  w.UsernodeReact.places = { topicHandles, openPlace, openTopicRef };
}
