/**
 * THE MESSAGE MENU, WRITTEN ONCE: the ⋯ menu a message row opens, and the
 * long-press sheet that leads with Reply and Save, for every chat.
 *
 * Two lists used to build this menu: a Messages conversation's row
 * (../messages/message-row.tsx) and a project channel's or a thread's row
 * (../group-chat/transcript.tsx). They held the same acts in the same order
 * and had already started to drift: the same words in two catalogs, Translate
 * in one only, a delete or block confirmation worded twice, and a failed act
 * shown three ways. This module decides the list (which item, in which order,
 * its words, its icon, its divider, the confirmation a destructive act asks
 * for and what a success says). A row passes only what its place can do,
 * and the acts that go to its place's own store or socket.
 *
 * The order:
 *
 *   Make this a request · Reply in thread / View thread · Edit message ·
 *   Copy text · Translate · Download image · Copy link to message ·
 *   Mark unread · ── Delete message  |  ── Report message · Block
 *
 * Items show or hide by place. Make this a request is a project channel's
 * (Homeroom bot files the request); Translate is offered where the row can
 * ask for a translation; Report and Block are for somebody else's message,
 * Delete for your own. A place leaves out what it cannot do.
 */

import {
  BookmarkIcon, BookmarkSolidIcon, ChatIcon, CopyIcon, DownloadIcon, DraftTrashIcon, EnvelopeIcon, FlagIcon, GlobeIcon,
  LinkIcon, NoSymbolIcon, PencilSquareIcon, ReplyArrowIcon, ThreadIcon,
} from '@/components/ui/icons';

import { confirmAction } from '../../lib/confirm';
import { t } from '../../lib/i18n/runtime';
import { downloadLabel, downloadableImages, saveImages, type SaveableImage } from '../image-viewer/save-image';
import type { TranslateView } from '../messages/translate';
import type { MenuItem } from './action-bar';
import { absoluteLink, copyToClipboard, toast } from './clipboard';

/**
 * Who a Block item names: the name as the place writes it ("@ada" in a
 * channel, "ada" in a direct message), or a stand-in for an author with no
 * name. `handle`: the account is there, its name is not ("@unknown").
 */
export type BlockWho = { name: string } | { unknown: 'handle' | 'nameless' };

export interface MessageMenuSpec {
  /** Hand the message to Homeroom bot as a request, in its author's words. */
  makeRequest?: (() => void) | null;
  /** The thread under the message: whether one has started, and how to open it. */
  thread?: { started: boolean; open: () => void } | null;
  /** Edit your own message. */
  edit?: (() => void) | null;
  /** The words to copy; no Copy text without them. */
  text?: string | null;
  /** The row's translation (../messages/translate.tsx), where it offers one. */
  translation?: Pick<TranslateView, 'state' | 'ask' | 'toggle'> | null;
  /** The message's pictures, which Download image saves to the device. */
  pictures?: SaveableImage[];
  /** The message's own address, which Copy link to message copies. */
  link?: string | null;
  /** Mark it unread; the promise settles when the place has done it. */
  markUnread?: (() => Promise<unknown>) | null;
  /** Delete your own message, once its author has confirmed it. */
  remove?: (() => Promise<unknown>) | null;
  /** Report somebody else's message. */
  report?: (() => void) | null;
  /** Block its author, once confirmed. `busy` while a block is on its way. */
  block?: { who: BlockWho; run: () => Promise<unknown>; busy?: boolean } | null;
  /** Where a failed act says so. `fallback` is the menu's own sentence for it. */
  failed: (error: unknown, fallback: string) => void;
}

function blockLabel(who: BlockWho): string {
  if ('name' in who) return t('messages:row.menu.block', { name: who.name });
  return who.unknown === 'handle' ? t('messages:row.menu.blockUnknownHandle') : t('messages:row.menu.blockUnknown');
}

function blockTitle(who: BlockWho): string {
  if ('name' in who) return t('messages:row.block.title', { name: who.name });
  return who.unknown === 'handle' ? t('messages:row.block.titleUnknownHandle') : t('messages:row.block.titleUnknown');
}

function translateLabel(state: TranslateView['state']): string {
  // #6081: while it is being translated the words stay as written and the
  // item says so, rather than offering a second tap that does nothing.
  if (state === 'pending') return t('messages:translate.pending');
  if (state === 'shown') return t('messages:row.menu.showOriginal');
  if (state === 'original') return t('messages:row.menu.showTranslation');
  return t('messages:row.menu.translate');
}

/** The ⋯ menu's items, in the one order, for what this message's place can do. */
export function messageMenu(spec: MessageMenuSpec): MenuItem[] {
  const items: MenuItem[] = [];
  // B9: hand one of your own messages to Homeroom bot, in your words.
  if (spec.makeRequest) items.push({ key: 'ask-bot', label: t('messages:row.menu.makeRequest'), icon: ChatIcon, onSelect: spec.makeRequest });
  const thread = spec.thread;
  if (thread) {
    items.push({ key: 'thread', label: thread.started ? t('messages:row.menu.viewThread') : t('messages:row.menu.replyInThread'), icon: ThreadIcon, onSelect: thread.open });
  }
  if (spec.edit) items.push({ key: 'edit', label: t('messages:row.menu.edit'), icon: PencilSquareIcon, onSelect: spec.edit });
  const text = spec.text || '';
  if (text) items.push({ key: 'copy', label: t('messages:row.menu.copyText'), icon: CopyIcon, onSelect: () => { void copyToClipboard(text, t('messages:row.textCopied')); } });
  // #6081: someone else's words, in the reader's language. One more item in
  // the same menu, so a chat does not fill up with a button on every message.
  const translation = spec.translation;
  if (translation) {
    items.push({
      key: 'translate', label: translateLabel(translation.state), icon: GlobeIcon, disabled: translation.state === 'pending',
      onSelect: () => {
        if (translation.state === 'shown' || translation.state === 'original') translation.toggle();
        else translation.ask();
      },
    });
  }
  // #4055: its pictures onto the device, whoever sent them.
  const pictures = downloadableImages(spec.pictures || []);
  if (pictures.length) items.push({ key: 'download', label: downloadLabel(pictures.length), icon: DownloadIcon, onSelect: () => { void saveImages(pictures); } });
  const link = spec.link;
  if (link) items.push({ key: 'link', label: t('messages:row.menu.copyLink'), icon: LinkIcon, onSelect: () => { void copyToClipboard(absoluteLink(link), t('messages:row.linkCopied')); } });
  const markUnread = spec.markUnread;
  if (markUnread) {
    items.push({
      key: 'unread', label: t('messages:row.menu.markUnread'), icon: EnvelopeIcon,
      onSelect: () => {
        markUnread().then(() => toast(t('messages:row.markedUnread'))).catch((error) => spec.failed(error, t('messages:row.error.unread')));
      },
    });
  }
  const remove = spec.remove;
  if (remove) {
    items.push({
      key: 'delete', label: t('messages:row.menu.delete'), icon: DraftTrashIcon, danger: true, separated: true,
      // QA 2026-09-24 Q15: the app's confirm dialog, not window.confirm().
      onSelect: () => {
        void confirmAction({
          title: t('messages:row.delete.title'),
          message: t('messages:row.delete.message'),
          confirmLabel: t('messages:row.delete.confirm'),
          danger: true,
        }).then((ok) => {
          if (ok) remove().catch((error) => spec.failed(error, t('messages:row.error.delete')));
        });
      },
    });
  }
  // Report opens the shared reporting dialog (../dialogs/report.tsx), which
  // feeds the platform's one moderation queue (#2721); the place says what
  // is reported.
  if (spec.report) items.push({ key: 'report', label: t('messages:row.menu.report'), icon: FlagIcon, separated: true, onSelect: spec.report });
  const block = spec.block;
  if (block) {
    items.push({
      key: 'block', label: blockLabel(block.who), icon: NoSymbolIcon, danger: true, disabled: !!block.busy,
      // The divider goes above the first of the hard acts: Report when it is there.
      ...(spec.report ? {} : { separated: true }),
      onSelect: () => {
        void confirmAction({
          title: blockTitle(block.who),
          message: t('messages:row.block.message'),
          confirmLabel: t('messages:row.block.confirm'),
          danger: true,
        }).then((ok) => {
          if (ok) block.run().catch((error) => spec.failed(error, t('messages:row.error.block')));
        });
      },
    });
  }
  return items;
}

/**
 * The phone's long-press sheet: the bar's Reply and Save first, then the
 * same menu. A place leaves out Reply where its reader cannot reply, and
 * Save where its messages cannot be saved.
 */
export function messageSheet(
  acts: { reply?: (() => void) | null; save?: { saved: boolean; toggle: () => void } | null },
  items: MenuItem[],
): MenuItem[] {
  const head: MenuItem[] = [];
  if (acts.reply) head.push({ key: 'reply', label: t('messages:row.sheet.reply'), icon: ReplyArrowIcon, onSelect: acts.reply });
  const save = acts.save;
  if (save) head.push({ key: 'save', label: save.saved ? t('messages:row.sheet.unsave') : t('messages:row.sheet.save'), icon: save.saved ? BookmarkSolidIcon : BookmarkIcon, onSelect: save.toggle });
  return [...head, ...items];
}
