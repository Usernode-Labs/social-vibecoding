/**
 * #platform-strip-apps — the five apps you used most recently, on the
 * desktop strip (#4417).
 *
 * ── It replaces Recents ──────────────────────────────────────────────
 *
 * The desktop rail was 224px of sections, then Recents (#2802): the apps you
 * left and the conversations you were in, on one clock, with the running
 * apps above them under Active (#3074). The rail is a 76px strip now, the
 * four sections as an icon over a label, and the column beside it holds what
 * the section on screen needs (./section-column.tsx): a project's places in
 * Communities, the conversation list in Messages. So the conversations went
 * home to Messages' own list, where every one of them already was, and what
 * is left here is the apps: the five you used last, newest first, each its
 * own tile over its name.
 *
 * ── Still open ───────────────────────────────────────────────────────
 *
 * The last few apps opened stay running in hidden frames
 * (../app-frame/app-frame-store.js `kept`, up to keepAliveLimit()), so going
 * back to one is instant and shows it as it was left. Those carry the green
 * dot (../app-frame/live-apps.tsx), and their name says "still open" to a
 * screen reader. The app on screen is the one lit (`aria-current`).
 *
 * ── Where an app goes when it closes ─────────────────────────────────
 *
 * Its tile here is where a closed app shrinks to and where a resumed one
 * grows out of on the desktop (./resume-motion.ts resumeHandleFor): pressing
 * it notes it as the zoom's origin, as Recents' Resume pill did (#3618).
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * The root ships EMPTY and `hidden`; the apps arrive from localStorage after
 * hydration, one commit after mount, so the prerendered document and the
 * first client render agree. `hidden` goes through useHiddenClass.
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { liveAppLabel, LiveAppDot, useCurrentAppSlug, useLiveAppSlugs } from '../app-frame/live-apps';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from './nav-store.js';
import { readRecentApps, recentAppsStore } from './recent-apps-store.js';
import { noteResumeOrigin } from './resume-motion';

/** How many apps the strip shows. */
export const STRIP_APPS = 5;

/** An app you used, as ./recent-apps-store.js keeps it. */
export interface StripApp {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  at?: string;
}

/**
 * The strip's apps, at most STRIP_APPS, each once: the app you are in first,
 * even before it has ever been left (its header record names it, `current`);
 * then the apps still running behind it (`live`, the frame store's order,
 * named from the stored list where it has them, else by slug); then the rest
 * of the stored list, the most recently used first. Pure.
 */
export function stripApps(
  apps: StripApp[],
  current: StripApp | null = null,
  live: string[] = [],
  limit: number = STRIP_APPS,
): StripApp[] {
  const out: StripApp[] = [];
  const push = (app: StripApp | null | undefined) => {
    if (!app || !app.slug || out.some((a) => a.slug === app.slug)) return;
    out.push({ ...app, name: app.name || app.slug });
  };
  push(current);
  for (const slug of live) {
    push(apps.find((a) => a.slug === slug) || { slug, name: slug, iconUrl: null, iconEmoji: null });
  }
  const dated = apps.slice().sort((a, b) => {
    const diff = Date.parse(b.at || '') - Date.parse(a.at || '');
    return Number.isNaN(diff) ? 0 : diff;
  });
  for (const app of dated) push(app);
  return out.slice(0, Math.max(0, limit));
}

/**
 * The app ON SCREEN, which is the only app lit (#3096), or null.
 *
 * NOT the mounted frame on its own: the frame store's `slug` stays set while
 * the frame is mounted, which outlasts every way of leaving but Home (a tab,
 * the app's own Workshop, its discussion). The router's answer decides: the
 * app is on screen only while its screen is `#app-view` AND no tab is lit
 * (`#app-view` with a tab lit is the app's Workshop, where the lit tab is
 * the strip's one "you are here").
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

function onAppClick(event: MouseEvent<HTMLAnchorElement>, slug: string, live: boolean): void {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  event.preventDefault();
  // #3618: a running app grows back out of the tile that was pressed.
  if (live) noteResumeOrigin(slug, event.currentTarget.querySelector('.platform-strip-tile') || event.currentTarget);
  // The router's "this app, this tab" entry point: it switches to an app
  // that is still open and navigates to any other.
  (window as unknown as { App?: { openAppTab?: (slug: string, tab: string) => void } }).App?.openAppTab?.(slug, 'app');
}

export function StripApps() {
  const t = useMessages('core');
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const { apps } = useStoreState(recentAppsStore);
  const live = useLiveAppSlugs();
  const frameSlug = useCurrentAppSlug();
  const improve = useStoreState(improveStore);
  const { viewer, screen, tab } = useStoreState(navStore);
  const on = currentAppOnScreen({ frameSlug, screen, tab });

  // POST-MOUNT, for hydration. The stored apps are read by ./mount.ts when
  // the router names the viewer, since the list is theirs; this covers a
  // viewer named before the island hydrated.
  useEffect(() => {
    setMounted(true);
    const who = navStore.get().viewer;
    if (who && !recentAppsStore.get().apps.length) {
      const stored = readRecentApps(who);
      if (stored.length) recentAppsStore.set({ apps: stored });
    }
  }, []);

  // The open app's header record names it before it has ever been left.
  const current: StripApp | null = on
    ? (apps.find((a: StripApp) => a.slug === on)
      || (improve.slug === on ? { slug: on, name: improve.name || on, iconUrl: improve.iconUrl || null, iconEmoji: improve.iconEmoji || null } : { slug: on, name: on, iconUrl: null, iconEmoji: null }))
    : null;
  const items = mounted && viewer ? stripApps(apps as StripApp[], current, live) : [];
  useHiddenClass(ref, items.length === 0);

  return (
    <div ref={ref} id="platform-strip-apps" className="platform-strip-apps hidden" role="group" aria-label={t('core:stripApps.label')}>
      {items.map((app) => {
        const running = live.includes(app.slug);
        const lit = app.slug === on;
        const record = { icon_url: app.iconUrl, icon_emoji: app.iconEmoji, name: app.name };
        return (
          <a
            key={app.slug}
            className="platform-strip-app"
            href={`/app/${encodeURIComponent(app.slug)}`}
            data-strip-app={app.slug}
            title={app.name}
            // A kept-alive app says so aloud after its name: two facts, joined
            // the way the language joins them.
            aria-label={running ? listText([app.name, liveAppLabel()]) : undefined}
            aria-current={lit ? 'page' : undefined}
            {...(running ? { 'data-live': 'true' } : null)}
            onClick={(event) => onAppClick(event, app.slug, running && !lit)}
          >
            <span className="platform-strip-mark">
              <span className="app-icon-tile platform-strip-tile" data-icon={appIconKind(record)} aria-hidden="true">
                <AppIconContent app={record} />
              </span>
              {running ? <LiveAppDot className="platform-strip-live" /> : null}
            </span>
            <span className="platform-strip-label">{app.name}</span>
          </a>
        );
      })}
    </div>
  );
}
