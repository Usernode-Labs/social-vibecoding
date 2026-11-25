/** The reference's recent-activity list, drawn from real merged changes. */
import { CheckIcon } from '@/components/ui/icons';
import { changeHref } from '../../lib/change-href';
import { useMessages } from '../../lib/i18n/react';
import { relativeDate } from './profile-store.js';

type RecentChange = { sessionId: number; prNumber?: number | null; title: string; appSlug: string; appName: string; mergedAt?: string | null };
export function ProfileRecentActivity({ changes, limit = 3, empty = false }: { changes: RecentChange[]; limit?: number; empty?: boolean }) {
  const t = useMessages('profile');
  const tm = useMessages('messages');
  if (!changes.length && !empty) return null;
  return <section id="profile-recent-activity">
    <div className="profile-recent-heading">
      <h2>{t('profile:recent.title')}</h2>
      {changes.length ? <a href="#homeroom-bot/history?kind=change">{t('profile:recent.all')}</a> : null}
    </div>
    {changes.length ? <ul>
      {changes.slice(0, limit).map((change) => {
        const when = relativeDate(change.mergedAt);
        return <li key={change.sessionId}>
          <a href={changeHref(change.appSlug, change.sessionId, change.prNumber)}>
            <span className="profile-recent-icon"><CheckIcon aria-hidden="true"/></span>
            <span className="profile-recent-copy"><strong>{change.appName}</strong><span>{change.title}</span></span>
            {when ? <time dateTime={change.mergedAt || undefined}>{when}</time> : null}
          </a>
        </li>;
      })}
    </ul> : <ul><li className="profile-recent-empty">{tm('messages:ai.history.empty')}</li></ul>}
  </section>;
}
