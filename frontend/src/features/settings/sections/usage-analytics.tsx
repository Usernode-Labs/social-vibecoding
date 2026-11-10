/**
 * Settings › Privacy, its last block: usage data. It sits under who can
 * reach you and who can find you (./privacy.tsx, #5104), on the same page.
 *
 * It says plainly what Homeroom keeps: what it always keeps because the
 * product runs on it, the screen usage data it also records for everyone,
 * and what it never records. There is no switch. Somebody who does not want
 * their screen usage data recorded writes to the data protection address
 * (GET /api/public/waitlist/options data_protection_email, the address the
 * privacy notice gives too), and an admin adds them to Admin › Journey's
 * left-out list as "objected", which erases it and stops it
 * (src/services/usage-analytics.js). It replaces #5593's "Share usage
 * analytics", which was off for everyone and whose Off line said nothing was
 * kept.
 *
 * Static text, so the prerender and the first client render are the same:
 * the address starts as the default and becomes the server's once the
 * options arrive.
 */

import { SectionHeading } from '@/components/ui/field';

import { useMessages } from '../../../lib/i18n/react';
import { useWaitlistOptions } from '../../auth/waitlist-shared';

import { HELP } from './privacy-text';

const DEFAULT_DATA_PROTECTION_EMAIL = 'dataprotection@onhomeroom.com';

export function UsageAnalyticsSection() {
  const t = useMessages('settings');
  const served = useWaitlistOptions()?.data_protection_email;
  const address = typeof served === 'string' && served.includes('@') ? served : DEFAULT_DATA_PROTECTION_EMAIL;

  return (
    <div id="settings-usage-analytics-section" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      <SectionHeading title={t('settings:privacy.usageAnalytics.title')} blurbClassName="dark:text-zinc-400">
        {t('settings:privacy.usageAnalytics.intro')}
      </SectionHeading>
      <div className={`${HELP} mt-3 space-y-3`} data-usage-analytics-kept>
        <div>
          <p className="font-medium text-zinc-700 dark:text-zinc-300">{t('settings:privacy.usageAnalytics.alwaysKept.title')}</p>
          <ul className="mt-1 list-disc ps-5 space-y-0.5">
            <li>{t('settings:privacy.usageAnalytics.alwaysKept.apps')}</li>
            <li>{t('settings:privacy.usageAnalytics.alwaysKept.acts')}</li>
            <li>{t('settings:privacy.usageAnalytics.alwaysKept.challenges')}</li>
          </ul>
        </div>
        <div data-usage-analytics-recorded>
          <p className="font-medium text-zinc-700 dark:text-zinc-300">{t('settings:privacy.usageAnalytics.alsoRecorded.title')}</p>
          <ul className="mt-1 list-disc ps-5 space-y-0.5">
            <li>{t('settings:privacy.usageAnalytics.alsoRecorded.screens')}</li>
            <li>{t('settings:privacy.usageAnalytics.alsoRecorded.speed')}</li>
          </ul>
        </div>
        <p>{t('settings:privacy.usageAnalytics.neverRecorded')}</p>
        <p data-usage-analytics-ask>
          {t('settings:privacy.usageAnalytics.leaveOut.ask')}
          <br />
          <a
            href={`mailto:${address}`}
            className="font-medium text-violet-700 underline underline-offset-2 dark:text-violet-400"
          >{address}</a>
        </p>
      </div>
    </div>
  );
}
