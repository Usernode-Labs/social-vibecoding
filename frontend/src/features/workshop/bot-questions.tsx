/**
 * #6019: the questions Homeroom bot asked you about your requests, at the
 * top of Needs you (GET /api/workshop/bot-questions).
 *
 *   HOMEROOM BOT ASKED YOU
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Newest first, or oldest first?                         › │
 *   │ Seed swap · Request #7                                   │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The bot asks in the request's public discussion, where its group can see
 * it, so a row opens the request and it is answered there. The chat with
 * the bot (the AI tab) is private. Nothing is drawn when nothing is asked,
 * and nothing before the read lands: the first render is the prerender's.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';

export interface BotQuestionRow {
  messageId: number;
  appSlug: string;
  appName: string;
  issueNumber: number;
  question: string | null;
  at?: string | null;
}

/** A question's request page, the in-app address its row opens. */
export function questionHref(q: Pick<BotQuestionRow, 'appSlug' | 'issueNumber'>): string {
  return `#app/${encodeURIComponent(q.appSlug)}/dev/issues/${Number(q.issueNumber)}`;
}

export function BotQuestions(): ReactNode {
  const t = useMessages('communities');
  const [rows, setRows] = useState<BotQuestionRow[]>([]);
  useEffect(() => {
    let live = true;
    fetch('/api/workshop/bot-questions', { credentials: 'same-origin', cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (live && data && Array.isArray(data.questions)) setRows(data.questions); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  if (!rows.length) return null;
  return (
    <section data-bot-questions={rows.length} aria-label={t('communities:needs.botAsked.label')}>
      <SectionHeader>{t('communities:needs.botAsked.label')}</SectionHeader>
      <GroupedList>
        {rows.map((q) => (
          <ListRow
            key={q.messageId}
            as="a"
            href={questionHref(q)}
            title={q.question || t('communities:needs.botAsked.untitled')}
            subtitle={t('communities:needs.botAsked.where', { project: q.appName, number: q.issueNumber })}
            data-bot-question={q.messageId}
          />
        ))}
      </GroupedList>
    </section>
  );
}
