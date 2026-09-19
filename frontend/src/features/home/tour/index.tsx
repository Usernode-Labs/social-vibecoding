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
 * Nothing here is a drawing of the product. The Improve arc works because
 * `#improve-btn` is on Home: the header's Improve control, targeting the
 * platform's own self-hosted row for as long as Home is up
 * (`Home.publishImproveTarget`, #1367). So steps 3 to 6 are one interaction
 * rather than four descriptions:
 *
 *   * step 3 spotlights the button and asks the viewer to press it. It has no
 *     Next. The click is NOT intercepted: the tour subscribes to
 *     `improveStore` and advances when `open` goes true, so what opens the
 *     panel is the product's own handler and the tour is only watching;
 *   * steps 4 to 6 spotlight `#improve-row-feedback`, `#improve-row-new-session`
 *     and `#app-context-row-workshop` INSIDE the panel the viewer just opened,
 *     and Next moves between them;
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
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { useClassToggle, useHiddenClass, useIsomorphicLayoutEffect } from '../../../lib/legacy-dom';
import { readVisibility, useVisibility } from '../../../lib/visibility-store';
import { Improve } from '../../improve/improve-controller.js';
import { improveStore } from '../../improve/improve-store.js';
import { cardWidth, findTarget, padRect, placeCard, shadeBoxes, type Box } from './spotlight';
import { useTourRequest } from './tour-request';
import {
  clampIndex, hasNext, IMPROVE_STEP_INDEX, isLastStep, stepAt, stepCounter, TOUR_LENGTH,
} from './tour-steps';
import { currentUserId, readDone, writeDone } from './tour-storage';

/** How long to keep waiting for Home before giving up on this page load. */
const HOME_WAIT_TRIES = 60;
const HOME_WAIT_MS = 300;

/**
 * Re-measure for this long after anything that moves the target.
 *
 * A smooth scroll, the panel's CSS slide and the kit sheet's spring all take
 * a few hundred milliseconds and none of them reports when it is done. The
 * scroll listener catches the first; this catches the other two.
 */
const SETTLE_MS = 600;
const SETTLE_TICK_MS = 50;

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Kit surfaces. Anything presented in one of these that is NOT the Improve
 * panel means the viewer is in a flow the tour must get out of the way of.
 * app.css already keys off this vocabulary (`.un-sheet:has(#improve-panel)`),
 * so it is the kit's published seam rather than a guess.
 */
const KIT_SURFACES = '.un-modal, .un-sheet, .un-alert';

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

/** True on the routes that must render the same way every single time. */
function isDeterministicRoute(): boolean {
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

/** Is a kit surface other than the Improve panel presented right now? */
function otherSurfacePresented(): boolean {
  for (const el of document.querySelectorAll(KIT_SURFACES)) {
    if (!el.querySelector('#improve-panel')) return true;
  }
  return false;
}

function panelOpenNow(): boolean {
  return !!improveStore.get().open;
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
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [otherSurface, setOtherSurface] = useState(false);

  const step = stepAt(index);
  const last = isLastStep(index);
  const showsNext = hasNext(index);

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
  useHiddenClass(nextRef, !showsNext);
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

  const start = useCallback(() => {
    setIndex(0);
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
      const home = await whenHomeVisible();
      if (cancelled || started.current || !home) return;
      // Re-read the flag: a replay, or another tab, may have answered while
      // the gates above were still resolving.
      if (readDone(userId)) return;
      started.current = true;
      start();
    })();
    return () => { cancelled = true; };
  }, [userId, start]);

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

  // ── The Improve panel ────────────────────────────────────────────────
  //
  // Watched, never driven. The advance fires on the EDGE into open, so the
  // viewer's own click on the real button is what moves the tour on and a
  // step cannot skip itself just because the panel happens to be up.
  useEffect(() => {
    if (!open) return;
    let was = panelOpenNow();
    setPanelOpen(was);
    return improveStore.subscribe(() => {
      const now = panelOpenNow();
      if (now === was) return;
      was = now;
      setPanelOpen(now);
      if (now && stepAt(indexRef.current).advanceOn === 'improve-open') {
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

  // The Improve step's instruction is "press Improve", and it ends on the
  // panel OPENING, so arriving with the panel already up is a dead end: there
  // is no edge left to wait for. Whichever way the viewer got here, Back from
  // step 4 or a panel opened through an earlier cut-out, the panel is shut
  // again through the controller's own close path. That is also the answer to
  // what Back does with a still-open panel: it closes it, so the step always
  // presents the same way.
  useEffect(() => {
    if (!live) return;
    if (stepAt(index).advanceOn !== 'improve-open') return;
    if (!panelOpenNow()) return;
    void Improve.close();
  }, [live, index]);

  // Step 7 ends the arc by shutting the panel itself.
  useEffect(() => {
    if (!live) return;
    if (!stepAt(index).closesPanel) return;
    if (!panelOpenNow()) return;
    void Improve.close();
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
  // every state change, and directly from the resize/scroll listeners, which
  // is why it writes the DOM rather than setting state.
  const apply = useCallback(() => {
    const card = cardRef.current;
    const spot = spotRef.current;
    const shades = [topRef.current, rightRef.current, bottomRef.current, leftRef.current];
    if (!card || !spot || shades.some((el) => !el)) return;
    const target = findTarget(stepAt(indexRef.current).targets);
    const hole = target ? padRect(target.getBoundingClientRect()) : null;
    const viewport = { width: window.innerWidth, height: window.innerHeight };

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
    shadeBoxes(viewport, hole).forEach((box: Box, i: number) => {
      const el = shades[i] as HTMLDivElement;
      el.style.top = `${box.top}px`;
      el.style.left = `${box.left}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
    });

    const width = cardWidth(viewport.width);
    card.style.width = `${width}px`;
    const placed = placeCard(viewport, { width, height: card.offsetHeight }, hole);
    card.style.top = `${placed.top}px`;
    card.style.left = `${placed.left}px`;
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!live) return;
    apply();
    const onChange = () => apply();
    window.addEventListener('resize', onChange);
    // Capture, so a scroll inside #home-screen or the panel's own body (which
    // are the scrollers, not the document) re-measures too: scroll does not
    // bubble, but it is delivered to a capturing listener on the way down.
    window.addEventListener('scroll', onChange, true);
    // And a short settle, for the animations that report nothing: the smooth
    // scroll below, the panel's CSS slide, the kit sheet's spring.
    const ticker = window.setInterval(apply, SETTLE_TICK_MS);
    const stop = window.setTimeout(() => window.clearInterval(ticker), SETTLE_MS);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
      window.clearInterval(ticker);
      window.clearTimeout(stop);
    };
  }, [live, index, confirming, panelOpen, apply]);

  // Bring the step's target into view before pointing at it. Skipped for a
  // target inside the Improve panel: the panel is `position: fixed` and
  // already on screen, and scrolling the page under it would move Home for no
  // reason.
  useEffect(() => {
    if (!live || confirming) return;
    const target = findTarget(stepAt(index).targets);
    if (!target) return;
    if (document.getElementById('improve-panel')?.contains(target)) return;
    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    try {
      target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    } catch {
      target.scrollIntoView();
    }
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
    setConfirming(false);
    setOpen(false);
  }, [userId]);

  const goBack = useCallback(() => setIndex(clampIndex(indexRef.current - 1)), []);
  const goNext = useCallback(() => {
    if (isLastStep(indexRef.current)) finish();
    else setIndex(clampIndex(indexRef.current + 1));
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
                  Hidden on the step that ends when the panel opens: there is
                  nothing for Next to do there, and a live one would let the
                  viewer past the only step that asks them to press something.
              */}
              <Button
                ref={nextRef}
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
