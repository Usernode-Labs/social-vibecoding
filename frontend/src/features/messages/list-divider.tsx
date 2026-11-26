/**
 * THE LINE BETWEEN THE LIST AND THE PANE BESIDE IT IS A HANDLE (24 Nov 2026,
 * desktop polish 09). From 768px the Messages list stands beside an open
 * conversation, or beside the guide when none is open, and this grip on the
 * line between them moves it: the list takes the width it is dragged to,
 * the pane beside it the rest.
 *
 * - The grip is the bot tab's and the Workshop's (`.split-handle`, app.css):
 *   unseen at rest, a 6 x 48px bar at half strength under the pointer,
 *   the accent on focus and while held.
 * - The width is Messages' own: `--messages-list-chosen-w`, written on
 *   <html> (outside React's body tree, so hydration never disagrees with
 *   it), and read only by `.messages-list-pane` (app.css, THE TWO PANES).
 *   `--list-pane-w`, the inbox's default measure that the bot tab's list
 *   also reads, is left alone.
 * - It holds between LIST_MIN and 42% of the Messages area. The 42% is the
 *   stylesheet's (a `clamp()` against the layout), so a window that narrows
 *   gives the room back without rewriting what was chosen.
 * - It is kept on this device under its own key, and applied when this
 *   module loads, before React hydrates: Messages is first drawn at it.
 * - A double-click goes back to the default; the arrow keys move it
 *   (Shift four times as far, as the bot tab's divider does).
 *
 * Built on lib/split-drag.ts, the Workshop panel's handle, rather than the
 * bot tab's SidePanelDivider, which sizes a column pinned at the window's
 * edge. The reply thread's own divider (index.tsx, #5691) is separate.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { armOnMove, readSplitWidth, splitKey, startSplitDrag, writeSplitWidth, type SplitDrag } from '../../lib/split-drag';

export const LIST_WIDTH_KEY = 'messages-list-width-v1';
export const LIST_WIDTH_PROPERTY = '--messages-list-chosen-w';
/** The narrowest the list may be dragged. */
export const LIST_MIN = 280;
/** The widest, as a share of the Messages area (app.css holds it). */
export const LIST_MAX_SHARE = 42;
/** One arrow-key press; Shift moves four times as far (the bot tab's step). */
export const LIST_KEY_STEP = 16;

/** The value written for a chosen width: the stylesheet keeps it in range. */
export function listWidthValue(px: number): string {
  return `clamp(${LIST_MIN}px, ${Math.round(px)}px, ${LIST_MAX_SHARE}%)`;
}

/** Show the list at `px`, or hand it back to the stylesheet's default. */
export function applyListWidth(px: number | null, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return;
  if (px == null) root.style.removeProperty(LIST_WIDTH_PROPERTY);
  else root.style.setProperty(LIST_WIDTH_PROPERTY, listWidthValue(px));
}

// Before the first paint of Messages: the bundle runs this before it
// hydrates the shell, and the screen is hidden until the router shows it.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  applyListWidth(readSplitWidth(LIST_WIDTH_KEY, LIST_MIN));
}

/** The list's width on screen now: what a drag starts from. */
function listWidthNow(handle: HTMLElement | null): number {
  const pane = handle?.parentElement;
  return pane ? Math.round(pane.getBoundingClientRect().width) : 0;
}

export function ListDivider(): ReactNode {
  const t = useMessages('messages');
  // The tooltip is the bot tab's and the Workshop's own words.
  const ta = useMessages('agent');
  const ref = useRef<HTMLDivElement>(null);
  // What a screen reader hears as the separator's value: the list's width
  // in pixels. Read after mount (and on every move), never while rendering,
  // so the prerendered markup and the first render agree.
  const [now, setNow] = useState<number | null>(null);
  const read = () => {
    const px = listWidthNow(ref.current);
    setNow(px > 0 ? px : null);
  };
  const drag: SplitDrag = {
    start: () => listWidthNow(ref.current),
    apply: (px) => { applyListWidth(px); read(); },
    // Keep what the screen shows, not what the pointer reached past a limit,
    // and show exactly that, so a wider window later does not reach further.
    done: () => {
      const px = listWidthNow(ref.current);
      if (px > 0) { applyListWidth(px); writeSplitWidth(LIST_WIDTH_KEY, px); }
      read();
    },
  };
  useEffect(() => {
    read();
    const disarm = armOnMove(ref.current);
    const pane = ref.current?.parentElement;
    const observer = pane && typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null;
    if (observer && pane) observer.observe(pane);
    return () => {
      disarm();
      observer?.disconnect();
      // A drag that never ended must not leave the page in the resize cursor.
      document.documentElement.classList.remove('side-panel-resizing');
    };
  }, []);
  return (
    <div
      ref={ref}
      className="messages-list-divider split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('messages:inbox.resize')}
      aria-valuenow={now ?? undefined}
      aria-valuemin={now == null ? undefined : LIST_MIN}
      title={ta('agent:sidePanel.resizeTitle')}
      tabIndex={0}
      data-messages-list-divider=""
      onPointerDown={(e) => startSplitDrag(e, drag)}
      onKeyDown={(e) => {
        if (splitKey(e.key, e.shiftKey ? LIST_KEY_STEP * 4 : LIST_KEY_STEP, drag)) e.preventDefault();
      }}
      onDoubleClick={() => {
        writeSplitWidth(LIST_WIDTH_KEY, null);
        applyListWidth(null);
        read();
      }}
    />
  );
}
