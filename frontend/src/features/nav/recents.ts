/**
 * The desktop rail's Recents, as one list (#2802).
 *
 * "What was I just doing" has two kinds of answer on this platform: an app
 * you stepped out of, and a conversation — a DM, a group chat, a channel or
 * an agent chat. The rail used to answer the first with a single Resume strip
 * at its foot and left the second to the Messages tab. This merges both onto
 * ONE clock, newest first, and keeps as many as the rail has room for.
 *
 * NOT ../messages/inbox.ts's order. The inbox puts channels in a section of
 * their own after the chats (#2783), because a channel is a room you visit
 * rather than a thread waiting on you. A recents list is a history, so a
 * channel you were just in sits exactly where its clock says.
 *
 * PURE ON PURPOSE, for the reason inbox.ts is: the order and the cut are the
 * whole argument, and a test should drive them with plain arrays.
 */

import { agentActivity, type AgentActivity } from '../agent-session/activity';
import type { AgentChat, AppDiscussion } from '../messages/inbox';

/** An app you left, as ./recent-apps-store.js keeps it. */
export interface RecentApp {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  at: string;
}

export type RecentKind = 'app' | 'direct' | 'group' | 'channel' | 'agent';

export interface RecentItem {
  /** Unique across kinds: the kind is part of it. */
  key: string;
  kind: RecentKind;
  label: string;
  /** Where the row goes. Apps resume through the router instead, but keep a
   *  real address so a modified click opens a tab. */
  href: string;
  /** ISO, or null when the source has no clock. */
  at: string | null;
  unread: boolean;
  /** Only for `agent` sessions: working (a spinner) or finished unseen (a green dot). */
  activity?: AgentActivity;
  /** Only for `app`: what the tile draws and what resuming opens. */
  app?: { slug: string; name: string; iconUrl: string | null; iconEmoji: string | null };
  /** Only for an Active row (#3074): the app the viewer is in right now. */
  current?: boolean;
}

/** The part of a conversation summary the merge reads. */
export interface RecentConversation {
  id: number;
  kind: 'direct' | 'group' | 'channel';
  title: string;
  lastActivityAt: string;
  unreadCount: number;
  archived?: boolean;
  channelKey?: string | null;
  peer?: { id: number; username: string } | null;
  members?: Array<{ id: number; username: string }>;
  /** An unanswered request's sender — its only name before it is accepted. */
  membershipStatus?: string;
  requester?: { id: number; username: string } | null;
}

/** An agent session (#2779): a conversation with the Mayor, by its own clock. */
export interface RecentAgentSession {
  id: number;
  title: string | null;
  status: string;
  lastActivityAt: string | null;
  createdAt?: string | null;
  activeChange?: unknown;
  busy?: boolean;
  doneUnseen?: boolean;
}

/** How many rows the list holds (#2878). NOT how many the rail shows: the
 *  list runs down the rest of the rail to the rule above Me and scrolls
 *  inside it (app.css), so a tall window shows more history and a short one
 *  scrolls. This is only the ceiling on how far back that history goes. */
export const RECENTS_LIMIT = 30;

function stamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function directLabel(item: RecentConversation, viewerId: number | null): string {
  // QA 2026-09-24 Q33a: a request the viewer has not answered carries no
  // peer and no roster, but it does carry who sent it — name them, as the
  // Messages list does, rather than "Direct message".
  const peer = item.peer
    || (item.members || []).find((member) => Number(member.id) !== viewerId)
    || (item.membershipStatus === 'invited' ? item.requester : null)
    || null;
  return peer?.username ? `@${peer.username}` : item.title;
}

export function buildRecents(input: {
  apps: RecentApp[];
  conversations: RecentConversation[];
  discussions: AppDiscussion[];
  agents: AgentChat[];
  /** Agent sessions (#2779 follow-up): conversations too, so recent ones are here. */
  agentSessions?: RecentAgentSession[];
  viewerId?: number | null;
  limit?: number;
  /** #3074: the apps listed under Active, which Recents leaves out. Dropped
   *  BEFORE the cut, so an active app never costs Recents a row. */
  active?: string[];
}): RecentItem[] {
  const viewerId = input.viewerId ?? null;
  const active = input.active || [];
  const items: RecentItem[] = [];
  for (const app of input.apps) {
    if (active.includes(app.slug)) continue;
    items.push({
      key: `app:${app.slug}`,
      kind: 'app',
      label: app.name,
      href: `/app/${encodeURIComponent(app.slug)}`,
      at: app.at || null,
      unread: false,
      app: { slug: app.slug, name: app.name, iconUrl: app.iconUrl, iconEmoji: app.iconEmoji },
    });
  }
  for (const item of input.conversations) {
    // An archived conversation is one the viewer put away; it is not recent
    // in any sense they would recognise.
    if (item.archived) continue;
    const kind: RecentKind = item.kind === 'channel' ? 'channel' : item.kind === 'group' ? 'group' : 'direct';
    items.push({
      key: `conversation:${item.id}`,
      kind,
      label: kind === 'channel'
        ? `#${item.channelKey || item.title}`
        : kind === 'direct' ? directLabel(item, viewerId) : item.title,
      href: `#messages/${item.id}`,
      at: item.lastActivityAt || null,
      unread: item.unreadCount > 0,
    });
  }
  // An app's channel carries no unread count: `chat_messages` has no
  // per-viewer read cursor (../messages/index.tsx, AppChannelRow). A channel
  // nobody has spoken in has no clock, so nothing happened there recently
  // and it is left out rather than padding the list.
  for (const item of input.discussions) {
    if (!item.lastAt) continue;
    items.push({
      key: `discussion:${item.slug}`,
      kind: 'channel',
      label: `#${item.channel || item.slug}`,
      href: `#messages/app/${encodeURIComponent(item.slug)}`,
      at: item.lastAt,
      unread: false,
    });
  }
  for (const item of input.agents) {
    items.push({
      key: `agent:${item.id}`,
      kind: 'agent',
      label: item.title || 'Untitled chat',
      href: `#chat/${encodeURIComponent(item.id)}`,
      at: item.updatedAt || item.createdAt || null,
      unread: false,
    });
  }
  for (const item of input.agentSessions || []) {
    // An untitled one with no change has had nothing said in it yet (the
    // first message titles it): nothing to go back to.
    if (item.status !== 'open' || !(item.title || item.activeChange)) continue;
    items.push({
      key: `agent-session:${item.id}`,
      kind: 'agent',
      label: item.title || 'New session',
      href: `#messages/agent/${item.id}`,
      at: item.lastActivityAt || item.createdAt || null,
      unread: false,
      activity: agentActivity(item),
    });
  }
  return pick(items, input.limit);
}

/* ── ACTIVE (#3074) ────────────────────────────────────────────────────
 *
 * The apps running right now: the ones with a live frame, which already carry
 * the green "still open" dot (../app-frame/live-apps.tsx). The rail lists them
 * in a section of their own ABOVE Recents, and Recents leaves them out
 * (buildRecents' `active`), so nothing is listed twice. When a frame goes
 * (evicted, rebuilt, sign-out) its app drops out of `live` and so back into
 * Recents, at the time it was left.
 *
 * In the frame store's order: the app the viewer is in first (`current`,
 * which the row highlights), then the kept ones, most recently used first.
 *
 * The name and icon are Recents' own (./recent-apps-store.js), so an active
 * row is the row the app had in Recents. The app the viewer is in may never
 * have been left, and so not be there yet: `known` is what else the caller
 * has for it (the open app's header record), and the slug is the last resort,
 * which is what the Resume strip falls back to as well. */

export interface ActiveAppInfo {
  slug: string;
  name?: string | null;
  iconUrl?: string | null;
  iconEmoji?: string | null;
}

export function buildActive(input: {
  /** Slugs with a live frame, in liveAppSlugs' order. */
  live: string[];
  /** The slug of the app on screen (currentAppOnScreen), or null when the
   *  viewer is in none. */
  current: string | null;
  apps: RecentApp[];
  known?: ActiveAppInfo[];
}): RecentItem[] {
  const items: RecentItem[] = [];
  for (const slug of input.live) {
    if (!slug || items.some((item) => item.app?.slug === slug)) continue;
    const found: ActiveAppInfo = input.apps.find((app) => app.slug === slug)
      || (input.known || []).find((app) => app.slug === slug && app.name)
      || { slug };
    const name = found.name || slug;
    items.push({
      key: `app:${slug}`,
      kind: 'app',
      label: name,
      href: `/app/${encodeURIComponent(slug)}`,
      at: null,
      unread: false,
      app: { slug, name, iconUrl: found.iconUrl || null, iconEmoji: found.iconEmoji || null },
      current: slug === input.current,
    });
  }
  // The app the viewer is in leads, whatever order the caller passed.
  return items.sort((a, b) => Number(!!b.current) - Number(!!a.current));
}

/**
 * The app ON SCREEN, which is the only Active row lit (#3096), or null.
 *
 * NOT the mounted frame on its own. The frame store's `slug` is the app whose
 * frame is mounted, and it stays set for as long as that frame is: it is
 * cleared only when the app is retired by backing out to Home (app.js goHome)
 * or dropped. Leaving it any other way — a rail or tab-bar row to Messages,
 * Discover, Workshop or Me, a Recents row, the app's own Workshop (the frame
 * is PARKED behind it, app-view.js _parkAppFrame) or its discussion — keeps
 * the frame mounted, so a row lit from `slug` alone stayed lit on screens that
 * had nothing to do with the app.
 *
 * So the router's answer decides, as it does for everything else in the
 * rail: the app is on screen only while the router's screen is `#app-view`
 * AND no tab is lit. `#app-view` with a tab lit is the app's Workshop or one
 * of its message threads (App._showOnlyScreen passes the override), where the
 * lit tab is the rail's one "you are here" and the app row must not compete.
 */
export function currentAppOnScreen(input: {
  /** The mounted frame's slug, '' or null when none is. */
  frameSlug: string | null;
  /** navStore's `screen`: the root the router last revealed. */
  screen: string | null;
  /** navStore's `tab`: the tab that screen lights, or null. */
  tab: string | null;
}): string | null {
  if (input.screen !== 'app-view' || input.tab) return null;
  return input.frameSlug || null;
}

/** Newest first, a row with no clock last, stable within a timestamp. */
function pick(items: RecentItem[], limit = RECENTS_LIMIT): RecentItem[] {
  return items
    .slice()
    .sort((a, b) => {
      const diff = stamp(b.at) - stamp(a.at);
      return Number.isNaN(diff) ? 0 : diff;
    })
    .slice(0, limit);
}

/* ── BY DAY (#2919) ────────────────────────────────────────────────────
 *
 * The list reads as one run of rows, so "when was that?" had no answer short
 * of opening the row. It is cut into the viewer's own calendar days, each with
 * a small label: Today, Yesterday, then "2 days ago" through "5 days ago".
 * Anything before those six days, and a row with no clock at all, is folded
 * behind one "Show N older" control, closed on every load.
 *
 * CALENDAR DAYS, NOT 24-HOUR SPANS, in the viewer's own zone: a DM from
 * 11:50pm last night is "Yesterday" at 12:05am, which is what a person means
 * by the word. Rounding the midnight-to-midnight gap absorbs the 23- and
 * 25-hour days a daylight-saving change makes.
 *
 * GROUPING ONLY. The rows arrive in buildRecents' order and at its count, and
 * reading the groups top to bottom, then the older tail, gives them back in
 * exactly that order: no row moves and none is dropped. */

/** Today and the five days before it each get a label; older is folded. */
export const RECENT_DAYS = 6;

/** QA 2026-09-24 Q31: the fewest rows the list shows while folded. A viewer
 *  whose whole history is older than the labelled days used to see only
 *  "RECENTS" over "Show N older", which reads as an empty list. So when the
 *  labelled days hold fewer than this, the newest older rows top them up
 *  under an "Earlier" label and only the rest fold. */
export const RECENTS_MIN_SHOWN = 3;

export interface RecentDay {
  /** 0 is today, 1 yesterday, and so on, in the viewer's calendar. */
  daysAgo: number;
  label: string;
  items: RecentItem[];
}

export interface RecentGroups {
  /** Only the days that have a row, newest first. */
  days: RecentDay[];
  /** Before the labelled days but shown anyway, under "Earlier", so the
   *  folded list is never shorter than RECENTS_MIN_SHOWN rows while it has
   *  that many (QA 2026-09-24 Q31). Empty when the days already fill it. */
  earlier: RecentItem[];
  /** The rest of the rows before the labelled days, or with no clock:
   *  behind "Show N older". */
  older: RecentItem[];
}

export function recentDayLabel(daysAgo: number): string {
  if (daysAgo <= 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  return `${daysAgo} days ago`;
}

function localMidnight(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Whole calendar days from `at` to `now` in the local zone. A clock a
 *  little ahead of this one (another device's) counts as today. */
export function daysAgo(at: number, now: number): number {
  return Math.max(0, Math.round((localMidnight(now) - localMidnight(at)) / 86400000));
}

export function groupRecents(items: RecentItem[], now: number = Date.now()): RecentGroups {
  const days: RecentDay[] = [];
  const older: RecentItem[] = [];
  for (const item of items) {
    const at = stamp(item.at);
    const ago = Number.isFinite(at) ? daysAgo(at, now) : Number.POSITIVE_INFINITY;
    if (ago >= RECENT_DAYS) {
      older.push(item);
      continue;
    }
    let day = days.find((entry) => entry.daysAgo === ago);
    if (!day) {
      day = { daysAgo: ago, label: recentDayLabel(ago), items: [] };
      days.push(day);
    }
    day.items.push(item);
  }
  days.sort((a, b) => a.daysAgo - b.daysAgo);
  // Top up from the front of the older rows, which are the newest of them:
  // reading days, then earlier, then older is still buildRecents' order.
  const shown = days.reduce((sum, day) => sum + day.items.length, 0);
  const topUp = Math.max(0, RECENTS_MIN_SHOWN - shown);
  const earlier = older.splice(0, topUp);
  return { days, earlier, older };
}
