/**
 * #admin-screen — the Admin & moderation console chassis, as a React island
 * (#1082 chunk E).
 *
 * The full-page console behind the header shield icon (#818, extended by #860
 * to fold in the seven standalone operator pages). Hash route #admin[/section];
 * mounted by App.navigateToAdminConsole, which gates on App.user.isAdmin — both
 * full and view-only admins — and every /api/admin/* endpoint it calls is
 * independently enforced server-side.
 *
 * ── What is React's here, and what is not ──────────────────────────────
 *
 * This component owns the CHASSIS MARKUP that ./admin-console.js used to write
 * into #admin-root with innerHTML on every open, every section switch and every
 * viewport crossing: the md:flex column pair, the desktop nav host, the
 * view-only banner, #admin-section-content, and the temporary-password dialog.
 * The nineteen sections' contents are still the modules' — that boundary is not
 * a staging post, it is the shape the screen has to keep:
 *
 *  - #admin-nav-desktop is an innerHTML host, filled by
 *    AdminConsole._navItemsHtml() on every repaint. It ships EMPTY (React
 *    hydrates an empty host and never looks inside it again), exactly the seam
 *    #settings-nav-desktop uses. Rendering the nav from React would mean
 *    reconciling over markup the module also writes.
 *  - #admin-section-content is the same kind of host, and stays one. Unlike
 *    Settings — where every pane is permanently mounted and the router only
 *    toggles `hidden` — an admin section MUST be torn down when you leave it:
 *    Health & status polls /api/status every 5s (which shells out to
 *    `docker stats` server-side) and Node & chain polls every 2s, so the
 *    render(host)/destroy() lifecycle in AdminConsole._renderSection is
 *    load-bearing rather than incidental. It also hosts the phone layout's
 *    level-1 menu, which is innerHTML'd into the same node. React owns the
 *    container and nothing below it.
 *  - #admin-view-only-banner ships HIDDEN and its class is toggled from
 *    AdminConsole._renderShell() through classList — never a rendered
 *    className. Same contract as lib/legacy-dom.ts's useHiddenClass: React
 *    writes the attribute once, at hydration, and never again.
 *  - #admin-temp-pw-modal is static for the same reason. It is NOT one of the
 *    nine dialogs (nothing lifts its card into a kit shell), and
 *    AdminConsole._showTempPasswordModal binds its two buttons with .onclick
 *    (assignment, not addEventListener) at show time, so the nodes may live
 *    here permanently — a repeated show rebinds rather than accumulating.
 *
 * ── The nine heavy sections, through this seam ──────────────────────────
 *
 * Health & status, Node & chain, Analytics, Estimator accuracy, Merge debug,
 * Screenshot gallery, Maintenance campaigns, Push delivery and Email delivery are the sections
 * with their own module (AdminConsole.SECTION_MODULES), and the reason
 * #admin-section-content is a torn-down host rather than a permanently-mounted
 * pane set. Three properties of theirs the chassis has to keep working, all
 * pinned by tests/admin-heavy-sections-island.test.js:
 *
 *  - render(<host>) / destroy(). The host argument IS #admin-section-content;
 *    none of the eight looks it up by id, so the chassis owns that id outright.
 *    destroy() is where four of them clear a timer — status (5s /api/status,
 *    which shells out to `docker stats`), node (2s /api/node-status), merges
 *    (its Live checkbox, via setLive(false)) and campaigns.
 *  - Analytics and Estimator append <div id="dc-tip"> to <body> so their chart
 *    tooltips escape the section's overflow, and remove it in destroy(). That
 *    node lands OUTSIDE this island, in React's hydration container — which is
 *    document.body itself (see main.tsx). It survives because <Shell/> is
 *    static at the root: nothing ever re-renders body's child list, so React
 *    never reconciles the extra child away. Only destroy() reclaims it.
 *  - Four of them (analytics, estimator, gallery, merges) read the page-level
 *    ?demo=1 flag at module-EVALUATION time to select the server's staging
 *    fixtures, which ~12 declared dapp.json checks depend on. Since this bundle
 *    is also evaluated in Node by the prerender pass, each of those reads is
 *    `typeof window !== 'undefined' && …` — the browser answer is unchanged,
 *    because an absent flag already meant false.
 *
 * FULL WIDTH (no max-w / mx-auto, unlike every other screen — including
 * Settings, which is a form column at max-w-5xl): this is a dense operator
 * console, not a reading surface. The folded-in Health & status and Analytics
 * sections were always the widest thing in the app — a 6-across tile grid, wide
 * SVG charts, and user/limit/code tables that were horizontally scrolling
 * inside a capped column — so a capped column cost information rather than
 * protecting legibility. The gutter stays modest (p-4, a little roomier from lg
 * up) and everything inside is percentage/grid-based, so mobile is unchanged.
 *
 * ── Visibility ─────────────────────────────────────────────────────────
 *
 * #admin-screen is in App.SCREEN_IDS, and now in App.REACT_SCREEN_IDS too: the
 * router publishes (id, visible) into the visibility store instead of toggling
 * the class. It has to be the SYNCHRONOUS variant — App.navigateToAdminConsole
 * reveals the screen inside PlatformUI.transition(fn), and the native kit
 * captures the "after" state from whatever fn did before it returned, so a
 * re-render scheduled in a later task would animate nothing.
 *
 * ── The eleven modules ─────────────────────────────────────────────────
 *
 * ./admin-console.js and nine of the ten section modules are the retired
 * public/js/admin-*.js files, MOVED into this bundle rather than rewritten;
 * admin-push.js is the first new module built directly on the same seam.
 * They are imported here, admin-console.js first, because AdminUI — the frozen
 * class-string registry it exports — was a load-order dependency: three of them
 * read it while the module body evaluates. The imports below are what replaces
 * the ten <script> tags; each module still publishes its window global, because
 * AdminConsole._renderSection dispatches sections through window[modName] and
 * app.js calls window.AdminConsole directly.
 *
 * admin-topochain.js is the one that forced that clustering: `const PANEL_CLS =
 * AdminUI.card` runs while its module body evaluates, and a module script is
 * deferred, so retiring admin-console.js alone would have left this file reading
 * a global that no longer existed by the time it ran.
 *
 * admin-topochain.js is otherwise easy to host: since #1179 each of its screens
 * is a first-class console section (Season events still owns tail segments —
 * #admin/season-events/<eventId>[/new-challenge[/<templateId>]] — which it
 * reads from location.hash in render() and writes back with replaceState;
 * AdminConsole._writeHash deliberately leaves an address that deep alone). It
 * holds no timers at all, so its destroy() only
 * releases the host reference. Its SQL-schema explorer
 * (#admin-topo-sql-schema{,-filter,-count}) fetches the ~90-table schema once
 * and filters it in the browser. See tests/admin-seasons-island.test.js.
 *
 * NOT retired: public/js/topochain-events.js stays a classic script — it serves
 * the public Leaderboard screen too, so it is not this chunk's to move.
 */

import { useRef } from 'react';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';

// admin-console.js FIRST: it exports the AdminUI registry the others import,
// and admin-topochain.js reads AdminUI.card at module-evaluation time.
import { AdminUI } from './admin-console.js';
import './admin-overview.tsx';
import './admin-codes.tsx';
import './admin-featured-apps.tsx';
import './admin-db-export.tsx';
import './admin-features.tsx';
import './admin-limits.tsx';
import './admin-users.tsx';
import './admin-rollover.tsx';
import './admin-staging-reap.tsx';
import './admin-status.tsx';
import './admin-node.tsx';
import './admin-analytics.tsx';
import './admin-estimator.tsx';
import './admin-merges.tsx';
import './admin-gallery.tsx';
import './admin-campaigns.tsx';
import './admin-push.tsx';
import './admin-mail.tsx';
import './admin-e2e.tsx';
import './admin-topochain.js';

export function AdminScreen() {
  const screenRef = useRef<HTMLElement | null>(null);

  // Ships hidden, so `false` is the pre-publish fallback that keeps the first
  // (hydrating) render identical to the prerendered document.
  useVisibilityHiddenClass(screenRef, 'admin-screen', false);

  // No init() effect, deliberately — unlike Settings, none of these modules
  // ever had a DOMContentLoaded bootstrap. App.navigateToAdminConsole calls
  // AdminConsole.open() when the #admin route resolves, and the imports above
  // are enough to guarantee the ordering the <script> tags used to give for
  // free: /shell/assets/shell.js is a module script, so it (and therefore
  // every window global those modules publish) evaluates before the
  // DOMContentLoaded handler app.js registers.

  return (
    <main
      ref={screenRef}
      id="admin-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: "relative" }}
    >
      <div id="admin-root" className="w-full p-4 lg:px-6">
        <div className="md:flex md:items-start md:gap-6">
          {/*
              Desktop sidebar menu. Below md there is no nav here at all:
              phones get the two-level hierarchy instead (the level-1 menu
              renders INTO #admin-section-content). Empty on arrival —
              AdminConsole._renderShell() fills it.
          */}
          <nav
            id="admin-nav-desktop"
            aria-label="Admin sections"
            className="hidden md:block md:w-64 shrink-0 space-y-1"
          >
          </nav>
          <div className="flex-1 min-w-0">
            {/*
                View-only admin banner (issue #311), same copy as /admin.
                Ships hidden; AdminConsole._renderShell() reveals it for a
                view-only admin (isAdmin without canAdminWrite) and keeps it
                hidden in public mode, where the viewer is not an admin at all
                and an amber "you can't make changes" strip would be nonsense.
            */}
            <div
              id="admin-view-only-banner"
              className="hidden bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 rounded-lg px-4 py-3 mb-4 text-sm"
            >
              <span className="font-semibold">View-only — read access only.</span>
              {/*
                  ONE text child, not `{' '}` followed by the sentence. The
                  prerender pass uses renderToStaticMarkup (prerender.tsx), which
                  deliberately omits the <!-- --> markers React normally writes
                  between two adjacent text children — so a component with two of
                  them hydrates against a document where they have merged into
                  one node, and that is a hydration mismatch: React error #418,
                  logged as a console.error on EVERY route, which fails the
                  platform's proposal checks. Keep interpolated whitespace inside
                  the string.
              */}
              {" You can see every admin surface but can't make changes. Mutating controls are hidden."}
            </div>
            <div id="admin-section-content" className="pb-8"></div>
          </div>
        </div>
        {/*
            Temporary password modal (issue #282): the reset response is the
            only time the plaintext exists — shown once, never persisted.
            Class strings come from the AdminUI registry so this dialog and the
            module-rendered ones stay one source of truth.
        */}
        <div id="admin-temp-pw-modal" className={`hidden ${AdminUI.dialogOverlay}`}>
          <div className={AdminUI.dialogPanel}>
            <h2 className={`${AdminUI.cardTitle} mb-1`}>Temporary password</h2>
            <p className={`${AdminUI.muted} mb-4`}>
              Give this to <span id="admin-temp-pw-username" className="font-medium text-zinc-800 dark:text-zinc-200"></span> out-of-band (chat, in person). They use it as their password to log in, then set their own from <a href="#settings/password" className="text-violet-700 hover:text-violet-800 dark:text-violet-400 dark:hover:text-violet-300 underline">Settings → Change password</a>. It signs them out everywhere and <span className="font-medium">won't be shown again</span>.
            </p>
            <div className="flex gap-2">
              <code id="admin-temp-pw-value" className="flex-1 min-w-0 break-all rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-900 dark:text-zinc-100"></code>
              <button id="admin-temp-pw-copy" className={`${AdminUI.btn.primary} shrink-0`}>Copy</button>
            </div>
            <button id="admin-temp-pw-close" className={`${AdminUI.btn.outline} mt-4 w-full`}>Done</button>
          </div>
        </div>
      </div>
    </main>
  );
}
