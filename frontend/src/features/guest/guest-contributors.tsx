/**
 * TOP CONTRIBUTORS on a public project's signed-out page (./guest-project.tsx):
 * the member hub's card (dev-board/workshop/hub-cards.tsx ContributorsCard,
 * request 6837), shown to visitors too.
 *
 * The same list and the same rules: up to five people, the most first, each
 * a face, a name and one count in words ("14 contributions": their changes
 * that went live, their votes on changes and the requests they filed); This
 * month or All time, opening on This month, or on All time while nobody has
 * taken part this month; no card until two people have taken part
 * (CONTRIBUTORS_MIN, the hub's HUB_CONTRIBUTORS_MIN); rows open nothing. Its
 * words are the hub's own (`project:hub.contributors.*`).
 *
 * What differs is where it is drawn: the hub's card wears the Workshop's
 * styles, which belong to `#dev-workshop`, so this one is drawn as the rest
 * of the signed-out page is, a small-caps label over a white card of rows,
 * with the shared strip's segment look (@/components/ui/tabs.tsx: the One
 * look's `one-seg`, its pill sliding to the span picked).
 *
 * Read from GET /api/public/apps/:slug/top-contributors (src/routes/
 * public-api.js), which carries a username and a count and nothing else.
 * This is the one place the signed-out page names anybody; the overview it
 * reads for everything else still names nobody.
 */

import { useEffect, useId, useState } from 'react';

import { SectionHeader } from '@/components/ui/grouped-list';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';
import { swatchFor } from '../messages/format';
import { CONTRIBUTORS_MIN, fetchTopContributors, type GuestTopContributors } from './guest-data';
import { PEOPLE_CARD } from './project-card';

const ROW_LINE = 'shadow-[inset_0_-1px_0_var(--app-sheet-line)]';
/** This month | All time, in the order the strip draws them. */
const CONTRIB_SPANS = ['month', 'all'] as const;

/** The card, drawn from a list already read; nothing below CONTRIBUTORS_MIN. */
export function GuestContributorsCard({ data, className }: { data: GuestTopContributors | null; className?: string }) {
  const t = useMessages('project');
  const headId = useId();
  const [picked, setPicked] = useState<'month' | 'all' | null>(null);
  const month = data?.month || [];
  const allTime = data?.all_time || [];
  if (allTime.length < CONTRIBUTORS_MIN) return null;
  const span = picked || (month.length ? 'month' : 'all');
  const people = span === 'month' ? month : allTime;
  return (
    <section data-guest-contributors={span} aria-labelledby={headId} className={className}>
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <SectionHeader id={headId} className="shrink-0 p-0">{t('project:hub.contributors.title')}</SectionHeader>
        <Tabs kind="radio" look="segment" values={CONTRIB_SPANS} value={span} onValueChange={(next) => setPicked(next === 'all' ? 'all' : 'month')}>
          <TabsList aria-label={t('project:hub.contributors.span')}>
            <TabsTrigger value="month" data-guest-contrib-span="month">{t('project:hub.contributors.month')}</TabsTrigger>
            <TabsTrigger value="all" data-guest-contrib-span="all">{t('project:hub.contributors.allTime')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className={cn(PEOPLE_CARD, 'overflow-hidden')}>
        {people.length ? people.map((person, i) => (
          <div
            key={person.username}
            data-guest-contributor={person.username}
            className={cn('flex min-h-[60px] items-center gap-3 px-3.5 py-2.5', i < people.length - 1 ? ROW_LINE : '')}
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white"
              style={{ background: swatchFor(person.username) }}
              aria-hidden="true"
            >
              {(person.username || '?').charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{person.username}</span>
              <span className="block text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
                {t('project:hub.contributors.count', { count: person.n })}
              </span>
            </span>
          </div>
        )) : (
          <p data-guest-contrib-none="" className="px-3.5 py-3 text-[15px] text-zinc-500 dark:text-zinc-400">
            {t('project:hub.contributors.emptyMonth')}
          </p>
        )}
      </div>
    </section>
  );
}

/** The card for a project, read once its page shows (never in a first render). */
export function GuestContributors({ slug, className, initial = null }: {
  slug: string;
  className?: string;
  /** A list already read (tests, and a member's "See what visitors see"). */
  initial?: GuestTopContributors | null;
}) {
  const [data, setData] = useState<GuestTopContributors | null>(initial);
  useEffect(() => {
    if (initial) { setData(initial); return undefined; }
    let live = true;
    setData(null);
    void fetchTopContributors(slug).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [slug, initial]);
  return <GuestContributorsCard data={data} className={className} />;
}
