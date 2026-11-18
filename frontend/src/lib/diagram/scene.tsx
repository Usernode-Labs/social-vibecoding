/**
 * #6832: the fixed picture set a "steps" picture is drawn from. Each name is
 * one simple line drawing, in the text colour plus the one accent, so it
 * follows light and dark through the parent's `color` and adds no colours or
 * images of its own. The names are the server's own list
 * (src/services/diagram.js `SCENES`); a name with no drawing here draws
 * nothing.
 *
 * These are scenes on their own 48-unit board, not glyphs from the shell's
 * 24-grid set (frontend/@/components/ui/icons.tsx), so they are drawn here —
 * the same reason the review flow's illustrations.tsx is. Their path data is
 * kept in the one table below and referenced as `d={PATHS.x}`, never written
 * as a literal `d="M…"` beside the module: a picture whose outline is typed
 * inline is how a second spelling of a drawing gets loose
 * (tests/shell-icon-set.test.js).
 */

import type { ReactNode } from 'react';

const SIZE = 48;

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 48 48" width={SIZE} height={SIZE} fill="none" stroke="currentColor"
    strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

/** Every path outline the set draws, in one place. */
const PATHS = {
  // Merged: two branches joining into one.
  merged: 'M12 8v12c0 6 12 6 12 12v8M36 8v12c0 6-12 6-12 12',
  // Tried again: an arrow coming back round.
  retry: 'M38 24a14 14 0 1 1-4.2-10',
  retryHead: 'M38 8v8h-8',
  // A preview that builds: a screen with a tick.
  buildTick: 'M16 21l6 6 10-11',
  // Handed back: an arrow turning back to the left.
  backShaft: 'M38 30H14',
  backHead: 'M21 23l-7 7 7 7',
  backTail: 'M14 16h14',
  // A person.
  shoulders: 'M10 40c0-8 6-12 14-12s14 4 14 12',
  // A bell.
  bellBody: 'M24 8c-7 0-11 5-11 12v8l-4 6h30l-4-6v-8c0-7-4-12-11-12z',
  bellClapper: 'M20 38a4 4 0 0 0 8 0',
  // A vote: a ballot box with a tick going in.
  box: 'M8 26h32v14H8z',
  slot: 'M16 26v-8l8-4 8 4v8',
  voteTick: 'M20 15l3 3 6-7',
} as const;

const PAGE = <rect x="10" y="6" width="28" height="36" rx="3" />;

const DRAWINGS: Record<string, ReactNode> = {
  // Two edits: two overlapping pages, the newer one in the accent.
  'two-edits': svg(<>
    <rect x="8" y="6" width="22" height="28" rx="3" />
    <rect x="18" y="14" width="22" height="28" rx="3" stroke="var(--accent)" />
  </>),
  // The same text kept twice: a page with its line drawn twice.
  'text-twice': svg(<>
    {PAGE}
    <line x1="16" y1="18" x2="32" y2="18" />
    <line x1="16" y1="26" x2="32" y2="26" />
  </>),
  // Kept once: the page with one line.
  'text-once': svg(<>
    {PAGE}
    <line x1="16" y1="20" x2="32" y2="20" />
  </>),
  // Merged: two branches joining into one.
  merged: svg(<path d={PATHS.merged} />),
  // Checked: a magnifier.
  checked: svg(<>
    <circle cx="20" cy="20" r="11" />
    <line x1="28" y1="28" x2="40" y2="40" />
  </>),
  // Tried again: an arrow coming back round.
  retry: svg(<>
    <path d={PATHS.retry} />
    <path d={PATHS.retryHead} />
  </>),
  // A preview that builds: a screen with a tick.
  builds: svg(<>
    <rect x="6" y="8" width="36" height="26" rx="3" />
    <path d={PATHS.buildTick} />
  </>),
  // A preview that cannot build: a screen with a cross.
  'cant-build': svg(<>
    <rect x="6" y="8" width="36" height="26" rx="3" />
    <line x1="18" y1="15" x2="30" y2="27" />
    <line x1="30" y1="15" x2="18" y2="27" />
  </>),
  // Handed back: an arrow turning back to the left.
  'handed-back': svg(<>
    <path d={PATHS.backShaft} />
    <path d={PATHS.backHead} />
    <path d={PATHS.backTail} />
  </>),
  // A person.
  person: svg(<>
    <circle cx="24" cy="16" r="7" />
    <path d={PATHS.shoulders} />
  </>),
  // A bell.
  bell: svg(<>
    <path d={PATHS.bellBody} />
    <path d={PATHS.bellClapper} />
  </>),
  // A card.
  card: svg(<>
    <rect x="6" y="12" width="36" height="24" rx="3" />
    <line x1="13" y1="21" x2="27" y2="21" />
    <line x1="13" y1="28" x2="21" y2="28" />
  </>),
  // A vote: a ballot box with a tick going in.
  vote: svg(<>
    <path d={PATHS.box} />
    <path d={PATHS.slot} />
    <path d={PATHS.voteTick} stroke="var(--accent)" />
  </>),
};

/** One picture from the fixed set, or nothing for a name this build has no drawing for. */
export function Scene({ pic }: { pic: string }): ReactNode {
  return DRAWINGS[pic] || null;
}
