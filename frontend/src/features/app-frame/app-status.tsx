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
 * build line one line under it, and "It opens here when it’s ready." below that:
 * no plan and no step count (#4043), the maker's way into their chat, and
 * a member's "Say hi in Discussion" (#4396). Once that version is
 * built and up for approval, the same thumbnail says Ready to try, and the
 * screen says what it waits on, with Try it and See the change.
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

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { type BuildLineState, buildLineOf } from '../first-session/build-line';
import { useTourRunning } from '../first-session/tour-running';
import { FeaturedCard, sketching, useSketch } from '../first-session/sketch-card';
import { appStatusStore } from './app-status-store.js';

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
   * `discussion` is the project's Discussion tab, for a member who is not
   * the maker, while the first version builds (#4396).
   * `tryChange` and `seeChange` are a first version that is ready to try:
   * its change's preview and its change page, by the change's id.
   */
  action: {
    key: 'secrets' | 'buildLog' | 'botChat' | 'discussion' | 'tryChange' | 'seeChange';
    label: string;
    slug: string;
    conversationId?: number | null;
    sessionId?: number | null;
    /** A small secondary button, not the screen's one primary action. */
    quiet?: boolean;
    /** Drawn right under the thumbnail and its build line, ahead of the lines. */
    underCard?: boolean;
  } | null;
  /** A second way on, beside the action (a first version's change page, under Try it). */
  alt?: { key: 'seeChange'; label: string; slug: string; sessionId: number } | null;
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

/**
 * The project's thumbnail, with its sketch's tagline once that is read
 * (GET /api/apps/:slug/sketch, as the made screen reads it), else its
 * description.
 */
function FirstVersionCard({ thumb, line }: { thumb: FirstVersionThumb; line: BuildLineState | null }): ReactNode {
  const sketch = useSketch(thumb.sketch === false ? null : thumb.slug);
  const card = sketch.card;
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
  discussion: { id: 'app-first-version-discussion', opener: 'openFirstVersionDiscussion' },
  tryChange: { id: 'app-first-version-try', opener: 'tryFirstVersion' },
  seeChange: { id: 'app-first-version-change', opener: 'openFirstVersionChange' },
} as const;

type StatusAction = NonNullable<AppStatusView['action']> | NonNullable<AppStatusView['alt']>;

/** Its opener, with what it opens: a change by its id, else the DM by its id (or nothing). */
function press(action: StatusAction): void {
  const { opener } = ACTIONS[action.key];
  if (action.key === 'tryChange' || action.key === 'seeChange') call(opener, action.slug, action.sessionId ?? null);
  else call(opener, action.slug, action.conversationId ?? null);
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
 * While the first-session tour runs, its last card is what names the plan
 * (../first-session/tour-running.ts): a plan waiting on its maker shows no
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
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 gap-2 p-4 text-center">
      {view.dot ? <div className={`status-dot ${view.dot}`}></div> : null}
      {thumb ? (
        <FirstVersionCard key={thumb.slug} thumb={thumb} line={view.buildLine === 'working' ? 'working' : buildLineOf(view.buildLine)} />
      ) : (
        <p className={titled ? 'max-w-sm text-base font-semibold text-zinc-900 dark:text-zinc-100' : 'text-sm'}>{view.message}</p>
      )}
      {action && action.underCard ? actionButton(action) : null}
      {titled ? view.lines!.map((line) => (
        <p
          key={line}
          {...(view.tourSays ? { 'data-app-first-version-note': '' } : {})}
          className={!thumb ? LINE : view.tourSays ? THUMB_LINE_TOUR_SAYS : THUMB_LINE}
        >
          {line}
        </p>
      )) : null}
      {view.detail ? (
        <p className="text-xs font-mono text-red-700 max-w-md break-words dark:text-red-400">{view.detail}</p>
      ) : null}
      {action && !action.underCard ? actionButton(action) : null}
      {view.alt ? (
        <Button id={ACTIONS[view.alt.key].id} variant="neutral" ink="neutral" onClick={() => press(view.alt!)}>
          {view.alt.label}
        </Button>
      ) : null}
    </div>
  );
}

export function AppStatus(): ReactNode {
  const { view } = useStoreState<{ view: AppStatusView | null }>(appStatusStore);
  return view ? <AppStatusView_ view={view} /> : null;
}
