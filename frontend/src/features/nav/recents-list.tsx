/**
 * #platform-recents — what you were just doing, in the desktop rail (#2802).
 *
 * ./recents.ts carries the argument for the list and its order. What lives
 * here is what the rows have to get right as controls.
 *
 * ── It replaces the Resume strip, on the desktop ─────────────────────
 *
 * The rail's footer used to be #platform-parked: ONE app, the one you left,
 * with Resume. The apps here are that same offer, several of them, beside the
 * conversations you were in, so on the desktop app.css hides the strip and
 * this list is the way back. The phone keeps the strip: it has no rail, and
 * its bar is five tabs across the foot of the screen with no room for a list.
 *
 * ── A glyph per kind, and an app's own icon ─────────────────────────
 *
 * A person, a group, a channel's `#` and the agent's sparkle, so a mixed
 * list can be scanned for "the DM" or "the app" without reading every
 * label. An app draws ITS OWN icon (#2878) — the image or emoji the launcher
 * and Discover draw, through the same AppIconContent — because "an app" is
 * not what you are scanning for, "Chess" is. The generic app window is kept
 * only for an app that has no icon at all. A row with something unread carries a dot, which is all a
 * 224px rail has room to say; the count is on the Messages tab and the row.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * The root ships EMPTY and `hidden`. Every source is filled after hydration:
 * the apps from localStorage, the conversations and channels from the
 * Messages store's boot fetch, the agent chats from the global chat's own
 * store. Rows that the prerendered document did not have are a hydration
 * mismatch (React #418) on every route, so nothing renders until one commit
 * after mount — the pattern ../messages/index.tsx uses for its sessions.
 * `hidden` goes through useHiddenClass, so React never rewrites the class.
 *
 * It is inside #platform-tabs, so the phone's bar never shows it (app.css)
 * and a peeked rail carries it: pointing at a recent row keeps the peek up
 * because the row is the rail.
 *
 * ── Cut into days, the old tail folded (#2919) ──────────────────────
 *
 * ./recents.ts's groupRecents says which rows are Today, Yesterday and "2
 * days ago" through "5 days ago"; each day that has a row gets a small label
 * before it. They are plain text, not headings: the list's one heading is
 * Recents, and a heading per day in the rail would bury the page's outline.
 * Everything older sits behind a real button that says how many it holds,
 * and the button's `aria-expanded` is the state. The fold is component state,
 * so every page load starts closed; nothing is stored. The labels and the
 * button arrive with the rows, one commit after mount, so the prerender is
 * untouched, and a timer at the viewer's midnight re-renders the list so a
 * rail left open overnight moves today's rows under Yesterday.
 *
 * ── Active above Recents (#3074) ─────────────────────────────────────
 *
 * The apps running right now, the ones with the green "still open" dot, get
 * a section of their own at the top, with the app on screen highlighted
 * (`aria-current`) — on screen, not merely mounted (#3096): the router's
 * screen says so, since the frame stays mounted behind every other screen. ./recents.ts's buildActive says which and in what order,
 * and buildRecents leaves them out of Recents, so no app is listed twice; an
 * app whose frame goes returns to Recents. They are the same rows, drawn by
 * RecentRow. The section sits INSIDE #platform-recents, before its heading,
 * so the rail's children and the declared checks that walk them are
 * unchanged, and like every row it arrives one commit after mount. There is
 * no close button: a frame goes the way it always has.
 *
 * ── Resume, where a running app is waiting (#3618) ───────────────────
 *
 * An Active row whose app is NOT on screen carries a Resume pill in the
 * accent: it is the one action the row stands for, and before it the row read
 * as one more grey line in a list of places. The app you are in has none —
 * resuming where you already are is not an action. The pill is a label inside
 * the row's anchor (the row is the target, as the phone strip's pill is), and
 * aria-hidden, because the row's name already says the app is still open.
 * It is also where a closed app shrinks to and where a resumed one grows out
 * of (./resume-motion.ts): pressing the row notes it as the zoom's origin.
 *
 * ── A channel opens its project's Discussion tab (#3555) ─────────────
 *
 * A channel is a tab of its project's page (#3494), so its row lands there,
 * under the page's header and tab strip with Discussion lit, the way the
 * hub's Open does — not on the Messages screen with a chevron back up to
 * the hub. onDiscussionClick is the door; ./recents.ts decides which rows
 * are one.
 */

import { Fragment, useEffect, useRef, useState, type MouseEvent } from 'react';

import {
  AppWindowIcon, ChevronDownIcon, ChevronUpIcon, HashIcon, SparklesIcon, UserGroupIcon, UserIcon,
} from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { agoStamp } from '../../lib/timestamp';
import {
  LIVE_APP_LABEL, LiveAppDot, useCurrentAppSlug, useLiveAppSlugs,
} from '../app-frame/live-apps';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { loadAgentSessions, useAgentSessions } from '../agent-session/store';
import { ACTIVITY_LABEL } from '../agent-session/activity';
import { AgentActivityIcon } from '../agent-session/activity-mark';
import { useGlobalChatSelector } from '../global-chat/store';
import { improveStore } from '../improve/improve-store.js';
import { usePlatformSlug } from '../messages/channel-hub';
import type { AgentChat } from '../messages/inbox';
import { useMessagesSnapshot } from '../messages/store';
import { navStore } from './nav-store.js';
import { readRecentApps, recentAppsStore } from './recent-apps-store.js';
import { noteResumeOrigin } from './resume-motion';
import {
  buildActive, buildRecents, currentAppOnScreen, groupRecents, type RecentItem, type RecentKind,
} from './recents';

const GLYPHS: Record<RecentKind, typeof UserIcon> = {
  app: AppWindowIcon,
  direct: UserIcon,
  group: UserGroupIcon,
  channel: HashIcon,
  agent: SparklesIcon,
};

/** What the kind is called, for the row's accessible name. */
const KIND_NAMES: Record<RecentKind, string> = {
  app: 'App',
  direct: 'Direct message',
  group: 'Group chat',
  channel: 'Channel',
  agent: 'Agent chat',
};

function onAppClick(event: MouseEvent<HTMLAnchorElement>, slug: string, resume = false): void {
  const nav = (window as unknown as {
    NavLink?: { isNativeClick?: (e: unknown) => boolean };
  }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  event.preventDefault();
  // #3618: a running app grows back out of the Resume pill that was pressed.
  if (resume) {
    const row = event.currentTarget;
    noteResumeOrigin(slug, row.querySelector('.platform-recent-resume') || row);
  }
  // The router's "this app, this tab" entry point, which is what the Resume
  // strip used (./parked-strip.tsx): it switches tabs for an app that is
  // still open and navigates for any other.
  window.App?.openAppTab?.(slug, 'app');
}

/**
 * A channel's row is a DOOR TO ITS PROJECT'S DISCUSSION TAB (#3555), not to
 * the room on the Messages screen (./recents.ts says why). The door the
 * hub's links use, turned to the Discussion: AppView._landOnTab writes the
 * remembered tab and tells a page already open for the project to switch,
 * then the hub's own address (App._hubHref's spelling) opens the page, which
 * reads that tab when it mounts. The window's query rides along, which the
 * row's `?ws=` href, there for a new tab, would have dropped. Back and
 * Forward are not doors: the page reopens on the tab last shown. Exported
 * for tests/nav-recents.test.js, which presses it against a stand-in window.
 */
export function onDiscussionClick(event: MouseEvent<HTMLAnchorElement>, slug: string): void {
  const win = window as unknown as {
    NavLink?: { isNativeClick?: (e: unknown) => boolean };
    AppView?: { _landOnTab?: (slug: string, tab: string) => void };
  };
  if (win.NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  win.AppView?._landOnTab?.(slug, 'discussion');
  // Already on that page (the router keeps it at its clean path, with no
  // fragment): the door has turned it, and a second address for the same
  // page would only be a Back press that goes nowhere.
  const page = `/app/${encodeURIComponent(slug)}/workshop`;
  if (window.location.pathname === page && !window.location.hash) return;
  window.location.hash = `#app/${encodeURIComponent(slug)}/workshop`;
}

/** The app's own icon, as the launcher draws it. */
function AppTile({ app }: { app: NonNullable<RecentItem['app']> }) {
  const record = { icon_url: app.iconUrl, icon_emoji: app.iconEmoji, name: app.name };
  return (
    <span
      data-icon={appIconKind(record)}
      className="app-icon-tile platform-recent-tile"
      aria-hidden="true"
    >
      <AppIconContent app={record} />
    </span>
  );
}

function RecentRow({
  item, live, resume = false, now,
}: { item: RecentItem; live: boolean; resume?: boolean; now?: number }) {
  const Glyph = GLYPHS[item.kind];
  const app = item.app && (item.app.iconUrl || item.app.iconEmoji) ? item.app : null;
  const unread = item.unread ? ', unread' : '';
  const loaded = live ? `, ${LIVE_APP_LABEL}` : '';
  const doing = item.activity ? `, ${ACTIVITY_LABEL[item.activity].toLowerCase()}` : '';
  // #4025: an app row says when you were last in it, in agoStamp's compact
  // form, the one every other list prints. Only apps: a conversation's clock
  // is its own row's business, and an Active row's `at` is null (recents.ts
  // buildActive) because an app still open was not "last opened". Empty text
  // (no stored time, or one agoStamp cannot parse) renders nothing at all.
  const opened = item.kind === 'app' && item.at
    ? agoStamp(item.at, now === undefined ? {} : { now: new Date(now) })
    : null;
  const at = opened?.text ? opened : null;
  const lastOpened = at ? `, last opened ${at.text}` : '';
  return (
    <a
      className="platform-recent"
      href={item.href}
      data-recent-kind={item.kind}
      data-recent-key={item.key}
      aria-label={`${KIND_NAMES[item.kind]}: ${item.label}${loaded}${doing}${unread}${lastOpened}`}
      {...(live ? { 'data-live': 'true' } : null)}
      {...(item.current ? { 'aria-current': 'true' as const, 'data-current': 'true' } : null)}
      onClick={item.app
        ? (event) => onAppClick(event, item.app!.slug, resume)
        : item.discussion ? (event) => onDiscussionClick(event, item.discussion!.slug) : undefined}
    >
      {/* #2779: an agent session working (a spinner) or finished unseen (a
          green dot), either IN PLACE of the row's icon (#3028, #3076)
          rather than beside it, so a session reads as one mark. The row's
          accessible name says either (`doing`). */}
      {item.activity
        ? <AgentActivityIcon activity={item.activity} className="platform-recent-glyph" />
        : app ? <AppTile app={app} /> : <Glyph className="platform-recent-glyph" aria-hidden="true" />}
      <span className="platform-recent-label">{item.label}</span>
      {/* #4025: the quiet when-you-were-last-in-it stamp, beside the name. */}
      {at ? <span className="platform-recent-at" title={at.title}>{at.text}</span> : null}
      {/* #3618: the action the row stands for, on a running app you left. */}
      {resume ? <span className="platform-recent-resume" aria-hidden="true">Resume</span> : null}
      {/* #2902: still loaded — resuming it shows it exactly as it was left. */}
      {live ? <LiveAppDot className="platform-recent-live" /> : null}
      {item.unread ? <span className="platform-recent-dot" aria-hidden="true" /> : null}
    </a>
  );
}

/**
 * The rows under their day labels, and the fold for the rest (#2919). Its own
 * component so a test can render it from plain props: RecentsList shows no
 * rows before mount, which is all a static render ever sees.
 */
export function RecentsByDay({ items, live, showOlder, onToggleOlder, now }: {
  items: RecentItem[];
  live: string[];
  showOlder: boolean;
  onToggleOlder: () => void;
  now?: number;
}) {
  const { days, earlier, older } = groupRecents(items, now);
  const row = (item: RecentItem) => (
    <RecentRow
      key={item.key}
      item={item}
      live={!!item.app && live.includes(item.app.slug)}
      now={now}
    />
  );
  return (
    <>
      {days.map((day) => (
        <Fragment key={day.daysAgo}>
          <div className="platform-recents-day">{day.label}</div>
          {day.items.map(row)}
        </Fragment>
      ))}
      {/* QA 2026-09-24 Q31: the newest older rows, shown while folded so
          the list is never just a heading over a button. Opened, the rest
          follow straight on: they are earlier too, and a second label
          ("Older") under "Earlier" would say nothing new. */}
      {earlier.length ? (
        <>
          <div className="platform-recents-day">Earlier</div>
          {earlier.map(row)}
        </>
      ) : null}
      {showOlder && older.length ? (
        <>
          {earlier.length ? null : <div className="platform-recents-day">Older</div>}
          {older.map(row)}
        </>
      ) : null}
      {older.length ? (
        <button
          type="button"
          className="platform-recents-more"
          aria-expanded={showOlder}
          onClick={onToggleOlder}
        >
          {showOlder
            ? <ChevronUpIcon className="platform-recents-more-icon" aria-hidden="true" />
            : <ChevronDownIcon className="platform-recents-more-icon" aria-hidden="true" />}
          <span>{showOlder ? 'Show less' : `Show ${older.length} older`}</span>
        </button>
      ) : null}
    </>
  );
}

/**
 * The running apps, above Recents (#3074). Nothing at all while there are
 * none, which is also the initial render. Its own component so a test can
 * render it from plain props.
 */
export function ActiveApps({ items }: { items: RecentItem[] }) {
  if (!items.length) return null;
  return (
    <div className="platform-active" role="group" aria-labelledby="platform-active-head">
      <h2 id="platform-active-head" className="platform-recents-head">Active</h2>
      {items.map((item) => <RecentRow key={item.key} item={item} live resume={!item.current} />)}
    </div>
  );
}

/** Re-render at the viewer's next midnight, and each one after, so the day
 *  labels move on while the rail stays open. groupRecents reads the clock
 *  itself; this only makes sure it is asked again. */
function useMidnightRender(): void {
  const [day, setDay] = useState(() => new Date().setHours(0, 0, 0, 0));
  useEffect(() => {
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    // A second past midnight, so the wake never lands on the old day.
    const timer = window.setTimeout(
      () => setDay(new Date().setHours(0, 0, 0, 0)),
      Math.max(1000, next.getTime() - Date.now() + 1000),
    );
    return () => window.clearTimeout(timer);
  }, [day]);
}

export function RecentsList() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  // #2919: the rows before the labelled days, folded on every load.
  const [showOlder, setShowOlder] = useState(false);
  useMidnightRender();
  const { apps } = useStoreState(recentAppsStore);
  const snap = useMessagesSnapshot();
  const bootstrap = useGlobalChatSelector((s) => s.bootstrap);
  const threads = useGlobalChatSelector((s) => s.threads);
  const live = useLiveAppSlugs();
  const frameSlug = useCurrentAppSlug();
  const improve = useStoreState(improveStore);

  // POST-MOUNT, for hydration (see the header). The stored apps are read by
  // ./mount.ts when the router names the viewer, since the list is theirs;
  // this covers a viewer named before the island hydrated.
  const { viewer, screen, tab } = useStoreState(navStore);
  // #3096: lit only while the app is ON SCREEN, not merely mounted — the
  // frame outlives every way of leaving but Home (see currentAppOnScreen).
  const current = currentAppOnScreen({ frameSlug, screen, tab });
  useEffect(() => {
    setMounted(true);
    const current = navStore.get().viewer;
    if (current && !recentAppsStore.get().apps.length) {
      const stored = readRecentApps(current);
      if (stored.length) recentAppsStore.set({ apps: stored });
    }
  }, []);

  // Gated on the same two flags the Messages inbox reads, so a shell where
  // the experimental chat is off shows no agent rows here either.
  const agentsOn = !!bootstrap?.parityReady
    && bootstrap.profiles.globalChat.enabled === true;
  // Agent sessions (#2779 follow-up), read once the viewer is named; the
  // store keeps the list current as conversations start and move. The flag
  // or not, as Messages lists them: turning agent sessions off never hides a
  // conversation that already exists.
  const agentSessions = useAgentSessions();
  useEffect(() => {
    if (viewer) void loadAgentSessions();
  }, [viewer]);
  // #3555: #general's project, whose Discussion tab its row opens. Late on a
  // cold load (#3407), so the row is re-drawn when it lands.
  const platformSlug = usePlatformSlug(!!viewer);
  // #3074: the open app's header record names it before it has ever been
  // left, which is when Recents first learns it.
  const active = mounted && viewer
    ? buildActive({
      live,
      current,
      apps,
      known: improve.slug ? [{
        slug: improve.slug, name: improve.name, iconUrl: improve.iconUrl, iconEmoji: improve.iconEmoji,
      }] : [],
    })
    : [];
  const items = mounted && viewer
    ? buildRecents({
      apps,
      conversations: snap.conversations,
      discussions: snap.discussions,
      agents: agentsOn ? (threads as AgentChat[]) : [],
      agentSessions,
      viewerId: Number(window.App?.user?.id) || null,
      active: active.map((item) => item.app!.slug),
      platformSlug,
    })
    : [];
  useHiddenClass(ref, items.length === 0 && active.length === 0);

  return (
    <div
      ref={ref}
      id="platform-recents"
      className="platform-recents hidden"
      role="group"
      aria-labelledby="platform-recents-head"
    >
      <ActiveApps items={active} />
      <h2 id="platform-recents-head" className="platform-recents-head">Recents</h2>
      <RecentsByDay
        items={items}
        live={live}
        showOlder={showOlder}
        onToggleOlder={() => setShowOlder((open) => !open)}
      />
    </div>
  );
}
