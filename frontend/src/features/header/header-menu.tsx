/**
 * #header-menu-overlay + #header-menu-panel — the hamburger drawer, as a React
 * island (#1079 chunk B). One component for both nodes because they are one
 * surface: the overlay is the panel's backdrop on the desktop / kit-missing
 * path, and nothing ever renders one without the other.
 *
 * ── What THE UI OVERHAUL changed here ─────────────────────────────────
 *
 * ── The drawer is the APP's surface (Streamlined Concept) ─────────────
 *
 * The Figma board draws one app-scoped drawer: the app, its Board, its
 * Activity, "+ New change", the changes in progress and the changes running on
 * other apps, over a Profile / Settings foot. That body is
 * <AppContextRows/> (../app-context/app-context-rows.tsx), which is where the
 * short-lived `#app-context-sheet` content went.
 *
 * What left this panel with that change: the Notifications and Messages rows
 * (they are the two header glyphs now — platform alerting has no business
 * inside the app's own surface) and the Your-apps list (the Apps sheet behind
 * the title tab switches apps).
 *
 * The two blocks are anchored to OPPOSITE ENDS of the panel — the app rows to
 * the top, the account rows to the bottom via `mt-auto`.
 *
 * Five things left: the theme selector (a SETTING now, and the first one —
 * features/settings/sections/theme.tsx), the kudos and AI-credit meters
 * (ambient numbers nobody acts on from a menu), the Leaderboard row (the home
 * screen's Challenges area links there) and the whole bottom-anchored footer —
 * version, GitHub, Share — which is app-scoped and therefore Improve-panel
 * material.
 *
 * The modules that own live content in this subtree — ./node-pill.js for
 * #drawer-row-node, ./wallet-sheet.js for #drawer-row-wallet, and
 * ./header-menu-controller.js for the drawer's own open/close — are imported
 * and initialised by ./platform-header.tsx. They used to boot from THIS
 * island's layout effect, which was never about the drawer: it was about being
 * the earliest island in the bundle, and the header bar is earlier.
 *
 * The drawer stays MARKUP-ONLY apart from the notifications body, and for the
 * usual reason: app.js and app-view.js still show and hide individual rows per
 * screen, and on touch the panel is physically adopted into a kit side drawer
 * (PlatformUI.panel({contentEl}) reparents it and adds .platform-panel-adopted),
 * which a re-render of the panel's own `className` or child order would clobber.
 *
 * <AppContextRows/> is the one exception, and it earns it the same way the
 * notifications body used to: its whole subtree is React's, driven by the
 * improve store, and nothing in public/js/** writes inside it. It renders the
 * shipped markup exactly on the first pass — target-less, no rows — so
 * hydration matches byte for byte.
 *
 * Why those init()s run from a LAYOUT effect (over in the header bar, now):
 * imported modules evaluate while the bundle loads — before hydration — and
 * both node-pill and wallet-sheet lift `hidden` off a row React is about to
 * hydrate. A layout effect runs inside flushSync(hydrateRoot), so the class
 * lands after hydration has adopted the node and still before
 * DOMContentLoaded, where app.js's own init waits.
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
import { AppContextRows } from '../app-context/app-context-rows';
import { NodePillRow } from './node-pill-row';
import { WalletRow } from './wallet-row';

export function HeaderMenu() {
  // NO BOOT SEAM HERE ANY MORE. This island used to carry the bundle's
  // earliest side-effect imports and a layout effect that init()ed NodePill,
  // WalletSheet, NativeAppVersion, HeaderMenu and Notifications — not because
  // any of them belonged to a drawer, but because this was the first island to
  // load. ./platform-header.tsx is earlier and never unmounts, so the seam
  // lives there now and this file is markup again.

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
          <AppContextRows />
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
            {/*
                PROFILE | SETTINGS, side by side (Streamlined Concept): the
                board closes its drawer with two equal buttons rather than two
                more full-width rows, which is what separates "the account"
                from the app rows above.
            */}
            <div className="flex gap-3 px-4 py-3">
            <a
              id="drawer-row-profile"
              href="#profile"
              className="flex-1 min-w-0 flex items-center justify-center gap-2 min-h-[44px] rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            >
              <UserIcon id="drawer-profile-glyph" className="w-4 h-4 shrink-0" />
              <img
                id="drawer-avatar"
                alt=""
                className="hidden w-4 h-4 shrink-0 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800"
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
              className="flex-1 min-w-0 flex items-center justify-center gap-2 min-h-[44px] rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            >
              <CogIcon className="w-4 h-4 shrink-0" />
              <span className="text-sm font-medium">
                Settings
              </span>
              <span
                id="drawer-byok-dot"
                className="hidden w-2 h-2 rounded-full bg-emerald-500 shrink-0"
                aria-hidden="true"
              >
              </span>
            </a>
            </div>
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
              THE DRAWER ENDS HERE — there is no footer.

              It used to end in a bottom-anchored #drawer-footer: the platform
              version, the installed mobile-app release, the "Forked from"
              lineage label, View on GitHub and Share app. THE UI OVERHAUL
              moved that block into the Improve panel, and the Streamlined
              Concept board then took it apart entirely, because the board
              draws a drawer of navigation and work and nothing else. Each
              line went to the surface it is actually about:

                - the two version lines  → Settings' #settings-about
                - fork lineage + GitHub  → the app's own page (#apps/<slug>)
                - Share app              → the Improve panel's third action

              Two consequences worth naming. The `mt-auto` on that footer was
              the only reason #header-menu-rows is a column flex, and it stays
              so — the account rows use it now (see #drawer-main-rows). And the
              deploy dot the footer's amber pill used to drive is unchanged:
              ImproveStatus.refreshDeployDot still reads a rendered version row,
              it just reads the one in Settings.
          */}

        </div>
      </div>
    </>
  );
}
