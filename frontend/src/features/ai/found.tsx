/**
 * What both faces of the tab's lists share to draw a message the search
 * found (13 Nov 2026, ./search.ts, ./lines.ts FoundLine): its snippet with
 * the found words marked, and the press of its link.
 */
import type { MouseEvent, ReactNode } from 'react';

import { goBotAddress } from './door';
import type { MarkPart } from './search';

/**
 * A snippet, its found words each a <mark>. The parts are text
 * (./search.ts markParts), so nothing the server sent is read as markup.
 * `className` is the mark's look on the face that draws it.
 */
export function Marked({ parts, className }: { parts: readonly MarkPart[]; className: string }): ReactNode {
  return (
    <>
      {parts.map((part, i) => (part.hit
        // The parts of one snippet never reorder: their place is their key.
        ? <mark key={i} className={className}>{part.text}</mark>
        : part.text))}
    </>
  );
}

/**
 * A found message's link, pressed: through the tab's own door, so the same
 * message opens again when its address is already the one in the bar
 * (./door.ts goBotAddress). A press that asks for a new tab or window is
 * left to the browser.
 */
export function followFound(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  goBotAddress(href);
}
