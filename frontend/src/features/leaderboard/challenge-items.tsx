// #7152: the viewer's own reports or proposals on a challenge's page, each
// with the status the count gives it. A read-only list: every row is a link
// to the request or change, and the word on the right says where it stands.
//
// It is the *Your invites* list's layout (./challenges-pane.tsx InviteList):
// a small-caps heading, one card of rows, the title over a grey reason line
// that may wrap, and the status word on the trailing edge. Unlike an invite
// row, these rows open something, so they carry the chevron and are anchors.

import type { ReactNode } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { changeHref } from '../../lib/change-href';
import { useMessages } from '../../lib/i18n/react';

export type ItemLink =
  | { kind: 'request'; slug: string; number: number }
  | { kind: 'change'; slug: string; session_id: number; pr_number?: number | null }
  | null;

export type ItemView = {
  key: string;
  title: string;
  subtitle: string;
  word: string;
  accent: boolean;
  counted: boolean;
  link: ItemLink;
};

export type ItemsView = {
  state: 'loading' | 'error' | 'ready';
  kind: 'feedback' | 'proposals';
  weekly: boolean;
  rows?: ItemView[];
};

// Counted is the green a finished thing earns, the way Your invites draws it;
// Up for vote is the accent, because it asks for a vote.
const COUNTED = 'text-sm font-medium text-emerald-700 dark:text-emerald-400';
const MUTED = 'text-sm font-medium text-zinc-500 dark:text-zinc-400';
const ACCENT = 'text-sm font-medium text-violet-700 dark:text-violet-400';
const RETRY = 'flex h-12 items-center justify-center self-start rounded-[0.875rem] bg-violet-600 px-4 '
  + 'text-[0.9375rem] font-semibold text-white transition-colors hover:bg-violet-500';

function hrefOf(link: ItemLink): string | null {
  if (!link) return null;
  if (link.kind === 'request') {
    const number = Number(link.number);
    if (!link.slug || !Number.isInteger(number) || number <= 0) return null;
    return `#app/${encodeURIComponent(link.slug)}/dev/issues/${number}`;
  }
  if (link.kind === 'change') {
    const id = Number(link.session_id);
    if (!link.slug || !Number.isInteger(id) || id <= 0) return null;
    return changeHref(link.slug, id, link.pr_number);
  }
  return null;
}

export function ChallengeItemList({ view }: { view: ItemsView }): ReactNode {
  const t = useMessages('leaderboard');
  const heading = view.weekly
    ? t(`leaderboard:challenges.items.heading.${view.kind}Week`)
    : t(`leaderboard:challenges.items.heading.${view.kind}`);
  if (view.state === 'loading') {
    return (
      <section data-tc-items className="flex flex-col">
        <SectionHeading title={heading} />
        <SkeletonGroup label={heading}>
          <GroupedList className="mx-0">
            {Array.from({ length: 3 }, (_, i) => (
              <ListRow
                key={i}
                chevron={false}
                title={<Skeleton shape="block" className="h-4 w-28" />}
                subtitle={<Skeleton shape="block" className="mt-1 h-3 w-full" />}
              />
            ))}
          </GroupedList>
        </SkeletonGroup>
      </section>
    );
  }
  if (view.state === 'error' || !view.rows?.length) {
    return (
      <section data-tc-items className="flex flex-col">
        <SectionHeading title={heading} />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {view.state === 'error'
            ? t('leaderboard:challenges.items.error')
            : t(`leaderboard:challenges.items.empty.${view.kind}`)}
        </p>
        {view.state === 'error' ? (
          <button
            type="button" id="tc-se-items-retry" className={RETRY}
            onClick={() => (window as {
              TopochainChallenges?: { retryItems(): void };
            }).TopochainChallenges?.retryItems()}
          >{t('leaderboard:bp.error.retry')}</button>
        ) : null}
      </section>
    );
  }
  return (
    <section data-tc-items className="flex flex-col">
      <SectionHeading title={heading} />
      <GroupedList className="mx-0">
        {view.rows.map((row) => {
          const href = hrefOf(row.link);
          const wordClass = row.accent ? ACCENT : (row.counted ? COUNTED : MUTED);
          return (
            <ListRow
              key={row.key}
              as={href ? 'a' : 'div'}
              href={href || undefined}
              chevron={!!href}
              title={row.title}
              subtitle={row.subtitle}
              subtitleClassName="whitespace-normal"
              trailing={<span className={wordClass}>{row.word}</span>}
            />
          );
        })}
      </GroupedList>
    </section>
  );
}
