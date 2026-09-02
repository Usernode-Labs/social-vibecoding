/**
 * The Settings module's EAGER half — what the shell needs from Settings on a
 * load that never opens the screen — and the door to the rest.
 *
 * ./settings.js is a 5,000-line controller; with the sixteen panes
 * (./sections) it is ~200KB of the shell bundle, downloaded, parsed and
 * compiled on every load of every screen so that the Settings screen can
 * open. Almost none of it runs on a load that stays on the board. What DOES
 * run at boot is small and specific:
 *
 *   - refresh(): /api/auth/me (joining the boot read) into Settings.state.
 *     dev-chat, app-view and the budget pill read `hasApiKey` / `keyLast4`
 *     before the screen is ever opened, and the byok dot on the profile
 *     screen is published from here. This cannot wait for a chunk.
 *   - the calls app.js makes on EVERY navigation — isOpen(), close(),
 *     syncChrome() — which have nothing to do while nothing is open.
 *
 * So this module publishes window.Settings first, with exactly that surface,
 * and everything else (open/route/showTermsSheet/logout) loads the chunk and
 * forwards. When ./settings-chunk.ts evaluates, settings.js takes over
 * window.Settings — SHARING the state object read here, so nothing observes
 * a reset — and from then on every call is the real, synchronous one.
 *
 * Two things keep Settings.open()'s synchronous contract (see
 * lib/mount-on-reveal.ts) intact across the split:
 *
 *   - the panes are committed through settingsChunkStore, with flushSync,
 *     the moment the chunk arrives and BEFORE a forwarded open() runs — so
 *     when open() calls _ensureMounted() and then reads a pane by id, the
 *     pane is there, and init() (a layout effect in ./sections) has already
 *     bound it.
 *   - once the chunk is in, window.Settings IS the module: no façade in the
 *     path, no promise, the same code as before the split.
 *
 * The chunk is prefetched at idle for a signed-in viewer (on sv:authed), so
 * a first open normally finds it loaded; the deferred path is for an open
 * that beats the idle callback, and for the one screen a check opens cold.
 *
 * Kept as a classic-shaped object literal on purpose: tests/settings-lazy.test.js
 * parses refresh() here and in settings.js and holds the two to the same
 * field list, which is what keeps this copy from drifting.
 */

import { flushSync } from 'react-dom';

import { createStore } from '../../lib/plain-store.js';

/**
 * `{ Sections, failed }` — the panes component once the chunk has arrived,
 * or the failure the chassis should say something about.
 */
export const settingsChunkStore = createStore({ Sections: null, failed: false });
settingsChunkStore.setFlush(flushSync);

// The state object. Shared with settings.js once it takes over (it adopts
// this very object rather than copying it), so a read that resolves after
// the takeover still lands where every reader looks. Same defaults as the
// literal in settings.js; the parity test pins that.
const state = {
  hasApiKey: false,
  demoKey: false,
  keyLast4: null,
  usernodePubkey: null,
  walletLinkEnabled: false,
  aiProgressEstimate: false,
  sessionBridgeEnabled: false,
  locale: null,
  devFlowPreference: null,
  externalFlowsAvailable: false,
};

let chunk = null;   // the import in flight (or settled), once started
let ready = false;  // window.Settings is the module

/**
 * Load the module (once) and resolve to window.Settings — the real object
 * after the chunk evaluates, or null when the load failed. Safe to call any
 * number of times; every caller joins the one load.
 */
export function ensureSettings() {
  if (ready) return Promise.resolve(window.Settings);
  if (!chunk) {
    chunk = import('./settings-chunk.ts').then((m) => {
      // Panes first, and synchronously: everything after this line — the
      // forwarded open() below, a check's selector — can see their ids.
      settingsChunkStore.set({ Sections: m.SettingsSections, failed: false });
      ready = true;
      return window.Settings;
    }).catch((err) => {
      // Leave the next open free to try again: the network may be back.
      chunk = null;
      settingsChunkStore.set({ Sections: null, failed: true });
      console.warn('[settings] module failed to load', err);
      return null;
    });
  }
  return chunk;
}

/**
 * Warm the chunk for a viewer who is signed in — the only kind who can open
 * the screen — once the page is idle. Not on a ?shot= or ?demo= route: those
 * render one state deterministically for a screenshot or a declared check,
 * and a chunk landing mid-assertion is the nondeterminism they exist to be
 * free of (the same guard AdminConsole.prefetchSections uses). Nothing is
 * lost: the screen still loads on demand, which is what the #settings checks
 * exercise.
 */
export function prefetchSettings() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('shot') || q.get('demo')) return;
  } catch { /* no URL to read is not a reason to skip a real prefetch */ }
  const start = () => { ensureSettings(); };
  // AFTER the boot, then idle. requestIdleCallback alone is not enough: a
  // boot at 4x CPU on a 150ms link is a chain of network waits, and every
  // one of them is "idle" to the browser — measured, the callback fired
  // ~700ms into a 1,200ms board boot and the chunk's parse landed on top of
  // the first paint, which cost about as much as the split saved. So wait
  // for the document's `load` (every script and stylesheet in), then a
  // further PREFETCH_DELAY_MS for the boot lane's API reads and first
  // render to finish, and only then ask for idle time. This chunk is worth
  // having eventually and worth nothing urgently — a first open that has to
  // wait for it costs about one navigation.
  const whenIdle = () => afterBoot(() => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 20000 });
    else setTimeout(start, 4000);
  });
  // `sv:authed` fires at most once per document, after the boot read
  // resolves a signed-in user; a document that already has one does not
  // fire it again (see terms-first-run.js, which listens the same way).
  if (window.App && window.App.user) whenIdle();
  else document.addEventListener('sv:authed', whenIdle, { once: true });
}

// How long after the document's `load` the boot is assumed to be over. The
// slowest boot measured (4x CPU, 150ms link, cold worker) put its first card
// on screen ~2.4s after navigation; this is well past that, and nothing is
// waiting on it.
const PREFETCH_DELAY_MS = 6000;

function afterBoot(fn) {
  const later = () => setTimeout(fn, PREFETCH_DELAY_MS);
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
}

// ── The boot read (settings.js's refresh(), minus the pane repaints) ────

function demoQuery() {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch { return ''; }
}

// The /api/auth/me payload, JOINING the boot read rather than repeating it
// (App.bootSession) — every field below is on the same `user` object App.init
// fetches. `?demo=1` still reads for itself: staging answers that request
// differently (the fixture key behind `demoKey`).
async function readMe(meDemoQ) {
  if (!meDemoQ && typeof window.App?.bootSession === 'function') {
    const boot = await window.App.bootSession();
    if (boot?.user) return { user: boot.user };
    if (boot?.signedOut) return null;
  }
  const r = await fetch(`/api/auth/me${meDemoQ}`, { credentials: 'same-origin' });
  if (!r.ok) return null;
  return await r.json();
}

function renderIndicator() {
  // Published rather than written by id: the dot rides the Profile screen's
  // account group, which React renders only once profile data lands.
  window.App?.Visibility?.publish?.('switcher-byok-dot', !!state.hasApiKey);
  // Let dev-chat swap its budget indicator for the BYOK badge without having
  // to observe us directly.
  if (window.DevChat && typeof window.DevChat.renderBudget === 'function') {
    try { window.DevChat.renderBudget(); } catch { /* the pill repaints on its own next tick */ }
  }
}

// Forward a call to the module, once it is in. `open` and `route` are what
// app.js calls to put the screen up; a viewer who left before the chunk
// arrived must not have the screen re-entered under whatever they moved to.
function whenLoaded(fn) {
  return ensureSettings().then((real) => {
    if (!real || real === Facade) return undefined;
    return fn(real);
  });
}

const Facade = {
  __facade: true,
  state,
  _cliAuthPromise: null,

  // Nothing is open before the module exists, so these answer truthfully
  // without loading anything: app.js calls all three on every navigation.
  isOpen() { return false; },
  close() {},
  syncChrome() {},
  _syncFooter() {},
  // init() binds the panes' controls; it is called from ./sections once the
  // panes exist, by which time this object has been replaced. A no-op here
  // only for a caller that races that.
  init() {},

  _cliTokensDemo() { return demoQuery() === '?demo=1'; },

  async refresh() {
    try {
      const j = await readMe(demoQuery());
      if (!j) return;
      const u = j.user || {};
      state.hasApiKey = !!u.hasApiKey;
      state.demoKey = !!u.demoKey;
      state.keyLast4 = u.keyLast4 || null;
      state.usernodePubkey = u.usernodePubkey || null;
      state.walletLinkEnabled = !!u.walletLinkEnabled;
      state.aiProgressEstimate = !!u.aiProgressEstimate;
      state.sessionBridgeEnabled = !!u.sessionBridgeEnabled;
      state.locale = u.locale || null;
      state.devFlowPreference = u.devFlowPreference || null;
      state.externalFlowsAvailable = !!u.externalFlowsAvailable;
      // The CLI-credentials gate's memo, primed from the same payload. Written
      // to whichever object is window.Settings NOW — this one, or the module
      // if it took over while the read was in flight — and kept here for the
      // takeover to adopt in the other order.
      const cliAuth = Promise.resolve(u.cliAuthEnabled !== false);
      Facade._cliAuthPromise = cliAuth;
      if (window.Settings && window.Settings !== Facade) window.Settings._cliAuthPromise = cliAuth;
      renderIndicator();
    } catch { /* offline with no cached answer: the defaults stand, as before */ }
  },

  open(section, opts) {
    whenLoaded((real) => {
      if (window.App && !window.App._inSettings) return;
      real.open(section, opts);
      // navigateToSettings writes the header from its transition callback
      // through syncChrome() — which was this object's no-op when it ran.
      // Write it now that there is a section to name.
      if (opts && opts.chrome === false) real.syncChrome();
    });
  },

  route(section) {
    whenLoaded((real) => {
      if (window.App && !window.App._inSettings) return;
      real.route(section);
    });
  },

  showTermsSheet(onAccepted, opts) {
    return whenLoaded((real) => real.showTermsSheet(onAccepted, opts));
  },

  async logout() {
    return whenLoaded((real) => real.logout());
  },
};

// Published at module scope, like the module it stands in for: app.js,
// app-view.js and dev-chat.js call window.Settings unguarded, and the bundle's
// entry runs before any of their init()s. The typeof guard is for the SSG
// prerender pass, which evaluates this module graph in Node.
if (typeof window !== 'undefined' && !window.Settings) window.Settings = Facade;

export { Facade as SettingsFacade };
