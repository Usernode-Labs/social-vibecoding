// The hamburger drawer's behaviour — open/close, the kit-panel adoption, the
// presentation state App._entryTransition reads, and app-scoped visibility
// (#1079 chunk B). Moved verbatim out of public/js/app.js, where it
// lived as App.HeaderMenu / App.DrawerStatus, when #header-menu-panel became a
// React island: the markup is React's now, so the code that drives it belongs
// beside the component rather than in the shell's router module.
//
// A MOVE, not a rewrite. Every threshold, every guard and every comment below
// came across unchanged, with three deliberate differences:
//
//   1. `App.HeaderMenu.x` self-references became `HeaderMenu.x`, and the two
//      objects publish as window.HeaderMenu / window.DrawerStatus. app.js keeps
//      `App.HeaderMenu` / `App.DrawerStatus` as thin forwarders onto those
//      globals, so its own call sites — plus app-view.js, native-chrome.js,
//      node-pill.js and wallet-sheet.js — are untouched.
//   2. The theme segmented control is genuinely React-owned now (see
//      ThemeControl in ./header-menu.tsx), so _renderThemeButtons and its click
//      wiring are gone from here. open() announces itself with a
//      `usernode:header-menu-open` event instead, which is what that component
//      re-reads Theme.get() on — the same "reflect the mode on every open"
//      contract, expressed as a subscription rather than a DOM write.
//   3. init() is called from the island's layout effect rather than from
//      App.bindEvents(), so the listeners land after hydration has adopted the
//      nodes and still before DOMContentLoaded.
//
// The publication is guarded on `window` because the SSG prerender pass
// evaluates this module's whole graph in Node.

import { adoptKitSurface } from '../../lib/kit-surface';

// Drawer status/version rows (header slim-down): the kudos + AI-credit meters
// render into #drawer-status-pane, and the platform version + mobile-app release +
// fork lineage label render into #drawer-footer — none of them in the header
// any more. The dApp SHA does not belong in this platform-information block.
const DrawerStatus = {
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
    if (!open) DrawerStatus.setForkVisible(false);
    // Self-hosted apps (the platform's own row) have no App mode at
    // all — appData.url maps to a slug-derived subdomain that doesn't
    // resolve, so switchTab coerces them to the Dev forum. A switch
    // with one reachable option is noise, so hide the whole control
    // rather than shipping a dead segment. setAppOpen(true) runs after
    // the /api/apps/:slug fetch resolves, so self_hosted is known by
    // the time this reads it.
    const modeSwitch = document.getElementById('app-mode-switch');
    if (modeSwitch) {
      const show = !!open && !window.AppView?.appData?.self_hosted;
      modeSwitch.classList.toggle('hidden', !show);
      // The control materially changes the header's right-group width,
      // which is one of the two inputs to the title's centered-vs-flow
      // decision. The group's ResizeObserver would catch this on its
      // own a frame later; the explicit hook exists so the title
      // doesn't visibly jump.
      window.HeaderLayout?.refresh?.();
    }
    DrawerStatus.refreshDeployDot();
  },

  // Driven by AppView.renderForkBadge(): shown only when it actually
  // wrote a badge (i.e. the open app is a fork). `flex`, not the row
  // default, because the row ships `hidden` and Tailwind's `hidden`
  // would otherwise fight an inline display.
  setForkVisible(visible) {
    const row = document.getElementById('drawer-row-app-fork');
    if (!row) return;
    row.classList.toggle('hidden', !visible);
    row.classList.toggle('flex', !!visible);
  },

  // Mirror "a deploy is in flight" onto the hamburger. Read straight
  // off the rendered platform version row rather than threading state: its markup is
  // already the single source of truth for the platform deploying state.
  // Scoped to #drawer-footer so a deploying dApp pill on a home tile can never
  // light this dot.
  refreshDeployDot() {
    const dot = document.getElementById('header-menu-deploy-dot');
    if (!dot) return;
    const deploying = !!document.querySelector(
      '#drawer-footer .drawer-ver--deploying');
    dot.classList.toggle('hidden', !deploying);
  },
};

// Slide-out navigation drawer — available at every viewport width
// (#122). Top to bottom: the kudos/AI-credit status pane, the theme
// selector directly below it, the native Node/Wallet rows, the four
// main nav rows (Profile, Leaderboard, Settings, Admin & moderation),
// and a bottom-anchored footer carrying the web/mobile-app releases plus
// GitHub + Share. (Members & visibility moved to the Dev "+" menu — #645.)
const HeaderMenu = {
  _panel: null,

  // ── Presentation state (#977) ───────────────────────────────────
  // The drawer's exit is the ONE motion a sidebar-originated
  // navigation is allowed to show, so App._entryTransition has to be
  // able to ask "is this drawer on screen (or still animating out)?"
  // and "did a link inside it just start this navigation?".
  //
  // _closingAt exists only for the LEGACY (desktop / kit-missing)
  // path: close() strips [data-open] synchronously while the 200ms
  // CSS slide still has to run, so the attribute alone reports the
  // drawer as gone while it is visibly still there. The kit path
  // needs no timestamp — _panel is cleared in the onDismiss teardown,
  // i.e. only once the exit spring has come to rest.
  _closingAt: 0,
  _navArmedAt: 0,
  // Callers waiting for the drawer to be fully gone (close()'s
  // completion promise — see close()).
  _dismissWaiters: [],
  LEGACY_CLOSE_MS: 200,
  // The legacy slide plus a frame of margin.
  CLOSING_WINDOW_MS: 260,
  // Generous, because it is CONSUMED on first read: only a link that
  // produced no navigation at all can leave it to expire.
  NAV_ARM_TTL_MS: 600,
  // Backstop for the completion promise, so a teardown that never
  // fires (a kit that vanished, a superseded handle) can't strand a
  // caller that chained its own presentation behind it.
  DISMISS_SAFETY_MS: 500,

  _now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  },

  // True while the drawer surface is on screen OR still animating out.
  isPresenting() {
    if (HeaderMenu._panel) return true;
    const panel = document.getElementById('header-menu-panel');
    if (panel && panel.hasAttribute('data-open')) return true;
    return HeaderMenu._closingAt > 0
      && (HeaderMenu._now() - HeaderMenu._closingAt)
        < HeaderMenu.CLOSING_WINDOW_MS;
  },

  // One-shot: a link inside the drawer armed this immediately before
  // close(), and the navigation it triggered is the next thing to ask.
  // Consumed on read so it can never apply to a second navigation.
  consumeNavPending() {
    const at = HeaderMenu._navArmedAt;
    if (!at) return false;
    HeaderMenu._navArmedAt = 0;
    return (HeaderMenu._now() - at) < HeaderMenu.NAV_ARM_TTL_MS;
  },

  _resolveDismissWaiters() {
    const waiters = HeaderMenu._dismissWaiters;
    if (!waiters.length) return;
    HeaderMenu._dismissWaiters = [];
    for (const resolve of waiters) {
      try { resolve(); } catch (err) { /* ignore */ }
    }
  },

  // Reflect the current theme mode every time the drawer opens (covers
  // cross-tab changes and explicit values that happen to match the OS).
  // The segmented control is a React component now, so this is an
  // announcement rather than a DOM write — ThemeControl re-reads
  // Theme.get() on it, which is the same contract _renderThemeButtons()
  // had when it was called from here.
  _announceOpen() {
    try {
      window.dispatchEvent(new CustomEvent('usernode:header-menu-open'));
    } catch (err) { /* ignore */ }
  },

  open() {
    const panel = document.getElementById('header-menu-panel');
    const overlay = document.getElementById('header-menu-overlay');
    const btn = document.getElementById('header-menu-btn');
    if (!panel) return;
    // A fresh presentation ends any "still sliding out" window the
    // legacy path was counting down (#977).
    HeaderMenu._closingAt = 0;
    // #555: the AI-credit row only ever renders in this drawer, so
    // opening it is exactly when its number matters. The refresh is
    // throttled inside AiCredit, so this is cheap on every open —
    // and it must run BEFORE the touch branch below, which returns.
    if (window.AiCredit?.refreshAll) AiCredit.refreshAll();
    // Touch platforms: present the drawer as a kit side panel — a
    // right-edge slide-in with 1:1 drag-to-dismiss, matching what
    // desktop's CSS slide-over already does positionally (it used to
    // come up from the bottom as a sheet capped at 70vh, which cut the
    // bottom-anchored footer off). The panel element itself is adopted
    // via contentEl — its row listeners ride along — and is restored to
    // <body> (off-screen, as usual) when the panel dismisses. Desktop
    // keeps the right-side slide-over below.
    // Assigned right below; captured here so onDismiss can tell its own
    // teardown apart from a newer one's (see stillOwns).
    let adoption = null;
    // The adopted class, the restore to <body> and the rollback when the kit
    // refuses are adoptKitSurface's now — see lib/kit-surface.ts's header for
    // the three other copies this used to be one of. `gate: 'touch'` is the
    // `PlatformUI.isTouch()` check that used to wrap this whole branch, so a
    // desktop browser falls straight through to the slide-over below.
    adoption = adoptKitSurface({
      kind: 'panel',
      contentEl: panel,
      home: 'body',
      gate: 'touch',
      present: { side: 'right' },
      onDismissStart: () => {
        // The drawer this handle owned has left the screen, so anyone
        // who chained a presentation behind close() may go — resolved
        // BEFORE the ownership guard below, or a superseded teardown
        // would strand them until the safety cap (#977).
        HeaderMenu._resolveDismissWaiters();
      },
      // Teardown is deferred behind the exit spring, so a tap on the
      // hamburger during that window can re-adopt the drawer into a
      // NEW kit panel before this fires. Restoring it to <body> then
      // would yank the node straight back out of the panel the user
      // just opened, leaving an empty drawer. Only the CURRENT
      // handle's teardown owns the node.
      stillOwns: () => !adoption || HeaderMenu._panel === adoption,
      onDismiss: () => {
        HeaderMenu._panel = null;
        // The hamburger's state is not the kit's business, so it is
        // reset here on EVERY exit path (backdrop, Escape, ✕, row
        // navigation) — they all route through the kit dismiss.
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-label', 'Open menu');
      },
    });
    if (adoption) {
      HeaderMenu._panel = adoption;
      // Announced on the touch path only, exactly as before — the desktop
      // slide-over below does its own. It moved after the presentation
      // because the touch gate lives inside adoptKitSurface now; the one
      // listener (ThemeControl) just re-reads Theme.get(), so it does not
      // care which side of the present it fires on.
      HeaderMenu._announceOpen();
      // The touch path used to return before the aria writes below,
      // leaving the button reading "Open menu" / collapsed while the
      // drawer was open.
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Close menu');
      return;
    }
    overlay.classList.remove('hidden');
    // Force a reflow so the transition fires (element was display:none).
    overlay.getBoundingClientRect();
    overlay.setAttribute('data-open', '');
    panel.setAttribute('data-open', '');
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', 'Close menu');
    HeaderMenu._announceOpen();
    const closeBtn = document.getElementById('header-menu-close');
    if (closeBtn) closeBtn.focus();
  },

  // Returns a promise that resolves once the drawer is actually GONE —
  // the kit teardown on the touch path, the CSS slide's end on the
  // legacy one, immediately when nothing was open (#977). Callers that
  // present a surface of their own (the Node / Wallet sheets, the Share
  // dialog) chain it so only one surface moves at a time; every other
  // caller can keep ignoring the return value.
  close() {
    if (HeaderMenu._panel) {
      const done = HeaderMenu._afterDismiss();
      HeaderMenu._closingAt = HeaderMenu._now();
      HeaderMenu._panel.dismiss();
      return done;
    }
    const panel = document.getElementById('header-menu-panel');
    const overlay = document.getElementById('header-menu-overlay');
    const btn = document.getElementById('header-menu-btn');
    if (!panel) return Promise.resolve();
    const wasOpen = panel.hasAttribute('data-open');
    if (wasOpen) HeaderMenu._closingAt = HeaderMenu._now();
    panel.removeAttribute('data-open');
    overlay.removeAttribute('data-open');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Open menu');
    if (!wasOpen) return Promise.resolve();
    const done = HeaderMenu._afterDismiss();
    // Hide overlay after the slide-out transition finishes.
    setTimeout(() => {
      overlay.classList.add('hidden');
      HeaderMenu._resolveDismissWaiters();
    }, HeaderMenu.LEGACY_CLOSE_MS);
    return done;
  },

  // The completion promise itself: settled by whichever exit path runs,
  // with a hard safety cap so a teardown that never fires can't hang a
  // chained presentation forever.
  _afterDismiss() {
    return new Promise((resolve) => {
      HeaderMenu._dismissWaiters.push(resolve);
      setTimeout(resolve, HeaderMenu.DISMISS_SAFETY_MS);
    });
  },

  _bound: false,

  init() {
    // Called from the island's layout effect, which React may run again
    // in StrictMode / on a remount; the listeners below are registered
    // on nodes that outlive the component, so binding twice would double
    // every close.
    if (HeaderMenu._bound) return;
    const btn = document.getElementById('header-menu-btn');
    if (!btn) return;
    HeaderMenu._bound = true;
    btn.addEventListener('click', () => HeaderMenu.open());
    document.getElementById('header-menu-close')
      .addEventListener('click', () => HeaderMenu.close());
    document.getElementById('header-menu-overlay')
      .addEventListener('click', () => HeaderMenu.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Adopted into a kit panel: the kit's own modal-stack handler
        // owns Escape (it dismisses the topmost surface, which may be a
        // modal opened above the drawer). Don't double-handle it.
        if (HeaderMenu._panel) return;
        const panel = document.getElementById('header-menu-panel');
        if (panel && panel.hasAttribute('data-open')) HeaderMenu.close();
      }
    });
    // Every LINK inside the drawer, in one rule (#977). Two jobs:
    //
    //   1. Arm the single-motion rule. A same-document hash link is
    //      about to navigate the shell, and the drawer's own exit is
    //      the only motion that navigation may show — so stamp
    //      _navArmedAt and let App._entryTransition downgrade the
    //      screen animation to 'none'. External links (the GitHub row,
    //      whose href is an absolute repo URL) animate nothing in this
    //      document, so they only close.
    //   2. Close the drawer for links that never had a handler of
    //      their own: the Kudos meter in the status pane
    //      (#leaderboard/prs, rendered by kudos.js) and the footer's
    //      "Forked from" line (#app/<slug>, rendered by app-view.js)
    //      used to navigate with the drawer left wide open.
    //
    // Registered on the panel element itself, so it rides along when
    // the panel is adopted into the kit drawer — same reason the
    // per-row listeners below survive adoption. Those per-row
    // handlers are now redundant with this one, and harmlessly so:
    // both close paths are idempotent (the kit's dismiss() returns
    // early once closed).
    const drawerPanel = document.getElementById('header-menu-panel');
    if (drawerPanel) {
      drawerPanel.addEventListener('click', (e) => {
        const link = e.target.closest ? e.target.closest('a[href]') : null;
        if (!link || !drawerPanel.contains(link)) return;
        // #1036: a cmd/ctrl/shift/middle click opens the destination
        // in ANOTHER tab — nothing navigates in this document, so
        // there is no screen animation to suppress (arming the flag
        // would leak onto the NEXT real navigation until its TTL) and
        // no reason to tear the drawer down under the user.
        if (window.NavLink && NavLink.isNativeClick(e)) return;
        // getAttribute, not .href: the property resolves to an absolute
        // URL, which would make every in-page hash link look external.
        const href = link.getAttribute('href') || '';
        if (href.startsWith('#')) {
          HeaderMenu._navArmedAt = HeaderMenu._now();
        }
        HeaderMenu.close();
      });
    }
    // Drawer row actions — each closes the menu after triggering its action.
    document.getElementById('drawer-row-github')
      .addEventListener('click', () => HeaderMenu.close());
    // Leaderboard (the merged Kudos + Topochain + Challenges screen) —
    // same real-anchor idiom as Profile below: navigation rides the
    // anchor's hash, the click handler here just closes the drawer. The
    // separate Challenges / Topochain-seasons rows that used to sit
    // beside it are gone; they're tabs of this one screen now.
    document.getElementById('drawer-row-leaderboard')
      ?.addEventListener('click', () => HeaderMenu.close());
    // Share — a dialog of its own, so it waits for the drawer to be
    // gone rather than fading in across the drawer's exit (#977).
    document.getElementById('drawer-row-share')
      .addEventListener('click', () => {
        Promise.resolve(HeaderMenu.close()).then(() => {
          if (window.AppView) AppView.openShareModal();
        });
      });
    // Settings — the #settings screen (settings-modal-to-screen
    // conversion). Same real-anchor idiom as Challenges / Profile above:
    // navigation rides the anchor's hash, this handler just closes the
    // drawer.
    document.getElementById('drawer-row-settings')
      ?.addEventListener('click', () => HeaderMenu.close());
    // Admin & moderation — visibility is App.renderAdminButton()'s job
    // (isAdmin gate); navigation rides the anchor's #admin hash, which
    // navigateToAdminConsole re-gates. Same idiom as Settings above.
    document.getElementById('drawer-row-admin')
      ?.addEventListener('click', () => HeaderMenu.close());
    // The theme segmented control used to be wired here, one listener
    // per segment plus a Theme.onChange re-render. It is a React
    // component now (ThemeControl in ./header-menu.tsx) — a live control
    // that sets the mode and re-highlights WITHOUT closing the drawer,
    // exactly as before, with the subscription expressed in the
    // component instead of in this init.
  },
};

if (typeof window !== 'undefined') {
  window.HeaderMenu = HeaderMenu;
  window.DrawerStatus = DrawerStatus;
}

export { HeaderMenu, DrawerStatus };
