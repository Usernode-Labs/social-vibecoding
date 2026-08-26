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
 * The two blocks are anchored to OPPOSITE ENDS of the panel — notifications to
 * the top, the navigation rows to the bottom via `mt-auto` — rather than
 * stacked from the top with all the slack underneath. That is why
 * #drawer-notifications is a sibling of #drawer-main-rows rather than its
 * first child.
 *
 * #1367 also collapsed the notifications SECTION behind a disclosure, and its
 * follow-up took that back out: the useful grain is each GROUP inside the
 * section, not the section itself. See the note in the component body.
 *
 * So this island is markup-only again, exactly as the header above describes —
 * no state, no disclosure, and <NotificationsBody/> still the one subtree that
 * renders from a store.
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

import {
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
    // #1436: notifications' init() and its pull-to-refresh attachment moved
    // WITH the list, to ../notifications/notifications-sheet.tsx. They belong
    // to whichever island renders #notifications-list, and that is no longer
    // this one.
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
              NOTIFICATIONS LEFT THIS DRAWER in #1436.

              THE UI OVERHAUL merged the bell in here, on the reasoning that
              two top-right drawers opening the same way one slot apart were
              one affordance too many. That was right about the DRAWERS and
              wrong about the destination: it left "what happened while I was
              away" as a list inside an unlabeled menu.

              #1436 does not undo the merge, it finishes it. The hamburger is
              gone — this surface is opened by the labeled app-switcher chip
              on the left now — so the bell is no longer a second drawer
              beside a first one. The list is
              ../notifications/notifications-sheet.tsx, with the same
              components, the same store and the same ids un-retired, so
              ../notifications/notifications.js is untouched by the move.

              What is left in here is the SWITCHER: where you are, where else
              you can go, and your account as a terminal group at the bottom.
              That is the spine the hamburger never had, and the rule that
              keeps it: a row that is neither "where am I" nor "you" does not
              belong in this menu.
          */}
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
          <div id="drawer-main-rows" className="shrink-0">
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
            {/*
                THE ROW HAIRLINE IS INSET past the glyph — `left-12` is this
                row's `px-4` (1rem) plus the 20px icon plus `gap-3` (0.75rem),
                i.e. exactly where the label starts. It is a pseudo-element
                rather than `border-b` because a border cannot be inset.

                Same treatment, same reason, as the home panels' rules and
                @/components/ui/grouped-list.tsx: the widget language starts a
                row separator at the content, not at the sheet's edge. The
                drawer's own chrome boundaries (the close-button strip at the
                top, the notifications pane's foot) keep their full-bleed
                borders — those divide PANES, not rows.
            */}
            <a
              id="drawer-row-profile"
              href="#profile"
              className="flex items-center gap-3 px-4 min-h-[44px] relative after:absolute after:bottom-0 after:left-12 after:right-0 after:h-px after:bg-zinc-100 dark:after:bg-zinc-800 after:content-[''] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
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
                MESSAGES LEFT THIS MENU in #1436, and its badge went with it.

                It is an INBOX, and this menu is the switcher: where you are,
                where else you can go, and your account. An inbox is neither,
                which is the rule that stops this drawer drifting back into
                the catch-all it used to be. Messages has its own header
                control beside the bell now — #messages-btn — and
                #drawer-messages-badge moved onto it, keeping its id and its
                writer so the Messages store paints it unchanged.

                That move is also what ended the double-count: one incoming
                direct message used to light this badge AND the red one on the
                button containing it, because `conversation_message` is a
                notification kind. Notifications._bellUnread() excludes it
                now — see the note there.
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
