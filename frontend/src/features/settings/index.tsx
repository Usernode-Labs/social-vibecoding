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
 *    ./sections), and they MOUNT ON FIRST REVEAL rather than shipping in the
 *    prerender (lib/mount-on-reveal.ts): the host is empty in
 *    public/index.html, exactly as #admin-section-content is. Their CODE
 *    arrives the same way: the panes and ./settings.js are one lazy chunk
 *    (./settings-chunk.ts) that ./facade.js loads on the first open or at
 *    idle, so a load that never opens this screen never downloads them.
 *    Once mounted, the router only toggles `hidden` on the wrappers — no
 *    pane is ever rebuilt, because settings.js binds every control inside
 *    them by id ONCE and a rebuilt pane is a pane whose controls silently
 *    stop working.
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
 * unchanged apart from its bootstrap lines: it still publishes window.Settings
 * at module scope (app.js, app-view.js, dev-chat.js and credit-options.js all
 * call it unguarded) — taking over from ./facade.js, which published the
 * boot-time surface first — and its DOMContentLoaded handler is replaced by
 * the init() the panes call once they exist.
 */

import type { ComponentType } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useStoreState } from '../../lib/use-store-state';
// The EAGER half of the module: publishes window.Settings with the boot-time
// surface (refresh() and the per-navigation no-ops) and loads the rest —
// ./settings.js via ./mount, and the sixteen panes — as one lazy chunk on the
// first open, or at idle for a signed-in viewer. See ./facade.js.
import { ensureSettings, prefetchSettings, settingsChunkStore } from './facade.js';
// The first-run terms prompt rides the SHELL, not the chunk: it listens for
// the once-per-document sv:authed boot signal and presents through
// window.Settings.showTermsSheet, which the façade answers by loading the
// module and forwarding. It used to be imported from ./mount, which is now
// inside the chunk — and a boot listener that only exists once the screen has
// been opened would never fire.
import './terms-first-run.js';
import { SettingsMobileMenu, SettingsNavDesktop } from './settings-nav';

interface SettingsChunkState {
  Sections: ComponentType | null;
  failed: boolean;
}

export function SettingsScreen() {
  // The sixteen panes mount on the screen's FIRST REVEAL, not in the
  // prerender (see lib/mount-on-reveal.ts). They were 437 of the document's
  // 1,485 elements, parsed, styled and hydrated on every load for a screen
  // most loads never open. The chassis below — the column, the sidebar, the
  // two nav hosts, the footer and the empty #settings-section-content — is
  // still in the document, because app.js reads the root by id and the
  // declared checks select through it.
  //
  // Settings.open() asks for the interior itself (`_ensureMounted`, through
  // window.UsernodeReact.mount) before it renders a single pane, and gets it
  // synchronously; the visibility path below is the belt to that brace.
  const mounted = useMountedOnReveal('settings-screen');
  // The panes' component, once the chunk is in. Committed with flushSync from
  // the chunk's own resolution (facade.js), so a Settings.open() that arrives
  // after it finds the panes already in the document.
  const { Sections, failed } = useStoreState(settingsChunkStore) as SettingsChunkState;

  // refresh() reads /api/auth/me (joining the boot read) into Settings.state,
  // which dev-chat and app-view consult for `hasApiKey` before this screen is
  // ever opened — so it runs at hydration, on every route, as before. At boot
  // window.Settings is the façade, whose refresh() is exactly that read and
  // nothing else; and this is also where the idle prefetch is armed.
  useIsomorphicLayoutEffect(() => {
    window.Settings?.refresh?.();
    prefetchSettings();
  }, []);

  // The reveal asks for the module. Settings.open() already does (it goes
  // through the façade, which loads and forwards); this is the belt for the
  // visibility path, so a screen revealed without open() is not left blank.
  // init() — binding every control by id, ONCE — no longer lives here: it is
  // a layout effect inside ./sections, which is the one place that runs
  // exactly when the panes exist. `mounted` is one-way, so neither re-fires.
  useIsomorphicLayoutEffect(() => {
    if (mounted) ensureSettings();
  }, [mounted]);

  return (
    <main
      id="settings-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll dc-lift dc-lift-strip"
      style={{ position: "relative" }}
    >
      {/*
          THE SCREEN IS THE STRIP and the open section is the SHEET, the dev
          session's ladder (`.dc-lift` in app.css): the section list — the
          level-1 menu on a phone, the sidebar from md up — sits on the strip,
          and #settings-section-content rises on it with the section inside.
      */}
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
            <div id="settings-footer" className="mt-6 pt-2">
              <button
                id="settings-logout"
                className="w-full rounded-full bg-red-500/10 px-4 py-2.5 text-[17px] font-semibold text-red-700 dark:text-red-400 hover:bg-red-500/15 transition-colors"
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
            <div id="settings-section-content" className="settings-sheet dc-lift dc-lift-session">
              {mounted && Sections ? <Sections /> : null}
              {mounted && !Sections && failed ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400 p-4">
                  Settings could not be loaded. Check your connection and try again.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
