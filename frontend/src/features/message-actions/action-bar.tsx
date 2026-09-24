import {
  Fragment, useEffect, useRef, type ComponentType, type KeyboardEvent, type ReactNode, type Ref,
} from 'react';

import {
  BookmarkIcon, BookmarkSolidIcon, EllipsisHorizontalIcon, FaceSmileIcon, ReplyArrowIcon, type IconProps,
} from '@/components/ui/icons';

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
  const quick = onReact ? recents.slice(0, 3) : [];
  return (
    <div
      ref={barRef}
      className={`${className} msgx-bar ${pickerOpen || moreOpen ? 'msgx-bar-open' : ''} ${hidden ? 'messages-message-actions-reserved' : ''}`}
      role="toolbar"
      aria-label="Message actions"
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
            aria-label={on ? `Remove your ${name} reaction` : `React with ${name}`}
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
          aria-label="Add reaction"
          title="Add reaction"
          aria-haspopup="dialog"
          aria-expanded={!!pickerOpen}
          onClick={onTogglePicker}
        >
          <FaceSmileIcon strokeWidth="1.6" aria-hidden="true" />
        </button>
      ) : null}
      {onReply ? (
        <button type="button" className="msgx-bar-icon msgx-bar-reply" aria-label="Reply" title="Reply" onClick={onReply}>
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
          aria-label={saved ? 'Unsave message' : 'Save message'}
          title={saved ? 'Saved. Click to unsave' : 'Save to your notifications'}
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
          aria-label="More actions"
          title="More"
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
      aria-label="More actions"
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
