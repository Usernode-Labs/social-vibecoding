import { DraftEditIcon, DraftSendIcon, DraftTrashIcon } from '@/components/ui/icons';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import type { SavedDraft } from './bot-drafts';

/**
 * The saved drafts above the message box in the chat with Homeroom bot
 * (./bot-drafts.ts): the agent session's list, drawn as it is there
 * (features/agent-session/index.tsx SavedDrafts) so the two read as one
 * thing. Each draft can be sent once the bot is free, put back in the box
 * to reword, or deleted. Sending is always a tap here, never automatic.
 *
 * Nothing is drawn with no drafts, so the box does not move for a list that
 * is not there; and a first render has none (the list is read in an effect).
 * The heading is a small line of text, not a heading of the page.
 */
export function BotSavedDrafts({ drafts, busy, held = false, onSend, onEdit, onDelete }: {
  drafts: readonly SavedDraft[];
  /** Homeroom bot is working here: sending waits for it. */
  busy: boolean;
  /** The box cannot send right now (a file on its way up, dictation running). */
  held?: boolean;
  onSend: (draft: SavedDraft) => void;
  onEdit: (draft: SavedDraft) => void;
  onDelete: (draft: SavedDraft) => void;
}) {
  const t = useMessages('messages');
  if (!drafts.length) return null;
  const button = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors '
    + 'hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent '
    + 'dark:text-zinc-400 dark:hover:bg-zinc-800';
  return (
    <section
      aria-label={t('messages:drafts.label')}
      className="mb-2 max-h-40 overflow-y-auto rounded-2xl bg-zinc-100 p-1.5 dark:bg-zinc-800/70"
      data-bot-drafts={drafts.length}
    >
      <p className="flex flex-wrap items-baseline gap-x-1.5 px-2 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <RichMessage
          id="messages:drafts.heading"
          values={{ count: drafts.length }}
          components={[<span className="font-semibold uppercase tracking-wide" />, <span />]}
        />
        {busy
          ? <span className="ms-auto" data-bot-drafts-locked="">{t('messages:drafts.locked')}</span>
          : <span className="ms-auto font-semibold text-violet-700 dark:text-violet-300" data-bot-drafts-ready="">{t('messages:drafts.ready')}</span>}
      </p>
      <ul className="flex flex-col gap-1">
        {drafts.map((draft) => (
          <li
            key={draft.id}
            className="flex items-center gap-0.5 rounded-xl bg-white py-0.5 ps-3 pe-0.5 dark:bg-zinc-900"
            data-bot-draft={draft.id}
          >
            <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200" title={draft.text}>{draft.text}</span>
            <button
              type="button"
              className={`${button} hover:text-emerald-700 dark:hover:text-emerald-400`}
              aria-label={t('messages:drafts.send')}
              title={busy ? t('messages:drafts.sendBusyTitle') : t('messages:drafts.sendTitle')}
              disabled={busy || held}
              data-bot-draft-send=""
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSend(draft)}
            >
              <DraftSendIcon width={16} height={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${button} hover:text-violet-700 dark:hover:text-violet-300`}
              aria-label={t('messages:drafts.edit')}
              title={t('messages:drafts.editTitle')}
              data-bot-draft-edit=""
              onClick={() => onEdit(draft)}
            >
              <DraftEditIcon width={16} height={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${button} hover:text-red-700 dark:hover:text-red-300`}
              aria-label={t('messages:drafts.delete')}
              title={t('messages:drafts.delete')}
              data-bot-draft-delete=""
              onClick={() => onDelete(draft)}
            >
              <DraftTrashIcon width={16} height={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
