/**
 * #header-menu-overlay + #header-menu-panel — the hamburger drawer, as a React
 * island (#1079 chunk B). One component for both nodes because they are one
 * surface: the overlay is the panel's backdrop on the desktop / kit-missing
 * path, and nothing ever renders one without the other.
 *
 * ── What THE UI OVERHAUL changed here ─────────────────────────────────
 *
 * The bell merged into this drawer. #notifications-panel is gone and the
 * notifications list is the FIRST thing in the panel — two top-right drawers
 * that opened the same way, one slot apart, were one affordance too many, and
 * "what happened while I was away" belongs at the top of the catch-all menu.
 * The list is rendered by the same components from the same store, so
 * ../notifications/notifications.js is unchanged.
 *
 * ── What #1367 changed ────────────────────────────────────────────────
 *
 * Two things, both about where your eye and your thumb land when the drawer
 * opens. The notifications section is COLLAPSED by default and re-collapses on
 * every open (see `notificationsOpen` below), so the menu opens on the thing
 * you opened it for; and the two blocks are anchored to opposite ends of the
 * panel — notifications to the top, the navigation rows to the bottom — rather
 * than stacked from the top with the slack underneath.
 *
 * That made the drawer STATEFUL, which it was not before. It is allowed under
 * AGENTS.md's rule for the same reason <NotificationsBody/> already was: the
 * state lives entirely in React-owned nodes. Everything `public/js/**` still
 * shows and hides per screen — the node, wallet, profile, messages, settings
 * and admin rows — is untouched by it, and the two nodes the notifications
 * module DOES write to (#notifications-list, #notifications-mark-all) are
 * never unmounted; the collapse toggles a class on a wrapper above them.
 *
 * Five things left: the theme selector (a SETTING now, and the first one —
 * features/settings/sections/theme.tsx), the kudos and AI-credit meters
 * (ambient numbers nobody acts on from a menu), the Leaderboard row (the home
 * screen's Challenges area links there) and the whole bottom-anchored footer —
 * version, GitHub, Share — which is app-scoped and therefore Improve-panel
 * material.
 *
 * The modules that own live content in this subtree are bundled with it and
 * initialise from the island's layout effect:
 *
 *   ./node-pill.js               #drawer-row-node    (native node status)
 *   ./wallet-sheet.js            #drawer-row-wallet  (native wallet balance)
 *   ./header-menu-controller.js  the drawer's own open/close (was
 *                                App.HeaderMenu / App.DrawerStatus in app.js)
 *
 * The drawer stays MARKUP-ONLY apart from the notifications body, and for the
 * usual reason: app.js and app-view.js still show and hide individual rows per
 * screen, and on touch the panel is physically adopted into a kit side drawer
 * (PlatformUI.panel({contentEl}) reparents it and adds .platform-panel-adopted),
 * which a re-render of the panel's own `className` or child order would clobber.
 *
 * <NotificationsBody/> is the one exception, and it earns it the same way the
 * theme segments used to: its whole subtree is React's, driven by
 * ../notifications/notifications-store.js, and nothing in public/js/** writes
 * inside it. It renders the shipped markup exactly on the first pass — an empty
 * list with the hint and "Mark all read" both inert — so hydration matches byte
 * for byte.
 *
 * Why init() moves to a layout effect: imported modules evaluate while the
 * bundle loads — before hydration — and both node-pill and wallet-sheet lift
 * `hidden` off a row React is about to hydrate. A layout effect runs inside
 * flushSync(hydrateRoot), so the class lands after hydration has adopted the
 * node and still before DOMContentLoaded, where app.js's own init waits. The
 * notifications module needs the same treatment for a different reason — see
 * the effect below.
 */

import { useState } from 'react';

import {
  ChatBubbleTailIcon,
  ChevronRightIcon,
  CogIcon,
  GitHubIcon,
  LightBulbIcon,
  ShareIcon,
  ShieldCheckIcon,
  SunIcon,
  ThumbsUpIcon,
  TrophyIcon,
  UserIcon,
  WalletIcon,
  XIcon,
} from '@/components/ui/icons';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { NotificationsBody } from '../notifications/notifications-list';
import { notificationsStore } from '../notifications/notifications-store.js';
// Two side-effect modules whose ROWS moved out of this drawer — the AI-credit
// figure to Settings → Anthropic API key, the mobile-app version to the
// Improve panel's footer — but whose imports stay here on purpose. Both
// install a `window.*` global that app.js's boot looks for, and this island is
// the earliest thing in the bundle; hanging either off a surface that may
// never be opened would be a boot-order regression dressed up as tidiness.
//
// The AI-credit renderer. Its ROW moved to Settings → Anthropic API key when
// THE UI OVERHAUL emptied the drawer's status pane, but the import stays here:
// it is a side-effect module that installs window.AiCredit, App.init() is what
// calls AiCredit.Budget.init(), and this island is still the earliest thing in
// the bundle that loads before that. Moving the import to the settings screen
// would tie a boot-time global to a screen nobody has opened yet.
import './ai-credit.js';
import './native-app-version.js';
import './node-pill.js';
import './wallet-sheet.js';
import './header-menu-controller.js';
// The bell's module, imported here because its list is rendered here now.
// ../notifications/mount.ts installs the store's flush and publishes the
// controller; this pulls both in with the markup they drive.
import '../notifications/mount';

export function HeaderMenu() {
  // ── Notifications: COLLAPSED by default (#1367) ──────────────────────
  //
  // The drawer opens on the navigation rows, not on a wall of notifications.
  // The list is still the first thing in the panel and still one tap away —
  // what changed is that "what happened while I was away" no longer sits
  // between you and the row you opened the menu to reach.
  //
  // `false` is a CONSTANT initial value, which is what keeps hydration byte
  // exact: the SSG pass in frontend/scripts/build-shell.mjs renders this in
  // Node with no way to know a viewer's preference, so anything read from
  // localStorage or the store here would mismatch on the client's first pass
  // and console.error — which fails proposal checks.
  //
  // Deliberately NOT persisted, and deliberately re-collapsed on every open:
  // the request is "collapsed by default when opening the hamburger tray",
  // and a sticky expansion would quietly undo that for whoever expanded it
  // once. HeaderMenu.close() is not observed here — the panel is never
  // unmounted — so the reset rides ./header-menu-controller.js's own open
  // path via the `sv:drawer-open` event below.
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  // The store the list already renders from, read here for one bit: is there
  // anything unread behind the collapsed header. Without it a collapsed
  // section is a section you have no reason to open. (The hamburger's red
  // #notifications-badge says the same thing from outside the drawer; this is
  // the in-drawer half of that cue.)
  const notificationsState = useStoreState(notificationsStore) as {
    list: ({ type: 'row'; row: { unread: boolean } }
      | { type: 'group'; group: { hasUnread: boolean } })[] | null;
    invites: unknown[] | null;
  };
  const hasUnread = (notificationsState.list || []).some((entry) => (
    entry.type === 'row' ? entry.row.unread : entry.group.hasUnread
  )) || !!(notificationsState.invites || []).length;

  useIsomorphicLayoutEffect(() => {
    window.NodePill?.init();
    window.WalletSheet?.init();
    // The mobile-app version renderer. Its row is the Improve panel's footer
    // now, but the init stays on this island's layout effect: it runs inside
    // flushSync(hydrateRoot), so its class/text write lands after hydration has
    // adopted the node and still before DOMContentLoaded.
    window.NativeAppVersion?.init();
    // The drawer's own open/close wiring — app.js's bindEvents() used to call
    // this; it lives beside the markup it drives now (#1079 chunk B).
    window.HeaderMenu?.init();
    // Notifications init from HERE now, not from the retired
    // #notifications-panel island. A LAYOUT effect, not a passive one: it runs
    // inside main.tsx's flushSync(hydrateRoot), which is before
    // DOMContentLoaded — where the classic script's init() used to run, only
    // earlier still. A passive effect could be scheduled after app.js's init,
    // and `sv:authed` fires at most once, so a late listener would never get
    // the first fetch.
    window.Notifications?.init();
    // The list's pull-to-refresh, a kit attachment on a node this island owns.
    // The list is never re-created, so attaching it once here — from the same
    // effect as init() — is the same contract the bell's island had. The kit
    // no-ops it on desktop, exactly as before.
    const list = document.getElementById('notifications-list');
    if (list && window.PlatformUI?.pullToRefresh) {
      window.PlatformUI.pullToRefresh(
        list,
        () => window.Notifications?.refresh() ?? Promise.resolve(),
      );
    }
    // "Collapsed by DEFAULT" means on every open, not just the first one.
    // ./header-menu-controller.js emits this as it opens the panel (both the
    // desktop transform path and the kit side-drawer adoption), which is the
    // only moment either side agrees the drawer became visible.
    const collapse = () => setNotificationsOpen(false);
    document.addEventListener('sv:drawer-open', collapse);
    // …and the one thing that has to override that default: the
    // `?shot=notifications` deep link, whose whole job is making a
    // gesture-only state reachable from a URL for the capture pipeline and
    // the declared checks. A collapsed section is `hidden`, so its text is
    // absent from `document.body.innerText` — which is what a check's
    // `expectText` reads — and #1280's saved-message assertions read exactly
    // that text. ../notifications/notifications.js dispatches this straight
    // after opening the drawer, so it lands after the collapse above.
    const expand = () => setNotificationsOpen(true);
    document.addEventListener('sv:notifications-expand', expand);
    return () => {
      document.removeEventListener('sv:drawer-open', collapse);
      document.removeEventListener('sv:notifications-expand', expand);
    };
  }, []);

  return (
    <>
      {/*
          Slide-out navigation drawer (all viewport widths — #122).
          Overlay dims the page; panel slides in from the right. Both are
          controlled by HeaderMenu.open() / HeaderMenu.close() in app.js.
          On touch the panel below is ADOPTED into a kit side drawer
          (unNative.presentPanel — drag-to-dismiss), which supplies its own
          backdrop; the overlay here and the CSS transform transition are
          the desktop / kit-missing path.
      */}
      <div id="header-menu-overlay" className="hidden fixed inset-0 z-40 bg-black/40" aria-hidden="true">
      </div>
      <div
        id="header-menu-panel"
        role="dialog"
        aria-label="Navigation menu"
        className={"fixed top-0 right-0 bottom-0 z-50 w-60 max-w-[85vw] flex flex-col\n              bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-700\n              shadow-2xl header-menu-panel-transition"}
      >
        {/* Panel header with close button */}
        <div className="flex items-center justify-end px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <button id="header-menu-close" className="text-zinc-400 hover:text-zinc-200" aria-label="Close menu">
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        {/*
            Panel body — ONE scroller, laid out as a COLUMN FLEX with its two
            blocks anchored to OPPOSITE ENDS (#1367): notifications at the top,
            the navigation rows at the bottom via `mt-auto`. The free space
            between them belongs to neither, so a viewer with three
            notifications gets their nav rows under their thumb instead of
            stranded halfway up a tall panel.

            The column flex is the same one the retired #drawer-footer needed,
            and it degrades the same way: when the two blocks together overflow
            (a short viewport, an expanded list) there is no free space to
            collect and `mt-auto` contributes nothing, so the rows simply sit
            at the end of the scroll. One rule, both behaviours, no
            measurement. On touch the panel fills a full-height kit side drawer
            (.platform-panel-adopted), so the bottom really is the bottom of
            the screen there.
        */}
        <div id="header-menu-rows" className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          {/*
              NOTIFICATIONS, anchored to the TOP of the drawer (#1367).

              THE UI OVERHAUL merged the bell into the hamburger: two
              top-right drawers that opened the same way, one slot apart,
              were one affordance too many, and "what happened while I was
              away" belongs at the top of the catch-all menu rather than
              behind an icon of its own. #notifications-panel is gone; its
              whole body lives here, rendered by the same components from
              the same store, so ./notifications.js is unchanged.

              It is a SIBLING of #drawer-main-rows now rather than its first
              child, which is what lets the two ends of the panel be anchored
              independently: this block sits at the top, the navigation rows
              carry `mt-auto` and hug the bottom, and the free space between
              them belongs to neither. Both keep their ids — nothing moved
              out of the drawer, the nesting changed.

              Bounded height with its own scroller, so a long list cannot
              push the navigation rows below it off a short viewport — the
              anchored dropdown it replaced had exactly this cap (max-h-[70vh]
              on the panel) for the same reason.
          */}
          <div
            id="drawer-notifications"
            className="shrink-0 border-b border-zinc-100 dark:border-zinc-800"
          >
            <div className="flex items-center gap-2 px-4 py-2">
              {/*
                  The section header is the DISCLOSURE control. A <button>
                  beside "Mark all read" rather than wrapping it, because a
                  button inside a button is invalid markup and the browser
                  would drop one of them.
              */}
              <button
                type="button"
                className="flex items-center gap-1.5 flex-1 min-w-0 text-left un-touch-target"
                aria-expanded={notificationsOpen ? 'true' : 'false'}
                aria-controls="notifications-list"
                onClick={() => setNotificationsOpen((wasOpen) => !wasOpen)}
              >
                <ChevronRightIcon
                  className={
                    notificationsOpen
                      ? 'w-3 h-3 shrink-0 text-zinc-400 transition-transform rotate-90'
                      : 'w-3 h-3 shrink-0 text-zinc-400 transition-transform'
                  }
                  aria-hidden="true"
                />
                <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Notifications
                </span>
                {/* The reason to open a collapsed section. Hidden while it is
                    open, where the rows themselves carry their own dots. */}
                {hasUnread && !notificationsOpen ? (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0"
                    aria-label="Unread notifications"
                  />
                ) : null}
              </button>
              <button
                id="notifications-mark-all"
                className="text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-40"
                disabled={true}
              >
                Mark all read
              </button>
            </div>
            {/*
                COLLAPSED WITH A CLASS, never by unmounting. Three things
                inside this subtree are resolved once, by id, and would not
                survive being torn down and rebuilt: the layout effect above
                attaches the kit's pull-to-refresh to #notifications-list,
                ./notifications.js binds its click listener to
                #notifications-mark-all, and the same module writes that
                button's `disabled` property directly. Toggling `hidden` keeps
                every one of those attachments alive and costs one class.
            */}
            <div className={notificationsOpen ? undefined : 'hidden'}>
              <NotificationsBody />
            </div>
          </div>
          {/*
              THE NAVIGATION ROWS, anchored to the BOTTOM (#1367).

              `mt-auto` inside #header-menu-rows' column flex collects the
              free space ABOVE this block, so the rows hug the foot of the
              panel whenever the notifications above them leave room, and
              degrade to "just after the list" when they do not (a short
              viewport, an expanded list). One rule, both behaviours, no
              measurement — the same trick the retired #drawer-footer used,
              which is the reason #header-menu-rows was made a column flex in
              the first place.

              On touch the panel fills a full-height kit side drawer
              (.platform-panel-adopted), so this sits at the bottom of the
              screen there too — which is where a thumb actually is.
          */}
          <div id="drawer-main-rows" className="shrink-0 mt-auto">
            {/*
                The theme selector used to be the first thing in this drawer,
                and the kudos + AI-credit meters (#drawer-status-pane) sat
                directly below it. All three are gone from here:

                  * Theme is a SETTING now, and the first one — see
                    features/settings/sections/theme.tsx. A live control that
                    changes how the whole product looks does not belong in a
                    navigation menu.
                  * The kudos and AI-credit meters were ambient numbers nobody
                    acts on from a menu. Kudos is a leaderboard concern (the
                    home screen's Challenges area links there) and AI credit
                    surfaces where it actually bites — in the composer's
                    session options, and in Settings.

                Their renderers (Kudos.Budget._render, AiCredit.Budget._render)
                resolve their slots by getElementById and no-op when the slot is
                absent, so both simply stop painting.
            */}
            {/*
                Node status + Wallet: native app chrome absorbed into SV
                (app-as-SV-chrome migration, NATIVE-BRIDGE.md). Native top frames
                always reveal both rows; capabilities and temporary state affect
                their contents, never the navigation structure. They are wired by
                ./node-pill.js / ./wallet-sheet.js, which this island initialises
                below. Tapping opens the same detail sheets the old header pill /
                chip opened.
            */}
            <button
              id="drawer-row-node"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <span id="drawer-node-dot" className="w-2.5 h-2.5 rounded-full bg-zinc-400 shrink-0" aria-hidden="true">
              </span>
              <span className="text-sm font-medium">
                Node
              </span>
              <span id="drawer-node-status" className="ml-auto text-xs font-medium text-zinc-400">
              </span>
            </button>
            <button
              id="drawer-row-wallet"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <WalletIcon className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">
                Wallet
              </span>
              <span
                id="drawer-wallet-balance"
                className="ml-auto text-xs font-semibold text-violet-600 dark:text-violet-400"
              >
              </span>
            </button>
            {/*
                Members & visibility used to be a drawer row here; #645 moved it
                into the Dev tab's "+" menu (see AppView._wirePlusMenu).
                "View on GitHub" and "Share App" used to be here too; #913 made
                them the last two items of a bottom-anchored #drawer-footer,
                and THE UI OVERHAUL moved them out of this drawer entirely —
                they are rows of the Improve panel now, scoped to one app,
                which is what both of them always were.
            */}
            {/*
                MAIN NAV ORDER — Profile, Messages, Leaderboard, Settings,
                Admin & moderation. Personal-first, then shared, then configuration,
                then the admin surface; the app-scoped and reference rows sit
                outside this group (status pane above, footer below).
            */}
            {/*
                Profile — web screen (#profile hash route, public/js/profile.js;
                profile-and-settings-to-web migration). Always visible: the row
                used to be hidden until the Usernode bridge reported the
                getProfileInfo capability, but /challenges-api/me/* scopes to
                the platform session server-side since the topochain merge, so
                the screen works in any browser. Real anchor (like Challenges)
                so hash navigation drives the screen. The former native-push
                Profile / App Settings rows are gone: App Settings merged into
                the Settings modal as capability-gated sections (settings.js).
                
                #982: when the viewer has set a profile picture, it REPLACES the
                generic person glyph here — App.applyUserAvatar (public/js/app.js)
                swaps which of the two is `hidden` from App.user.avatarUrl, so the
                row shows the same face the profile screen does. The <img> ships
                hidden with no src: a signed-out shell and a user with no picture
                both keep the glyph, and nothing requests /avatars/ until there is
                something to request.
            */}
            <a
              id="drawer-row-profile"
              href="#profile"
              className="flex items-center gap-3 px-4 min-h-[44px] border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <UserIcon id="drawer-profile-glyph" className="w-5 h-5 shrink-0" />
              <img
                id="drawer-avatar"
                alt=""
                className="hidden w-5 h-5 shrink-0 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800"
              />
              <span className="text-sm font-medium">
                Profile
              </span>
            </a>
            {/* Platform-wide direct and group conversations (#488). A real
                anchor keeps deep links and modified clicks browser-native;
                the badge is updated by the React Messages store. */}
            <a
              id="drawer-row-messages"
              href="#messages"
              className="flex items-center gap-3 px-4 min-h-[44px] border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <ChatBubbleTailIcon className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">Messages</span>
              <span id="drawer-messages-badge" className="hidden ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-violet-600 text-white text-[10px] font-bold leading-[18px] text-center" aria-label="Unread messages"></span>
            </a>
            {/*
                The Leaderboard row used to sit here — the one entry point for
                shared progress (Topochain standings, Kudos, the season's
                challenges), itself the replacement for the header trophy.

                THE UI OVERHAUL moved it to the HOME SCREEN, into the header of
                the Challenges area, which is the one place on the platform
                already showing the season's shared progress. A menu row is
                where you go when you remember the feature exists; a link
                beside the challenges themselves is where you notice it.
                #leaderboard is unchanged as a route.
            */}
            {/*
                Settings — always shown; green dot is the BYOK "key configured"
                indicator, toggled directly by settings.js _renderIndicator().
                Real anchor (like Challenges / Profile) since Settings became the
                #settings screen: navigation rides the anchor's hash and the click
                handler in App.HeaderMenu.init just closes the drawer.
            */}
            <a
              id="drawer-row-settings"
              href="#settings"
              className="flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <CogIcon className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">
                Settings
              </span>
              <span
                id="drawer-byok-dot"
                className="hidden ml-auto w-2 h-2 rounded-full bg-emerald-500 shrink-0"
                aria-hidden="true"
              >
              </span>
            </a>
            {/*
                Admin & moderation console entry point (#588 shipped it as a
                header shield icon; the header slim-down moved it here). Sits
                immediately after Settings.
                
                Ships `hidden` and is revealed by App.renderAdminButton() for
                platform admins AND view-only admins — i.e. gated on
                `App.user.isAdmin`, which BOTH roles carry, and deliberately NOT
                on `canAdminWrite` (that's the full-admin-only mutation gate, so
                it would hide the console from view-only admins who are exactly
                the moderation audience). Never gated on USERNODE_ENV: the row
                must exist identically in staging and production. Navigation
                rides the anchor's #admin hash, which navigateToAdminConsole
                re-gates server-side-enforced.
            */}
            <a
              id="drawer-row-admin"
              href="#admin"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <ShieldCheckIcon className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">
                Admin &amp; moderation
              </span>
            </a>
          </div>
          {/*
              ── Drawer footer ────────────────────────────────────────────────
              Platform information + app-scoped link rows, pinned to the FOOT of the
              panel: `mt-auto` inside #header-menu-rows' column flex hugs the
              bottom of the viewport whenever the rows above leave free space,
              and degrades to "just at the end of the scroll" when they don't
              (touch sheet, short viewport). No JS, no measurement.
              
              The revision/version lines render as PLAIN TEXT rather than pills — the
              old "usernode · 1a2b3c4" pill overflowed the 15rem panel, and a
              version you can't act on doesn't need pill chrome. The slots keep
              their ids, so App.renderPlatformVersionPill and
              AppView.renderForkBadge still resolve them by getElementById.
              
              GitHub + Share are the last two items, on the same
              app-open lifecycle they had as mid-list rows (App.openApp /
              navigate* toggle their `hidden`).
          {/*
              The drawer used to end in a bottom-anchored #drawer-footer:
              the platform version, the installed mobile-app release, the
              "Forked from" lineage label, View on GitHub and Share App.

              THE UI OVERHAUL moved all of it into the Improve panel, which is
              where it belongs — every one of those lines is ABOUT AN APP, and
              the panel is the surface scoped to one. The version and the repo
              link in particular were describing whichever app happened to be
              open while sitting in a menu that is otherwise global.

              Two consequences worth naming. The `mt-auto` on that footer was
              the only reason #header-menu-rows is a column flex, and it stays
              so — the rows above simply sit at the top now. And the amber
              #header-menu-deploy-dot on the hamburger used to be derived from
              the deploying pill rendered INSIDE this footer; DrawerStatus
              .refreshDeployDot reads the Improve panel's version state instead
              (features/improve/improve-store.js's `deploying`).
          */}

        </div>
      </div>
    </>
  );
}
