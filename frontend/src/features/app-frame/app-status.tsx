/**
 * `#app-content`'s placeholder states — what the App tab shows when there is
 * no running app to frame.
 *
 * Five of them: spinning up, awaiting secrets, failed to start, not
 * available, and offline-with-no-app-worker. `renderAppTab` built each as an
 * `innerHTML` string and then bound two buttons by id afterwards, because
 * the branch re-renders on every status change and a delegated listener
 * would have re-attached. A sixth since #15: the first version, being built
 * by the Homeroom bot from the project's description. Since #4053 that is
 * the project's thumbnail (features/first-session/sketch-card.tsx) with its
 * build line one line under it, and "It opens here when it’s ready." below that
 * (its maker reads "We’ll notify you when it’s live", with a check, run six):
 * no plan, no step count, nothing to press (#4043); a member who is not its
 * maker gets a "While you wait" card under it (#4396, ./waiting-card.tsx).
 * For its members the thumbnail's band shows the first look, then its real
 * screens, and the build line says what it is adding (#4387,
 * ./first-version-screens.tsx).
 * Once that version is
 * built and up for approval, the same thumbnail says Ready to try, and the
 * screen says what it waits on, with Try it and See the change. If its build
 * stopped (14 Oct 2026, newcomer run eight), the thumbnail stays, its line
 * says Stopped, and its maker gets Try again (the build's thread in their
 * chat with Homeroom bot), never the starter template the repo was made from.
 *
 * ── Why this can own `#app-content` ────────────────────────────────────
 *
 * That host is SHARED: the four Dev sub-views mount their own frames into
 * it, and `showLaunchCoverShot` still writes it by hand. It is single-owner
 * anyway, at the boundary rather than at a node inside it — every path into
 * `#app-content` runs `_teardownDevRoots()` first, exactly the way
 * `AdminConsole._renderSection` tears the previous section down before
 * mounting the next. The ownership audit's entry is scoped with `when` for
 * the same reason.
 *
 * ── What is NOT here ───────────────────────────────────────────────────
 *
 * The launch cover (`showLaunchCoverShot`) stays a string builder: it is the
 * one launch surface with no app behind it, `_launchCoverHtml` has four
 * other callers, and `insertAdjacentHTML`-ing a cover BESIDE a live iframe
 * is the whole point of that path — the frame must survive.
 */

import { Suspense, lazy, useCallback, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { CheckIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { type BuildLineState, buildLineOf, phaseLine, useNow } from '../first-session/build-line';
import { stepsOf } from '../first-session/build-line-words.js';
import { useLookSwap } from '../first-session/drawn-look';
import { useTourRunning } from '../first-session/tour-running';
import { FeaturedCard, sketching, useSketch } from '../first-session/sketch-card';
import { appStatusStore } from './app-status-store.js';
import { type FirstVersionEstimate, countsDown, estimateOf, leftNote, plainLineNote } from './first-version-eta';
import { type FirstVersionScreens, ScreensBand, hasScreens } from './first-version-screens';
import { FirstVersionSteps } from './first-version-steps';
import { type FirstVersionLive, LiveSwitch, useLiveChoice } from './live-switch';
import { type FirstVersionWaiting, WaitingCard, lineNote } from './waiting-card';

// #4449: Live's player (rrweb) is loaded only once Live is shown.
const LiveBand = lazy(() => import('./live-band'));

/** The resolved placeholder. `null` means some other owner has the host. */
export interface AppStatusView {
  /** `creating` and `awaiting` share the amber dot; `error` gets the red one. */
  dot: 'creating' | 'error' | null;
  message: string;
  /** The missing secret names, or the failure reason — one mono red line. */
  detail: string | null;
  /**
   * Plain lines under the message, which then reads as the screen's title,
   * or under the thumbnail (#15: what comes next).
   */
  lines?: string[];
  /**
   * #4053: the project whose first version is on its way, drawn as its
   * thumbnail in place of the message, with `buildLine` one line under it.
   */
  thumb?: FirstVersionThumb | null;
  /** None: no line (a screen that cannot know the step). */
  buildLine?: BuildLineState | null;
  /**
   * #4387: what the build is adding now ("Adding the tier rows"), the build
   * line's note while it is built, in place of "usually 10 to 25 min".
   */
  buildNote?: string | null;
  /**
   * #4387: the first look, or the real screens, the thumbnail's colour band
   * shows in place of its icon (./first-version-screens.tsx).
   */
  screens?: FirstVersionScreens | null;
  /**
   * #4449: Live, offered to a member while it is built ("Building it"),
   * once its watcher has a frame to show (N6): the band's "Preview | Live"
   * switch (./live-switch.tsx). N7: with `last`, at "Testing it" and
   * "Ready to try" without real screens, the build's last frame, no switch.
   */
  live?: FirstVersionLive | null;
  /**
   * N4: the stage it is at by its own name, with when it began
   * (`first_version.phase`), said on the build line while it is built
   * ("Working out the details · 2 min so far").
   */
  phase?: unknown;
  /** N4: every step, done, under way or to come (./first-version-steps.tsx). */
  steps?: unknown;
  /**
   * Run six: how long it still has to go (`first_version.estimate`,
   * ./first-version-eta.ts), said on the build line ("Building it · about
   * 15 min left") and under the step under way, in place of the time so far.
   */
  estimate?: unknown;
  /**
   * Run six: its maker's promise under the card, with a small check: "We’ll
   * notify you when it’s live", in place of the lines.
   */
  promise?: string | null;
  /**
   * The lines say what a first-session tour card can say over this screen
   * ("It opens here when it’s ready."), so they hide while a card that says
   * it is on the page: one that carries `data-tour-says-where-it-opens`. A
   * tour card that does not say it leaves the line in place.
   */
  tourSays?: boolean;
  /**
   * At most one, and only for a viewer who can act on it. `botChat` opens
   * the viewer's DM with the Homeroom bot (#15), by its id when known. "Review the
   * plan" while their plan waits, "Open Homeroom bot" (`quiet`) while it
   * builds, "Open my chat with Homeroom bot" once it is ready to try.
   * `tryChange` and `seeChange` are a first version that is ready to try:
   * its change's preview and its change page, by the change's id.
   * `botThread` (14 Oct 2026) is a stopped first version's Try again: the
   * build's thread in its maker's chat with Homeroom bot, by the
   * conversation, the thread's root and the message that said it stopped.
   */
  action: {
    key: 'secrets' | 'buildLog' | 'botChat' | 'botThread' | 'tryChange' | 'seeChange';
    label: string;
    slug: string;
    conversationId?: number | null;
    threadRootId?: number | null;
    messageId?: number | null;
    sessionId?: number | null;
    /** A small secondary button, not the screen's one primary action. */
    quiet?: boolean;
    /** Drawn right under the thumbnail and its build line, ahead of the lines. */
    underCard?: boolean;
  } | null;
  /** A second way on, beside the action (a first version's change page, under Try it). */
  alt?: { key: 'seeChange'; label: string; slug: string; sessionId: number } | null;
  /**
   * #4396: "While you wait", for a member who is not the maker of a first
   * version that is not ready yet (AppView._firstVersionWaiting): a card
   * under the thumbnail, ahead of the lines (./waiting-card.tsx).
   */
  waiting?: FirstVersionWaiting | null;
}

/** What the thumbnail is drawn from: the project's record (AppView.appData). */
export interface FirstVersionThumb {
  name: string;
  slug: string;
  emoji: string | null;
  /** Its description, said until (or unless) the sketch has a tagline. */
  description: string | null;
  /** False for a made-up project (`?shot=first-version`): no sketch to read. */
  sketch?: boolean;
}

/** The band's first picture, what useLookSwap waits on. */
const firstImage = (screens: FirstVersionScreens): string | null => (Array.isArray(screens.images) && screens.images[0]) || null;

/**
 * The project's thumbnail, with its sketch's tagline once that is read
 * (GET /api/apps/:slug/sketch, as the made screen reads it), else its
 * description.
 */
function FirstVersionCard({ thumb, line, caption = null, usual = null, estimate = null, screens = null, live = null, phase = null, listed = false }: {
  thumb: FirstVersionThumb;
  line: BuildLineState | null;
  /** What the build is adding now ("Adding the tier rows"), while it builds. */
  caption?: string | null;
  /** How long it usually takes (a member's "usually 10 to 25 min"), said without an estimate. */
  usual?: string | null;
  /** Run six: how long it still has to go. */
  estimate?: FirstVersionEstimate | null;
  screens?: FirstVersionScreens | null;
  live?: FirstVersionLive | null;
  /** N4: the stage by its own name (`first_version.phase`). */
  phase?: unknown;
  /** N4: the steps are listed under it, the build's phrase with them. */
  listed?: boolean;
}): ReactNode {
  // N4: "Working out the details · 2 min so far", in place of "Building it";
  // run six: "· about 15 min left" when there is an estimate.
  const now = useNow();
  const left = countsDown(line) ? leftNote(estimate, now) : null;
  const named = phaseLine(line, phase, now, listed ? null : caption, left);
  const sketch = useSketch(thumb.sketch === false ? null : thumb.slug);
  const card = sketch.card;
  // 15 Oct 2026: a first look that is only drawn so far stays until the
  // picture that follows it is loaded (../first-session/drawn-look.tsx).
  const steady = useLookSwap(screens ?? null, firstImage);
  // Pictures that would not load leave the thumbnail as it was, until there
  // are others to show (the real screens after a first look, say).
  const shownKey = hasScreens(steady) ? `${steady.kind} ${steady.images.join(' ')}` : '';
  const [emptyKey, setEmptyKey] = useState<string | null>(null);
  const onEmpty = useCallback(() => setEmptyKey(shownKey), [shownKey]);
  const shows = hasScreens(steady) && emptyKey !== shownKey ? steady : null;
  // #4449: while it is built, Preview (the above) or Live, Live unless
  // Preview was picked for this project (run six). At "Testing it" the
  // switch goes, and the real screens show;
  // N7: without them, the build's last frame stays (`live.last`), rather
  // than the first look drawn from the plan. The same LiveBand stays
  // mounted from one to the other, so the frame does not start over.
  const lastFrame = !!live && !!live.last && (line === 'testing' || line === 'ready');
  const liveOffered = !!live && !live.last && line === 'building';
  // Run six: Live, once offered (it has frames), unless Preview was picked
  // for this project.
  const [choice, choose] = useLiveChoice(liveOffered ? live.userKey : null, liveOffered ? live.slug : null);
  const watching = (liveOffered && choice === 'live') || lastFrame;
  const preview = shows ? <ScreensBand key={shownKey} screens={shows} name={thumb.name} onEmpty={onEmpty} /> : null;
  const band = watching && live ? (
    <Suspense fallback={preview}>
      <LiveBand key={live.slug} live={live} firstLook={shows && shows.kind === 'first_look' ? shows : null} name={thumb.name} />
    </Suspense>
  ) : preview;
  return (
    <div className="w-full max-w-[342px]" data-app-first-version={line || ''}>
      <FeaturedCard
        name={thumb.name}
        colorKey={thumb.slug}
        emoji={card?.emoji || thumb.emoji}
        card={card}
        description={thumb.description}
        sketching={!card && !thumb.description && sketching(sketch.state)}
        line={line}
        lineNote={named.words ? named.note : plainLineNote(caption, usual, left)}
        lineWords={named.words}
        band={band}
        bandCorner={liveOffered ? <LiveSwitch value={choice} onChange={choose} /> : null}
      />
    </div>
  );
}

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/** Each action's id (the declared checks select on the first two) and its opener on AppView. */
const ACTIONS = {
  secrets: { id: 'awaiting-open-secrets', opener: 'openAwaitingSecrets' },
  buildLog: { id: 'app-error-build-log', opener: 'openAppBuildLog' },
  botChat: { id: 'app-first-version-chat', opener: 'openBotChat' },
  botThread: { id: 'app-first-version-retry', opener: 'openFirstVersionThread' },
  tryChange: { id: 'app-first-version-try', opener: 'tryFirstVersion' },
  seeChange: { id: 'app-first-version-change', opener: 'openFirstVersionChange' },
} as const;

type StatusAction = NonNullable<AppStatusView['action']> | NonNullable<AppStatusView['alt']>;

/** Its opener, with what it opens: a change by its id, the build's thread, else the DM by its id (or nothing). */
function press(action: StatusAction): void {
  const { opener } = ACTIONS[action.key];
  if (action.key === 'tryChange' || action.key === 'seeChange') call(opener, action.slug, action.sessionId ?? null);
  else if (action.key === 'botThread') {
    call(opener, action.slug, action.conversationId ?? null, action.threadRootId ?? null, action.messageId ?? null);
  } else call(opener, action.slug, action.conversationId ?? null);
}

const LINE = 'max-w-sm text-sm';
const THUMB_LINE = 'max-w-sm pt-1 text-[15px] leading-5';
// Hidden while a tour card that says where the app opens is on the page.
const THUMB_LINE_TOUR_SAYS = 'max-w-sm pt-1 text-[15px] leading-5 [body:has([data-tour-says-where-it-opens])_&]:hidden';

function actionButton(action: NonNullable<AppStatusView['action']>): ReactNode {
  // "Open Homeroom bot": the creator's small, quiet way into the chat while
  // the first version builds, under the thumbnail and its build line.
  if (action.quiet) {
    return (
      <Button id={ACTIONS[action.key].id} variant="pillRaised" size="sm" ink="accent" className="min-h-9" onClick={() => press(action)}>
        {action.label}
      </Button>
    );
  }
  return (
    <Button id={ACTIONS[action.key].id} className={action.underCard ? 'mt-1' : 'mt-3'} onClick={() => press(action)}>
      {action.label}
    </Button>
  );
}

/**
 * While the first-session tour runs (../first-session/tour-running.ts),
 * which asks for nothing but its own cards, a plan waiting on its maker shows no
 * "Review the plan" here, and its line says the bot is working on it. Every
 * other screen, and this one once the tour ends, is as AppView answers it.
 */
export function heldForTour(view: AppStatusView, touring: boolean): AppStatusView {
  if (!touring || !view.thumb || buildLineOf(view.buildLine) !== 'plan') return view;
  return {
    ...view,
    buildLine: 'working',
    action: view.action && view.action.key === 'botChat' ? null : view.action,
  };
}

export function AppStatusView_({ view: answered }: { view: AppStatusView }): ReactNode {
  const view = heldForTour(answered, useTourRunning());
  const action = view.action;
  const titled = !!view.lines?.length;
  const thumb = view.thumb || null;
  const line = view.buildLine === 'working' ? 'working' : buildLineOf(view.buildLine);
  const waiting = thumb && view.waiting ? view.waiting : null;
  // N4: the steps, while it is made (never once it is ready to try, nor
  // once its build stopped: nothing is under way).
  const steps = thumb && line !== 'ready' && line !== 'live' && line !== 'stopped' && stepsOf(view.steps).length ? view.steps : null;
  const estimate = thumb && countsDown(line) ? estimateOf(view.estimate) : null;
  const caption = line === 'building' ? view.buildNote || null : null;
  const body = (
    <>
      {view.dot ? <div className={`status-dot ${view.dot}`}></div> : null}
      {thumb ? (
        <FirstVersionCard
          key={thumb.slug}
          thumb={thumb}
          line={line}
          caption={caption}
          usual={waiting ? lineNote(line) : null}
          estimate={estimate}
          screens={view.screens || null}
          live={view.live || null}
          phase={view.phase || null}
          listed={!!steps}
        />
      ) : (
        <p className={titled ? 'max-w-sm text-base font-semibold text-zinc-900 dark:text-zinc-100' : 'text-sm'}>{view.message}</p>
      )}
      {action && action.underCard ? actionButton(action) : null}
      {steps ? <FirstVersionSteps steps={steps} phase={view.phase || null} caption={caption} estimate={estimate} /> : null}
      {waiting ? <WaitingCard waiting={waiting} line={line} /> : null}
      {titled ? view.lines!.map((line) => (
        <p
          key={line}
          {...(view.tourSays ? { 'data-app-first-version-note': '' } : {})}
          className={!thumb ? LINE : view.tourSays ? THUMB_LINE_TOUR_SAYS : THUMB_LINE}
        >
          {line}
        </p>
      )) : null}
      {thumb && view.promise ? (
        <p data-app-first-version-promise="" className="flex max-w-sm items-center justify-center gap-1.5 pt-1 text-[15px] leading-5">
          <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{view.promise}</span>
        </p>
      ) : null}
      {view.detail ? (
        <p className="text-xs font-mono text-red-700 max-w-md break-words dark:text-red-400">{view.detail}</p>
      ) : null}
      {action && !action.underCard ? actionButton(action) : null}
      {view.alt ? (
        <Button id={ACTIONS[view.alt.key].id} variant="neutral" ink="neutral" onClick={() => press(view.alt!)}>
          {view.alt.label}
        </Button>
      ) : null}
    </>
  );
  // With the card the screen can be taller than the frame: it scrolls, and
  // is centred while it fits (my-auto on the column inside). So with the
  // steps listed.
  if (waiting || steps) {
    return (
      <div className="flex flex-col items-center h-full overflow-y-auto text-zinc-500 dark:text-zinc-400 p-4 text-center">
        <div className="my-auto flex w-full flex-col items-center gap-2">{body}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 gap-2 p-4 text-center">
      {body}
    </div>
  );
}

export function AppStatus(): ReactNode {
  const { view } = useStoreState<{ view: AppStatusView | null }>(appStatusStore);
  return view ? <AppStatusView_ view={view} /> : null;
}
