/**
 * YOUR WORK, one row (5 Nov 2026): how much of yours there is on this project
 * and a door to it, on the Homeroom bot tab narrowed to the project
 * (../../ai/desk.ts, ../../ai/filter-address.ts). The tab is the desk for
 * everything of yours, so the Workshop and the Hub no longer list your work a
 * second time, each in its own words; they say how much there is, in the
 * tab's words, and open it:
 *
 *   [bot] Your work                    Needs you: 2 · In progress: 1  ›
 *         Next: Dark mode
 *
 * The Workshop draws it as a card of its own under Overview (YourWorkCard).
 * Until 6 Nov 2026 the Hub's For you card drew the same row among its doors
 * (hub-cards.tsx); that row is the Workshop's now, at every width.
 * It replaced the Workshop's Waiting on you, Your work and Up next, and the
 * Hub's Your work row, which counted from the board's own buckets.
 *
 * 10 Nov 2026: for somebody who has made nothing on the project yet, the
 * Workshop's card asks who should build instead (./first-change.tsx), until
 * they close it or make something.
 *
 * 14 Nov 2026: the Workshop's card has a second row under the first, a new
 * chat with Homeroom bot about this project:
 *
 *   [+]   New chat about Garden club
 *         Ask Homeroom bot for a change, a fix or an answer
 *
 * Every conversation with the bot is a thread now (Main Chat is gone), so a
 * project's own door to the bot starts one, already set to the project
 * (../../ai/door.ts botNewAddress: `#homeroom-bot/new?project=<slug>`). The
 * first-change card keeps its own rows: its Homeroom bot row is the same
 * door, so this one is not drawn beside it.
 *
 * An anchor, so the browser's own ways to open a link work on it. The first
 * render is the prerender's: the title and nothing else until the lists are
 * read (an effect).
 */

import type { ReactNode } from 'react';

import { ListRow } from '@/components/ui/grouped-list';
import { PlusIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { deskLine, deskWords, useDesk } from '../../ai/desk';
import { botNewAddress } from '../../ai/door';
import { projectTabAddress } from '../../ai/filter-address';
import { BOT_AVATAR } from '../../messages/format';
import { FirstChangeCard, useFirstChange } from './first-change';

export function YourWorkRow({ slug, name, className = '', ...hooks }: {
  slug: string;
  /** The project's name, for the row's tooltip. */
  name: string;
  className?: string;
  [hook: `data-${string}`]: string | undefined;
}): ReactNode {
  const t = useMessages('project');
  const desk = useDesk(slug);
  const words = deskWords(desk);
  const line = deskLine(desk);
  return (
    <ListRow
      as="a"
      href={projectTabAddress(slug)}
      inset="none"
      className={className}
      tooltip={t('project:workshop.desk.open', { project: name })}
      data-ws-desk-open=""
      data-ws-desk-ready={desk.ready ? '' : undefined}
      {...hooks}
      leading={<img src={BOT_AVATAR} alt="" className="h-[34px] w-[34px] shrink-0 rounded-[10px] object-cover" />}
      title={t('project:workshop.desk.title')}
      subtitle={line ? <span data-ws-desk-line={desk.first ? 'next' : 'empty'}>{t(line.id, line.values)}</span> : undefined}
      trailing={words ? (
        <span className="shrink-0 text-[13px] text-zinc-500 dark:text-zinc-400" data-ws-desk-count="">
          <RichMessage
            id={words.id}
            values={words.values}
            components={[<strong className="font-semibold text-violet-700 dark:text-violet-300" />]}
          />
        </span>
      ) : undefined}
    />
  );
}

/**
 * A new chat with Homeroom bot about this project: the Your work card's
 * second row. An anchor to the tab's New chat, set to the project, with a
 * plus tile where the first row has the bot's picture.
 */
export function NewChatRow({ slug, name, className = '' }: { slug: string; name: string; className?: string }): ReactNode {
  const t = useMessages('project');
  return (
    <ListRow
      as="a"
      href={botNewAddress({ project: slug })}
      inset="none"
      className={className}
      data-ws-desk-new=""
      leading={(
        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] bg-zinc-200/70 text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-200">
          <PlusIcon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
      )}
      title={t('project:workshop.desk.newChat', { project: name })}
      subtitle={t('project:workshop.desk.newChatSub')}
    />
  );
}

/** The Workshop's Your work: the row and, under it, New chat about the project, in a card of their own under Overview. */
export function YourWorkCard({ slug, name }: { slug: string; name: string }): ReactNode {
  // The desk is read once for every row on screen (../../ai/desk.ts), so
  // asking here as well as in the row costs no second read.
  const first = useFirstChange(slug, useDesk(slug));
  if (first.show) return <FirstChangeCard slug={slug} onClose={first.close} />;
  return (
    <section className="dev-ws-strip dev-ws-desk" data-ws-desk="">
      <YourWorkRow slug={slug} name={name} className="rounded-[14px] px-1 py-2" />
      <div className="mx-1 border-t border-[color:var(--app-sheet-line)]" aria-hidden="true" />
      <NewChatRow slug={slug} name={name} className="rounded-[14px] px-1 py-2" />
    </section>
  );
}
