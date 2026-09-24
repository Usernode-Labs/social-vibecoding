/**
 * `#home-tour` — the eight-step welcome tour, replacing the `#home-welcome`
 * banner (#1561) that this change retires.
 *
 * The banner said the two things the launcher never says, in three lines, and
 * then went away for good. What it could not do is point: "send feedback from
 * the Improve button" names a control, and a new account has no way to tell
 * which of the things in front of it that sentence is about. The tour dims
 * the page, cuts a hole around the thing it is talking about, and puts the
 * sentence next to it.
 *
 * ── Real controls, all eight steps ─────────────────────────────────────
 *
 * Nothing here is a drawing of the product. The Improve arc works because the
 * Improve row is reachable on Home: the app's own menu, behind the Homeroom
 * mark, targeting the platform's own self-hosted row for as long as Home is up
 * (`Home.publishImproveTarget`, #1367). So steps 3 to 6 are one interaction
 * rather than four descriptions:
 *
 *   * step 3 spotlights the MARK that opens that menu, asking the viewer to
 *     press it. The click is NOT intercepted: the tour subscribes to
 *     `appContextStore` and advances when `open` goes true, so what opens the
 *     panel is the product's own handler and the tour is only watching. Its
 *     Next opens the menu through `AppContext.open()` — the same path — and
 *     the same watcher advances it, so Next never lands on step 4 with the
 *     menu shut;
 *   * steps 4 and 5 spotlight `#improve-row-feedback` and
 *     `#improve-row-new-session` INSIDE the panel the viewer just opened, and
 *     Next moves between them. Both are DESCRIBED, not driven: the cut-out
 *     blocks the press the way the dim around it does, because each of them
 *     leaves the tour (a dialog, a new session) and a spotlight is not an
 *     instruction to press. ./tour-steps.ts carries the whole argument;
 *   * steps 6 and 7 leave the panel for the mark and the Workshop tab;
 *   * step 7 shuts the panel through `Improve.close()`, the controller's own
 *     close path and never a write into its DOM, then points at Challenges.
 *
 * ── The island rules, and how each is kept ────────────────────────────
 *
 * This is a fixed overlay that ships in the shell and starts `hidden`, the
 * same arrangement as `#mobile-install-banner` and the banner it replaces:
 *
 *   * THE FIRST RENDER IS THE PRERENDERED MARKUP. Nothing viewer-dependent
 *     is read during render. `open` is false, `index` is 0 and `confirming`
 *     is false on both sides of hydration, so the built document and the
 *     first client pass emit the same tree: step 1's copy, hidden.
 *   * VISIBILITY RIDES REFS. The root, the cut-out, Next and the
 *     confirmation all carry CONSTANT class strings with `hidden` exactly
 *     where the prerender has it, and the toggles go through `useHiddenClass`
 *     / `useClassToggle` or, for the nodes the geometry pass owns, a
 *     `classList` write inside that pass. See ../../../lib/legacy-dom.ts.
 *   * GEOMETRY IS WRITTEN, NOT RENDERED. The shades, the cut-out and the
 *     card's position are `style` writes through refs, for the reason
 *     features/settings/sections/theme.tsx writes its caret index that way:
 *     the shipped markup carries no `style` attribute, and a measured pixel
 *     is not something to reconcile. It also means a resize, a scroll or the
 *     panel's slide re-measures without a React render.
 *
 * Nothing in `public/js/**` writes into this subtree, so the region is
 * React-owned end to end and may hold state (AGENTS.md).
 *
 * ── Following the target ───────────────────────────────────────────────
 *
 * The hole is measured once per animation frame for as long as the overlay
 * is up, and written only when the numbers move. It used to be measured on a
 * 50ms ticker for 600ms after each step change, which covered the kit
 * sheet's entrance spring and nothing after it -- and on a phone the panel
 * keeps moving after it: `Improve.open()` refreshes the sessions list over
 * the network once the sheet is up, a session state tick reloads it while
 * the panel is open, the Chats group appears when its bootstrap answers, and
 * the deploy note comes and goes. Every one of those changes the height of a
 * bottom-anchored, content-sized sheet, and the kit answers by holding the
 * top edge and springing the sheet to its new rest (native.js's watchSize),
 * so every row moves by exactly that much. A refresh that lands after the
 * window left the ring on the row's OLD position, over the panel's title
 * (the report behind this). None of those motions announces itself -- a
 * spring on a transform fires no event and no ResizeObserver -- so the only
 * signal that is always right is the next frame. One `getBoundingClientRect`
 * a frame, on one element, while a tour is on screen, is a cost nobody can
 * measure; a ring on the wrong row is not.
 *
 * ── Where the card goes while the panel is open ────────────────────────
 *
 * Beside the panel, never on it. On desktop, where the panel is a right-side
 * sheet, the card's right edge sits one gap from the panel's left edge and
 * lines up vertically with the middle of the highlighted row, so the eye
 * travels straight across from the sentence to the control. On a narrow
 * viewport the panel takes the whole width and there is no "beside" left, so
 * the rule relaxes to the weaker one: clear of the ROW, above or below it,
 * rather than clear of the panel. ./spotlight.ts's `placeCardForPanel` is
 * both halves, and the fallback is a call to the ordinary `placeCard`.
 *
 * ── Why four shades and not one box-shadow ─────────────────────────────
 *
 * A `box-shadow` spread paints a dim but receives no pointer events, so it
 * cannot block a click, and step 3 needs exactly that split: the cut-out must
 * pass clicks through to the real Improve button while the dimmed area keeps
 * swallowing them. Four positioned panels around the hole are both the dim
 * and the blocker, and the hole is then genuinely a hole.
 *
 * ── z-index ────────────────────────────────────────────────────────────
 *
 * `z-[9993]`, which is deliberate rather than a round number. The Improve
 * panel is `z-50` on desktop, but on touch the kit ADOPTS it into `.un-sheet`
 * (native.css: backdrop 9990, sheet 9991, popover 9992), and the cut-out has
 * to land on the panel's rows on a phone too. 9993 clears all three and stays
 * under the kit's own feedback pill (9995) and debug affordance (99999).
 *
 * ── When it opens, and when it gets out of the way ─────────────────────
 *
 * Once per account, on the first sign-in that reaches Home, and never in a
 * way that can surprise an automated capture:
 *
 *   * the viewer has to be known (`App.user`, resolved in an effect, because
 *     it is a classic-script global that is only populated after the session
 *     has been read);
 *   * ../../settings/terms-first-run.js has to be done with. Its `settled()`
 *     is the same promise ../../auth/username-first-run.js exposes and terms
 *     itself awaits, so awaiting terms covers both gates;
 *   * `#home-screen` has to be on screen. The tour points at things on Home
 *     and never navigates the viewer anywhere;
 *   * and `?shot=`, `?demo=` and `?token=` routes are skipped outright. The
 *     first two are the deterministic capture routes ../../settings/terms-first-run.js
 *     also refuses; the third is the capture identity the platform's declared
 *     checks render under (src/services/visuals.js mints it), and an overlay
 *     over 695 checks is not a thing to discover later.
 *
 * Once it is up it PAUSES rather than fights. Whenever Home leaves the screen,
 * or any kit surface that is not the Improve panel is presented (a dialog, a
 * sheet, an alert), the overlay hides and the step is kept; it comes back at
 * the same step when the viewer does. A panel step whose panel is no longer
 * open resumes at the Improve step instead, which is the one place in the arc
 * that stands on its own.
 *
 * Settings' "Replay the tour" clears the stored flag and asks for it again
 * through ./tour-request.ts, which is the one path that ignores all of the
 * above except "Home has to be on screen".
 *
 * ── A reload is not a restart ──────────────────────────────────────────
 *
 * Nothing here moves a tour backwards except Back, so a viewer who pressed
 * Next and saw step 1 again had their document replaced under them: the
 * shell reloads itself once its replacement build is cached after a cold
 * boot from the worker cache (App._reloadPrefetchedShellIfSafe), and the
 * boot-time session reconcile reloads when the server disagrees about the
 * session. Both land during the first seconds on Home, which is exactly when
 * the tour is up, and a tour that only remembered "finished" started over at
 * step 1 every time -- the "looping between the first and second step" that
 * was reported. The step now rides sessionStorage (./tour-storage.ts), the
 * auto-start resumes there (`resumeIndex`, ./tour-steps.ts), and the shell's
 * automatic reload treats a live `#home-tour` the way it treats a draft in a
 * textarea: not now (App._hasUnsavedShellInput).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { useClassToggle, useHiddenClass, useIsomorphicLayoutEffect } from '../../../lib/legacy-dom';
import { isEmbeddedPanel } from '../../../lib/side-panel-mode';
import { readVisibility, useVisibility } from '../../../lib/visibility-store';
import { AppContext } from '../../app-context/app-context-controller.js';
import { appContextStore } from '../../app-context/app-context-store.js';
import { Improve } from '../../improve/improve-controller.js';
import { improveStore } from '../../improve/improve-store.js';
import {
  CARD_GAP, cardWidth, findTarget, fitHole, padRect, placeCardForPanel, panelBox, shadeBoxes,
  SPOTLIGHT_PAD, type Box,
} from './spotlight';
import { useTourRequest } from './tour-request';
import {
  clampIndex, IMPROVE_STEP_INDEX, isLastStep, nextOpensMenu, resumeIndex, stepAt, stepCounter,
  TOUR_LENGTH,
} from './tour-steps';
import {
  clearStep, currentUserId, readDone, readStep, writeDone, writeStep,
} from './tour-storage';

/** How long to keep waiting for Home before giving up on this page load. */
const HOME_WAIT_TRIES = 60;
const HOME_WAIT_MS = 300;
/** In the app, how long the tour waits for the first touch before starting anyway. */
const FIRST_TOUCH_WAIT_MS = 6_000;

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Kit surfaces. Anything presented in one of these that is not one of the
 * tour's OWN two means the viewer is in a flow the tour must get out of the
 * way of. app.css already keys off this vocabulary
 * (`.un-sheet:has(#apps-switcher-sheet)`), so it is the kit's published seam rather
 * than a guess.
 */
const KIT_SURFACES = '.un-modal, .un-sheet, .un-alert';

/**
 * The two surfaces the tour drives, and therefore does not pause for.
 *
 * The Improve panel has always been one. #2718 added the app's own menu,
 * and it is not a refinement — it is required: on TOUCH that sheet is adopted
 * into a `.un-sheet`, so a tour that paused for it would open the menu on the
 * menu step and hide itself in the same frame, leaving the
 * viewer a presented sheet and no card. The web presentation is not a kit
 * surface at all, which is why this is only ever wrong on a phone — the
 * surface the tour is most often run on.
 */
const TOUR_OWNED_SURFACES = ['#apps-switcher-sheet'];

// ── Class strings ──────────────────────────────────────────────────────
//
// Complete literals, every one of them: Tailwind's extractor is a regex over
// source text, so a class name assembled at runtime is a class name that
// never gets compiled. `violet-*` is the shell's accent (tailwind.config.js);
// the admin console's `indigo` vocabulary is a different system and does not
// cross over (AGENTS.md).

// `pointer-events-none` on the root, re-enabled per child: that is what lets
// the cut-out be a real hole while the shades around it still block.
const ROOT = 'hidden fixed inset-0 z-[9993] overflow-hidden pointer-events-none';
const SHADE = 'absolute bg-zinc-950/60 dark:bg-zinc-950/75 pointer-events-auto '
  + 'motion-safe:transition-all motion-safe:duration-200';
// The cut-out's outline. No pointer-events utility in the rendered string: it
// inherits `none` from the root, and a step that only DESCRIBES its target
// adds `pointer-events-auto` through useClassToggle so the highlighted
// control cannot be pressed there.
const SPOT = 'hidden absolute rounded-xl ring-2 ring-violet-500 dark:ring-violet-400 '
  + 'motion-safe:transition-all motion-safe:duration-200';
const CARD = 'absolute w-[340px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-zinc-200 '
  + 'dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xl focus:outline-none '
  + 'pointer-events-auto motion-safe:transition-[top,left] motion-safe:duration-200';

/**
 * True on the routes that must render the same way every single time — and in
 * the side panel's document (`?panel=1`, beside a running app), which never
 * shows Home and whose top window runs the tour.
 */
function isDeterministicRoute(): boolean {
  if (isEmbeddedPanel()) return true;
  try {
    const params = new URLSearchParams(location.search);
    return !!(params.get('shot') || params.get('demo') || params.get('token'));
  } catch {
    return false;
  }
}

function homeVisibleNow(): boolean {
  // The router publishes Home's visibility (../../../lib/visibility-store.ts);
  // the DOM is the fallback for the window before it has said anything, which
  // is exactly the fallback App._isScreenVisible makes for the same reason.
  const published = readVisibility('home-screen');
  if (published !== undefined) return published;
  const el = document.getElementById('home-screen');
  return !!el && !el.classList.contains('hidden');
}

/** Resolves true once Home is on screen, false if it never arrives. */
function whenHomeVisible(): Promise<boolean> {
  if (homeVisibleNow()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (homeVisibleNow()) {
        window.clearInterval(timer);
        resolve(true);
      } else if (tries >= HOME_WAIT_TRIES) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, HOME_WAIT_MS);
  });
}

/** Await the first-run terms gate, if this document has one. */
async function whenTermsSettled(): Promise<void> {
  const gate = (window as unknown as {
    TermsFirstRun?: { settled?: () => Promise<void> };
  }).TermsFirstRun;
  if (!gate || typeof gate.settled !== 'function') return;
  try {
    await gate.settled();
  } catch {
    /* A broken gate must not keep the tour from ever running. */
  }
}

/**
 * In the app, wait for the viewer's first touch on the page, or a few
 * seconds. Right after sign-in the phone can put its own dialog on top
 * (Samsung Pass offering to save the password), and a tour started under it
 * opens on a step nobody can read. That dialog does not take focus from the
 * page, so focus cannot tell; a touch on the page means the dialog is gone.
 */
function whenUserSettled(): Promise<void> {
  const native = (window as unknown as { usernode?: { isNative?: boolean } })
    .usernode?.isNative === true;
  if (!native) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener('pointerdown', done, true);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, FIRST_TOUCH_WAIT_MS);
    document.addEventListener('pointerdown', done, true);
  });
}

/**
 * The status bar's height, in px; 0 in a browser tab. Measured, because in
 * the app the value is `env(safe-area-inset-top)` behind the shell's
 * `--platform-safe-top` token, which no script can read as a number.
 */
let safeTopCache: number | null = null;
function safeTopInset(): number {
  if (safeTopCache != null) return safeTopCache;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;' +
    'pointer-events:none;height:var(--platform-safe-top, env(safe-area-inset-top, 0px))';
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  safeTopCache = Number.isFinite(px) ? px : 0;
  return safeTopCache;
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { safeTopCache = null; });
}

/**
 * How much of the bottom of the screen the tab bar covers, for a target that
 * is NOT one of its tabs (QA 2026-09-24 Q30d); 0 with no bar on screen (the
 * desktop sidebar) or when the step points at a tab, which is in the bar.
 */
function tabBarInset(target: HTMLElement | null): number {
  const bar = document.getElementById('platform-tabs');
  if (!bar || (target && bar.contains(target))) return 0;
  const rect = bar.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return 0;
  return Math.max(0, window.innerHeight - rect.top);
}

/** Where the header ends, so a scroll can land a target just below it. */
function headerBottom(): number {
  const header = document.getElementById('platform-header');
  if (!header) return 0;
  const rect = header.getBoundingClientRect();
  return rect.height > 0 ? Math.max(0, rect.bottom) : 0;
}

/** The element that scrolls `el`: its nearest scrolling ancestor, else the page. */
function scrollerOf(el: HTMLElement): Element {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement || document.documentElement;
}

/**
 * Bring a step's target into view (QA 2026-09-24 Q30d). Centred when it fits
 * between the header and the tab bar, as before. A target TALLER than that
 * band (Challenges, on a phone) is lined up by its START instead, just below
 * the header: centring it pushed its heading off the top, leaving the card
 * nothing to sit under but the section's middle.
 */
function bringIntoView(target: HTMLElement, reduced: boolean): void {
  const rect = target.getBoundingClientRect();
  const top = headerBottom();
  const band = window.innerHeight - tabBarInset(target) - top;
  const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth';
  try {
    if (rect.height + SPOTLIGHT_PAD * 2 > band) {
      scrollerOf(target).scrollBy({ top: rect.top - (top + SPOTLIGHT_PAD + CARD_GAP), behavior });
    } else {
      target.scrollIntoView({ block: 'center', behavior });
    }
  } catch {
    target.scrollIntoView();
  }
}

/** Scroll Home back to its top, where the tour found it. */
function backToTopOfHome(): void {
  const home = document.getElementById('home-screen');
  if (!home || home.classList.contains('hidden')) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  home.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
}

/** Is a kit surface other than the tour's own two presented right now? */
function otherSurfacePresented(): boolean {
  for (const el of document.querySelectorAll(KIT_SURFACES)) {
    if (!TOUR_OWNED_SURFACES.some((sel) => el.querySelector(sel))) return true;
  }
  return false;
}

/**
 * THE SURFACE THESE STEPS ARE ON (#2718 review). It was the Improve panel and
 * it is the mark's menu: the panel retired, and its two actions are rows of
 * the menu now. Everything below that says "panel" means this one surface,
 * and `Improve.open()` / `Improve.close()` still name it — the controller
 * forwards both to AppContext.
 */
function panelOpenNow(): boolean {
  return !!appContextStore.get().open;
}

export function OnboardingTour() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const spotRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [otherSurface, setOtherSurface] = useState(false);

  const step = stepAt(index);
  const last = isLastStep(index);

  // Home's visibility, as a subscription. `true` is the shipped value, which
  // is also what the DOM fallback answers before the router has published.
  const homeVisible = useVisibility('home-screen', true);
  // Paused: still running, just not on screen. Derived, so there is no second
  // piece of state to keep in step with the two it is made of.
  const paused = !homeVisible || otherSurface;
  const live = open && !paused;

  // Read inside listeners that are registered once, so they never close over
  // a stale step.
  const indexRef = useRef(index);
  indexRef.current = index;
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;

  useHiddenClass(rootRef, !live);
  useHiddenClass(bodyRef, confirming);
  useHiddenClass(confirmRef, !confirming);
  useClassToggle(spotRef, 'pointer-events-auto', !step.interactive);

  // ── The viewer ───────────────────────────────────────────────────────
  //
  // Resolved in an effect, never during render: `App.user` is a classic-script
  // global populated only once the session has been read, which is after
  // hydration.
  useEffect(() => {
    const resolve = () => {
      const id = currentUserId();
      if (id != null) setUserId(id);
    };
    resolve();
    document.addEventListener('sv:authed', resolve);
    return () => document.removeEventListener('sv:authed', resolve);
  }, []);

  const start = useCallback((at = 0) => {
    setIndex(clampIndex(at));
    setConfirming(false);
    setOpen(true);
  }, []);

  // ── First sign-in ────────────────────────────────────────────────────
  //
  // `started` is per document and one-way: neither the auto-start nor a
  // replay may fire a second tour over the one on screen.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || userId == null) return;
    if (isDeterministicRoute()) return;
    if (readDone(userId)) return;
    let cancelled = false;
    void (async () => {
      await whenTermsSettled();
      if (cancelled || started.current) return;
      await whenUserSettled();
      if (cancelled || started.current) return;
      const home = await whenHomeVisible();
      if (cancelled || started.current || !home) return;
      // Re-read the flag: a replay, or another tab, may have answered while
      // the gates above were still resolving.
      if (readDone(userId)) return;
      started.current = true;
      // At the step this page session had reached, if the document was
      // reloaded under a tour in progress; from the top otherwise.
      start(resumeIndex(readStep(userId)));
    })();
    return () => { cancelled = true; };
  }, [userId, start]);

  // ── Where the viewer is, kept across a reload ────────────────────────
  //
  // Written on every step while the tour is up, so a reload -- whichever of
  // the shell's own reasons caused it -- comes back here rather than at step
  // 1. Cleared by finish(), because a finished tour has nowhere to resume.
  useEffect(() => {
    if (!open || userId == null) return;
    writeStep(userId, index);
  }, [open, index, userId]);

  // ── Settings' "Replay the tour" ──────────────────────────────────────
  const request = useTourRequest();
  const seenRequest = useRef(0);
  useEffect(() => {
    if (request === seenRequest.current) return;
    seenRequest.current = request;
    // Claim the document so the first-sign-in path cannot also fire.
    started.current = true;
    let cancelled = false;
    void (async () => {
      const home = await whenHomeVisible();
      if (cancelled || !home) return;
      start();
    })();
    return () => { cancelled = true; };
  }, [request, start]);

  // ── The mark's menu ──────────────────────────────────────────────────
  //
  // Watched, never driven. The advance fires on the EDGE into open, so the
  // viewer's own press on the real control is what moves the tour on and a
  // step cannot skip itself just because the menu happens to be up.
  useEffect(() => {
    if (!open) return;
    let was = panelOpenNow();
    setPanelOpen(was);
    return appContextStore.subscribe(() => {
      const now = panelOpenNow();
      if (now === was) return;
      was = now;
      setPanelOpen(now);
      if (now && stepAt(indexRef.current).advanceOn === 'menu-open') {
        setIndex((i) => clampIndex(i + 1));
      }
    });
  }, [open]);

  // ── Anything else the kit has presented ──────────────────────────────
  //
  // The kit mounts its surfaces on `body`, so a childList observer on body is
  // the whole detector. It runs only while the tour is up.
  useEffect(() => {
    if (!open) return;
    const read = () => setOtherSurface(otherSurfacePresented());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [open]);

  // ── The Improve step arrives with a clean slate ──────────────────────
  //
  // Two things have to be true when it presents, and they are ORDERED, which
  // is the whole reason they are one effect rather than two.
  //
  // THE PANEL MUST BE SHUT. The step's instruction is "press Improve" and it
  // ends on the panel OPENING, so arriving with it already up is a dead end:
  // there is no edge left to wait for. Whichever way the viewer got here —
  // Back from step 4, or a panel opened through an earlier cut-out — it is
  // shut again through the controller's own close path. That is also the
  // answer to what Back does with a still-open panel: it closes it, so the
  // step always presents the same way.
  //
  // THEN THE APP'S MENU OPENS, because #2718 made the step's target a row of
  // it and a row inside a closed sheet has no box for ./spotlight.ts to find.
  // It WAITS for the panel's teardown rather than racing it: on touch the kit
  // cannot present a surface while it is still dismissing another, which is
  // the ordering lib/sheet-controller.js's dismissForNav exists for and the
  // reason `Improve.close()` is awaited here rather than fired and forgotten.
  // (AppContext.open's own `_closeSiblings` dismisses the panel too, but it
  // does not await it — that is the race, not the fix for it.)
  //
  // THE MENU STEP ARRIVES WITH THE MENU SHUT (#2718 review).
  //
  // `opensSheet` retired with the Improve panel. It existed because the step's
  // target was a ROW INSIDE the menu, which has no box for ./spotlight.ts to
  // find while the menu is closed — so the tour had to present the surface
  // first. The target is the MARK now, which is on screen on every route, so
  // there is nothing to present and the viewer's own press is the whole step.
  //
  // What is left is the other half: arriving here with the menu already up
  // would mean the edge into `open` never fires and the step could not
  // advance. So it shuts it, once, on arrival — which is what the deps say.
  useEffect(() => {
    if (!live) return;
    if (stepAt(index).advanceOn !== 'menu-open') return;
    if (panelOpenNow()) void Improve.close();
  }, [live, index]);

  // Step 7 ends the arc by shutting the panel itself — and the app's menu with
  // it, because the steps that carry `closesPanel` spotlight the header and a
  // sheet drawn over the header hides the thing the cut-out is drawn around.
  useEffect(() => {
    if (!live) return;
    if (!stepAt(index).closesPanel) return;
    if (panelOpenNow()) void Improve.close();
    if (appContextStore.get().open) void AppContext.close();
  }, [live, index]);

  // A panel step with no panel cannot be shown. Falling back to the Improve
  // step is the resume rule: a viewer who closed the panel, or who came back
  // from a feedback draft or a new change, is asked to press Improve again
  // rather than being shown a card pointing at nothing. Gated on `live`, so a
  // flow in progress finishes first.
  useEffect(() => {
    if (!live) return;
    if (!stepAt(index).needsPanel) return;
    if (panelOpen) return;
    setIndex(IMPROVE_STEP_INDEX);
  }, [live, index, panelOpen]);

  // ── Geometry ─────────────────────────────────────────────────────────
  //
  // One pass: find the step's target, lay the four shades around it, outline
  // it, and put the card beside it. Called from the layout effect below on
  // every state change and then once per frame while the overlay is up,
  // which is why it writes the DOM rather than setting state -- and why it
  // writes only when the numbers have moved: the last geometry painted is
  // kept as one string, and a frame that measures the same thing touches
  // nothing.
  const paintedRef = useRef('');
  const apply = useCallback(() => {
    const card = cardRef.current;
    const spot = spotRef.current;
    const shades = [topRef.current, rightRef.current, bottomRef.current, leftRef.current];
    if (!card || !spot || shades.some((el) => !el)) return;
    const target = findTarget(stepAt(indexRef.current).targets);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // QA 2026-09-24 Q30d: the hole is fitted to where its ring can be seen,
    // inside the screen's edges and above the tab bar unless the target is
    // a tab, and the card keeps above the bar by the same inset.
    const bottomInset = tabBarInset(target);
    const hole = target ? fitHole(padRect(target.getBoundingClientRect()), viewport, bottomInset) : null;
    const boxes = shadeBoxes(viewport, hole);

    // The card's width goes first because its height, measured next, depends
    // on it. Written only when it changes, so a steady frame touches nothing.
    const width = cardWidth(viewport.width);
    if (card.style.width !== `${width}px`) card.style.width = `${width}px`;
    // The card must not sit ON the Improve panel while it is open: a tooltip
    // over the row it describes hides the thing it is pointing at. Only the
    // three panel steps consult it, so a closed panel's off-screen rect never
    // reaches the arithmetic.
    const panel = stepAt(indexRef.current).needsPanel && panelOpenNow() ? panelBox() : null;
    const placed = placeCardForPanel(
      viewport, { width, height: card.offsetHeight }, hole, panel, safeTopInset(), bottomInset,
    );

    const painted = JSON.stringify([hole, boxes, placed]);
    if (painted === paintedRef.current) return;
    paintedRef.current = painted;

    // The class strings above are constants React writes once, so this toggle
    // is the `useHiddenClass` contract spelled imperatively: the pass that
    // measures is the pass that reveals.
    spot.classList.toggle('hidden', !hole);
    if (hole) {
      spot.style.top = `${hole.top}px`;
      spot.style.left = `${hole.left}px`;
      spot.style.width = `${hole.width}px`;
      spot.style.height = `${hole.height}px`;
    }
    boxes.forEach((box: Box, i: number) => {
      const el = shades[i] as HTMLDivElement;
      el.style.top = `${box.top}px`;
      el.style.left = `${box.left}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
    });
    card.style.top = `${placed.top}px`;
    card.style.left = `${placed.left}px`;
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!live) return;
    // Forget what was painted last: the first pass after a state change, or
    // after a pause, always writes, even when the numbers happen to match.
    paintedRef.current = '';
    apply();
    // Then follow the target for as long as the overlay is up. A resize, a
    // scroll in #home-screen or in the panel's own body, the panel's CSS
    // slide, the kit sheet's spring and the sheet re-sizing under a list that
    // loads later all move the target; only the last two report nothing, and
    // the next frame is the one signal that is right for all of them. See
    // "Following the target" in the header.
    let frame = window.requestAnimationFrame(function follow() {
      apply();
      frame = window.requestAnimationFrame(follow);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [live, index, confirming, panelOpen, apply]);

  // Bring the step's target into view before pointing at it. Skipped for a
  // target inside the Improve panel: the panel is `position: fixed` and
  // already on screen, and scrolling the page under it would move Home for no
  // reason.
  useEffect(() => {
    if (!live || confirming) return;
    const target = findTarget(stepAt(index).targets);
    if (!target) return;
    if (document.getElementById('apps-switcher-sheet')?.contains(target)) return;
    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    bringIntoView(target, reduced);
  }, [live, index, confirming]);

  // ── Focus ────────────────────────────────────────────────────────────
  //
  // Moved into whichever surface is up, and held there: the tour covers the
  // page, so a tab that walked out of it would be a keyboard user driving a
  // screen they cannot see. The one exception is the step the viewer has to
  // ACT on, where focus goes to the highlighted control instead, because that
  // is the next thing to press.
  useEffect(() => {
    if (!live) return;
    if (!confirming && stepAt(index).advanceOn) {
      const target = findTarget(stepAt(index).targets);
      if (target) {
        target.focus?.();
        return;
      }
    }
    const surface = confirming ? confirmRef.current : bodyRef.current;
    const first = surface?.querySelector<HTMLElement>(FOCUSABLE);
    // The card itself is `tabIndex={-1}`, so it is the landing place when a
    // surface somehow has no control of its own.
    (first ?? cardRef.current)?.focus?.();
  }, [live, index, confirming]);

  const finish = useCallback(() => {
    writeDone(userId);
    clearStep(userId);
    setConfirming(false);
    setOpen(false);
    // The steps scrolled Home down to Challenges; hand the viewer back the
    // top of the page they started on.
    backToTopOfHome();
  }, [userId]);

  const goBack = useCallback(() => setIndex(clampIndex(indexRef.current - 1)), []);
  const goNext = useCallback(() => {
    const at = indexRef.current;
    // The menu step's Next does what the mark does rather than moving the
    // counter itself: the store subscription above sees `open` go true and
    // advances from there, so step 4 always arrives with the menu it points
    // into.
    if (nextOpensMenu(at)) void AppContext.open();
    else if (isLastStep(at)) finish();
    else setIndex(clampIndex(at + 1));
  }, [finish]);

  useEffect(() => {
    if (!live) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape behaves like Skip, and a second Escape backs out of the
        // question rather than answering it.
        setConfirming((was) => !was);
        return;
      }
      if (event.key !== 'Tab') return;
      // The step the viewer has to act on leaves the highlighted control in
      // the tab order: trapping focus in the card would make that step
      // impossible to complete from a keyboard.
      if (!confirmingRef.current && stepAt(indexRef.current).advanceOn) return;
      const surface = confirmingRef.current ? confirmRef.current : bodyRef.current;
      if (!surface) return;
      const stops = [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => !el.classList.contains('hidden'));
      if (!stops.length) return;
      const first = stops[0];
      const final = stops[stops.length - 1];
      const active = document.activeElement;
      if (!surface.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (!event.shiftKey && active === final) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        final.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [live]);

  return (
    <div
      ref={rootRef}
      id="home-tour"
      className={ROOT}
      role="dialog"
      aria-modal="true"
      aria-labelledby="home-tour-title"
    >
      {/*
          The dim, as four panels around the cut-out rather than one shadow.
          They are what BLOCKS, so the hole they leave is a real hole and the
          Improve button inside it can be pressed on the step that asks for
          it. With no target they collapse to a single full-screen shade.
      */}
      <div ref={topRef} id="home-tour-shade-top" className={SHADE}></div>
      <div ref={rightRef} id="home-tour-shade-right" className={SHADE}></div>
      <div ref={bottomRef} id="home-tour-shade-bottom" className={SHADE}></div>
      <div ref={leftRef} id="home-tour-shade-left" className={SHADE}></div>
      <div ref={spotRef} id="home-tour-spotlight" className={SPOT}></div>
      <div
        ref={cardRef}
        id="home-tour-card"
        tabIndex={-1}
        className={CARD}
      >
        <div ref={bodyRef} id="home-tour-body">
          <div
            id="home-tour-counter"
            className="text-[0.6875rem] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400"
          >
            {stepCounter(index)}
          </div>
          <h2
            id="home-tour-title"
            className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100"
          >
            {step.title}
          </h2>
          <p id="home-tour-text" className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            {step.body}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <Button
              id="home-tour-skip"
              type="button"
              variant="unstyled"
              size="inline"
              ink="muted"
              className="rounded px-1 py-1"
              onClick={() => setConfirming(true)}
            >
              Skip
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                id="home-tour-back"
                type="button"
                variant="outline"
                size="sm"
                ink="muted"
                disabledStyle="dim"
                disabled={index === 0}
                onClick={goBack}
              >
                Back
              </Button>
              {/*
                  On every step. On the menu step it opens the menu rather
                  than skipping it (goNext), so it cannot carry the viewer
                  past the step that asks them to press something.
              */}
              <Button
                id="home-tour-next"
                type="button"
                size="sm"
                onClick={goNext}
              >
                {last ? 'Finish' : 'Next'}
              </Button>
            </div>
          </div>
        </div>
        {/*
            The Skip question. A sibling of the body rather than a second
            surface, so the card keeps its position and only its contents
            change; the geometry pass re-measures on `confirming`, because the
            question is shorter than most steps.
        */}
        <div ref={confirmRef} id="home-tour-confirm" className="hidden">
          <p
            id="home-tour-confirm-text"
            className="text-sm text-zinc-700 dark:text-zinc-200"
          >
            Are you sure? You can reopen this from Settings.
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              id="home-tour-confirm-cancel"
              type="button"
              variant="outline"
              size="sm"
              ink="muted"
              onClick={() => setConfirming(false)}
            >
              Keep going
            </Button>
            <Button
              id="home-tour-confirm-skip"
              type="button"
              size="sm"
              onClick={finish}
            >
              Skip the tour
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { TOUR_LENGTH };
