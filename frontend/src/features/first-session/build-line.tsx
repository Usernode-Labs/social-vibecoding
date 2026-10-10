/**
 * The build line (#4053): one line that says where a project's first version
 * is, the same way on every screen that shows it. It is separate from the
 * project's thumbnail (./sketch-card.tsx): one line about 8px under the card,
 * not a row in it (owner, 8 Oct 2026, reversing the 6 October call to keep it
 * inside), on the made screen and the App tab, and the hub's First version
 * card draws it too.
 *
 * The server says which line, for the person reading (`first_version.line`,
 * services/homeroom-bot-progress.js buildLineOf); the words are here, once:
 *
 *   planning     Homeroom bot is planning it          steps 1 to 3, everyone
 *   plan         Your plan is ready to review         its plan waits, for the person who started it
 *   plan-member  Planning it                          the same, for everyone else
 *   question     Homeroom bot has a question for you  it asked the person who started it
 *   building     Building it                          step 4
 *   testing      Testing it                           step 5
 *   ready        Ready to try                         step 6
 *   live         Live                                 step 7
 *
 * A spinner turns while it is being made, a blue dot marks the one line that
 * waits on the reader, and a check marks it ready or live. No step numbers:
 * "Step 4 of 7" stays in Homeroom bot's chat, the one place it is counted.
 * Before this the line was "Step 4 of 7: Build it", which an invited member
 * read as being asked to build it, beside a dot that only faded (and stood
 * still in the Homeroom app on iPhone, app.css `.status-dot.creating`), so
 * nothing showed that anything was happening (onboarding test, 6 October
 * 2026). The spinner is a functional progress spinner, which that rule
 * leaves turning; with reduced motion it stands still.
 */

import type { ReactNode } from 'react';

import { CheckIcon, SpinnerRingIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
// The words, once, as message ids (./build-line-words.js, plain JavaScript
// so home.js and its classic-script tests read the same ones).
import { BUILD_LINE_WORDS } from './build-line-words.js';

export { BUILD_LINE_WORDS };

/**
 * One line the server never sends (so not in BUILD_LINE_WORDS, which match
 * its states one for one): the maker's hub card while the first-session tour
 * runs, in place of "Review the plan" (./tour-running.ts). A spinner, as the
 * lines on their way have. A message id, as BUILD_LINE_WORDS holds.
 */
export const WORKING_LINE_WORDS = 'onboarding:buildLine.working';

/** The lines the server sends (`first_version.line`). */
export type ServerBuildLine = keyof typeof BUILD_LINE_WORDS;

export type BuildLineState = ServerBuildLine | 'working';

/** The same lines on a Home tile (./build-line-words.js). */
export { BUILD_LINE_TILE_CARD, buildLineTileClass, buildLineTileOf } from './build-line-words.js';

/** The line in an answer (`first_version.line`), or null for none or one this shell does not know. */
export function buildLineOf(value: unknown): ServerBuildLine | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUILD_LINE_WORDS, value)
    ? (value as ServerBuildLine) : null;
}

/** The lines that wait on the reader: blue, with a dot. */
export function buildLineAsks(state: BuildLineState): boolean {
  return state === 'plan' || state === 'question';
}


/** The lines that are done: a check. */
export function buildLineDone(state: BuildLineState): boolean {
  return state === 'ready' || state === 'live';
}

/**
 * `note`, after the words: how long it usually takes, where a screen says so
 * (#4392, Homeroom bot's thanks: "Building it · usually 10 to 25 min").
 */
export function BuildLine({ state, note = null, className = '' }: { state: BuildLineState; note?: string | null; className?: string }): ReactNode {
  const t = useMessages('onboarding');
  const asks = buildLineAsks(state);
  const done = buildLineDone(state);
  const words = t(state === 'working' ? WORKING_LINE_WORDS : BUILD_LINE_WORDS[state]);
  // A span, so it can sit in a row's text as well as in a card.
  return (
    <span
      role="status"
      data-build-line={state}
      className={`flex min-h-[24px] min-w-0 items-center gap-2 text-[15px] leading-5 ${asks ? 'font-semibold text-[color:var(--accent)]' : 'text-zinc-500 dark:text-zinc-400'} ${className}`}
    >
      {asks ? (
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--accent)]" />
      ) : done ? (
        <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <SpinnerRingIcon className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      )}
      <span className="truncate">{note ? t('onboarding:buildLine.withNote', { line: words, note }) : words}</span>
    </span>
  );
}
