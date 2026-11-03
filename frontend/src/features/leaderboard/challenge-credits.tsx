import type { ReactNode } from 'react';

import { SectionHeading } from '@/components/ui/field';

import { changeHref } from '../../lib/change-href';
import { useMessages } from '../../lib/i18n/react';
import { ActivityRow, type ActivityTimePrecision } from './activity-row';

export type CreditView = {
  text: string;
  points: number;
  at?: string | null;
  precision?: ActivityTimePrecision | null;
  change: { slug: string; sessionId: number; prNumber?: number | null } | null;
};

/**
 * #3247: which of the viewer's actions made a challenge's count. A credit with
 * a change it can show links to that change. The address is built here from
 * its parts, never taken from the payload, and this sits outside the pane so
 * the pane's one href stays the guarded action.
 */
export function CreditList({ credits, weekly }: { credits?: CreditView[]; weekly?: boolean }): ReactNode {
  const t = useMessages('leaderboard');
  if (!credits || !credits.length) return null;
  return (
    <section id="tc-se-detail-credits" className="flex flex-col">
      <SectionHeading
        title={weekly ? t('leaderboard:challenges.detail.countedWeek') : t('leaderboard:challenges.detail.counted')}
      />
      <ul className="space-y-1">
        {credits.map((credit, i) => (
          <ActivityRow
            key={i}
            text={credit.text}
            points={`+${credit.points}`}
            at={credit.at}
            precision={credit.precision}
            href={credit.change
              ? changeHref(credit.change.slug, credit.change.sessionId, credit.change.prNumber)
              : null}
          />
        ))}
      </ul>
    </section>
  );
}
