/**
 * The community the Communities tab is on, and the switcher that changes it.
 *
 * ── What the tab is ────────────────────────────────────────────────────
 *
 * The fourth tab is the community you are in: its tile in a square ring, its
 * short name, and how many votes it is waiting on you for. With none chosen it
 * is All communities, a dark tile in the same ring labelled Communities, and
 * its page is the list of every community you are in.
 *
 * WHICH ONE is the router's answer, not a second memory: the tab already
 * reopens the project page you left (App._noteWorkshopView keeps it in
 * localStorage, App._forgetWorkshopView drops it when the list is shown), so
 * the scope is that same slug. app.js tells this store when either happens
 * (`setScope`), and on a cold load `hydrate()` reads the same key.
 *
 * WHAT IT LOOKS LIKE is described by whoever knows: a project page publishes
 * its own name, icon, colour and votes owed (`describe`), and the switcher's
 * read of every community fills in the rest. The chosen community's
 * description is kept beside the key, so the tab draws its tile on a cold
 * load without waiting for a read.
 *
 * ── The switcher ───────────────────────────────────────────────────────
 *
 * "Your communities": All communities first, then each community you are in,
 * then "Join or start a community". It opens from the phone's tab pressed
 * while it is already lit, from the community's name and ⌄ in the coloured
 * header, and from the header's "Communities ⌄" on the Communities list.
 * `openSwitcher(from)` says where, so a wide window can hang the menu off
 * whatever opened it.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The store starts empty, which is what the prerendered tab bar draws (the
 * plain Communities tab); everything here arrives from effects and from
 * app.js after the first paint.
 */

import { createStore } from '../../lib/plain-store.js';
import { orderRows } from './sections';

export interface CommunityInfo {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  /** What dapp.json set (`icon.color`), if anything. */
  iconColor: string | null;
  audience?: 'open' | 'invited' | 'solo' | string;
  memberCount?: number;
  /** Votes owed by the viewer here. */
  needs?: number;
  selfHosted?: boolean;
  lastActiveAt?: string | null;
}

/** Where the switcher was opened from: the phone's tab, or the header. */
export type SwitcherFrom = 'tab' | 'header';

export interface CommunityScopeState {
  /** The community the tab is on, or null for All communities. */
  slug: string | null;
  /** What is known about each community, by slug. */
  info: Record<string, CommunityInfo>;
  /** Every community you are in, in the switcher's order, once read. */
  list: string[] | null;
  /** Votes owed across all of them, once counted. */
  totalNeeds: number | null;
  /** Where the open switcher was opened from; null when it is shut. */
  switcher: SwitcherFrom | null;
  /** The opener's box, for a menu that hangs off it on a wide window. */
  anchor: { top: number; left: number; right: number; bottom: number } | null;
}

const INITIAL: CommunityScopeState = {
  slug: null, info: {}, list: null, totalNeeds: null, switcher: null, anchor: null,
};

export const communityScopeStore = createStore(INITIAL);

/** app.js's own key for the project page the tab reopens. */
const VIEW_KEY = 'usernode_workshop_view_v1';
/** The chosen community's description, kept for a cold paint. */
const INFO_KEY = 'communityScopeInfo:v1';

function readViewSlug(): string | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(VIEW_KEY) || 'null');
    return v && typeof v.slug === 'string' && v.slug ? v.slug : null;
  } catch {
    return null;
  }
}

function saveInfo(info: CommunityInfo | null): void {
  try {
    if (info) window.localStorage.setItem(INFO_KEY, JSON.stringify(info));
    else window.localStorage.removeItem(INFO_KEY);
  } catch { /* a cold paint without the tile is the old behaviour */ }
}

let hydrated = false;
/** Read what the last visit left, once, after the first paint. */
export function hydrateCommunityScope(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  const slug = readViewSlug();
  let info: CommunityInfo | null = null;
  try {
    const raw = JSON.parse(window.localStorage.getItem(INFO_KEY) || 'null');
    if (raw && typeof raw.slug === 'string') info = raw as CommunityInfo;
  } catch { /* nothing kept */ }
  const cur = communityScopeStore.get();
  communityScopeStore.set({
    slug: cur.slug || slug,
    info: info && info.slug === slug && !cur.info[slug] ? { ...cur.info, [slug]: info } : cur.info,
  });
}

/** The router's word: the tab is now on `slug`, or on All communities. */
export function setScope(slug: string | null): void {
  const cur = communityScopeStore.get();
  if (cur.slug === slug) return;
  communityScopeStore.set({ slug });
  saveInfo(slug ? cur.info[slug] || null : null);
}

/** What someone knows about a community: merged into what is known. */
export function describe(slug: string, patch: Partial<CommunityInfo>): void {
  if (!slug) return;
  const cur = communityScopeStore.get();
  const prev = cur.info[slug];
  const base: CommunityInfo = prev || { slug, name: slug, iconUrl: null, iconEmoji: null, iconColor: null };
  const next: CommunityInfo = {
    ...base,
    ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<CommunityInfo>),
    slug,
  };
  if (prev && Object.keys(next).every((k) => (next as any)[k] === (prev as any)[k])) return;
  const info = { ...cur.info, [slug]: next };
  const totalNeeds = cur.list
    ? cur.list.reduce((sum, s) => sum + (Number(info[s]?.needs) || 0), 0)
    : cur.totalNeeds;
  communityScopeStore.set({ info, totalNeeds });
  if (cur.slug === slug) saveInfo(next);
}

export function openSwitcher(from: SwitcherFrom, anchorEl?: Element | null): void {
  let anchor: CommunityScopeState['anchor'] = null;
  try {
    const r = anchorEl?.getBoundingClientRect();
    if (r) anchor = { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  } catch { /* no box: the sheet needs none */ }
  communityScopeStore.set({ switcher: from, anchor });
  void loadCommunities();
}

export function closeSwitcher(): void {
  communityScopeStore.set({ switcher: null, anchor: null });
}

export function toggleSwitcher(from: SwitcherFrom, anchorEl?: Element | null): void {
  if (communityScopeStore.get().switcher) closeSwitcher();
  else openSwitcher(from, anchorEl);
}

function demoQuery(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

type AppRow = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  icon_color?: string | null;
  audience?: string;
  member_count?: number;
  last_active_at?: string | null;
  self_hosted?: boolean;
  demo?: boolean;
  is_member?: boolean;
};

let loading: Promise<void> | null = null;
let loadedAt = 0;

/**
 * Every community you are in, with what each is waiting on you for: GET
 * /api/apps (the rows the Communities list reads, joined the way it joins
 * them) and GET /api/workshop/counts (votes owed, `needs`). At most every
 * thirty seconds; the switcher asks on each open.
 */
export function loadCommunities(force = false): Promise<void> {
  if (loading) return loading;
  if (!force && Date.now() - loadedAt < 30_000 && communityScopeStore.get().list) return Promise.resolve();
  const q = demoQuery();
  loading = (async () => {
    try {
      const [appsRes, countsRes] = await Promise.all([
        fetch(`/api/apps${q}`, { credentials: 'same-origin' }),
        fetch(`/api/workshop/counts${q}`, { credentials: 'same-origin' }).catch(() => null),
      ]);
      if (!appsRes.ok) return;
      const body = await appsRes.json();
      const rows: AppRow[] = Array.isArray(body) ? body : (body && Array.isArray(body.apps) ? body.apps : []);
      const home = (window as any).Home;
      const joined = rows.filter((r) => r && r.slug && (
        typeof home?.isJoined === 'function' ? home.isJoined(r) : !!r.is_member
      ));
      let counts: Record<string, { needs?: number }> = {};
      if (countsRes && countsRes.ok) {
        const c = await countsRes.json().catch(() => null);
        counts = (c && c.counts) || {};
      }
      // Newest first, the order the Communities list and its sections use.
      const ordered = orderRows(joined as any) as unknown as AppRow[];
      const cur = communityScopeStore.get();
      const info = { ...cur.info };
      for (const r of ordered) {
        info[r.slug] = {
          ...(info[r.slug] || {}),
          slug: r.slug,
          name: r.name || r.slug,
          iconUrl: r.icon_url || null,
          iconEmoji: r.icon_emoji || null,
          iconColor: r.icon_color || null,
          audience: r.audience,
          memberCount: Number(r.member_count) || 0,
          needs: Number(counts[r.slug]?.needs) || 0,
          selfHosted: !!r.self_hosted,
          lastActiveAt: r.last_active_at || null,
        };
      }
      const list = ordered.map((r) => r.slug);
      communityScopeStore.set({
        info,
        list,
        totalNeeds: list.reduce((sum, s) => sum + (Number(info[s]?.needs) || 0), 0),
      });
      if (cur.slug && info[cur.slug]) saveInfo(info[cur.slug]);
      loadedAt = Date.now();
    } catch {
      /* the switcher says it could not load; the tab keeps what it had */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Read every community a moment after sign-in, so the tab's badge can say
 * what is waiting before anybody opens the switcher. Returns a cancel.
 */
export function warmCommunities(delayMs = 1500): () => void {
  const timer = window.setTimeout(() => { void loadCommunities(); }, delayMs);
  return () => window.clearTimeout(timer);
}

/** The short name a tab label has room for: the name, cut at a word. */
export function shortName(name: string, max = 12): string {
  const n = String(name || '').trim();
  if (n.length <= max) return n;
  const cut = n.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at >= 4 ? cut.slice(0, at) : n.slice(0, max)).trim();
}

/**
 * Go to a community from the switcher: All communities is the list (and
 * forgets the page the tab reopened), a community is its hub.
 */
export function goToCommunity(slug: string | null): void {
  closeSwitcher();
  const app = (window as any).App;
  if (!slug) {
    setScope(null);
    try { app?._forgetWorkshopView?.(); } catch { /* nothing to forget */ }
    if (window.location.hash !== '#communities') window.location.hash = '#communities';
    return;
  }
  setScope(slug);
  try { (window as any).AppView?._landOnHub?.(slug); } catch { /* the page opens where it opens */ }
  // Already on its page (the lander, not a card or a session under it):
  // _landOnHub has turned it to the hub, and there is nowhere to go.
  const onPage = app?.currentApp === slug
    && !!document.querySelector('#app-view:not(.hidden) #dev-workshop > .dev-ws');
  if (onPage) return;
  void app?.navigateToApp?.(slug, 'dev');
}

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.communityScope = { setScope, describe, openSwitcher, closeSwitcher, loadCommunities };
}
