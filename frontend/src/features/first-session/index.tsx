/**
 * The first session after an invite: "You're in", then a short tour on the
 * real screens.
 *
 *   welcome  A full-screen card on the landing's wallpaper: you joined this
 *            group, and — for an account the invite's own sign-up made — what
 *            Homeroom is, in three lines. "Go to <name>" starts the tour.
 *   tour     ./tour-steps.ts, over the live shell. Each screen is shown whole
 *            first, then the control that leads on is cut out of the dim and
 *            the reader presses it: the product's own handler navigates, and
 *            the tour only watches the press. Back re-opens the screen the
 *            previous step was on; Skip ends on the last step's screen.
 *
 * App.\_followInvite (public/js/app.js) opens it through
 * `window.UsernodeReact.firstSession.welcome(info)`, once per account and
 * project (localStorage), when the invite link it is following has just
 * joined the viewer. It answers false when it will not show, and the caller
 * lands them on the hub the way it always did.
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Wordmark } from '@/components/ui/wordmark';

import { type Made, MakeScreen } from './make';
import { MadeScreen } from './made';
import { invitedSteps, makerSteps, type TourScreen, type TourStep } from './tour-steps';

export type FirstSessionInfo = {
  slug: string;
  /** Homeroom bot's chat with the viewer, when it builds this project for them. */
  conversationId?: number | null;
  name: string;
  iconEmoji?: string | null;
  iconUrl?: string | null;
  inviterName?: string | null;
  inviterMadeIt?: boolean;
  /** The account was made by the sign-up the link opened. */
  newAccount?: boolean;
};

type Legacy = {
  App?: {
    user?: { id?: number; username?: string; displayName?: string | null } | null;
    navigateHome?: (opts?: unknown) => void;
    navigateToApp?: (slug: string, tab: string) => unknown;
    openDiscussionInHub?: (slug: string) => void;
    _WORKSHOP_VIEW_KEY?: string;
    _workshopViewPath?: (url: string) => string | null;
    _publishCommunityScope?: (slug: string | null) => void;
  };
  AppView?: { _landOnHub?: (slug: string) => void };
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

/** The visible elements a selector list names, drawn as one box, or null. */
export function targetBox(selectors: string): Box | null {
  const rects = Array.from(document.querySelectorAll(selectors))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

const PAD = 6;
/** The ring's width (`ring-[3px]` below), kept on screen around a hole. */
const RING = 3;
const SHADE = 'pointer-events-auto fixed bg-[rgba(9,9,12,0.6)] transition-all duration-200';

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
 */
export type Measured = { step: number; box: Box | null };

export function boxForStep(measured: Measured, step: number): Box | null {
  return measured.step === step ? measured.box : null;
}

/**
 * The cut-out around a target: padded, and kept inside the screen so its
 * whole ring shows. A tab on the phone's bar sits on the screen's bottom
 * edge, and its padded ring ran off it.
 */
export function holeFor(box: Box, viewport: { width: number; height: number }): Box {
  const left = Math.max(RING, box.left - PAD);
  const top = Math.max(RING, box.top - PAD);
  const right = Math.min(viewport.width - RING, box.left + box.width + PAD);
  const bottom = Math.min(viewport.height - RING, box.top + box.height + PAD);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function boxKey(b: Box | null): string {
  return b ? `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}` : '';
}

/** The coach card's position for a target box, as inline style. */
export function cardPlacement(box: Box | null, step: TourStep, viewport: { width: number; height: number }): React.CSSProperties {
  const H = viewport.height;
  const tabs = document.getElementById('platform-tabs');
  const tabsTop = tabs && tabs.getBoundingClientRect().height ? tabs.getBoundingClientRect().top : H;
  if (!box) return { bottom: H - tabsTop + 16 };
  if (step.place && typeof step.place === 'object') {
    const above = document.querySelector(step.place.above);
    if (above) return { bottom: H - above.getBoundingClientRect().top + 12 };
  }
  if (step.place === 'bottom') return { bottom: H - tabsTop + 16 };
  if (box.height > H * 0.45) return { bottom: Math.max(16, H - (box.top + box.height) + 20) };
  if (box.top + box.height / 2 > H / 2) return { bottom: H - box.top + PAD + 12 };
  return { top: box.top + box.height + PAD + 12 };
}

function Tour({ info, steps, onEnd }: { info: FirstSessionInfo; steps: TourStep[]; onEnd: () => void }) {
  const [index, setIndex] = useState(0);
  const [measured, setMeasured] = useState<Measured>({ step: -1, box: null });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const step = steps[index];
  const stepRef = useRef(step);
  stepRef.current = step;
  const indexRef = useRef(index);
  indexRef.current = index;
  const box = boxForStep(measured, index);

  // A new step measures its own target before it is painted, so its card
  // never shows beside the last step's cut-out (see Measured).
  useLayoutEffect(() => {
    setMeasured({ step: index, box: targetBox(step.target) });
  }, [index, step.target]);

  // Then follow the target every frame; keep it only when it moved. A frame
  // that throws (a selector the document cannot parse) must not end the
  // loop, or the ring would stay wherever it was last drawn.
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      try {
        const at = indexRef.current;
        const b = targetBox(stepRef.current.target);
        const key = `${at}:${boxKey(b)}`;
        if (key !== last) { last = key; setMeasured({ step: at, box: b }); }
        if (window.innerWidth !== viewport.width || window.innerHeight !== viewport.height) {
          setViewport({ width: window.innerWidth, height: window.innerHeight });
        }
      } catch { /* measured again next frame */ }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewport.width, viewport.height]);

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

  // A tap step advances when its target is pressed. The press is not
  // intercepted: it is the product's own handler that navigates.
  useEffect(() => {
    if (!step.tap) return undefined;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      const hit = Array.from(document.querySelectorAll(step.target)).some((el) => el.contains(t));
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

  const hole = box && holeFor(box, viewport);
  const card = cardPlacement(box, step, viewport);

  return (
    // The layer itself lets presses through: only the shades, the card and
    // (on a step that only shows its screen) the cover over the cut-out
    // take them, so the cut-out's own control is pressable.
    <div data-first-session-tour={index + 1} className="pointer-events-none fixed inset-0 z-[9000]">
      {hole ? (
        <>
          <div className={SHADE} style={{ left: 0, top: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div className={SHADE} style={{ left: 0, top: hole.top + hole.height, right: 0, bottom: 0 }} />
          <div className={SHADE} style={{ left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height }} />
          <div className={SHADE} style={{ left: hole.left + hole.width, top: hole.top, right: 0, height: hole.height }} />
          <div
            aria-hidden="true"
            className={`fixed rounded-2xl ${step.tap ? 'pointer-events-none ring-[3px] ring-[rgba(90,169,255,0.9)] motion-safe:animate-pulse' : ''}`}
            style={hole}
          />
          {/* A step that only shows its screen keeps it from being pressed. */}
          {step.tap ? null : <div className="pointer-events-auto fixed" style={hole} />}
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
        <p id="first-session-tour-title" className="mt-0.5 text-[17px] font-semibold leading-snug">{step.title}</p>
        <p className="mt-1 text-[15px] leading-snug text-zinc-600 dark:text-zinc-300">{step.text}</p>
        <div className="mt-3 flex items-center justify-between gap-3">
          {step.last ? <span /> : (
            <button type="button" onClick={skip} className="py-1.5 text-[15px] font-semibold text-zinc-500 dark:text-zinc-400">Skip</button>
          )}
          <div className="flex items-center gap-2.5">
            {index > 0 ? (
              <button type="button" onClick={() => go(index - 1)} className="rounded-full bg-zinc-100 px-3.5 py-1.5 text-[15px] font-semibold text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100">Back</button>
            ) : null}
            {step.tap && !step.last ? (
              <span className="text-[13px] font-semibold text-violet-700 dark:text-violet-400">{step.tap}</span>
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

function YoureIn({ info, onGo }: { info: FirstSessionInfo; onGo: () => void }) {
  const user = legacy().App?.user;
  const who = user?.displayName || user?.username || '';
  const existing = !info.newAccount;
  const maker = info.inviterMadeIt && info.inviterName ? info.inviterName : null;
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => { go.current?.focus(); }, []);
  return (
    <div
      role="dialog"
      aria-labelledby="first-session-title"
      data-first-session-welcome=""
      className="fixed inset-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className="flex h-[52px] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
        <Wordmark className="h-6 w-auto text-[color:var(--brand-ink)]" />
      </div>
      <div className="mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] text-center">
        <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full bg-white py-1.5 pl-1.5 pr-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
          <span className="app-icon-tile flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-xl" aria-hidden="true">
            {info.iconUrl ? <img src={info.iconUrl} alt="" className="h-full w-full object-cover" /> : (info.iconEmoji || info.name.slice(0, 1))}
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
            ? `${maker ? `${maker} made it for the group.` : 'It is the group\'s own app.'} Have a look, then say hi.`
            : 'Anyone using an app can change it. The group decides what goes in.'}
        </p>
        {existing ? null : (
          <div className="mt-6 rounded-2xl bg-white p-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
            <p className="text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">How it works</p>
            <ol className="mt-3 grid gap-2.5">
              {[
                maker ? `Someone makes an app for their group. ${maker} made this one.` : 'Someone makes an app for their group.',
                'Anyone in the group can ask for a change. Homeroom bot builds it.',
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
        <div className="grow" />
        <Button
          ref={go}
          type="button"
          onClick={onGo}
          layout="full"
          variant="pillAccent"
          size="pillLg"
          ink="solidLate"
          className="mt-8 flex items-center justify-center"
        >
          {`Go to ${info.name}`}
        </Button>
      </div>
    </div>
  );
}

type Mode =
  | { kind: 'none' }
  | { kind: 'welcome'; info: FirstSessionInfo }
  | { kind: 'make' }
  | { kind: 'made'; made: Made }
  | { kind: 'tour'; info: FirstSessionInfo; path: 'invited' | 'maker' };

// Set by the signed-out story's sheet for an account it just made
// (../auth/landing.tsx): ask it what to make once the shell has signed in.
// An account that signed in any other way (a password, a code, a provider)
// is asked through make() below instead, by the join screen it would
// otherwise have seen (../auth/communities-first-run.js).
const MAKE_FLAG = 'usernode:first-session:make';

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
    const check = () => {
      let flagged = false;
      try { flagged = sessionStorage.getItem(MAKE_FLAG) === '1'; } catch { /* no make screen */ }
      if (!flagged) return;
      try { sessionStorage.removeItem(MAKE_FLAG); } catch { /* shown once anyway */ }
      setMode((prev) => (prev.kind === 'none' ? { kind: 'make' } : prev));
    };
    if (legacy().App?.user) check();
    document.addEventListener('sv:authed', check);
    return () => document.removeEventListener('sv:authed', check);
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
      // "What do you want to make?" for an account that is due the join
      // screen and did not come through the story's sheet. Nothing else is
      // open by the time the join screen's turn comes, and if the story's
      // own flag got there first this leaves its screen as it is.
      make(): boolean {
        try { sessionStorage.removeItem(MAKE_FLAG); } catch { /* shown once anyway */ }
        setMode((prev) => (prev.kind === 'none' ? { kind: 'make' } : prev));
        return true;
      },
    };
    w.UsernodeReact.firstSession = api;
    return () => { if (w.UsernodeReact?.firstSession === api) delete w.UsernodeReact.firstSession; };
  }, []);

  const end = useCallback(() => setMode({ kind: 'none' }), []);
  const steps = useMemo(() => {
    if (mode.kind !== 'tour') return [];
    const project = { slug: mode.info.slug, name: mode.info.name, conversationId: mode.info.conversationId };
    return mode.path === 'maker' ? makerSteps(project) : invitedSteps(project);
  }, [mode]);

  if (mode.kind === 'make') {
    return (
      <MakeScreen
        who={viewerName()}
        onMade={(made) => setMode({ kind: 'made', made })}
        onLookAround={() => { setMode({ kind: 'none' }); legacy().App?.navigateHome?.(); }}
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
      />
    );
  }

  if (mode.kind === 'welcome') {
    return (
      <YoureIn
        info={mode.info}
        onGo={() => {
          rememberCommunity(mode.info.slug);
          enterScreen('home', mode.info.slug);
          setMode({ kind: 'tour', info: mode.info, path: 'invited' });
        }}
      />
    );
  }
  if (mode.kind === 'tour') return <Tour info={mode.info} steps={steps} onEnd={end} />;
  return null;
}
