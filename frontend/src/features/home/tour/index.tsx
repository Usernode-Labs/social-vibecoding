/**
 * `#home-tour` — the eight-step welcome tour, replacing the `#home-welcome`
 * banner (#1561) that this change retires.
 *
 * The banner said the two things the launcher never says, in three lines, and
 * then went away for good. What it could not do is point: "send feedback from
 * the Improve button" names a control that is on another screen, and a new
 * account has no way to tell which of the things in front of it that sentence
 * is about. The tour dims the page, cuts a hole around the thing it is
 * talking about, and puts the sentence next to it.
 *
 * ── The island rules, and how each is kept ────────────────────────────
 *
 * This is a fixed overlay that ships in the shell and starts `hidden`, the
 * same arrangement as `#mobile-install-banner` and the banner it replaces:
 *
 *   * THE FIRST RENDER IS THE PRERENDERED MARKUP. Nothing viewer-dependent
 *     is read during render. `open` is false, `index` is 0 and `confirming`
 *     is false on both sides of hydration, so the built document and the
 *     first client pass emit the same tree -- step 1's copy, hidden.
 *   * VISIBILITY RIDES REFS. The root, the dim, the spotlight, the Improve
 *     still life and the confirmation all carry CONSTANT class strings with
 *     `hidden` exactly where the prerender has it, and the toggles go through
 *     `useHiddenClass` or, for the two the geometry pass owns, a `classList`
 *     write inside that pass. See ../../../lib/legacy-dom.ts.
 *   * GEOMETRY IS WRITTEN, NOT RENDERED. The hole's box and the card's
 *     position are `style` writes through refs, for the reason
 *     features/settings/sections/theme.tsx writes its caret index that way:
 *     the shipped markup carries no `style` attribute, and a measured pixel
 *     is not something to reconcile. It also means a resize or a scroll
 *     re-measures without a React render.
 *
 * Nothing in `public/js/**` writes into this subtree, so the region is
 * React-owned end to end and may hold state (AGENTS.md).
 *
 * ── When it opens ─────────────────────────────────────────────────────
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
 *     over 693 checks is not a thing to discover later.
 *
 * Settings' "Replay the tour" clears the stored flag and asks for it again
 * through ./tour-request.ts, which is the one path that ignores all of the
 * above except "Home has to be on screen".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../../lib/legacy-dom';
import { readVisibility } from '../../../lib/visibility-store';
import { cardWidth, findTarget, padRect, placeCard } from './spotlight';
import { useTourRequest } from './tour-request';
import { clampIndex, isLastStep, stepAt, stepCounter, TOUR_LENGTH } from './tour-steps';
import { currentUserId, readDone, writeDone } from './tour-storage';

/** How long to keep waiting for Home before giving up on this page load. */
const HOME_WAIT_TRIES = 60;
const HOME_WAIT_MS = 300;

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// ── Class strings ──────────────────────────────────────────────────────
//
// Complete literals, every one of them: Tailwind's extractor is a regex over
// source text, so a class name assembled at runtime is a class name that
// never gets compiled. `violet-*` is the shell's accent (tailwind.config.js);
// the admin console's `indigo` vocabulary is a different system and does not
// cross over (AGENTS.md).

const ROOT = 'hidden fixed inset-0 z-[70] overflow-hidden';
// The whole-screen dim, used by a step with nothing to point at. The
// spotlight's own shadow does this job when there IS a hole, so exactly one
// of the two is ever visible.
const DIM = 'hidden absolute inset-0 bg-zinc-950/60 dark:bg-zinc-950/75';
// The hole. `shadow-[...]` fills the rest of the screen and `ring-*` draws
// the edge: Tailwind composes the two into one `box-shadow`, so the dim and
// the outline are the same element and can never drift apart.
const SPOT = 'hidden absolute rounded-xl pointer-events-none '
  + 'ring-2 ring-violet-500 dark:ring-violet-400 '
  + 'shadow-[0_0_0_9999px_rgba(9,9,11,0.6)] dark:shadow-[0_0_0_9999px_rgba(9,9,11,0.75)] '
  + 'motion-safe:transition-all motion-safe:duration-200';
const CARD = 'absolute w-[340px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-zinc-200 '
  + 'dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xl focus:outline-none '
  + 'motion-safe:transition-[top,left] motion-safe:duration-200';

const MOCK = 'hidden mt-3 rounded-xl border border-zinc-200 dark:border-zinc-800 '
  + 'bg-zinc-50 dark:bg-zinc-950/60 p-2';
const MOCK_PILL = 'rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold';
const MOCK_PILL_ON = 'bg-violet-600 text-white ring-2 ring-violet-400 dark:ring-violet-500';
const MOCK_PILL_OFF = 'bg-violet-600/40 text-white';
const MOCK_ROW = 'flex-1 rounded-md px-2 py-1 text-center text-[0.6875rem] font-medium';
const MOCK_ROW_ON = 'bg-violet-50 text-violet-700 ring-2 ring-violet-400 '
  + 'dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500';
const MOCK_ROW_OFF = 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
const MOCK_TAB = 'flex-1 rounded px-2 py-0.5 text-center text-[0.6875rem] font-medium';
const MOCK_TAB_ON = 'bg-white text-violet-700 ring-2 ring-violet-400 '
  + 'dark:bg-zinc-900 dark:text-violet-300 dark:ring-violet-500';
const MOCK_TAB_OFF = 'text-zinc-500 dark:text-zinc-400';

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

export function OnboardingTour() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dimRef = useRef<HTMLDivElement | null>(null);
  const spotRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const mockRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);

  const step = stepAt(index);
  const last = isLastStep(index);

  // Read inside listeners that are registered once, so they never close over
  // a stale step.
  const indexRef = useRef(index);
  indexRef.current = index;
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;

  useHiddenClass(rootRef, !open);
  useHiddenClass(mockRef, !step.mock);
  useHiddenClass(bodyRef, confirming);
  useHiddenClass(confirmRef, !confirming);

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

  // ── Geometry ─────────────────────────────────────────────────────────
  //
  // One pass: find the step's target, size the hole around it, and put the
  // card beside it. Called from the layout effect below on every state
  // change, and directly from the resize/scroll listeners, which is why it
  // writes the DOM rather than setting state.
  const apply = useCallback(() => {
    const card = cardRef.current;
    const spot = spotRef.current;
    const dim = dimRef.current;
    if (!card || !spot || !dim) return;
    const target = findTarget(stepAt(indexRef.current).targets);
    const hole = target ? padRect(target.getBoundingClientRect()) : null;
    // The class strings above are constants React writes once, so these two
    // toggles are the `useHiddenClass` contract spelled imperatively: the
    // pass that measures is the pass that reveals.
    spot.classList.toggle('hidden', !hole);
    dim.classList.toggle('hidden', !!hole);
    if (hole) {
      spot.style.top = `${hole.top}px`;
      spot.style.left = `${hole.left}px`;
      spot.style.width = `${hole.width}px`;
      spot.style.height = `${hole.height}px`;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const width = cardWidth(viewport.width);
    card.style.width = `${width}px`;
    const placed = placeCard(viewport, { width, height: card.offsetHeight }, hole);
    card.style.top = `${placed.top}px`;
    card.style.left = `${placed.left}px`;
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    apply();
    const onChange = () => apply();
    window.addEventListener('resize', onChange);
    // Capture, so a scroll inside #home-screen (which is the scroller, not
    // the document) re-measures too: scroll does not bubble, but it is
    // delivered to a capturing listener on the way down.
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [open, index, confirming, apply]);

  // Bring the step's target into view before pointing at it. The smooth
  // scroll keeps firing scroll events, which the capture listener above turns
  // into re-measures, so the hole tracks the element all the way down.
  useEffect(() => {
    if (!open || confirming) return;
    const target = findTarget(stepAt(index).targets);
    if (!target) return;
    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    try {
      target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    } catch {
      target.scrollIntoView();
    }
  }, [open, index, confirming]);

  // ── Focus ────────────────────────────────────────────────────────────
  //
  // Moved into whichever surface is up, and held there: the tour covers the
  // page, so a tab that walked out of it would be a keyboard user driving a
  // screen they cannot see.
  useEffect(() => {
    if (!open) return;
    const surface = confirming ? confirmRef.current : bodyRef.current;
    const first = surface?.querySelector<HTMLElement>(FOCUSABLE);
    // The card itself is `tabIndex={-1}`, so it is the landing place when a
    // surface somehow has no control of its own.
    (first ?? cardRef.current)?.focus?.();
  }, [open, index, confirming]);

  const finish = useCallback(() => {
    writeDone(userId);
    setConfirming(false);
    setOpen(false);
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape behaves like Skip, and a second Escape backs out of the
        // question rather than answering it.
        setConfirming((was) => !was);
        return;
      }
      if (event.key !== 'Tab') return;
      const surface = confirmingRef.current ? confirmRef.current : bodyRef.current;
      if (!surface) return;
      const stops = [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)];
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
  }, [open]);

  const mock = step.mock;

  return (
    <div
      ref={rootRef}
      id="home-tour"
      className={ROOT}
      role="dialog"
      aria-modal="true"
      aria-labelledby="home-tour-title"
    >
      <div ref={dimRef} id="home-tour-dim" className={DIM}></div>
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
          {/*
              The Improve panel, drawn small, with the control this step names
              picked out. Steps 3 to 6 are about things that live inside an
              app, and the tour does not take the viewer into one, so this is
              how they get shown rather than only described.
          */}
          <div ref={mockRef} id="home-tour-mock" className={MOCK} aria-hidden="true">
            <div className="flex items-center justify-between gap-2 px-1 pb-2">
              <span className="text-[0.6875rem] text-zinc-500 dark:text-zinc-400">
                Found inside any app
              </span>
              <span className={`${MOCK_PILL} ${mock === 'improve' ? MOCK_PILL_ON : MOCK_PILL_OFF}`}>
                Improve
              </span>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2">
              <div className="flex gap-1.5">
                <span className={`${MOCK_ROW} ${mock === 'feedback' ? MOCK_ROW_ON : MOCK_ROW_OFF}`}>
                  Give feedback
                </span>
                <span className={`${MOCK_ROW} ${mock === 'new-change' ? MOCK_ROW_ON : MOCK_ROW_OFF}`}>
                  New change
                </span>
              </div>
              <div className="mt-1.5 flex gap-1.5 rounded-md bg-zinc-100 dark:bg-zinc-800 p-0.5">
                <span className={`${MOCK_TAB} ${MOCK_TAB_OFF}`}>App</span>
                <span className={`${MOCK_TAB} ${mock === 'workshop' ? MOCK_TAB_ON : MOCK_TAB_OFF}`}>
                  Workshop
                </span>
              </div>
            </div>
          </div>
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
                onClick={() => setIndex((i) => clampIndex(i - 1))}
              >
                Back
              </Button>
              <Button
                id="home-tour-next"
                type="button"
                size="sm"
                onClick={() => (last ? finish() : setIndex((i) => clampIndex(i + 1)))}
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
