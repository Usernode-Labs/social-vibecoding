/**
 * #6832: the fixed picture set a "steps" picture is drawn from. Each name is
 * one simple line drawing, in the text colour plus the one accent, so it
 * follows light and dark through the parent's `color` and adds no colours or
 * images of its own. The names are the server's own list
 * (src/services/diagram.js `SCENES`); a name with no drawing here draws
 * nothing.
 */

import type { ReactNode } from 'react';

const SIZE = 48;

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 48 48" width={SIZE} height={SIZE} fill="none" stroke="currentColor"
    strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

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
  merged: svg(<path d="M12 8v12c0 6 12 6 12 12v8M36 8v12c0 6-12 6-12 12" />),
  // Checked: a magnifier.
  checked: svg(<>
    <circle cx="20" cy="20" r="11" />
    <line x1="28" y1="28" x2="40" y2="40" />
  </>),
  // Tried again: an arrow coming back round.
  retry: svg(<>
    <path d="M38 24a14 14 0 1 1-4.2-10" />
    <path d="M38 8v8h-8" />
  </>),
  // A preview that builds: a screen with a tick.
  builds: svg(<>
    <rect x="6" y="8" width="36" height="26" rx="3" />
    <path d="M16 21l6 6 10-11" />
  </>),
  // A preview that cannot build: a screen with a cross.
  'cant-build': svg(<>
    <rect x="6" y="8" width="36" height="26" rx="3" />
    <line x1="18" y1="15" x2="30" y2="27" />
    <line x1="30" y1="15" x2="18" y2="27" />
  </>),
  // Handed back: an arrow turning back to the left.
  'handed-back': svg(<>
    <path d="M38 30H14" />
    <path d="M21 23l-7 7 7 7" />
    <path d="M14 16h14" />
  </>),
  // A person.
  person: svg(<>
    <circle cx="24" cy="16" r="7" />
    <path d="M10 40c0-8 6-12 14-12s14 4 14 12" />
  </>),
  // A bell.
  bell: svg(<>
    <path d="M24 8c-7 0-11 5-11 12v8l-4 6h30l-4-6v-8c0-7-4-12-11-12z" />
    <path d="M20 38a4 4 0 0 0 8 0" />
  </>),
  // A card.
  card: svg(<>
    <rect x="6" y="12" width="36" height="24" rx="3" />
    <line x1="13" y1="21" x2="27" y2="21" />
    <line x1="13" y1="28" x2="21" y2="28" />
  </>),
  // A vote: a ballot box with a tick going in.
  vote: svg(<>
    <path d="M8 26h32v14H8z" />
    <path d="M16 26v-8l8-4 8 4v8" />
    <path d="M20 15l3 3 6-7" stroke="var(--accent)" />
  </>),
};

/** One picture from the fixed set, or nothing for a name this build has no drawing for. */
export function Scene({ pic }: { pic: string }): ReactNode {
  return DRAWINGS[pic] || null;
}
