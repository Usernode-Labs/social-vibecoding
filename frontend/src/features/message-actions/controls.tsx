import { useRef, useState, type ReactNode } from 'react';

import type { SaveableImage } from '../image-viewer/save-image';
import type { TranslateView } from '../messages/translate';
import { MessageActionBar, MessageMenu, placementFor, type MenuItem } from './action-bar';
import { MessageActionSheet, useLongPress } from './action-sheet';
import { EmojiPicker } from './emoji-picker';
import { messageMenu, messageSheet, type BlockWho } from './message-menu';
import { rememberReaction, useRecentReactions } from './recents';
import type { MessageActions } from './rules';
import { useDismiss } from './use-dismiss';

/**
 * A MESSAGE'S CONTROLS, WIRED ONCE: the hover bar with its picker and ⋯
 * menu, and the same acts as a sheet on a long press on a phone, for every
 * row that draws a message.
 *
 * Which acts are offered is never decided here, nor by the row: `allowed`
 * is ./rules.ts's answer for this viewer, this message and this place. The
 * row passes what each act DOES in its place (its store, its socket), and
 * an act whose flag is no is left out, however the row described it. Messages'
 * row and a project channel's row each held their own copy of this wiring
 * (the picker and menu state, the outside-press dismissal, the recents,
 * the sheet's items), and the two had begun to differ.
 */
export interface MessageActs {
  /** Toggle the viewer's reaction with this emoji. */
  react?: ((emoji: string) => void) | null;
  /** Reply to it (the inline quote). */
  reply?: (() => void) | null;
  /** The bookmark: whether it is saved, and how to flip it. */
  save?: { saved: boolean; toggle: () => void } | null;
  /** The thread under it: whether one has started, and how to open it. */
  thread?: { started: boolean; open: () => void } | null;
  edit?: (() => void) | null;
  /** The words Copy text copies. */
  text?: string | null;
  /** Its translation, where the place offers one (../messages/translate.tsx). */
  translation?: Pick<TranslateView, 'state' | 'ask' | 'toggle'> | null;
  /** Its pictures, which Download image saves. */
  pictures?: SaveableImage[];
  /** Its own address, which Copy link copies. */
  link?: string | null;
  markUnread?: (() => Promise<unknown>) | null;
  remove?: (() => Promise<unknown>) | null;
  report?: (() => void) | null;
  block?: { who: BlockWho; run: () => Promise<unknown>; busy?: boolean } | null;
  makeRequest?: (() => void) | null;
  /** Where a failed act says so; `fallback` is the menu's own sentence. */
  failed: (error: unknown, fallback: string) => void;
}

export interface MessageControls {
  /** The hover bar, with its picker and menu — or null when nothing is offered. */
  bar: ReactNode;
  /** The long-press sheet (portalled; render it anywhere in the row). */
  sheet: ReactNode;
  /** Spread on the row: a long press on a touch screen opens the sheet. */
  longPress: ReturnType<typeof useLongPress>;
  /** Whether the viewer has reacted with this emoji. */
  reacted: (emoji: string) => boolean;
  /** Toggle a reaction, or null when the viewer cannot react here (a reaction chip's tap). */
  toggleReaction: ((emoji: string) => void) | null;
}

/**
 * The ⋯ menu's items for a message: the acts the place supplies, each kept
 * only where the rule said yes, in the one menu's order (./message-menu.ts).
 * Pure: the hook below draws them, and a test can read them.
 */
export function messageItems(allowed: MessageActions, acts: MessageActs): MenuItem[] {
  return messageMenu({
    makeRequest: allowed.makeRequest ? acts.makeRequest : null,
    thread: allowed.thread ? acts.thread : null,
    edit: allowed.edit ? acts.edit : null,
    text: allowed.copy ? acts.text : null,
    translation: allowed.translate ? acts.translation : null,
    pictures: allowed.download ? acts.pictures : [],
    link: allowed.link ? acts.link : null,
    markUnread: allowed.markUnread ? acts.markUnread : null,
    remove: allowed.remove ? acts.remove : null,
    report: allowed.report ? acts.report : null,
    block: allowed.block ? acts.block : null,
    failed: acts.failed,
  });
}

export function useMessageControls({
  allowed, acts, reacted, preview, barClassName = '', moreClassName, hidden = false, disabled = false, barRef,
}: {
  allowed: MessageActions;
  acts: MessageActs;
  reacted: (emoji: string) => boolean;
  /** The message, a line of it, at the top of the sheet. */
  preview: { who: string; text: string };
  /** The place's own class on the bar's container (app.css places it; dapp.json selects on it). */
  barClassName?: string;
  /** The place's own class on ⋯. */
  moreClassName?: string;
  /** Laid out but invisible and inert: a send still in flight (#2907). */
  hidden?: boolean;
  /** No bar and no sheet at all (a failed or queued send, an open editor). */
  disabled?: boolean;
  /** The bar's element, for a place that measures it. */
  barRef?: React.RefObject<HTMLDivElement | null>;
}): MessageControls {
  const [picker, setPicker] = useState<'above' | 'below' | null>(null);
  const [menu, setMenu] = useState<'above' | 'below' | null>(null);
  const [sheet, setSheet] = useState(false);
  const ownBar = useRef<HTMLDivElement>(null);
  const bar = barRef || ownBar;
  const moreButton = useRef<HTMLButtonElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const recents = useRecentReactions();
  useDismiss(!!(picker || menu), [bar], () => { setPicker(null); setMenu(null); });

  const react = allowed.react && acts.react ? acts.react : null;
  const reply = allowed.reply && acts.reply ? acts.reply : null;
  const save = allowed.save && acts.save ? acts.save : null;
  const items = messageItems(allowed, acts);
  const sheetItems = messageSheet({ reply, save }, items);

  // A pick from the full picker ADDS the reaction (and makes it recent); it
  // never takes one away, which is what the chip under the message is for.
  const pick = react ? (emoji: string) => {
    rememberReaction(emoji);
    setPicker(null);
    if (!reacted(emoji)) react(emoji);
  } : undefined;
  const tap = react ? (emoji: string) => { setPicker(null); react(emoji); } : undefined;

  const offered = !!(react || reply || save || items.length);
  const longPress = useLongPress(() => setSheet(true), { disabled: disabled || hidden || !offered });

  const barNode = !disabled && offered ? (
    <MessageActionBar
      className={barClassName}
      moreClassName={moreClassName}
      hidden={hidden}
      // What useDismiss measures "outside" against: without it every press —
      // on a menu item or an emoji too — closed the popover before its click.
      barRef={bar}
      recents={recents}
      reacted={reacted}
      onReact={tap}
      pickerOpen={!!picker}
      pickerButtonRef={pickerButton}
      onTogglePicker={react ? () => { setMenu(null); setPicker((open) => (open ? null : placementFor(pickerButton.current, 430))); } : undefined}
      onReply={reply || undefined}
      saved={!!save?.saved}
      onToggleSave={save ? save.toggle : undefined}
      moreOpen={!!menu}
      moreButtonRef={moreButton}
      onToggleMore={items.length ? () => { setPicker(null); setMenu((open) => (open ? null : placementFor(moreButton.current, items.length * 38 + 24))); } : undefined}
    >
      {picker && pick ? <EmojiPicker placement={picker} onPick={pick} onClose={() => setPicker(null)} /> : null}
      {menu ? <MessageMenu items={items} placement={menu} onClose={() => { setMenu(null); moreButton.current?.focus({ preventScroll: true }); }} /> : null}
    </MessageActionBar>
  ) : null;

  const sheetNode = !disabled && offered ? (
    <MessageActionSheet
      open={sheet}
      onClose={() => setSheet(false)}
      recents={recents}
      reacted={reacted}
      onReact={react || undefined}
      onPick={pick}
      items={sheetItems}
      preview={preview}
    />
  ) : null;

  return { bar: barNode, sheet: sheetNode, longPress, reacted, toggleReaction: react };
}
