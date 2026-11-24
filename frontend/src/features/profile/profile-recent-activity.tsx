/** The reference's recent-activity list, drawn from real merged changes. */
import { CheckIcon } from '@/components/ui/icons';
import { changeHref } from '../../lib/change-href';
import { useMessages } from '../../lib/i18n/react';
import { relativeDate } from './profile-store.js';

type RecentChange = { sessionId: number; prNumber?: number | null; title: string; appSlug: string; appName: string; mergedAt?: string | null };
export function ProfileRecentActivity({ changes }: { changes: RecentChange[] }) {
  const t = useMessages('profile');
  if (!changes.length) return null;
  return <section id="profile-recent-activity">
    <div className="profile-recent-heading">
      <h2>{t('profile:recent.title')}</h2>
      <a href="#homeroom-bot/history?kind=change">{t('profile:recent.all')}</a>
    </div>
    <ul>
      {changes.slice(0, 3).map((change) => {
        const when = relativeDate(change.mergedAt);
        return <li key={change.sessionId}>
          <a href={changeHref(change.appSlug, change.sessionId, change.prNumber)}>
            <span className="profile-recent-icon"><CheckIcon aria-hidden="true"/></span>
            <span className="profile-recent-copy"><strong>{change.appName}</strong><span>{change.title}</span></span>
            {when ? <time dateTime={change.mergedAt || undefined}>{when}</time> : null}
          </a>
        </li>;
      })}
    </ul>
  </section>;
}
