/**
 * The first session after an invite: "You're in", then a short tour on the
 * real screens.
 *
 *   welcome  A full-screen card on the landing's wallpaper: you joined this
 *            group, and — for an account the invite's own sign-up made — what
 *            Homeroom is, in three lines. Under that, the project as its
 *            invite showed it (./joined-picture.tsx). "Go to <name>" starts
 *            the tour, told whether its first version is still being built
 *            (read here from GET /api/apps/:slug, now that they may).
 *   tour     ./tour-steps.ts, over the live shell. Each screen is shown whole
 *            first, then the control that leads on is cut out of the dim and
 *            the reader presses it, or the card's blue hint, which presses
 *            the same control: the product's own handler navigates, and
 *            the tour only watches the press. Back re-opens the screen the
 *            previous step was on; Skip ends on the last step's screen.
 *            The make screen opens it too: the maker's path after the made
 *            screen, and "Look around first"'s own four cards on Home.
 *
 * App.\_followInvite (public/js/app.js) opens it through
 * `window.UsernodeReact.firstSession.welcome(info)`, once per account and
 * project (localStorage), when the invite link it is following has just
 * joined the viewer; so does an invite by username, accepted from the
 * notifications (Notifications.\_acceptInvite, with the accept's `welcome`).
 * It answers false when it will not show, and the caller lands them where
 * it always did.
 *
 * A sign-in from the invite's own page (Join, then the sheet) is followed in
 * the tick the signed-in shell starts, and the link's standing, which says
 * whether to welcome them, is a request away: Home showed for that long
 * before "You're in" (Evan, 5 October 2026). So the follow asks for the
 * welcome's frame first, `holdWelcome()`, drawn at once (flushSync) on the
 * same wallpaper, before the shell draws Home; welcome() fills it, and
 * `endHold()` takes it down for any other ending. The make screen's own
 * hand-off (#3894) works the same way.
 *
 * ── The island rules ──────────────────────────────────────────────────
 *
 * It renders NOTHING until it is opened, so the prerendered shell is
 * unchanged, and only a press opens it, so the first client render matches.
 * Nothing in `public/js/**` writes into it; the legacy shell is only CALLED
 * (App.navigateHome, App.navigateToApp, App.openDiscussionInHub). The
 * spotlight's geometry is measured each frame from the target the step names
 * and kept in state only when it moves.
 */

import { type Dispatch, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '@/components/ui/button';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { Wordmark } from '@/components/ui/wordmark';

import { joinPicture, JoinedPicture } from './joined-picture';
import { type Made, MakeScreen } from './make';
import { MadeScreen, madeAppOf, madeAppUrl } from './made';
import { BOTTOM_BARS, type FirstVersionStage, invitedSteps, lookAroundSteps, makerSteps, type TourScreen, type TourStep } from './tour-steps';

export type FirstSessionInfo = {
  slug: string;
  /** Homeroom bot's chat with the viewer, when it builds this project for them. */
  conversationId?: number | null;
  name: string;
  iconEmoji?: string | null;
  iconUrl?: string | null;
  inviterName?: string | null;
  inviterMadeIt?: boolean;
  /** Its first version is still on its way: "<maker> is making it" (community-invites.js firstVersionPending). */
  building?: boolean;
  /**
   * The account was made by the sign-up the link opened (or is a test
   * account on its first sign-in: services/test-accounts.js onFirstRun).
   */
  newAccount?: boolean;
  /** The project's one line, and the picture its invite showed (./joined-picture.tsx). */
  description?: string | null;
  picture?: unknown;
  /**
   * Where its first version stands, as "You're in" read it. The tour's cards
   * no longer say it (./tour-steps.ts): the app screen behind them does.
   */
  firstVersion?: FirstVersionStage;
};

/**
 * Where a project's first version stands, from GET /api/apps/:slug's
 * `first_version` (madeAppOf): being built, built and up for approval, or
 * null once there is none (the app is what there is).
 */
export function firstVersionStage(body: unknown): FirstVersionStage {
  const fv = madeAppOf(body)?.firstVersion;
  if (!fv) return null;
  return fv.ready ? 'ready' : 'building';
}

type Legacy = {
  App?: {
    user?: { id?: number; username?: string; displayName?: string | null; needsCommunitiesChoice?: boolean } | null;
    saveSessionSnapshot?: (user: unknown) => void;
    navigateHome?: (opts?: unknown) => void;
    navigateToApp?: (slug: string, tab: string) => unknown;
    openDiscussionInHub?: (slug: string) => void;
    _WORKSHOP_VIEW_KEY?: string;
    _workshopViewPath?: (url: string) => string | null;
    _publishCommunityScope?: (slug: string | null) => void;
  };
  AppView?: {
    _landOnHub?: (slug: string) => void;
  };
  UsernodeReact?: Record<string, unknown>;
};
const legacy = (): Legacy => window as unknown as Legacy;

const SEEN_PREFIX = 'usernode:first-session:';
function seenKey(slug: string): string {
  return `${SEEN_PREFIX}${legacy().App?.user?.id ?? 'anon'}:${slug}`;
}
function seen(slug: string): boolean {
  try { return !!localStorage.getItem(seenKey(slug)); } catch { return false; }
}
function markSeen(slug: string): void {
  try { localStorage.setItem(seenKey(slug), String(Date.now())); } catch { /* private mode */ }
}

/** Open the screen a step is on, through the shell's own navigation. */
export function enterScreen(screen: TourScreen, slug: string, conversationId?: number | null): void {
  const { App, AppView } = legacy();
  if (!App) return;
  if (screen === 'home') App.navigateHome?.();
  else if (screen === 'app') App.navigateToApp?.(slug, 'app');
  else if (screen === 'hub') { AppView?._landOnHub?.(slug); App.navigateToApp?.(slug, 'dev'); }
  else if (screen === 'discussion') App.openDiscussionInHub?.(slug);
  else if (screen === 'bot' && conversationId) window.location.hash = `#messages/${conversationId}`;
}

/**
 * Make the Communities tab open on this project's hub: the page the tab
 * reopens is the one App._noteWorkshopView remembers (public/js/app.js), and
 * a viewer who has only used the app has none yet, so the tab would list
 * every community instead of the one they just joined.
 */
export function rememberCommunity(slug: string): void {
  const { App, AppView } = legacy();
  const key = App?._WORKSHOP_VIEW_KEY;
  const path = App?._workshopViewPath?.(`/app/${encodeURIComponent(slug)}/workshop`);
  if (!key || !path) return;
  try { localStorage.setItem(key, JSON.stringify({ slug, path })); } catch { return; }
  App?._publishCommunityScope?.(slug);
  // And on its Hub tab, whatever tab the page was last left on.
  AppView?._landOnHub?.(slug);
}

type Box = { left: number; top: number; width: number; height: number };

/** The boxes of the visible elements a selector list names. */
function visibleBoxes(selectors: string): Box[] {
  return Array.from(document.querySelectorAll(selectors))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
}

/** Pure: boxes drawn as one, the smallest box around all of them, or null. */
export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** The visible elements a selector list names, drawn as one box, or null. */
export function targetBox(selectors: string): Box | null {
  return unionBox(visibleBoxes(selectors));
}

/** How far below a transcript's top edge a row it shows from its top begins. */
const ROW_INSET = 8;

/**
 * Pure: how far a transcript scrolls back so a row whose top is at `rowTop`
 * begins ROW_INSET below the transcript's own top (`scrollerTop`), both on
 * screen: 0 when it does already. Never forward: a row lower down is in view.
 */
export function scrollBackFor(scrollerTop: number, rowTop: number, inset: number = ROW_INSET): number {
  const by = scrollerTop + inset - rowTop;
  return by > 0 ? Math.ceil(by) : 0;
}

type ScrollerLike = { scrollTop: number; getBoundingClientRect(): { top: number; height: number }; querySelectorAll(rows: string): ArrayLike<{ getBoundingClientRect(): { top: number } }> };

/**
 * A step's transcript (TourStep.newestFromTop): its newest row is shown from
 * its top edge. Pinned to its newest line, the bot's chat put a plan card
 * taller than the space above the coach card part-way down, its first line
 * ("Here's my plan for …") above the cut-out. Run every frame while the step
 * is up, so it holds when the rows arrive after the step lands and when the
 * chat follows a card that grew; the step covers its cut-out, so the reader
 * is never scrolled against their own hand. Answers whether it scrolled.
 */
export function showNewestFromTop(
  spec: { scroller: string; rows: string },
  root: { querySelectorAll(selectors: string): ArrayLike<unknown> } = document,
): boolean {
  const scroller = (Array.from(root.querySelectorAll(spec.scroller)) as ScrollerLike[])
    .find((el) => el.getBoundingClientRect().height > 0);
  if (!scroller) return false;
  const rows = scroller.querySelectorAll(spec.rows);
  const newest = rows.length ? rows[rows.length - 1] : null;
  if (!newest) return false;
  const by = scrollBackFor(scroller.getBoundingClientRect().top, newest.getBoundingClientRect().top);
  if (!by) return false;
  scroller.scrollTop = Math.max(0, scroller.scrollTop - by);
  return true;
}

const PAD = 6;
/** The ring's width (`ring-[3px]` below), kept on screen around a hole. */
const RING = 3;
const SHADE = 'pointer-events-auto fixed bg-[rgba(9,9,12,0.6)] transition-all duration-200';

/**
 * Pure: a cut-out with its foot taken off by the bars lying across it
 * (TourStep.endsAbove). A bar counts when it is at least half the cut-out's
 * width and begins inside it: the phone's tab bar, and the Resume strip on
 * it. The rail from 768px up runs down the side and takes nothing off. It
 * ends `pad` above the highest such bar, so the padded hole (holeFor) meets
 * the bar's edge rather than covering it.
 */
export function endAbove(box: Box, bars: Box[], pad: number = PAD): Box {
  const bottom = box.top + box.height;
  const across = bars.filter((b) => b.width >= box.width / 2 && b.top > box.top && b.top < bottom);
  if (!across.length) return box;
  const end = Math.min(...across.map((b) => b.top)) - pad;
  return { ...box, height: Math.max(0, Math.min(bottom, end) - box.top) };
}

/**
 * The cut-out a step draws, before padding: its target (null until that is
 * on screen), with what it is drawn `alongside` (the top bar), and its foot
 * taken off where it `endsAbove` a bar.
 */
export function stepBox(step: Pick<TourStep, 'target' | 'alongside' | 'endsAbove'>): Box | null {
  const target = targetBox(step.target);
  if (!target) return null;
  const box = step.alongside ? unionBox([target, ...visibleBoxes(step.alongside)]) || target : target;
  return step.endsAbove ? endAbove(box, visibleBoxes(step.endsAbove)) : box;
}

/** The control a tap step leads on by: its `press`, or its target. */
export function pressOf(step: Pick<TourStep, 'target' | 'press'>): string {
  return step.press || step.target;
}

type PressRoot = { querySelectorAll(selectors: string): ArrayLike<unknown> };
type Pressable = { getBoundingClientRect(): { width: number; height: number }; click(): void };

/**
 * A tap step's hint, pressed (TourStep.tap: "Tap it to open it", "Tap ✕"):
 * it presses the step's own control, the first one on screen, as a finger on
 * it does. So it goes the one way a press on the control goes: the product's
 * own handler navigates, and the tour's watcher (Tour, below) sees the press
 * and moves on. Nothing here moves the tour. Answers whether there was a
 * control to press.
 */
export function pressTarget(selectors: string, root: PressRoot = document): boolean {
  const control = (Array.from(root.querySelectorAll(selectors)) as Pressable[])
    .find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!control) return false;
  control.click();
  return true;
}

/**
 * A target measured, and the step it was measured FOR.
 *
 * The box used to be state of its own, refreshed by the next animation frame,
 * so the render that showed a new step's card still drew the previous step's
 * cut-out. On 4 of 7 that was the ring round ✕, at the top-left of the
 * app's header, drawn over Home's Homeroom logo beside "Tap Communities"
 * (production, 375x812 browser, 4 Oct 2026), and it stayed there for as long
 * as no frame came to replace it. A box now counts only for its own step:
 * until the new target has been measured the screen dims whole, with no
 * ring anywhere.
 *
 * `press` is the control a tap step rings, measured with it: the cut-out
 * itself, or within it the step's `press` (✕ in the app screen). `instead`
 * is whether what a step's card says instead is on screen (TourStep.instead:
 * the plan in the chat), read with the box, so the card's words change in
 * the frame the plan arrives.
 */
export type Measured = { step: number; box: Box | null; press?: Box | null; instead?: boolean };

export function boxForStep(measured: Measured, step: number): Box | null {
  return measured.step === step ? measured.box : null;
}

export function pressForStep(measured: Measured, step: number): Box | null {
  return measured.step === step ? (measured.press ?? null) : null;
}

/** A step's cut-out and the control it rings, measured now, for step `at`. */
export function measure(at: number, step: TourStep): Measured {
  const box = stepBox(step);
  const measured: Measured = { step: at, box, press: box && step.press ? targetBox(step.press) : box };
  if (step.instead) measured.instead = document.querySelectorAll(step.instead.when).length > 0;
  return measured;
}

/** The card's words for a step: what it says instead while that is on screen. */
export function wordsFor(step: TourStep, measured: Measured, at: number): { title: string; text: string } {
  const shown = step.instead && measured.step === at && measured.instead ? step.instead : step;
  return { title: shown.title, text: shown.text };
}

/**
 * The cut-out around a target: padded, and kept inside the screen so its
 * whole ring shows. A tab on the phone's bar sits on the screen's bottom
 * edge, and its padded ring ran off it. A cut-out with no ring of its own
 * (`margin` 0) runs to the screen's edges: the whole screen, as a screen,
 * with no line of dim round it.
 */
export function holeFor(box: Box, viewport: { width: number; height: number }, margin: number = RING): Box {
  const left = Math.max(margin, box.left - PAD);
  const top = Math.max(margin, box.top - PAD);
  const right = Math.min(viewport.width - margin, box.left + box.width + PAD);
  const bottom = Math.min(viewport.height - margin, box.top + box.height + PAD);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Pure: the parts of `outer` that are not `inner`, as up to four boxes. What
 * covers a cut-out round its one pressable control, so a press anywhere else
 * in it goes nowhere. An `inner` outside it leaves all of it covered.
 */
export function aroundBox(outer: Box, inner: Box): Box[] {
  const right = outer.left + outer.width;
  const bottom = outer.top + outer.height;
  const l = Math.max(outer.left, inner.left);
  const t = Math.max(outer.top, inner.top);
  const r = Math.min(right, inner.left + inner.width);
  const b = Math.min(bottom, inner.top + inner.height);
  if (r <= l || b <= t) return [outer];
  return [
    { left: outer.left, top: outer.top, width: outer.width, height: t - outer.top },
    { left: outer.left, top: b, width: outer.width, height: bottom - b },
    { left: outer.left, top: t, width: l - outer.left, height: b - t },
    { left: r, top: t, width: right - r, height: b - t },
  ].filter((part) => part.width > 0 && part.height > 0);
}

function boxKey(b: Box | null | undefined): string {
  return b ? `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}` : '';
}

/**
 * Pure: does a target lie outside the band a step can show it in, between
 * the top bar's foot (`top`) and the foot bars' top (`bottom`)? Then it is
 * scrolled into view before it is ringed (the owner, 6 October 2026: "each
 * step scrolls its target into view"). A cut-out of a whole screen (taller
 * than the band) is a screen, not something to scroll to.
 */
export function outOfBand(box: Box, band: { top: number; bottom: number }): boolean {
  if (box.height > band.bottom - band.top) return false;
  return box.top < band.top || box.top + box.height > band.bottom;
}

/**
 * Bring a step's target into view, at once (a smooth scroll moves it under a
 * ring still following it): the first one drawn, centred, unless it is on
 * the tab bar or the top bar, which are always in view. Before that, a
 * target the screen holds back is drawn by pressing the step's `revealWith`.
 * Answers whether it is done: the target is there and in view.
 */
export function bringIntoView(step: Pick<TourStep, 'target' | 'revealWith'>, viewport: { width: number; height: number }): boolean {
  const el = (Array.from(document.querySelectorAll(step.target)) as HTMLElement[])
    .find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!el) {
    if (step.revealWith) pressTarget(step.revealWith);
    return false;
  }
  if (el.closest('#platform-tabs, #platform-header, #platform-parked')) return true;
  const header = document.getElementById('platform-header')?.getBoundingClientRect();
  const band = { top: header && header.height ? header.bottom : 0, bottom: footTop(visibleBoxes(BOTTOM_BARS), viewport) };
  const r = el.getBoundingClientRect();
  if (outOfBand({ left: r.left, top: r.top, width: r.width, height: r.height }, band)) {
    try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch { el.scrollIntoView(); }
  }
  return true;
}

/** How far a card near the foot of the screen sits above the bar there. */
const CARD_GAP = 20;

/**
 * Pure: where the foot of the screen begins, the top of the bars lying along
 * it: the phone's tab bar and the Resume strip on it, each at least half the
 * screen wide and starting in its lower half. The rail beside the screen from
 * 768px up is neither, and a screen with no bar (the app, full screen) runs
 * to its own edge: the screen's height.
 */
export function footTop(bars: Box[], viewport: { width: number; height: number }): number {
  const H = viewport.height;
  const foot = bars.filter((b) => b.width >= viewport.width / 2 && b.top > H / 2 && b.top < H);
  return foot.length ? Math.min(...foot.map((b) => b.top)) : H;
}

/**
 * The coach card's position for a target box, as inline style. It never
 * covers the tab bar: a card near the foot sits CARD_GAP above the bar (or
 * the screen's edge and its safe area, where there is no bar), including a
 * card about a tab on that bar. A card about something in the top half of
 * the screen sits under it; one about something lower down, over it.
 */
export function cardPlacement(
  box: Box | null,
  step: TourStep,
  viewport: { width: number; height: number },
  foot: number = footTop(visibleBoxes(BOTTOM_BARS), viewport),
): React.CSSProperties {
  const H = viewport.height;
  const aboveFoot: React.CSSProperties = foot < H
    ? { bottom: H - foot + CARD_GAP }
    : { bottom: `calc(${CARD_GAP}px + env(safe-area-inset-bottom, 0px))` };
  if (!box) return aboveFoot;
  if (step.place && typeof step.place === 'object') {
    const above = document.querySelector(step.place.above);
    if (above) return { bottom: H - above.getBoundingClientRect().top + 12 };
  }
  if (step.place === 'bottom' || box.height > H * 0.45) return aboveFoot;
  const middle = box.top + box.height / 2;
  if (middle >= foot) return aboveFoot;
  if (middle > H / 2) return { bottom: H - box.top + PAD + 12 };
  return { top: box.top + box.height + PAD + 12 };
}

/** The tour over the live shell (see the header); exported so a test can draw its card. */
export function Tour({ info, steps, onEnd, start = 0 }: { info: FirstSessionInfo; steps: TourStep[]; onEnd: () => void; start?: number }) {
  // A screenshot state may open it part-way (tourShot, below), on its own
  // screen; the tour itself always starts at its first card.
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, steps.length - 1)));
  const [measured, setMeasured] = useState<Measured>({ step: -1, box: null });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const step = steps[index];
  const stepRef = useRef(step);
  stepRef.current = step;
  const indexRef = useRef(index);
  indexRef.current = index;
  const box = boxForStep(measured, index);
  const pressBox = pressForStep(measured, index);

  // A new step measures its own target before it is painted, so its card
  // never shows beside the last step's cut-out (see Measured).
  useLayoutEffect(() => {
    setMeasured(measure(index, step));
  }, [index, step]);

  // Then follow the target every frame; keep it only when it moved. A frame
  // that throws (a selector the document cannot parse) must not end the
  // loop, or the ring would stay wherever it was last drawn.
  useEffect(() => {
    let raf = 0;
    let last = '';
    // The step whose target was brought into view, and how many frames it
    // has had to appear (a press of `revealWith` is tried once).
    let shown = -1;
    let tries = 0;
    let lastAt = -1;
    const tick = () => {
      try {
        const at = indexRef.current;
        if (at !== lastAt) { lastAt = at; tries = 0; }
        // Into view first, once per step, so it is ringed where it shows.
        if (shown !== at && tries < 240) {
          // `revealWith` is pressed once, half a second in: a screen still
          // drawing its target gets that long first.
          const step = stepRef.current;
          const asked = tries === 30 ? step : { target: step.target };
          if (bringIntoView(asked, { width: window.innerWidth, height: window.innerHeight })) shown = at;
          tries += 1;
        }
        // Before measuring, so the cut-out is drawn round what it shows.
        const reveal = stepRef.current.newestFromTop;
        if (reveal) showNewestFromTop(reveal);
        const m = measure(at, stepRef.current);
        // The words too: the plan coming into the chat moves no box.
        const key = `${at}:${boxKey(m.box)}:${boxKey(m.press)}:${m.instead ? 1 : 0}`;
        if (key !== last) { last = key; setMeasured(m); }
        if (window.innerWidth !== viewport.width || window.innerHeight !== viewport.height) {
          setViewport({ width: window.innerWidth, height: window.innerHeight });
        }
      } catch { /* measured again next frame */ }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewport.width, viewport.height]);

  // Opened part-way: the step's own screen, as Back would open it. Once,
  // for where it was opened; every later step opens its own in go().
  useEffect(() => {
    if (index > 0) enterScreen(steps[index].screen, info.slug, info.conversationId);
  }, []);

  // A step whose target never shows (a screen that did not open) opens its
  // screen itself after a moment.
  useEffect(() => {
    const t = window.setTimeout(() => { if (!targetBox(step.target)) enterScreen(step.screen, info.slug, info.conversationId); }, 2500);
    return () => window.clearTimeout(t);
  }, [index, step, info.slug]);

  const go = useCallback((to: number) => {
    if (to < 0) return;
    if (to >= steps.length) { onEnd(); return; }
    if (steps[to].screen !== steps[index].screen || to < index) enterScreen(steps[to].screen, info.slug, info.conversationId);
    setIndex(to);
  }, [index, steps, info.slug, onEnd]);

  // A tap step advances when its control is pressed, by a finger or by the
  // card's hint (pressTarget). The press is not intercepted: it is the
  // product's own handler that navigates.
  useEffect(() => {
    if (!step.tap) return undefined;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      const hit = Array.from(document.querySelectorAll(pressOf(step))).some((el) => el.contains(t));
      if (!hit) return;
      window.setTimeout(() => setIndex((i) => (i === index ? i + 1 : i)), 0);
      const next = steps[index + 1];
      if (step.opensNext && next) window.setTimeout(() => enterScreen(next.screen, info.slug, info.conversationId), 250);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [step, index, steps, info.slug, info.conversationId]);

  const skip = useCallback(() => {
    enterScreen(steps[steps.length - 1].screen, info.slug, info.conversationId);
    onEnd();
  }, [steps, info.slug, onEnd]);

  // A tap step rings the control that leads on: the whole cut-out, kept a
  // ring's width inside the screen, or its `press` within a wider cut-out.
  // So does a step that only points at a control (`ringed`). Any other
  // cut-out runs to the screen's edges.
  const pointed = !!(step.tap || step.ringed);
  const hole = box && holeFor(box, viewport, pointed && !step.press ? RING : 0);
  const ring = hole && pointed && pressBox ? holeFor(pressBox, viewport) : null;
  // Presses reach only a tap step's control: a step that only shows its
  // screen, or points at a control, covers all of its cut-out, and a tap
  // step all of it but the ring.
  const covers = hole ? (ring && step.tap ? aroundBox(hole, ring) : [hole]) : [];
  const card = cardPlacement(box, step, viewport);
  const words = wordsFor(step, measured, index);

  return (
    // The layer itself lets presses through: only the shades, the card and
    // the covers over the cut-out take them, so the control the step asks
    // for is pressable.
    <div data-first-session-tour={index + 1} className="pointer-events-none fixed inset-0 z-[9000]">
      {hole ? (
        <>
          <div className={SHADE} style={{ left: 0, top: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div className={SHADE} style={{ left: 0, top: hole.top + hole.height, right: 0, bottom: 0 }} />
          <div className={SHADE} style={{ left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height }} />
          <div className={SHADE} style={{ left: hole.left + hole.width, top: hole.top, right: 0, height: hole.height }} />
          {ring ? (
            <div
              aria-hidden="true"
              className="pointer-events-none fixed rounded-2xl ring-[3px] ring-[rgba(90,169,255,0.9)] motion-safe:animate-pulse"
              style={ring}
            />
          ) : null}
          {covers.map((cover, i) => <div key={i} className="pointer-events-auto fixed" style={cover} />)}
        </>
      ) : (
        <div className={`${SHADE} inset-0`} />
      )}
      <div
        role="dialog"
        aria-labelledby="first-session-tour-title"
        className="pointer-events-auto fixed left-4 right-4 mx-auto max-w-md rounded-[20px] bg-white p-4 text-zinc-900 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)] dark:bg-zinc-800 dark:text-zinc-100"
        style={card}
      >
        <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{`${index + 1} of ${steps.length}`}</p>
        <p id="first-session-tour-title" className="mt-0.5 text-[17px] font-semibold leading-snug">{words.title}</p>
        <p className="mt-1 text-[15px] leading-snug text-zinc-600 dark:text-zinc-300">{words.text}</p>
        <div className="mt-3 flex items-center justify-between gap-3">
          {step.last ? <span /> : (
            <button type="button" onClick={skip} className="py-1.5 text-[15px] font-semibold text-zinc-500 dark:text-zinc-400">Skip</button>
          )}
          <div className="flex items-center gap-2.5">
            {index > 0 ? (
              <button type="button" onClick={() => go(index - 1)} className="rounded-full bg-zinc-100 px-3.5 py-1.5 text-[15px] font-semibold text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100">Back</button>
            ) : null}
            {step.tap && !step.last ? (
              // The hint presses the control it names (pressTarget), so it
              // does what a finger on the control does. Still the blue words
              // it was: no fill, no edge, no underline, only a pressed state.
              <button
                type="button"
                data-first-session-tap=""
                onClick={() => { pressTarget(pressOf(step)); }}
                className="py-1.5 text-[13px] font-semibold text-violet-700 transition-opacity active:opacity-60 dark:text-violet-400"
              >
                {step.tap}
              </button>
            ) : (
              <Button type="button" onClick={() => go(index + 1)} variant="pillAccent" size="sm" ink="solid" className="text-[15px] font-semibold">
                {step.last ? 'Got it' : 'Next'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "You're in"'s ground: the landing's wallpaper under the wordmark, full
 * screen. Held empty (WelcomeHeld) while the invite's standing is read.
 */
function WelcomeFrame({ children, held = false }: { children: React.ReactNode; held?: boolean }) {
  return (
    <div
      role="dialog"
      aria-labelledby={held ? undefined : 'first-session-title'}
      aria-label={held ? 'Opening your invite' : undefined}
      data-first-session-welcome={held ? 'held' : ''}
      className="fixed inset-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className="flex h-[52px] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
        <Wordmark className="h-6 w-auto text-[color:var(--brand-ink)]" />
      </div>
      <div className="mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] text-center">
        {children}
      </div>
    </div>
  );
}

/** The frame while the invite's standing is read: where its words will be. */
export function WelcomeHeld() {
  return (
    <WelcomeFrame held>
      <SkeletonGroup label="Opening your invite" className="flex flex-col items-center">
        <Skeleton shape="block" className="mt-4 h-12 w-56 rounded-full" />
        <Skeleton className="mt-5 w-28" />
        <Skeleton shape="block" className="mt-4 h-8 w-64" />
        <Skeleton shape="muted" className="mt-4 w-56" />
      </SkeletonGroup>
    </WelcomeFrame>
  );
}

export function YoureIn({ info, onGo }: { info: FirstSessionInfo; onGo: (firstVersion: FirstVersionStage) => void }) {
  const user = legacy().App?.user;
  const who = user?.displayName || user?.username || '';
  const existing = !info.newAccount;
  const maker = info.inviterMadeIt && info.inviterName ? info.inviterName : null;
  // Nothing is made yet while its first version is on its way.
  const made = info.building ? 'is making' : 'made';
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => { go.current?.focus(); }, []);
  // Whether its first version is still being built, for the tour's App
  // step: the record as the App tab reads it, past the service worker's
  // cache. A read that fails leaves the step as it was.
  const stage = useRef<FirstVersionStage>(info.firstVersion ?? (info.building ? 'building' : null));
  useEffect(() => {
    let live = true;
    fetch(madeAppUrl(info.slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (live && body) stage.current = firstVersionStage(body); })
      .catch(() => {});
    return () => { live = false; };
  }, [info.slug]);
  const tile = info.iconUrl ? <img src={info.iconUrl} alt="" className="h-full w-full object-cover" /> : (info.iconEmoji || info.name.slice(0, 1));
  return (
    <WelcomeFrame>
      <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full bg-white py-1.5 pl-1.5 pr-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <span className="app-icon-tile flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-xl" aria-hidden="true">
          {tile}
        </span>
        <span className="text-[14px] font-semibold">{`You joined ${info.name}`}</span>
      </div>
      <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">
        {who ? `You're in, ${who}!` : 'You\'re in!'}
      </p>
      <h1 id="first-session-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">
        {existing ? `Welcome to ${info.name}.` : 'On Homeroom, communities make apps together.'}
      </h1>
      <p className="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">
        {existing
          ? `${maker ? `${maker} ${made} it for the group.` : 'It is the group\'s own app.'} Have a look, then say hi.`
          : 'Anyone using an app can change it. The group decides what goes in.'}
      </p>
      {existing ? null : (
        <div className="mt-6 rounded-2xl bg-white p-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
          <p className="text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">How it works</p>
          <ol className="mt-3 grid gap-2.5">
            {[
              maker ? `Someone makes an app for their group. ${maker} ${made} this one.` : 'Someone makes an app for their group.',
              'Anyone in the group can suggest an improvement. Homeroom bot builds it.',
              'The group decides what goes in.',
            ].map((line, i) => (
              <li key={line} className="flex items-start gap-2.5 text-[15px] leading-snug text-zinc-700 dark:text-zinc-200">
                <span className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-violet-600 text-[12px] font-bold text-white">{i + 1}</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <JoinedPicture slug={info.slug} name={info.name} picture={joinPicture(info.picture)} description={info.description} tile={tile} building={!!info.building} compact={!existing} />
      <div className="grow" />
      <Button
        ref={go}
        type="button"
        onClick={() => onGo(stage.current)}
        layout="full"
        variant="pillAccent"
        size="pillLg"
        ink="solidLate"
        className="mt-8 flex items-center justify-center"
      >
        {`Go to ${info.name}`}
      </Button>
    </WelcomeFrame>
  );
}

export type Mode =
  | { kind: 'none' }
  | { kind: 'held' }
  | { kind: 'welcome'; info: FirstSessionInfo }
  | { kind: 'make' }
  | { kind: 'made'; made: Made }
  | { kind: 'tour'; info: FirstSessionInfo; path: TourPath; start?: number };

export type TourPath = 'invited' | 'maker' | 'look';

/**
 * "Look around first"'s tour is about Home and the tab bar, not a project:
 * it carries no project, and every step is on Home.
 */
const LOOK_AROUND_INFO: FirstSessionInfo = { slug: '', name: '' };

/**
 * The tours' screenshot states. Only a brand-new account's first session
 * reaches a tour, so the before/after shots open one on demand (the owner's
 * ruling for first-run screens, 6 October 2026, as app-view.js draws
 * `?shot=first-version`): `?shot=tour-make`, `?shot=tour-join` and
 * `?shot=tour-look`, and `&step=N` to open it at its Nth card. Making and
 * joining are walked over the first project on the viewer's Home, and making
 * ends in their chat with Homeroom bot when they have one. Nothing is
 * written: no answer to the question, no "seen" mark.
 */
const TOUR_SHOTS: Record<string, TourPath> = { 'tour-make': 'maker', 'tour-join': 'invited', 'tour-look': 'look' };

export function tourShot(search: string): { path: TourPath; start: number } | null {
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return null; }
  const path = TOUR_SHOTS[params.get('shot') || ''];
  if (!path) return null;
  const n = Number(params.get('step'));
  return { path, start: Number.isInteger(n) && n > 1 ? n - 1 : 0 };
}

/** The first project on Home, as its card names it, once Home has drawn it. */
async function firstHomeProject(): Promise<{ slug: string; name: string } | null> {
  for (let i = 0; i < 40; i += 1) {
    const card = document.querySelector('#app-list .app-card[data-slug]');
    const slug = card?.getAttribute('data-slug');
    if (card && slug) {
      const title = card.querySelector('.app-card-title');
      return { slug, name: title?.getAttribute('title') || title?.textContent?.trim() || slug };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return null;
}

/** The viewer's chat with Homeroom bot, if they have one. */
async function botConversationId(): Promise<number | null> {
  try {
    const r = await fetch('/api/conversations', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const body = await r.json() as { conversations?: Array<{ id?: unknown; kind?: unknown; homeroomBot?: unknown }> };
    const bot = (body.conversations || []).find((c) => c.kind === 'direct' && c.homeroomBot === true);
    return Number(bot?.id) || null;
  } catch {
    return null;
  }
}

async function openTourShot(shot: { path: TourPath; start: number }, setMode: Dispatch<SetStateAction<Mode>>): Promise<void> {
  const open = (info: FirstSessionInfo) => setMode((prev) => (
    prev.kind === 'none' ? { kind: 'tour', info, path: shot.path, start: shot.start } : prev
  ));
  legacy().App?.navigateHome?.();
  if (shot.path === 'look') { open(LOOK_AROUND_INFO); return; }
  const project = await firstHomeProject();
  if (!project) return;
  const conversationId = shot.path === 'maker' ? await botConversationId() : null;
  rememberCommunity(project.slug);
  open({ ...project, conversationId });
}

// Set by the signed-out story's sheet for an account it just made
// (../auth/landing.tsx): ask it what to make once the shell has signed in.
// An account that signed in any other way (a password, a code, a provider)
// is asked through make() below instead, by the join screen it would
// otherwise have seen (../auth/communities-first-run.js). So is every later
// boot of an account that has not answered yet: the question is the
// account's to answer, not this tab's, and the flag only gets the first
// showing there a tick sooner.
const MAKE_FLAG = 'usernode:first-session:make';

export const LOOK_AROUND_PATH = '/api/me/first-session/look-around';

/**
 * The question was answered in this document: Make it made a project, or
 * "Look around first". It is not opened here again, whatever asks: the
 * verified session read can land after the answer and before the server has
 * it (a reload's snapshot boot, ../auth/communities-first-run.js).
 */
let answeredHere = false;

/**
 * Answered: the shell's copy of the account says so, and so does this
 * device's session snapshot, so the next boot does not draw the make screen
 * from it before the session is confirmed. The server's own record is Make
 * it's POST /api/apps, or recordLookAround below.
 */
export function noteAnswered(): void {
  answeredHere = true;
  const app = legacy().App;
  if (!app?.user) return;
  app.user.needsCommunitiesChoice = false;
  try { app.saveSessionSnapshot?.(app.user); } catch { /* the next boot reads the server */ }
}

/**
 * "Look around first", told to the server so the question is not asked
 * again (src/routes/onboarding.js). Fire and forget: a request that fails
 * leaves it owed, and the next boot asks it again, which is the honest
 * outcome when the answer never arrived. Never a console.error.
 */
export async function recordLookAround(): Promise<void> {
  try {
    await fetch(LOOK_AROUND_PATH, { method: 'POST', credentials: 'same-origin' });
  } catch { /* asked again on the next boot */ }
}

/**
 * Open "What do you want to make?", unless something else is already up.
 * `now` draws it before returning: asked from the signed-in shell's own
 * start (`sv:authed`, or the join step in that same tick), that is before the
 * browser paints the Home the shell has just shown, so the make screen is
 * the first thing seen after the sign-in sheet leaves. Never from a render
 * or an effect, where React cannot draw synchronously.
 */
export function openMake(setMode: Dispatch<SetStateAction<Mode>>, now: boolean): void {
  if (answeredHere) return;
  const open = () => setMode((prev) => (prev.kind === 'none' ? { kind: 'make' } : prev));
  if (now) flushSync(open);
  else open();
}

function viewerName(): string {
  const user = legacy().App?.user;
  return user?.displayName || user?.username || '';
}

export function FirstSession() {
  const [mode, setMode] = useState<Mode>({ kind: 'none' });

  // An account the story's sheet just made is asked what to make, once,
  // as soon as the shell has signed it in with access (`sv:authed` fires
  // only then; somebody still waiting is in the waiting room instead).
  useEffect(() => {
    const check = (now: boolean) => {
      let flagged = false;
      try { flagged = sessionStorage.getItem(MAKE_FLAG) === '1'; } catch { /* no make screen */ }
      if (!flagged) return;
      try { sessionStorage.removeItem(MAKE_FLAG); } catch { /* shown once anyway */ }
      openMake(setMode, now);
    };
    if (legacy().App?.user) check(false);
    const onAuthed = () => check(true);
    document.addEventListener('sv:authed', onAuthed);
    return () => document.removeEventListener('sv:authed', onAuthed);
  }, []);

  // The bridge App._followInvite calls. welcome() answers whether it will
  // show, so the caller can land the viewer the old way when it will not.
  useEffect(() => {
    const w = legacy();
    w.UsernodeReact = w.UsernodeReact || {};
    const api = {
      welcome(info: FirstSessionInfo): boolean {
        if (!info || !info.slug || seen(info.slug)) return false;
        markSeen(info.slug);
        setMode({ kind: 'welcome', info });
        return true;
      },
      // "You're in"'s frame, drawn before this returns (see the header):
      // App._followInvite asks for it in the tick the signed-in shell starts,
      // before the shell draws Home. Only over nothing: a screen already up
      // stays.
      holdWelcome(): boolean {
        let held = false;
        flushSync(() => setMode((prev) => {
          if (prev.kind !== 'none' && prev.kind !== 'held') return prev;
          held = true;
          return { kind: 'held' };
        }));
        return held;
      },
      // The follow ended some other way (the hub, a confirm, a toast): the
      // frame goes, and only the frame.
      endHold(): void {
        setMode((prev) => (prev.kind === 'held' ? { kind: 'none' } : prev));
      },
      // "What do you want to make?" for an account that is due the join
      // screen and did not come through the story's sheet, and for any
      // account still due it on a later boot. Nothing else is open by the
      // time the join screen's turn comes, and if the story's own flag got
      // there first this leaves its screen as it is.
      make(): boolean {
        try { sessionStorage.removeItem(MAKE_FLAG); } catch { /* shown once anyway */ }
        openMake(setMode, true);
        return true;
      },
      // A make screen drawn from the session snapshot, for an account the
      // confirmed session says is no longer due it (answered on another
      // device, say). Only that screen: once Make it has made something,
      // what follows it stays.
      dismissMake(): void {
        setMode((prev) => (prev.kind === 'make' ? { kind: 'none' } : prev));
      },
    };
    w.UsernodeReact.firstSession = api;
    return () => { if (w.UsernodeReact?.firstSession === api) delete w.UsernodeReact.firstSession; };
  }, []);

  // A tour's screenshot state (tourShot): once, as soon as the shell is
  // signed in.
  useEffect(() => {
    const shot = tourShot(window.location.search);
    if (!shot) return undefined;
    let opened = false;
    const open = () => {
      if (opened || !legacy().App?.user) return;
      opened = true;
      void openTourShot(shot, setMode);
    };
    open();
    document.addEventListener('sv:authed', open);
    return () => document.removeEventListener('sv:authed', open);
  }, []);

  const end = useCallback(() => setMode({ kind: 'none' }), []);
  const steps = useMemo(() => {
    if (mode.kind !== 'tour') return [];
    if (mode.path === 'look') return lookAroundSteps();
    const project = { slug: mode.info.slug, name: mode.info.name, conversationId: mode.info.conversationId };
    return mode.path === 'maker' ? makerSteps(project) : invitedSteps(project);
  }, [mode]);

  if (mode.kind === 'make') {
    return (
      <MakeScreen
        who={viewerName()}
        // POST /api/apps answered the question as it made the project.
        onMade={(made) => { noteAnswered(); setMode({ kind: 'made', made }); }}
        // Home, and its own short tour of where things are (decision E).
        onLookAround={() => {
          noteAnswered();
          void recordLookAround();
          legacy().App?.navigateHome?.();
          setMode({ kind: 'tour', info: LOOK_AROUND_INFO, path: 'look' });
        }}
      />
    );
  }
  if (mode.kind === 'made') {
    const { made } = mode;
    return (
      <MadeScreen
        made={made}
        me={viewerName()}
        onContinue={() => {
          const info = { slug: made.slug, name: made.name, iconEmoji: made.emoji, conversationId: made.conversationId };
          markSeen(made.slug);
          rememberCommunity(made.slug);
          enterScreen('home', made.slug);
          setMode({ kind: 'tour', info, path: 'maker' });
        }}
        // The plan is answered in the chat with Homeroom bot: the first
        // session ends there, with no tour over it.
        onOpenChat={(conversationId) => {
          markSeen(made.slug);
          rememberCommunity(made.slug);
          setMode({ kind: 'none' });
          enterScreen('bot', made.slug, conversationId);
        }}
      />
    );
  }

  if (mode.kind === 'welcome') {
    return (
      <YoureIn
        info={mode.info}
        onGo={(firstVersion) => {
          rememberCommunity(mode.info.slug);
          enterScreen('home', mode.info.slug);
          setMode({ kind: 'tour', info: { ...mode.info, firstVersion }, path: 'invited' });
        }}
      />
    );
  }
  if (mode.kind === 'held') return <WelcomeHeld />;
  if (mode.kind === 'tour') return <Tour info={mode.info} steps={steps} onEnd={end} start={mode.start} />;
  return null;
}
