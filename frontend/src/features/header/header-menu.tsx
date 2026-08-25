/**
 * #header-menu-overlay + #header-menu-panel — the hamburger drawer, as a React
 * island (#1079 chunk B). One component for both nodes because they are one
 * surface: the overlay is the panel's backdrop on the desktop / kit-missing
 * path, and nothing ever renders one without the other.
 *
 * ── What THE UI OVERHAUL changed here ─────────────────────────────────
 *
 * The bell merged into this drawer. #notifications-panel is gone and the
 * notifications list briefly led the panel; the Streamlined Concept moved it
 * to its own SCREEN (#notifications) behind a badged Notifications row, and
 * the drawer now leads with the viewer's APPS — see ./drawer-apps.tsx.
 *
 * The two blocks are anchored to OPPOSITE ENDS of the panel — Your apps to
 * the top, the navigation rows to the bottom via `mt-auto` — rather than
 * stacked from the top with all the slack underneath (#1367's layout,
 * inherited by the apps section).
 *
 * So this island is markup-only apart from <DrawerApps/>, the one subtree
 * that renders from a store.
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
 * <DrawerApps/> is the one exception, and it earns it the same way the
 * notifications body used to: its whole subtree is React's, driven by
 * ./drawer-apps-store.js, and nothing in public/js/** writes inside it. It
 * renders the shipped markup exactly on the first pass — the empty container
 * — so hydration matches byte for byte.
 *
 * Why init() moves to a layout effect: imported modules evaluate while the
 * bundle loads — before hydration — and both node-pill and wallet-sheet lift
 * `hidden` off a row React is about to hydrate. A layout effect runs inside
 * flushSync(hydrateRoot), so the class lands after hydration has adopted the
 * node and still before DOMContentLoaded, where app.js's own init waits. The
 * notifications module needs the same treatment for a different reason — see
 * the effect below.
 */

import {
  BellIcon,
  ChatBubbleTailIcon,
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
import { DrawerApps } from './drawer-apps';
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
import { NodePillRow } from './node-pill-row';
import { WalletRow } from './wallet-row';
import './node-pill.js';
import './wallet-sheet.js';
import './header-menu-controller.js';
// The bell's module, imported here because its list is rendered here now.
// ../notifications/mount.ts installs the store's flush and publishes the
// controller; this pulls both in with the markup they drive.
import '../notifications/mount';

export function HeaderMenu() {
  // ── The notifications AREA is not collapsible ────────────────────────
  //
  // #1367 briefly collapsed this whole section behind a disclosure. That was
  // the wrong grain: what is worth collapsing is each GROUP inside it — an app
  // with nine notifications should fold to one line, but the section itself is
  // the reason the drawer has a top half at all, and hiding it behind a tap
  // just moved the work. The per-group fold is where it belongs, and it lives
  // in ../notifications/notifications.js (`Notifications.expanded`, cleared on
  // every drawer open so each one starts folded).
  //
  // So this island holds no notifications state again, and the section renders
  // exactly the markup it shipped: header, "Mark all read", body.
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
    // The list's pull-to-refresh moved to the Notifications SCREEN with the
    // list itself (Streamlined Concept) — see notifications-screen.tsx.
  }, []);

  return (
    <>
      {/*
          Slide-out navigation drawer (all viewport widths — #122).
          Overlay dims the page; panel slides in from the LEFT (Streamlined
          Concept — it mirrors the hamburger, which leads the header's left
          group now). Both are
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
        className={"fixed top-0 left-0 bottom-0 z-50 w-60 max-w-[85vw] flex flex-col\n              bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-700\n              shadow-2xl header-menu-panel-transition"}
      >
        {/* Panel header with close button */}
        <div className="flex items-center justify-end px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <button id="header-menu-close" className="text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200" aria-label="Close menu">
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        {/*
            Panel body — a COLUMN FLEX that does NOT scroll. The notifications
            block above takes every pixel left over and scrolls inside itself;
            the navigation rows below are `shrink-0`, so they are on screen at
            every viewport height and every list length.

            It used to be the one scroller, with the two blocks anchored to
            opposite ends by `mt-auto`, which is fine right up until the list
            is long: then there is no free space, `mt-auto` contributes
            nothing, and Profile / Messages / Settings / Admin sit below the
            fold behind a scroll nobody expects in a menu. The rows are the
            reason the drawer opens. Giving the scroll to the list instead
            costs one `flex-1` and settles it at every height.
        */}
        <div id="header-menu-rows" className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {/*
              THE TOP OF THE DRAWER (owner review, round 2): Notifications
              and Messages lead — the two "what happened while I was away"
              rows — then the collapsible Your-apps section. Only Profile,
              Settings and Admin & moderation stay in the bottom-anchored
              group.
          */}
          <div id="drawer-top-rows" className="shrink-0">
            {/*
                Notifications — the full-screen view (Streamlined Concept).
                The list left the drawer for #notifications; this badged row
                is the way in, first of the nav rows because "what happened
                while I was away" keeps its top-of-menu billing. Real anchor,
                like every nav row. The badge (#drawer-notifications-badge) is
                painted by Notifications._renderBadge — notifications-only
                (bell unread + invites), while the hamburger's red badge sums
                Messages in as the whole drawer's number.
            */}
            <a
              id="drawer-row-notifications"
              href="#notifications"
              className="flex items-center gap-3 px-4 min-h-[44px] border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <BellIcon className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">Notifications</span>
              <span id="drawer-notifications-badge" className="hidden ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-[18px] text-center" aria-label="Unread notifications"></span>
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
          </div>
          {/*
              YOUR APPS — a nav item of its own AND a collapsible section:
              the row navigates home (where the grid lives), the chevron
              folds the app list. Fully React-owned — see ./drawer-apps.tsx.
          */}
          <DrawerApps />
          {/*
              THE NAVIGATION ROWS, at the BOTTOM and always on screen.

              `shrink-0` is the whole rule now. They used to get there with
              `mt-auto` collecting the free space above them, which put them
              at the foot of the panel only while there WAS free space — the
              case where it mattered, a long notification list, is exactly the
              one where it did nothing. The notifications block above is
              `flex-1` instead, so the space is spent there and these rows keep
              their height unconditionally.

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
            <NodePillRow />
            <WalletRow />
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
                Profile — leads the bottom group (owner review, round 2:
                Profile, Settings, Admin & moderation and nothing else down
                here). Same id, same avatar swap — App.applyUserAvatar still
                resolves #drawer-avatar / #drawer-profile-glyph by id.
                Original web-screen note (#profile hash route, public/js/profile.js;
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
              className="flex items-center gap-3 px-4 min-h-[44px] w-full text-left relative after:absolute after:bottom-0 after:left-12 after:right-0 after:h-px after:bg-zinc-100 dark:after:bg-zinc-800 after:content-[''] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
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
              className="hidden flex items-center gap-3 px-4 min-h-[44px] relative after:absolute after:bottom-0 after:left-12 after:right-0 after:h-px after:bg-zinc-100 dark:after:bg-zinc-800 after:content-[''] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
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
