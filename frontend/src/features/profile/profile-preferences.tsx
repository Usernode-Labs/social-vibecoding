/** The reference's preference card and page links, using existing destinations. */
import { BellIcon, ChevronRightIcon, CogIcon, ShieldCheckIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';

export function ProfilePreferences() {
  const t = useMessages('profile');
  return <section id="profile-preferences" className="profile-preferences-card">
    <h2>{t('profile:preferences.title')}</h2>
    <a href="#settings/theme"><CogIcon aria-hidden="true"/><span>{t('profile:preferences.appearance')}</span><ChevronRightIcon aria-hidden="true"/></a>
    <a href="#settings/alerts"><BellIcon aria-hidden="true"/><span>{t('profile:settings.notifications.title')}</span><ChevronRightIcon aria-hidden="true"/></a>
    <a href="#settings/privacy"><ShieldCheckIcon aria-hidden="true"/><span>{t('profile:preferences.privacy')}</span><ChevronRightIcon aria-hidden="true"/></a>
  </section>;
}

export function ProfileSectionLinks() {
  const t = useMessages('profile');
  return <nav className="profile-section-links" aria-label={t('profile:sections.label')}>
    <a href="#profile" aria-current="page">{t('profile:sections.projects')}</a>
    <a href="#homeroom-bot/history?kind=change">{t('profile:sections.changes')}</a>
    <a href="#homeroom-bot/history?kind=request">{t('profile:sections.requests')}</a>
    <a href="#homeroom-bot/history?kind=vote">{t('profile:sections.votes')}</a>
    <button type="button" onClick={() => document.getElementById('profile-activity')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}>{t('profile:sections.activity')}</button>
  </nav>;
}
