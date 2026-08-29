/**
 * #settings-screen — the settings chassis, as a React island (#1081 chunk D).
 *
 * The screen was a modal overlay (#settings-modal) until it was converted into
 * a real screen laid out like the Admin & moderation console: a grouped sidebar
 * on md+, a two-level menu -> section hierarchy below it. It is mounted by
 * App.navigateToSettings and ships hidden like its sibling screens.
 *
 * ── What is React's here, and what is not ──────────────────────────────
 *
 * This component owns the CHASSIS MARKUP: the max-w-5xl column, the sidebar,
 * the two nav hosts, the log-out footer and the section container. ../settings.js
 * owns everything that happens inside them. That boundary is not a staging post
 * — it is the shape the screen has to keep:
 *
 *  - #settings-nav-desktop and #settings-mobile-menu-host were the ONLY two
 *    nodes on this screen that were ever innerHTML-rendered. #1191 slice 6
 *    conversion 8 converted BOTH (./settings-nav.tsx, fed by
 *    ./settings-nav-store.js), so the module no longer writes markup anywhere
 *    on this screen: Settings._renderNav() pushes two descriptors and the
 *    components render them. Both hosts still ship EMPTY, which is what keeps
 *    the prerendered markup identical.
 *  - #settings-section-content's children are static components (see
 *    ./sections). The router only toggles `hidden` on the wrappers — no pane is
 *    ever rebuilt, because settings.js binds every control inside them by id
 *    ONCE and a rebuilt pane is a pane whose controls silently stop working.
 *  - #settings-footer is physically RE-PARENTED between the two columns by
 *    Settings._syncFooter() (sidebar on desktop, under the level-1 menu on
 *    mobile). React must therefore never re-render it either: this subtree is
 *    static for the same reason the panes are. Since conversion 8 the move
 *    leaves a comment behind in the sidebar column (lib/kit-surface.ts's
 *    createPlaceholderHome, planted by ./mount.ts), so the slot React
 *    rendered the footer into stays open while the node is away — the same
 *    seam the dialog cards' lift uses, and the reason there is no portal
 *    here.
 *
 * max-w-5xl (not the admin console's full width): every section here is a form
 * column, none is a wide chart grid.
 *
 * ./settings.js is the retired public/js/settings.js, moved into this bundle
 * unchanged apart from its two bootstrap lines: it still publishes
 * window.Settings at module scope (app.js, app-view.js, dev-chat.js and
 * credit-options.js all call it unguarded), and its DOMContentLoaded handler
 * is replaced by the init() below.
 */

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { SettingsSections } from './sections';
// ./mount imports ./settings.js and plants both seams on it. Importing that
// module directly here would publish window.Settings without a store and
// leave the two nav hosts permanently empty.
import './mount';
import { SettingsMobileMenu, SettingsNavDesktop } from './settings-nav';

export function SettingsScreen() {
  // A LAYOUT effect, like the other islands: init() binds every control on
  // this screen by id, and it has to have run before app.js's DOMContentLoaded
  // handler routes an initial #settings/<section> hash at it. The React entry
  // is a deferred module, so this still lands in the same window the classic
  // <script> tag's own DOMContentLoaded handler used to.
  useIsomorphicLayoutEffect(() => {
    window.Settings?.init();
  }, []);

  return (
    <main
      id="settings-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: "relative" }}
    >
      <div id="settings-root" className="max-w-5xl mx-auto p-4 w-full">
        <div className="md:flex md:items-start md:gap-6">
          {/*
              Desktop sidebar menu. Below md there is no nav here at all:
              phones get the two-level hierarchy instead (the level-1 menu
              renders into #settings-mobile-menu-host).
          */}
          <div id="settings-sidebar-col" className="hidden md:block md:w-56 shrink-0">
            <SettingsNavDesktop />
            {/*
                Log out is pinned below the section list rather than buried
                inside a section. On mobile it moves under the level-1 menu
                (see Settings._syncFooter) — the node itself is MOVED, never
                rebuilt, so the click handler settings.js binds in init()
                survives the trip.
            */}
            <div id="settings-footer" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700">
              <button
                id="settings-logout"
                className="w-full rounded-lg border border-red-400 dark:border-red-700 px-4 py-2 text-sm font-medium text-red-700 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
              >
                Log out
              </button>
            </div>
          </div>
          <div id="settings-content-col" className="flex-1 min-w-0">
            {/*
                Mobile level 1: the grouped section menu. Empty (and
                md:hidden) on desktop.
            */}
            <SettingsMobileMenu />
            {/*
                Every section lives here permanently; the router unhides
                exactly one wrapper (or hides the host entirely on mobile
                level 1). max-w-xl keeps form controls from stretching the
                full width of the wide shell.
            */}
            <div id="settings-section-content" className="pb-8 max-w-xl">
              <SettingsSections />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
