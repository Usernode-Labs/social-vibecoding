import {
  useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { FaceSmileIcon } from '@/components/ui/icons';

import type { MenuItem } from './action-bar';
import { emojiName } from './emoji-data';
import { EmojiPicker } from './emoji-picker';

/**
 * THE PHONE'S HOVER BAR (#2387): a long press on a message opens this sheet
 * with everything the bar and its ⋯ offer on a pointer — the three recent
 * reactions and the picker on top, then one list of acts.
 *
 * A touch screen has no hover, so the bar used to be laid out on every row,
 * a line of discs under each message (#2905 counted them). The sheet takes
 * that line away: a row is just the message until you ask it for more, the
 * way every phone messenger works.
 *
 * Portalled to <body>, over a scrim that closes it. "Add reaction" turns the
 * sheet into the picker in place rather than stacking a second sheet.
 */
export function MessageActionSheet({
  open,
  onClose,
  recents,
  reacted,
  onReact,
  onPick,
  items,
  preview,
}: {
  open: boolean;
  onClose: () => void;
  recents: readonly string[];
  reacted?: (emoji: string) => boolean;
  /** A tap on one of the recent three. */
  onReact?: (emoji: string) => void;
  /** A pick from the picker (remembered as recent by the caller). */
  onPick?: (emoji: string) => void;
  items: MenuItem[];
  /** The message, a line of it, so the sheet says what it acts on. */
  preview?: { who: string; text: string } | null;
}) {
  const [picking, setPicking] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) setPicking(false); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    sheet.current?.focus({ preventScroll: true });
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="msgx-sheet-layer">
      <button type="button" className="msgx-sheet-scrim" aria-label="Close" onClick={onClose} />
      <div ref={sheet} className="msgx-sheet platform-safe-sheet" role="dialog" aria-label="Message actions" tabIndex={-1}>
        <span className="msgx-sheet-grabber" aria-hidden="true" />
        {picking && onPick ? (
          <EmojiPicker placement="inline" autoFocus={false} onPick={(emoji) => { onClose(); onPick(emoji); }} onClose={() => setPicking(false)} />
        ) : (
          <>
            {preview ? (
              <p className="msgx-sheet-preview"><strong>@{preview.who}</strong> {preview.text || 'Attachment'}</p>
            ) : null}
            {onReact ? (
              <div className="msgx-sheet-reactions">
                {recents.slice(0, 3).map((emoji) => {
                  const on = !!reacted?.(emoji);
                  return (
                    <button
                      key={emoji}
                      type="button"
                      className={`msgx-sheet-emoji ${on ? 'msgx-sheet-emoji-on' : ''}`}
                      aria-pressed={on}
                      aria-label={on ? `Remove your ${emojiName(emoji)} reaction` : `React with ${emojiName(emoji)}`}
                      onClick={() => { onClose(); onReact(emoji); }}
                    >
                      {emoji}
                    </button>
                  );
                })}
                {onPick ? (
                  <button type="button" className="msgx-sheet-emoji" aria-label="Add reaction" onClick={() => setPicking(true)}>
                    <FaceSmileIcon className="w-6 h-6" strokeWidth="1.6" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="msgx-sheet-list" role="menu" aria-label="Message actions">
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={`msgx-sheet-item ${item.separated ? 'msgx-sheet-item-separated' : ''} ${item.danger ? 'msgx-sheet-danger' : ''}`}
                  onClick={() => { onClose(); item.onSelect(); }}
                >
                  <item.icon className="msgx-sheet-glyph" strokeWidth="1.6" aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A long press, for touch only: 450ms held without moving opens the sheet.
 *
 * A mouse never triggers it — the bar is its answer — and a finger that
 * moves (a scroll) or lifts early cancels. The click the lift would produce
 * after a completed press is swallowed, so the press does not also follow a
 * link or open a quote under the finger.
 */
export function useLongPress(onLongPress: () => void, { disabled = false, ms = 450 } = {}) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const touching = useRef(false);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown(event: ReactPointerEvent) {
      if (disabled || event.pointerType !== 'touch') return;
      touching.current = true;
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        timer.current = null;
        onLongPress();
      }, ms);
    },
    onPointerMove(event: ReactPointerEvent) {
      const start = origin.current;
      if (!start) return;
      if (Math.abs(event.clientX - start.x) > 8 || Math.abs(event.clientY - start.y) > 8) cancel();
    },
    onPointerUp() { touching.current = false; cancel(); },
    onPointerCancel() { touching.current = false; cancel(); },
    onClickCapture(event: ReactMouseEvent) {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    // The platform's own long-press menu (copy, select) would open over the
    // sheet. Only while a finger is down on this row: a right-click with a
    // mouse keeps the browser's menu.
    onContextMenu(event: ReactMouseEvent) {
      if (!disabled && touching.current) event.preventDefault();
    },
  };
}
