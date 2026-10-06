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
 * build line at its foot, and "It opens here when it’s ready." under it:
 * no plan, no step count, nothing to press (#4043). Once that version is
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
   * thumbnail in place of the message, with `buildLine` at its foot.
   */
  thumb?: FirstVersionThumb | null;
  buildLine?: BuildLineState | null;
  /**
   * At most one, and only for a viewer who can act on it. `botChat` opens
   * the viewer's DM with the Homeroom bot (#15), by its id when known.
   * `tryChange` and `seeChange` are a first version that is ready to try:
   * its change's preview and its change page, by the change's id.
   */
  action: {
    key: 'secrets' | 'buildLog' | 'botChat' | 'tryChange' | 'seeChange';
    label: string;
    slug: string;
    conversationId?: number | null;
    sessionId?: number | null;
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

export function AppStatusView_({ view }: { view: AppStatusView }): ReactNode {
  const action = view.action;
  const titled = !!view.lines?.length;
  const thumb = view.thumb || null;
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 gap-2 p-4 text-center">
      {view.dot ? <div className={`status-dot ${view.dot}`}></div> : null}
      {thumb ? (
        <FirstVersionCard key={thumb.slug} thumb={thumb} line={buildLineOf(view.buildLine)} />
      ) : (
        <p className={titled ? 'max-w-sm text-base font-semibold text-zinc-900 dark:text-zinc-100' : 'text-sm'}>{view.message}</p>
      )}
      {titled ? view.lines!.map((line) => <p key={line} className={thumb ? 'max-w-sm pt-1 text-[15px] leading-5' : 'max-w-sm text-sm'}>{line}</p>) : null}
      {view.detail ? (
        <p className="text-xs font-mono text-red-700 max-w-md break-words dark:text-red-400">{view.detail}</p>
      ) : null}
      {action ? (
        <Button id={ACTIONS[action.key].id} className="mt-3" onClick={() => press(action)}>
          {action.label}
        </Button>
      ) : null}
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
