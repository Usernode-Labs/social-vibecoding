import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Localized, message as catalogText } from "../../lib/i18n/react";
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
    <Localized element={<div
      ref={barRef}
      className={`${className} msgx-bar ${pickerOpen || moreOpen ? 'msgx-bar-open' : ''} ${hidden ? 'messages-message-actions-reserved' : ''}`}
      role="toolbar" aria-label={catalogText("core:message_actions_f532ee1f")}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      {quick.map((emoji) => {
        const on = !!reacted?.(emoji);
        const name = emojiName(emoji);
        return (
          <LocalizedDynamic element={<button
            key={emoji}
            type="button"
            className={`msgx-bar-emoji ${on ? 'msgx-bar-emoji-on' : ''}`}
            aria-pressed={on}
            aria-label={on ? tr("core:remove_your_value1_reaction_5f6c5fa3", { value1: name }) : tr("core:react_with_value1_509e60e8", { value1: name })}
            title={name}
            onClick={() => onReact?.(emoji)}
          >
            {emoji}
          </button>} resolve={() => ({ "aria-label": on ? tr("core:remove_your_value1_reaction_5f6c5fa3", { value1: name }) : tr("core:react_with_value1_509e60e8", { value1: name }) })} />
        );
      })}
      {quick.length ? <span className="msgx-bar-divider" aria-hidden="true" /> : null}
      {onTogglePicker ? (
        <Localized element={<button
          ref={pickerButtonRef}
          type="button"
          className={`msgx-bar-icon msgx-bar-picker ${pickerOpen ? 'msgx-bar-icon-on' : ''}`} aria-label={catalogText("core:add_reaction_d97239a6")} title={catalogText("core:add_reaction_d97239a6")}
          aria-haspopup="dialog"
          aria-expanded={!!pickerOpen}
          onClick={onTogglePicker}
        >
          <FaceSmileIcon strokeWidth="1.6" aria-hidden="true" />
        </button>} messages={{"aria-label":"core:add_reaction_d97239a6","title":"core:add_reaction_d97239a6"}} />
      ) : null}
      {onReply ? (
        <Localized element={<button type="button" className="msgx-bar-icon msgx-bar-reply" aria-label={catalogText("core:reply_c253f451")} title={catalogText("core:reply_c253f451")} onClick={onReply}>
          <ReplyArrowIcon strokeWidth="1.8" aria-hidden="true" />
        </button>} messages={{"aria-label":"core:reply_c253f451","title":"core:reply_c253f451"}} />
      ) : null}
      {/* SAVE, the bookmark (#1280): solid when saved, outline when not — the
          state lives in the SHAPE — with `aria-pressed` saying so. Its two
          labels are what dapp.json's checks select on. */}
      {onToggleSave ? (
        <LocalizedDynamic element={<button
          type="button"
          className={`msgx-bar-icon msgx-bar-save ${saved ? 'messages-action-saved msgx-bar-icon-accent' : ''}`}
          aria-pressed={!!saved}
          aria-label={saved ? tr("core:unsave_message_a92fa23a") : tr("core:save_message_46dc28c2")}
          title={saved ? tr("core:saved_click_to_unsave_5c8c40fa") : tr("core:save_to_your_notifications_ccd643dc")}
          onClick={onToggleSave}
        >
          {saved ? <BookmarkSolidIcon aria-hidden="true" /> : <BookmarkIcon strokeWidth="1.6" aria-hidden="true" />}
        </button>} resolve={() => ({ "aria-label": saved ? tr("core:unsave_message_a92fa23a") : tr("core:save_message_46dc28c2"), "title": saved ? tr("core:saved_click_to_unsave_5c8c40fa") : tr("core:save_to_your_notifications_ccd643dc") })} />
      ) : null}
      {onToggleMore ? (
        <Localized element={<button
          ref={moreButtonRef}
          type="button"
          className={`msgx-bar-icon ${moreClassName} ${moreOpen ? 'msgx-bar-icon-on' : ''}`} aria-label={catalogText("core:more_actions_f8d46c25")} title={catalogText("core:more_d47d7cb0")}
          aria-haspopup="menu"
          aria-expanded={!!moreOpen}
          onClick={onToggleMore}
        >
          <EllipsisHorizontalIcon aria-hidden="true" />
        </button>} messages={{"aria-label":"core:more_actions_f8d46c25","title":"core:more_d47d7cb0"}} />
      ) : null}
      {children}
    </div>} messages={{"aria-label":"core:message_actions_f532ee1f"}} />
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
    <Localized element={<div
      ref={setRefs}
      className={`msgx-menu msgx-menu-${placement} ${className}`}
      role="menu" aria-label={catalogText("core:more_actions_f8d46c25")}
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
    </div>} messages={{"aria-label":"core:more_actions_f8d46c25"}} />
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
