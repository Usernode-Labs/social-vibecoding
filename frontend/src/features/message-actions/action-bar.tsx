import {
  Fragment, useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type Ref,
} from 'react';

import {
  BookmarkIcon, BookmarkSolidIcon, EllipsisHorizontalIcon, FaceSmileIcon, ReplyArrowIcon, type IconProps,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { emojiName } from './emoji-data';

/**
 * THE HOVER BAR (#2387) — the one strip of controls every chat row carries,
 * on every surface: a DM, a group, #general and an app's channel.
 *
 *   [ 👍 ❤️ 🙏 ] | ☺  ↩  🔖  ⋯
 *
 * The viewer's three most recent reactions (./recents.ts) as one-tap
 * reactions, then the full picker, Reply (the inline quote, as before),
 * Save (the bookmark, as before) and ⋯ for everything rarer. Discord's shape;
 * the rarer acts live behind ⋯ (./message-menu.tsx) so the bar stays short.
 *
 * ── The container is the caller's ─────────────────────────────────────
 *
 * The bar renders its buttons as DIRECT children of one element whose class
 * the caller names: `.messages-message-actions` on the Messages screen, where
 * dapp.json's declared checks select `.messages-message-actions >
 * button.messages-action-more[aria-haspopup="menu"]` and the Save button by
 * its label, and the app chat's own class there. Revealed on hover and on
 * focus-within by app.css; on a touch screen it is not drawn at all — a long
 * press opens ./action-sheet.tsx with the same acts instead.
 */

export interface MenuItem {
  key: string;
  label: string;
  icon: ComponentType<IconProps>;
  onSelect: () => void;
  danger?: boolean;
  /** Draw a divider above this item — the line between everyday acts and report/block/delete. */
  separated?: boolean;
  disabled?: boolean;
}

export function MessageActionBar({
  className,
  recents,
  reacted,
  onReact,
  pickerOpen,
  onTogglePicker,
  pickerButtonRef,
  onReply,
  saved,
  onToggleSave,
  moreOpen,
  onToggleMore,
  moreButtonRef,
  moreClassName = 'messages-action-more',
  hidden = false,
  barRef,
  children,
}: {
  className: string;
  recents: readonly string[];
  /** Whether the viewer has already reacted with this emoji — the recent button is pressed. */
  reacted?: (emoji: string) => boolean;
  onReact?: (emoji: string) => void;
  pickerOpen?: boolean;
  onTogglePicker?: () => void;
  pickerButtonRef?: Ref<HTMLButtonElement>;
  onReply?: () => void;
  saved?: boolean;
  onToggleSave?: () => void;
  moreOpen?: boolean;
  onToggleMore?: () => void;
  moreButtonRef?: Ref<HTMLButtonElement>;
  moreClassName?: string;
  /** Laid out but invisible and inert — a send still in flight (#2907). */
  hidden?: boolean;
  /**
   * The bar's own element, for the caller's outside-press dismissal: a press
   * on the open picker or menu, which are children of the bar, is inside.
   */
  barRef?: Ref<HTMLDivElement>;
  /** The picker and the menu, anchored to the bar. */
  children?: ReactNode;
}) {
  const t = useMessages('messages');
  const quick = onReact ? recents.slice(0, 3) : [];
  // #6697: an ordinary row keeps the bar's old place on its top edge, over
  // the name line; a continuation row's words start at the row's own top, so
  // the pill is raised there just clear of the first line. Where there is no
  // room above the row, the pill goes just below it instead. Measured once
  // when the pointer or the keyboard enters the row, the way the picker and
  // the menu measure with placementFor, never while it stays open.
  const ownBar = useRef<HTMLDivElement | null>(null);
  const [below, setBelow] = useState(false);

  function setBar(node: HTMLDivElement | null) {
    ownBar.current = node;
    if (typeof barRef === 'function') barRef(node);
    else if (barRef) (barRef as { current: HTMLDivElement | null }).current = node;
  }

  useEffect(() => {
    const node = ownBar.current;
    if (!node || typeof window === 'undefined') return;
    // Somebody else's bubble on the Messages screen keeps its bar beside its
    // name line (message-row.tsx `barBesideHead`), which already sits beside
    // the message rather than over its words: nothing to measure there.
    if (node.parentElement?.classList.contains('messages-message-head')) return;
    let row: HTMLElement | null = node.parentElement;
    while (row && getComputedStyle(row).position === 'static') row = row.parentElement;
    if (!row) return;
    const target = row;
    const place = () => {
      const lift = barLift(target);
      node.style.setProperty('--msgx-bar-lift', `${lift}px`);
      // Desktop polish 11: a continuation line of somebody else's sits on
      // its bubble (message-row.tsx `barOnBubble`). Where the bubble is in
      // the row goes to app.css, which lines the bar up with it.
      if (node.classList.contains('msgx-bar-on-bubble')) {
        const box = bubbleBox(target);
        if (box) {
          node.style.setProperty('--msgx-bubble-start', `${box.start}px`);
          node.style.setProperty('--msgx-bubble-w', `${box.width}px`);
          node.style.setProperty('--msgx-bubble-top', `${box.top}px`);
        }
      }
      setBelow(!roomAbove(target, lift));
    };
    target.addEventListener('pointerenter', place);
    target.addEventListener('focusin', place);
    return () => {
      target.removeEventListener('pointerenter', place);
      target.removeEventListener('focusin', place);
    };
  }, []);

  return (
    <div
      ref={setBar}
      className={`${className} msgx-bar ${below ? 'msgx-bar-below' : ''} ${pickerOpen || moreOpen ? 'msgx-bar-open' : ''} ${hidden ? 'messages-message-actions-reserved' : ''}`}
      role="toolbar"
      aria-label={t('messages:actions.toolbar')}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      {quick.map((emoji) => {
        const on = !!reacted?.(emoji);
        const name = emojiName(emoji);
        return (
          <button
            key={emoji}
            type="button"
            className={`msgx-bar-emoji ${on ? 'msgx-bar-emoji-on' : ''}`}
            aria-pressed={on}
            aria-label={on ? t('messages:actions.removeReaction', { emoji: name }) : t('messages:actions.reactWith', { emoji: name })}
            title={name}
            onClick={() => onReact?.(emoji)}
          >
            {emoji}
          </button>
        );
      })}
      {quick.length ? <span className="msgx-bar-divider" aria-hidden="true" /> : null}
      {onTogglePicker ? (
        <button
          ref={pickerButtonRef}
          type="button"
          className={`msgx-bar-icon msgx-bar-picker ${pickerOpen ? 'msgx-bar-icon-on' : ''}`}
          aria-label={t('messages:actions.addReaction')}
          title={t('messages:actions.addReaction')}
          aria-haspopup="dialog"
          aria-expanded={!!pickerOpen}
          onClick={onTogglePicker}
        >
          <FaceSmileIcon strokeWidth="1.6" aria-hidden="true" />
        </button>
      ) : null}
      {onReply ? (
        <button type="button" className="msgx-bar-icon msgx-bar-reply" aria-label={t('messages:actions.reply')} title={t('messages:actions.reply')} onClick={onReply}>
          <ReplyArrowIcon strokeWidth="1.8" aria-hidden="true" />
        </button>
      ) : null}
      {/* SAVE, the bookmark (#1280): solid when saved, outline when not — the
          state lives in the SHAPE — with `aria-pressed` saying so. Its two
          labels are what dapp.json's checks select on. */}
      {onToggleSave ? (
        <button
          type="button"
          className={`msgx-bar-icon msgx-bar-save ${saved ? 'messages-action-saved msgx-bar-icon-accent' : ''}`}
          aria-pressed={!!saved}
          aria-label={saved ? t('messages:actions.unsaveMessage') : t('messages:actions.saveMessage')}
          title={saved ? t('messages:actions.savedTooltip') : t('messages:actions.saveTooltip')}
          onClick={onToggleSave}
        >
          {saved ? <BookmarkSolidIcon aria-hidden="true" /> : <BookmarkIcon strokeWidth="1.6" aria-hidden="true" />}
        </button>
      ) : null}
      {onToggleMore ? (
        <button
          ref={moreButtonRef}
          type="button"
          className={`msgx-bar-icon ${moreClassName} ${moreOpen ? 'msgx-bar-icon-on' : ''}`}
          aria-label={t('messages:actions.moreActions')}
          title={t('messages:actions.more')}
          aria-haspopup="menu"
          aria-expanded={!!moreOpen}
          onClick={onToggleMore}
        >
          <EllipsisHorizontalIcon aria-hidden="true" />
        </button>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The ⋯ menu (#2387): the rarer acts on a message, one list for every
 * surface. The caller builds the items — which ones exist depends on whose
 * message it is and what kind of chat it sits in — and this draws them.
 *
 * Arrow keys move through the items and Escape closes, as a menu should; the
 * first item takes focus when it opens from the keyboard.
 */
export function MessageMenu({ items, onClose, placement = 'below', menuRef, className = '' }: {
  items: MenuItem[];
  onClose: () => void;
  placement?: 'above' | 'below';
  menuRef?: Ref<HTMLDivElement>;
  className?: string;
}) {
  const t = useMessages('messages');
  const own = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const first = own.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    if (first && document.activeElement?.closest('.msgx-bar')) first.focus({ preventScroll: true });
  }, []);
  function setRefs(node: HTMLDivElement | null) {
    own.current = node;
    if (typeof menuRef === 'function') menuRef(node);
    else if (menuRef) (menuRef as { current: HTMLDivElement | null }).current = node;
  }
  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...(own.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  return (
    <div
      ref={setRefs}
      className={`msgx-menu msgx-menu-${placement} ${className}`}
      role="menu"
      aria-label={t('messages:actions.moreActions')}
      onKeyDown={move}
    >
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.separated ? <div className="msgx-menu-rule" role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`msgx-menu-item ${item.danger ? 'msgx-menu-danger messages-more-danger' : ''}`}
            onClick={() => { onClose(); item.onSelect(); }}
          >
            <item.icon className="msgx-menu-glyph" strokeWidth="1.6" aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Where a popover anchored in a transcript row fits: below the bar unless
 * that would run past the bottom of the scroller the row lives in (the
 * composer and the tab bar are under it), in which case above.
 */
export function placementFor(anchor: Element | null, height: number): 'above' | 'below' {
  if (!anchor || typeof window === 'undefined') return 'below';
  let floor = window.innerHeight;
  let ceiling = 0;
  for (let node = anchor.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
      const box = node.getBoundingClientRect();
      floor = box.bottom; ceiling = box.top;
      break;
    }
  }
  const rect = anchor.getBoundingClientRect();
  if (rect.bottom + height <= floor) return 'below';
  return rect.top - height >= ceiling ? 'above' : 'below';
}

/**
 * How far above its row a message's bar sits (#6697). An ordinary row keeps
 * the bar's old place, 16px above its top, so the pill covers the name line
 * and stops short of the words. A continuation row has no name line and its
 * words start at the row's own top padding, so there the bar is raised just
 * clear of the first line: the 40px pill and its 4px gap, less that padding.
 */
export function barLift(row: Element): number {
  const grouped = row.hasAttribute('data-grouped')
    || row.classList.contains('messages-message-grouped');
  if (!grouped || typeof window === 'undefined') return 16;
  const top = parseFloat(getComputedStyle(row).paddingTop);
  return 44 - (Number.isFinite(top) ? top : 0);
}

/**
 * Where a continuation row's message is drawn, in the row's own terms
 * (desktop polish 11): how far its bubble starts from the row's
 * inline-start edge (its left, or its right in Arabic), how wide it is, and
 * how far its top is below the row's. Pictures stand above the words and
 * take the bubble's part when they come first (or alone), so the bar never
 * covers them. Null when the row draws neither.
 */
export function bubbleBox(row: Element): { start: number; width: number; top: number } | null {
  if (!row || typeof window === 'undefined') return null;
  const wrap = Array.from(row.children).find((child) => child.classList.contains('messages-bubble-wrap'));
  const anchor = wrap
    ? Array.from(wrap.children).find((child) => child.classList.contains('messages-bubble') || child.classList.contains('messages-message-images'))
    : null;
  if (!anchor) return null;
  const r = row.getBoundingClientRect();
  const b = anchor.getBoundingClientRect();
  const rtl = getComputedStyle(row).direction === 'rtl';
  return {
    start: Math.round(rtl ? r.right - b.right : b.left - r.left),
    width: Math.round(b.width),
    top: Math.round(b.top - r.top),
  };
}

/**
 * Whether a message's bar fits in the room above its row (#6697): the row's
 * top has to clear the top of the nearest scroller (else the page's top, 0)
 * by the height of the bar's lift, read from barLift. Read when the pointer
 * or the keyboard enters the row, the way placementFor reads its popover's
 * room.
 */
export function roomAbove(row: Element, height: number): boolean {
  if (!row || typeof window === 'undefined') return false;
  let ceiling = 0;
  for (let node = row.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
      ceiling = node.getBoundingClientRect().top;
      break;
    }
  }
  return row.getBoundingClientRect().top - height >= ceiling;
}
