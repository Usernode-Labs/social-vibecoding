/**
 * #6019 (threads, stage 6): competing changes in one thread, as one ballot
 * (./thread-model.ts ballotOf).
 *
 *   PICK ONE
 *   These changes are for the same thing. The first one approved goes live,
 *   and the others close.
 *   ( ) Change #8: Dark mode toggle
 *   ( ) Change #9: Dark mode by schedule
 *   ( ) Neither
 *
 * A pick is ordinary votes, cast the platform's own way (AppView.castVote /
 * retractVote, with each change's approval epoch): Yes on the one picked and
 * its Yes taken back from the others, or No on each for Neither. Each change
 * keeps its own vote underneath, so a push to one clears only its own.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { SectionHeader } from '@/components/ui/grouped-list';
import { ballotOf, ballotVotes, type ThreadPayload } from './thread-model';

function appView(): any {
  return typeof window !== 'undefined' ? (window as any).AppView : null;
}

export function ThreadBallot({ data, onChanged }: { data: ThreadPayload; onChanged: () => void }): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  const ballot = ballotOf(data);
  if (!ballot) return null;
  const choose = async (pick: number | 'neither') => {
    const av = appView();
    if (busy || !av) return;
    setBusy(true);
    try {
      for (const v of ballotVotes(ballot, pick)) {
        if (v.vote === null) await av.retractVote?.(v.sessionId, v.epoch);
        else await av.castVote?.(v.sessionId, v.vote, v.epoch);
      }
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const name = `thread-ballot-${data.thread.id}`;
  return (
    <section className="mt-3" data-thread-ballot={ballot.options.length} aria-busy={busy}>
      <SectionHeader className="px-0 pb-1 pt-2">{t('project:topic.thread.ballot.label')}</SectionHeader>
      <p className="text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{t('project:topic.thread.ballot.about')}</p>
      <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label={t('project:topic.thread.ballot.label')}>
        {ballot.options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-[0.9375rem]" data-ballot-option={o.id}>
            <input type="radio" name={name} checked={ballot.pick === o.id} disabled={busy} onChange={() => { void choose(o.id); }} />
            <span className="min-w-0 truncate">
              {o.number ? t('project:topic.thread.ballot.option', { number: o.number, title: o.title || '' }) : (o.title || '')}
            </span>
          </label>
        ))}
        <label className="flex items-center gap-2 text-[0.9375rem]" data-ballot-option="neither">
          <input type="radio" name={name} checked={ballot.pick === 'neither'} disabled={busy} onChange={() => { void choose('neither'); }} />
          <span>{t('project:topic.thread.ballot.neither')}</span>
        </label>
      </div>
    </section>
  );
}
