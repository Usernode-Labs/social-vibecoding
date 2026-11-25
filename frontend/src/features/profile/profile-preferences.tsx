/** The reference's preference card and page links, using existing destinations. */
import { BellIcon, ChevronRightIcon, CogIcon, ShieldCheckIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { tabAddress, type YouTab } from './frame/you-tabs';
import { Profile } from './profile.js';

export function ProfilePreferences() {
  const t = useMessages('profile');
  return <section id="profile-preferences" className="profile-preferences-card">
    <h2>{t('profile:preferences.title')}</h2>
    <a href="#settings/theme"><CogIcon aria-hidden="true"/><span>{t('profile:preferences.appearance')}</span><ChevronRightIcon aria-hidden="true"/></a>
    <a href="#settings/alerts"><BellIcon aria-hidden="true"/><span>{t('profile:settings.notifications.title')}</span><ChevronRightIcon aria-hidden="true"/></a>
    <a href="#settings/privacy"><ShieldCheckIcon aria-hidden="true"/><span>{t('profile:preferences.privacy')}</span><ChevronRightIcon aria-hidden="true"/></a>
  </section>;
}

/** The five tabs of the standard profile (#7134). The row looks like tabs, so
 *  it works like tabs: pressing one switches the column below it in place and
 *  stays on the profile, and only the tab that is up wears the sun underline.
 *  A modified click still opens the address in a new tab, as a link would. */
const SECTION_TABS = [
  ['overview', 'profile:sections.projects'],
  ['changes', 'profile:sections.changes'],
  ['requests', 'profile:sections.requests'],
  ['votes', 'profile:sections.votes'],
  ['activity', 'profile:sections.activity'],
] as const;

export function ProfileSectionLinks({ tab }: { tab: string }) {
  const t = useMessages('profile');
  // A tab of another look (Friends) lights Projects: this row has no such tab.
  const current = SECTION_TABS.some(([key]) => key === tab) ? tab : 'overview';
  return <nav className="profile-section-links" aria-label={t('profile:sections.label')}>
    {SECTION_TABS.map(([key, label]) => (
      <a
        key={key}
        href={tabAddress(key as YouTab)}
        aria-current={current === key ? 'page' : undefined}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          Profile.showTab(key as YouTab);
        }}
      >{t(label)}</a>
    ))}
  </nav>;
}
