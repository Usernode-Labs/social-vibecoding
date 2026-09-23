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
 * ── A glyph per kind ─────────────────────────────────────────────────
 *
 * A person, a group, a channel's `#`, the agent's sparkle and an app window,
 * so a mixed list can be scanned for "the DM" or "the app" without reading
 * every label. A row with something unread carries a dot, which is all a
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
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';

import {
  AppWindowIcon, HashIcon, SparklesIcon, UserGroupIcon, UserIcon,
} from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useGlobalChatState } from '../global-chat/store';
import type { AgentChat } from '../messages/inbox';
import { useMessagesSnapshot } from '../messages/store';
import { navStore } from './nav-store.js';
import { readRecentApps, recentAppsStore } from './recent-apps-store.js';
import { buildRecents, type RecentItem, type RecentKind } from './recents';

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

function onAppClick(event: MouseEvent<HTMLAnchorElement>, slug: string): void {
  const nav = (window as unknown as {
    NavLink?: { isNativeClick?: (e: unknown) => boolean };
  }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  event.preventDefault();
  // The router's "this app, this tab" entry point, which is what the Resume
  // strip used (./parked-strip.tsx): it switches tabs for an app that is
  // still open and navigates for any other.
  window.App?.openAppTab?.(slug, 'app');
}

function RecentRow({ item }: { item: RecentItem }) {
  const Glyph = GLYPHS[item.kind];
  const unread = item.unread ? ', unread' : '';
  return (
    <a
      className="platform-recent"
      href={item.href}
      data-recent-kind={item.kind}
      data-recent-key={item.key}
      aria-label={`${KIND_NAMES[item.kind]}: ${item.label}${unread}`}
      onClick={item.app ? (event) => onAppClick(event, item.app!.slug) : undefined}
    >
      <Glyph className="platform-recent-glyph" aria-hidden="true" />
      <span className="platform-recent-label">{item.label}</span>
      {item.unread ? <span className="platform-recent-dot" aria-hidden="true" /> : null}
    </a>
  );
}

export function RecentsList() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const { apps } = useStoreState(recentAppsStore);
  const snap = useMessagesSnapshot();
  const chat = useGlobalChatState();

  // POST-MOUNT, for hydration (see the header). The stored apps are read by
  // ./mount.ts when the router names the viewer, since the list is theirs;
  // this covers a viewer named before the island hydrated.
  const { viewer } = useStoreState(navStore);
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
  const agentsOn = !!chat.bootstrap?.parityReady
    && chat.bootstrap.profiles.globalChat.enabled === true;
  const items = mounted && viewer
    ? buildRecents({
      apps,
      conversations: snap.conversations,
      discussions: snap.discussions,
      agents: agentsOn ? (chat.threads as AgentChat[]) : [],
      viewerId: Number(window.App?.user?.id) || null,
    })
    : [];
  useHiddenClass(ref, items.length === 0);

  return (
    <div
      ref={ref}
      id="platform-recents"
      className="platform-recents hidden"
      role="group"
      aria-labelledby="platform-recents-head"
    >
      <h2 id="platform-recents-head" className="platform-recents-head">Recents</h2>
      {items.map((item) => <RecentRow key={item.key} item={item} />)}
    </div>
  );
}
