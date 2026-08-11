/**
 * #header-menu-overlay + #header-menu-panel — the hamburger drawer, as a React
 * island (#1079 chunk B). One component for both nodes because they are one
 * surface: the overlay is the panel's backdrop on the desktop / kit-missing
 * path, and nothing ever renders one without the other.
 *
 * The modules that own live content in this subtree are bundled with it and
 * initialise from the island's layout effect:
 *
 *   ./node-pill.js               #drawer-row-node    (native node status)
 *   ./wallet-sheet.js            #drawer-row-wallet  (native wallet balance)
 *   ./native-app-version.js      #native-app-version-slot (installed build)
 *   ./ai-credit.js               #drawer-row-ai-budget / #ai-budget-slot
 *   ./header-menu-controller.js  the drawer's own open/close (was
 *                                App.HeaderMenu / App.DrawerStatus in app.js)
 *
 * The drawer stays MARKUP-ONLY apart from the theme segments below, and for the
 * usual reason: app.js and app-view.js still show and hide individual rows per
 * screen, and on touch the panel is physically adopted into a kit side drawer
 * (PlatformUI.panel({contentEl}) reparents it and adds .platform-panel-adopted),
 * which a re-render of the panel's own `className` or child order would clobber.
 *
 * ThemeControl is the one exception, and it earns it: the segmented control's
 * whole subtree is React's — nothing in public/js/** writes to it now that
 * _renderThemeButtons has moved in here as state. It still renders the shipped
 * markup exactly on the first pass (no active segment, aria-checked="false", no
 * caret index) and only reflects Theme.get() from a layout effect, so hydration
 * matches byte for byte.
 *
 * Why init() moves to a layout effect: imported modules evaluate while the
 * bundle loads — before hydration — and both node-pill and wallet-sheet lift
 * `hidden` off a row React is about to hydrate. A layout effect runs inside
 * flushSync(hydrateRoot), so the class lands after hydration has adopted the
 * node and still before DOMContentLoaded, where app.js's own init waits.
 * ai-credit.js is imported for its side effect only — App.init() calls
 * AiCredit.Budget.init() when the viewer is known to be signed in, which is a
 * decision this component cannot make.
 */

import { useCallback, useRef, useState } from 'react';
import { useIsomorphicLayoutEffect, useWindowEvent } from '../../lib/legacy-dom';
import './ai-credit.js';
import './native-app-version.js';
import './node-pill.js';
import './wallet-sheet.js';
import './header-menu-controller.js';

// Order of the three segments in the DOM — also the caret's stop index, so the
// two can never disagree.
const THEME_MODES = ['light', 'dark', 'system'] as const;
type ThemeMode = (typeof THEME_MODES)[number];

const THEME_SEG_CLASS =
  'theme-seg flex-1 basis-0 rounded-md px-1.5 py-1 transition-colors';

const THEME_LABELS: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/**
 * The Light / Dark / System segmented control — App.HeaderMenu's
 * _renderThemeButtons(), as state.
 *
 * `mode` starts null, which renders EXACTLY the markup the hand-written shell
 * shipped: no `theme-seg-active`, `aria-checked="false"` on all three, and no
 * `--theme-caret-index` on the track. Theme.get() is only readable on the
 * client (the inline head block owns it), so reading it during render would
 * mismatch the prerender; the layout effect below fills it in on the first
 * client pass instead.
 *
 * The caret index is written through a ref rather than rendered as a `style`
 * prop for the same reason — the shipped track carries no style attribute, and
 * a custom property is not something to reconcile.
 *
 * Three things re-read the mode, matching the three the legacy wiring had:
 * a click on a segment, Theme.onChange (another tab, the OS sunset switch), and
 * every drawer open (`usernode:header-menu-open`, dispatched by the controller
 * where open() used to call _renderThemeButtons directly).
 */
function ThemeControl() {
  const [mode, setMode] = useState<ThemeMode | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const sync = useCallback(() => {
    const current = window.Theme?.get?.();
    setMode(
      THEME_MODES.includes(current as ThemeMode) ? (current as ThemeMode) : null,
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    sync();
    // Storage/OS-driven changes (other tab, OS sunset switch) re-highlight too.
    window.Theme?.onChange?.(sync);
  }, [sync]);

  // Reflect the current mode every time the drawer opens — covers cross-tab
  // changes and explicit values that happen to match the OS.
  useWindowEvent('usernode:header-menu-open', sync);

  useIsomorphicLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || mode === null) return;
    // The caret is moved by writing --theme-caret-index (0|1|2) on the track
    // and letting CSS translate a thirds-width element by index * 100%.
    // Deliberately NOT a pixel measurement: this runs from the drawer's
    // open BEFORE PlatformUI.panel resizes the panel from w-60 to the kit
    // drawer's --un-panel-width, so a pixel read here would be stale the
    // moment the panel presents. Percentages are correct at both widths with
    // no re-measure, and the transition in CSS is what makes the caret slide.
    track.style.setProperty(
      '--theme-caret-index',
      String(Math.max(0, THEME_MODES.indexOf(mode))),
    );
  }, [mode]);

  // A live control, NOT a navigation row: it sets the mode and re-highlights
  // WITHOUT closing the drawer, so the user can see the recolor and switch
  // again. (These are <button>s, so the panel's delegated a[href] close
  // handler never sees them.)
  const choose = useCallback(
    (next: ThemeMode) => {
      window.Theme?.set?.(next);
      sync();
    },
    [sync],
  );

  return (
    <div
      id="drawer-theme-track"
      ref={trackRef}
      role="radiogroup"
      aria-label="Theme"
      className="relative flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs font-medium"
    >
      {THEME_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m ? 'true' : 'false'}
          data-theme-mode={m}
          className={mode === m ? `${THEME_SEG_CLASS} theme-seg-active` : THEME_SEG_CLASS}
          onClick={() => choose(m)}
        >
          {THEME_LABELS[m]}
        </button>
      ))}
      <span id="drawer-theme-caret-track" aria-hidden="true">
        <span id="drawer-theme-caret">
        </span>
      </span>
    </div>
  );
}

export function HeaderMenu() {
  useIsomorphicLayoutEffect(() => {
    window.NodePill?.init();
    window.WalletSheet?.init();
    window.NativeAppVersion?.init();
    // The drawer's own open/close wiring — app.js's bindEvents() used to call
    // this; it lives beside the markup it drives now (#1079 chunk B).
    window.HeaderMenu?.init();
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
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/*
            Panel body — ONE scroller, laid out as a COLUMN FLEX so the
            footer block at its end can be bottom-anchored with `mt-auto`:
            when the rows above are short the free space collects above the
            footer and it hugs the bottom of the panel; when they overflow
            (a short viewport) there is no free space and the footer simply
            sits at the end of the scroll. One rule, both behaviours, no
            measurement. On touch the panel fills a full-height kit side
            drawer (.platform-panel-adopted), so the footer sits at the
            bottom of the screen there too.
            
            The theme selector and the status pane are first in DOM order
            rather than pinned outside the scroller: pinning blocks above
            the list would leave a short viewport almost no room for the
            navigation rows. Being first means they're on screen the moment
            the drawer opens at any realistic viewport.
        */}
        <div id="header-menu-rows" className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          <div id="drawer-main-rows" className="shrink-0">
            {/*
                Theme — Light / Dark / System, the FIRST thing in the menu.
                Unlike every row below it this is a live control, not a
                navigation action: a non-clickable container (no hover bg) whose
                only interactive descendants are the three segment buttons, and
                tapping a mode does NOT close the drawer.
                
                Deliberately compact — text-xs faces on a py-1 track — so the
                control reads as a setting rather than a banner and costs the
                rows below it as little height as possible.
                
                Active segment + caret position are React state now
                (ThemeControl above, which is where App.HeaderMenu's
                _renderThemeButtons ended up). All the persistence still lives
                in the inline `window.Theme` block at the top of
                frontend/src/head.html — head-blocking, so the stored mode is
                applied before first paint — untouched by both the segmented
                restyle and this conversion.
            */}
            <div
              id="drawer-row-theme"
              className="px-4 pt-2 pb-2.5 border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300"
            >
              <div className="flex items-center gap-3 mb-1.5">
                <svg
                  className="w-5 h-5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
                <span className="text-xs font-medium">
                  Theme
                </span>
              </div>
              {/*
                  Segmented track + caret. The caret is positioned purely in CSS
                  from the --theme-caret-index custom property (0|1|2) that
                  ThemeControl writes on the track: a thirds-width element
                  translated by index * 100%. Deliberately NOT measured in JS —
                  the index is written before PlatformUI.panel resizes the panel
                  from w-60 to the kit drawer's width, so any pixel read at that
                  moment would be wrong. Percentages are right at both.
              */}
              <ThemeControl />
            </div>
            {/*
                Status pane: the viewer's remaining weekly kudos and their daily
                AI credit. Every <span> below is the SAME element (same id) that
                used to sit in the header, so Kudos.Budget._render /
                AiCredit.Budget._render keep resolving their slot by
                getElementById with no change.
                
                The build/version rows moved OUT of this pane and into
                #drawer-footer at the bottom of the panel (they're reference
                information, not something you act on), where they render as
                plain text rather than pills. Their slot ids are unchanged.
                
                The rows are plain <div>s, never <a>/<button>: the values render
                their own anchor/button where one is warranted, and nesting
                those inside a clickable row would be invalid markup.
            */}
            <div id="drawer-status-pane" className="border-b border-zinc-100 dark:border-zinc-800">
              <div
                id="drawer-row-kudos"
                className="flex items-center gap-3 px-4 min-h-[44px] text-zinc-600 dark:text-zinc-300"
              >
                <svg
                  className="w-5 h-5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"
                  />
                </svg>
                <span className="text-sm font-medium">
                  Kudos
                </span>
                <span id="kudos-budget-slot" className="ml-auto inline-flex min-w-0">
                </span>
              </div>
              {/*
                  AI credit (#555): the viewer's own daily LLM-spend allowance,
                  used vs. remaining. Shown to EVERY signed-in user — the first
                  place in the product that tells you where you stand before a
                  turn is refused with "Daily limit reached".
                  
                  Ships hidden and is revealed by AiCredit.Budget once
                  /api/me/ai-budget answers, so a signed-out visitor (or someone
                  still in the waiting room) never sees an empty row. Carries no
                  global spend or global cap: those are admin-only, per
                  services/status.js redact().
              */}
              <div
                id="drawer-row-ai-budget"
                className="hidden flex flex-wrap items-center gap-3 px-4 py-1 min-h-[44px] text-zinc-600 dark:text-zinc-300"
              >
                <svg
                  className="w-5 h-5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                  />
                </svg>
                <span className="text-sm font-medium">
                  AI credit
                </span>
                {/*
                    `grow text-right` (rather than the plain `ml-auto inline-flex`
                    the other value slots use) is what keeps this value hard against
                    the panel's right edge in BOTH of its layouts. `ml-auto` alone
                    only right-aligns it while it shares the line with the label;
                    the figure is usually too wide for the 15rem panel, so the
                    row's `flex-wrap` drops it to its own line — where an
                    auto-width item sits flush LEFT under the icon. Growing to fill
                    that line and right-aligning the text inside means the wrapped
                    value ends where the label's value would have, and the two
                    halves of a `·`-broken figure stack right-aligned under each
                    other.
                */}
                <span id="ai-budget-slot" className="ml-auto grow min-w-0 text-right">
                </span>
              </div>
              {/*
                  An "Anthropic credits" row (the ORGANISATION's remaining
                  Anthropic balance) used to sit here for admins. It was removed:
                  Anthropic publishes no credit balance, so the figure had to be
                  recorded by hand and the row read "Not set up" indefinitely.
                  The balance now lives only in the admin console's Spend limits
                  section (see AdminConsole.renderLimitsSection) — the
                  /api/admin/anthropic-credits endpoints are unchanged.
              */}
            </div>
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
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"
                />
              </svg>
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
                "View on GitHub" and "Share App" used to be here too; they are
                the LAST two items of #drawer-footer at the bottom of the panel
                now (same ids, same lifecycle).
            */}
            {/*
                MAIN NAV ORDER — Profile, Leaderboard, Settings, Admin &
                moderation. Personal-first, then shared, then configuration,
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
              <svg
                id="drawer-profile-glyph"
                className="w-5 h-5 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
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
                Leaderboard — the one entry point for shared progress: the
                Topochain standings (the primary tab, and what the bare
                #leaderboard hash opens), the Kudos leaderboard and the season's
                challenges, three tabs on a single screen. This row replaces the header
                trophy (#leaderboard-btn), the old
                #drawer-row-topochain-leaderboard, and the separate Challenges /
                Topochain-seasons rows that used to sit under it. Keeps the
                trophy icon the header used. Real anchor so hash navigation
                drives the screen; the handler in HeaderMenu.init just closes
                the drawer.
            */}
            <a
              id="drawer-row-leaderboard"
              href="#leaderboard"
              className="flex items-center gap-3 px-4 min-h-[44px] border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 11V3H8v8M5 7H3v4a2 2 0 002 2h3M19 7h2v4a2 2 0 01-2 2h-3M8 15a4 4 0 008 0h-8z M12 15v3m-3 3h6"
                />
              </svg>
              <span className="text-sm font-medium">
                Leaderboard
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
              className="flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
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
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
              <span className="text-sm font-medium">
                Admin &amp; moderation
              </span>
            </a>
          </div>
          {/*
              ── Drawer footer ────────────────────────────────────────────────
              Reference + app-scoped link rows, pinned to the FOOT of the
              panel: `mt-auto` inside #header-menu-rows' column flex hugs the
              bottom of the viewport whenever the rows above leave free space,
              and degrades to "just at the end of the scroll" when they don't
              (touch sheet, short viewport). No JS, no measurement.
              
              The build lines render as PLAIN TEXT rather than pills — the
              old "usernode · 1a2b3c4" pill overflowed the 15rem panel, and a
              version you can't act on doesn't need pill chrome. The slots keep
              their ids, so App.renderPlatformVersionPill /
              AppView.refreshVersionPill / AppView.renderForkBadge all still
              resolve them by getElementById; the renderers just emit the
              .drawer-ver text form for these two (see the `plain` flag on
              AppView.renderAppVersionPillHTML).
              
              GitHub + Share are the last two items, on the same
              app-open lifecycle they had as mid-list rows (App.openApp /
              navigate* toggle their `hidden`).
          */}
          <div id="drawer-footer" className="mt-auto shrink-0 border-t border-zinc-100 dark:border-zinc-800">
            {/*
                Display utilities stay in the markup (never in .drawer-ver-row)
                so the `hidden`-toggling rows below keep behaving exactly as
                they did: Tailwind's `hidden` must win over the row's own
                `flex`, which it can only do reliably against another Tailwind
                utility. .drawer-ver-row carries typography + metrics only.
            */}
            <div id="drawer-row-platform-version" className="drawer-ver-row flex items-center gap-2 px-4">
              <span className="drawer-ver-label">
                Platform version
              </span>
              <span
                id="platform-version-pill-slot"
                className="drawer-ver-value ml-auto inline-flex min-w-0 justify-end"
              >
              </span>
            </div>
            {/*
                Installed Usernode app build (#1101) — populated from the
                native bridge's getSettingsState().buildInfo and revealed only
                in the native top frame. It is independent of both the deployed
                platform SHA above and the currently-open dApp SHA below.
            */}
            <div id="drawer-row-native-app-version" className="hidden drawer-ver-row flex items-center gap-2 px-4">
              <span className="drawer-ver-label">
                App version
              </span>
              <span
                id="native-app-version-slot"
                className="drawer-ver drawer-ver-value ml-auto min-w-0 justify-end"
              >
              </span>
            </div>
            {/*
                dApp build — revealed by App.DrawerStatus.setAppOpen() whenever
                a non-self-hosted app is open, on the same lifecycle as
                #drawer-row-github / #drawer-row-share. The self-hosted
                platform would duplicate "Platform version", so it stays
                hidden there.
            */}
            <div id="drawer-row-app-version" className="hidden drawer-ver-row flex items-center gap-2 px-4">
              <span className="drawer-ver-label">
                dApp version
              </span>
              <span id="app-version-pill-slot" className="drawer-ver-value ml-auto inline-flex min-w-0 justify-end">
              </span>
            </div>
            {/*
                Fork lineage: amber "⑂ Forked from <name>" label, written by
                AppView.renderForkBadge() and revealed by
                App.DrawerStatus.setForkVisible(). Sits directly under the app
                build line so the two read as one app-scoped block.
            */}
            <div id="drawer-row-app-fork" className="hidden drawer-ver-row items-center gap-2 px-4">
              <span id="app-fork-badge-slot" className="ml-auto inline-flex min-w-0 justify-end">
              </span>
            </div>
            {/* View on GitHub — only shown when app is open and has a repo */}
            <a
              id="drawer-row-github"
              href="#"
              target="_blank"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] border-t border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span className="text-sm font-medium">
                View on GitHub
              </span>
            </a>
            {/* Share App — only shown when app is open and running */}
            <button
              id="drawer-row-share"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-t border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </svg>
              <span className="text-sm font-medium">
                Share App
              </span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
