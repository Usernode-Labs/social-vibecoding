/**
 * #apps-switcher-sheet — the menu behind the header chip (#1443).
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * ONE CONTROL NAMES WHERE YOU ARE, AND ITS MENU LISTS EVERYWHERE YOU CAN
 * GO. Everything in here has its own page. Nothing that isn't a destination
 * belongs in this sheet at all — an inbox's CONTENTS are not a destination,
 * which is why the notifications list is a sheet of its own and only the
 * Messages ROW is here. A row that is neither is the signal this menu is
 * decaying back into the hamburger it replaced.
 *
 * ── What #1431 built and what #1443 changed ────────────────────────────
 *
 * #1431 made this the Apps sheet: a title row with "Create New", a strip of
 * the viewer's apps, and a `Home | Explore` footer, presented as a kit bottom
 * sheet on touch by ./app-context-controller.js. All of that is kept — the
 * lifecycle, the strip, the create action.
 *
 * What changed is that it now carries the platform's destinations too, so it
 * is reachable from every screen rather than only from inside an app. The two
 * footer buttons became the first two rows of that list, and `canOpen`'s
 * `!!slug` gate went with the chip's — a menu you can only open inside an app
 * is not a way to get to an app.
 *
 * ── The app views moved here from the Improve panel ────────────────────
 *
 * #1431 put App / Board / Activity in the Improve panel as `#improve-views`.
 * They are destinations, so under the rule they belong here, and the Improve
 * panel goes back to being about making a change rather than about getting
 * around. Same three routes, same `Improve.openApp()` for the first.
 *
 * ── Why the strip is horizontal, and why that is the scroll fix ────────
 *
 * The first cut of this menu (on the superseded #1436 branch) made the apps a
 * VERTICAL list, and with the 39 apps on a real account that list ran to
 * ~1800px inside an 844px panel: Home, Discover, Messages, Profile and
 * Settings were pushed past the fold and CLIPPED, with no scroller anywhere
 * to reach them. That is what "the menu is missing home and profile" was.
 *
 * #1431's horizontal strip makes the bug structurally impossible instead of
 * fixing it: 39 apps occupy exactly the vertical space that 2 do, so the
 * destinations below can never be pushed anywhere. The strip scrolls
 * sideways; the DESTINATIONS get the vertical scroller, so on a short
 * viewport they give way rather than clip. Nothing here is ever unreachable,
 * at any app count and any height.
 *
 * First render is the prerender: closed, no apps, no app-scoped rows.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  AppWindowIcon,
  ChatBubbleTailIcon,
  ChevronRightIcon,
  CogIcon,
  HomeIcon,
  NewspaperIcon,
  PlusWideIcon,
  SearchIcon,
  ShieldCheckIcon,
  UserIcon,
  XIcon,
} from '@/components/ui/icons';

import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { improveStore } from '../improve/improve-store.js';
import { Improve } from '../improve/improve-controller.js';
import { appContextStore } from './app-context-store.js';
import { AppContext } from './app-context-controller.js';

type SwitcherApp = {
  slug: string; name?: string; icon_url?: string | null; icon_emoji?: string | null;
};

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 '
  + 'transition-colors';

const SECTION = 'px-5 pt-4 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-400 dark:text-zinc-500';

/**
 * One destination. An ANCHOR, always — these are hash routes, so cmd/ctrl
 * click, middle-click and "open in new tab" all have to work, the same reason
 * #back-btn is an <a>. `dismissForNav` closes the sheet on a plain activation;
 * a modified click never reaches it because the browser handles it natively.
 */
function MenuRow({
  id, href, icon, label, trailing, onClick, elRef, shipsHidden,
}: {
  id: string;
  href: string;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  elRef?: React.Ref<HTMLAnchorElement>;
  // Ships `hidden` in the FIRST render, for a row a classic module reveals.
  // The className stays a constant either way — which is what keeps the
  // outside `hidden` toggle a sanctioned seam rather than a second owner.
  shipsHidden?: boolean;
}): ReactNode {
  return (
    <a
      ref={elRef}
      id={id}
      href={href}
      className={shipsHidden ? `hidden ${ROW}` : ROW}
      onClick={(e) => {
        if (onClick) { onClick(e); return; }
        AppContext.dismissForNav();
      }}
    >
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
      {trailing}
      <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
    </a>
  );
}

/**
 * One app in the rail.
 *
 * THE APP'S OWN ARTWORK, never its initial if it has any. ../apps/app-card-view's
 * AppIconContent is the three-way `icon_url → icon_emoji → letter` walk Home
 * and the browse list already share; a letter is the LAST resort.
 *
 * `.app-icon-tile` + `data-icon` draw the box, and this call site adds no
 * background or text colour of its own — app.css says tile call sites must not
 * repaint the one tile face.
 */
function AppTile({ app, current }: { app: SwitcherApp; current: boolean }) {
  const label = app.name || app.slug;
  return (
    <a
      href={`#app/${app.slug}/app`}
      data-switcher-app={app.slug}
      aria-current={current ? 'page' : undefined}
      className="shrink-0 w-16 flex flex-col items-center gap-1.5"
      onClick={() => AppContext.dismissForNav()}
    >
      {/* The ring sits OUTSIDE the tile's own hairline, offset in the sheet's
          ground, so a selected tile reads as one edge rather than two. */}
      <span
        data-icon={appIconKind(app)}
        className={'app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center text-xl font-bold'
          + (current
            ? ' ring-2 ring-violet-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900'
            : '')}
      >
        <AppIconContent app={app} />
      </span>
      {/* Colour only, never weight — navigation.md forbids a weight change
          between nav item states. */}
      <span
        className={'w-full text-center text-[0.8125rem] truncate '
          + (current
            ? 'text-violet-600 dark:text-violet-400'
            : 'text-zinc-900 dark:text-zinc-100')}
      >
        {label}
      </span>
    </a>
  );
}

export function AppsSwitcherSheet(): ReactNode {
  const { open } = useStoreState(appContextStore);
  const { slug, name, selfHosted, tab, subTab } = useStoreState(improveStore);
  const [apps, setApps] = useState<SwitcherApp[] | null>(null);

  // Both flags arrive from classic modules through the visibility store —
  // App.renderAdminButton for the console, settings.js for the BYOK dot — and
  // both elements ship `hidden` with a CONSTANT className, which is what makes
  // a `hidden` toggle from outside React sanctioned rather than a second owner.
  const adminRef = useRef<HTMLAnchorElement | null>(null);
  const byokRef = useRef<HTMLSpanElement | null>(null);
  useVisibilityHiddenClass(adminRef, 'switcher-row-admin', false);
  useVisibilityHiddenClass(byokRef, 'switcher-byok-dot', false);

  const close = useCallback(() => AppContext.close(), []);

  // The viewer's apps, in the home grid's own "Your apps" order — the one
  // answer to "which apps are mine" the platform already has. Loaded when the
  // sheet opens, never during the first render: the prerender ships an empty
  // strip and a fetch there would be a hydration mismatch.
  useEffect(() => {
    if (!open || apps) return;
    let live = true;
    (async () => {
      try {
        const demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
        const res = await fetch(`/api/apps${demo}`);
        if (!res.ok) return;
        const data = await res.json();
        const home = (window as any).Home;
        const mine = home?.partitionApps
          ? home.partitionApps(data.apps || []).yours
          : (data.apps || []);
        if (live) setApps(mine);
      } catch {
        // Offline is a state, not a failure: no strip, the rows still work.
      }
    })();
    return () => { live = false; };
  }, [open, apps]);

  const rows = apps || [];
  // The app-scoped section exists only while an app is on screen. Same three
  // gates #improve-views used, moved with the rows.
  const inApp = !!slug;
  const onApp = tab !== 'dev';
  const onActivity = tab === 'dev' && subTab === 'chat';
  const onBoard = tab === 'dev' && (subTab === 'forum' || subTab === 'topic');
  const AppRowIcon = selfHosted ? HomeIcon : AppWindowIcon;
  const here = 'text-violet-600 dark:text-violet-400';

  return (
    <>
      <div
        id="apps-switcher-overlay"
        aria-hidden="true"
        {...(open ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40 bg-black/40"
        onClick={close}
      >
      </div>
      <div
        id="apps-switcher-sheet"
        role="dialog"
        aria-label="Menu"
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className="fixed z-50 flex flex-col bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 shadow-2xl app-context-transition"
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3 shrink-0">
          <span className="flex-1 min-w-0 block text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Apps
          </span>
          <button
            id="apps-switcher-create"
            type="button"
            className="inline-flex items-center gap-1 text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline un-touch-target"
            onClick={() => {
              AppContext.dismissForNav();
              (window as any).Home?.openCreateApp?.();
            }}
          >
            <PlusWideIcon className="w-3.5 h-3.5 shrink-0" strokeWidth="2.5" aria-hidden="true" />
            Create New
          </button>
          <button
            id="apps-switcher-close"
            type="button"
            className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 un-touch-target"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        {/* The apps, as a horizontal strip — vertically BOUNDED, which is what
            keeps every row below reachable at any app count. See the header. */}
        <div
          id="apps-switcher-list"
          className="shrink-0 flex gap-4 px-5 pb-5 overflow-x-auto overscroll-contain"
        >
          {rows.map((app) => (
            <AppTile key={app.slug} app={app} current={app.slug === slug} />
          ))}
          {apps && rows.length === 0 ? (
            <span className="py-4 text-sm text-zinc-500 dark:text-zinc-400">
              No apps yet. Discover finds the ones you can join.
            </span>
          ) : null}
        </div>
        {/* THE ONLY VERTICAL SCROLLER. Everything above is `shrink-0`. */}
        <nav
          id="switcher-nav"
          className="flex-1 min-h-0 overflow-y-auto border-t border-zinc-100 dark:border-zinc-800 pb-2 platform-safe-sheet"
        >
          {inApp ? (
            <>
              <div className={SECTION}>{name || 'This app'}</div>
              <MenuRow
                id="switcher-row-app"
                href={`#app/${slug}/app`}
                icon={<AppRowIcon className={onApp ? here : undefined} />}
                label={selfHosted ? 'Home' : name || 'App'}
                onClick={(e) => {
                  if ((window as any).NavLink?.isNativeClick?.(e)) return;
                  e.preventDefault();
                  AppContext.dismissForNav();
                  Improve.openApp();
                }}
              />
              <MenuRow
                id="switcher-row-board"
                href={`#app/${slug}/board`}
                icon={<NewspaperIcon className={onBoard ? here : undefined} />}
                label="Board"
              />
              <MenuRow
                id="switcher-row-activity"
                href={`#app/${slug}/activity`}
                icon={<ChatBubbleTailIcon className={onActivity ? here : undefined} />}
                label="Activity"
              />
            </>
          ) : null}
          <div className={SECTION}>Platform</div>
          <MenuRow
            id="switcher-row-home"
            href="/"
            icon={<HomeIcon />}
            label="Home"
            onClick={(e) => {
              if ((window as any).NavLink?.isNativeClick?.(e)) return;
              e.preventDefault();
              AppContext.dismissForNav();
              (window as any).App?.navigateHome?.();
            }}
          />
          <MenuRow
            id="switcher-row-discover"
            href="#apps"
            icon={<SearchIcon />}
            label="Discover"
          />
          {/* Messages keeps the badge id it wore on the retired header bubble,
              so Notifications._renderBadge and messages/store.ts are still its
              only writers — only the parent changed. */}
          <MenuRow
            id="switcher-row-messages"
            href="#messages"
            icon={<ChatBubbleTailIcon />}
            label="Messages"
            trailing={(
              <span
                id="drawer-messages-badge"
                className="hidden min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-violet-600 text-white text-[0.65rem] font-bold flex items-center justify-center shrink-0"
                aria-label="Unread messages"
              >
              </span>
            )}
          />
          <div className={SECTION}>You</div>
          <MenuRow
            id="switcher-row-profile"
            href="#profile"
            icon={<UserIcon />}
            label="Profile"
          />
          <MenuRow
            id="switcher-row-settings"
            href="#settings"
            icon={<CogIcon />}
            label="Settings"
            trailing={(
              <span
                ref={byokRef}
                id="switcher-byok-dot"
                className="hidden w-2 h-2 rounded-full bg-emerald-500 shrink-0"
                aria-hidden="true"
              >
              </span>
            )}
          />
          {/*
              Admin & moderation. Ships `hidden`; App.renderAdminButton()
              publishes the flag for platform admins AND view-only admins —
              gated on `App.user.isAdmin`, which both roles carry, and
              deliberately NOT on `canAdminWrite` (the full-admin mutation
              gate, which would hide the console from exactly the moderation
              audience). Never gated on USERNODE_ENV: the row must exist
              identically in staging and production. Navigation rides the
              anchor's #admin hash, which navigateToAdminConsole re-gates
              server-side.
          */}
          <MenuRow
            elRef={adminRef}
            shipsHidden
            id="switcher-row-admin"
            href="#admin"
            icon={<ShieldCheckIcon />}
            label="Admin & moderation"
          />
        </nav>
      </div>
    </>
  );
}
