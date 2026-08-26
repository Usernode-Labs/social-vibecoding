/**
 * What the Improve button is ABOUT, and what its version dot says.
 *
 * Two publishers, one lifecycle. `setAppOpen` says which app (or the platform
 * itself) the header's Improve control is scoped to; `refreshDeployDot` says
 * whether a platform deploy is rolling out or the tab has fallen behind. Both
 * end in a `window.Improve.*` publish — nothing here touches a node the
 * Improve button renders, because that button is React-owned end to end.
 *
 * ── Why it is not called DrawerStatus any more ─────────────────────────
 *
 * It was, for as long as the hamburger drawer existed: the status pane, the
 * version footer and the App/Dev switch all hung off this one call. Every one
 * of those has since moved — the rows to Settings' About block, the switch to
 * the Improve button — so by the time the drawer is taken down there is
 * nothing left here that refers to it. A `DrawerStatus` that publishes only
 * Improve state is the kind of name that outlives everyone who remembers what
 * it referred to, which is the same reason `#header-menu-deploy-dot` is not
 * allowed to keep its name when it moves.
 *
 * app.js keeps `App.ImproveStatus` as a thin forwarder onto the global, so its
 * own call sites plus app-view.js address it the classic way.
 *
 * The publication is guarded on `window` because the SSG prerender pass
 * evaluates this module's whole graph in Node.
 */

const ImproveStatus = {
  // The header's App/Dev switch rides the SAME lifecycle, which is why
  // it's owned here rather than in a seventh place: this one call
  // already covers openApp, navigateHome, AppView.close() and all six
  // other-screen navigations (leaderboard, challenges, profile, admin,
  // settings, topochain). It used to be free — the old #app-tabs bar
  // was a child of #app-view and disappeared whenever that did — but a
  // header-resident control has to be hidden explicitly.
  setAppOpen(open) {
    // Fork lineage is app-scoped too — closing an app can never leave
    // the previous app's "Forked from" line behind.
    // THE UI OVERHAUL: this used to show and hide #app-mode-switch, the
    // App/Dev segmented control. There is no App/Dev switch any more — an
    // app is just an app, and "Dev" is somewhere the Improve panel links to.
    // What this call publishes now is that panel's TARGET, which is what
    // decides whether #improve-btn exists at all, so the header control still
    // rides exactly this one lifecycle: it already covers openApp,
    // navigateHome, AppView.close() and all six other-screen navigations.
    //
    // The self-hosted platform row is NOT excluded here, unlike the switch it
    // replaced. That exclusion existed because the row's App mode had no
    // reachable iframe target, which made a two-option control a control with
    // one dead option. Improve has no such problem — everything it offers
    // works on the platform's own row, opened like any other app.
    const appData = window.AppView?.appData;
    if (open && appData?.slug) {
      window.Improve?.setTarget({
        kind: appData.self_hosted ? 'platform' : 'app',
        slug: appData.slug,
        name: appData.name || appData.slug,
        selfHosted: !!appData.self_hosted,
        repoUrl: appData.repo_url || null,
        iconUrl: appData.icon_url || null,
        iconEmoji: appData.icon_emoji || null,
        version: appData.main_sha ? appData.main_sha.slice(0, 7) : null,
        deploying: appData.status === 'deploying',
        readOnly: !!window.AppView?.readOnly,
        canShare: appData.status === 'running' && !!appData.url,
      });
    } else if (!open) {
      // Cleared here rather than per-screen: every navigation away from an
      // app already funnels through this call, home included — which is what
      // keeps the Improve button from lingering in the header after backing
      // out of an app.
      //
      // Home immediately republishes the PLATFORM's own row on top of this
      // (#1367, Home.publishImproveTarget) — so on home the clear is a swap,
      // not an absence. Every other screen leaves it cleared.
      window.Improve?.setTarget(null);
    }
    ImproveStatus.refreshDeployDot();
  },

  // Mirror the platform version row's state onto the Improve button. Read
  // straight off the rendered row rather than threading state: its markup is
  // already the single source of truth for both conditions.
  //
  // Scoped to #settings-about — where the Streamlined Concept board's removal
  // of the drawer's reference footer moved that row — so a deploying dApp pill
  // on a home tile can never light this dot. The row is in the shell at all
  // times (the settings screen is hidden, never unmounted), so reading it does
  // not depend on Settings being open.
  //
  // THE DOT MOVED WITH THE ROWS. It was `#header-menu-deploy-dot` on the
  // hamburger, from when the version rows lived in that drawer's footer; they
  // are in the Improve panel's footer now, so the cue that says "go and look
  // at them" belongs on the control that opens it. The name went too — a dot
  // called `header-menu-*` on the Improve button would be a lie that outlives
  // everyone who remembers the move.
  //
  // And it PUBLISHES rather than toggling a class: #improve-btn is React-owned
  // end to end, so its indicators are store state. That also lets the second
  // state exist at all — `button.drawer-ver--stale`, the violet "the platform
  // rolled past the SHA this tab loaded against" reload affordance, which the
  // old dot could not show because it had exactly one colour.
  refreshDeployDot() {
    const deploying = !!document.querySelector(
      '#settings-about .drawer-ver--deploying');
    const stale = !deploying && !!document.querySelector(
      '#settings-about button.drawer-ver--stale');
    const state = deploying ? 'deploying' : (stale ? 'stale' : 'idle');
    if (typeof window !== 'undefined') window.Improve?.setVersionState?.(state);
  },
};

if (typeof window !== 'undefined') {
  window.ImproveStatus = ImproveStatus;
}

export { ImproveStatus };
