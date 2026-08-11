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
 *  - #settings-nav-desktop and #settings-mobile-menu-host are the ONLY two
 *    nodes on this screen that are ever innerHTML-rendered, and they still are,
 *    by Settings._renderNav(). They ship EMPTY (as they always have), so React
 *    hydrates two empty hosts and never looks at them again; the module fills
 *    them on open. Rendering the nav from React instead would mean reconciling
 *    over markup the module also writes, which is the one thing the island rule
 *    forbids.
 *  - #settings-section-content's children are static components (see
 *    ./sections). The router only toggles `hidden` on the wrappers — no pane is
 *    ever rebuilt, because settings.js binds every control inside them by id
 *    ONCE and a rebuilt pane is a pane whose controls silently stop working.
 *  - #settings-footer is physically RE-PARENTED between the two columns by
 *    Settings._syncFooter() (sidebar on desktop, under the level-1 menu on
 *    mobile). React must therefore never re-render it either: this subtree is
 *    static for the same reason the panes are.
 *
 * max-w-5xl (not the admin console's full width): every section here is a form
 * column, none is a wide chart grid.
 */

import { SettingsSections } from './sections';

export function SettingsScreen() {
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
            <nav id="settings-nav-desktop" aria-label="Settings sections" className="space-y-1">
            </nav>
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
                className="w-full rounded-lg border border-red-400 dark:border-red-700 px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
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
            <div id="settings-mobile-menu-host" className="md:hidden">
            </div>
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
