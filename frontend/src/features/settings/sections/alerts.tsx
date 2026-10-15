import { SectionHeading, StatusLine } from '@/components/ui/field';

import { NotificationPrefsList } from '../notification-prefs-list';
import { SwitchRow } from '@/components/ui/switch';
import { useMessages } from '../../../lib/i18n/react';

/**
 * #138: Dev-chat sound & alerts (default ON). Client-only preference
 * (localStorage key devchat_alerts_enabled); wired in settings.js. Plays a
 * chime when an AI dev-chat turn finishes while you're in the app, or a system
 * notification when it's in the background.
 *
 * Below it, the mobile push categories. Those rows are NOT SwitchRows: their
 * shape is the other way round (caption block first, switch right-aligned and
 * top-aligned) and their checkbox writes `type`/`class`/`disabled` in that
 * order, which the primitive's prop order does not produce. They stay literal
 * — the same call alert.tsx makes for the banner with a display conflict.
 *
 * They are also seven WRITTEN-OUT rows rather than a map over a table, which
 * looks like the obvious deduplication and is not one:
 * tests/settings-mobile-push.test.js reads the label and blurb of every
 * category out of this file's SOURCE, and asserts that no internal
 * notification identifier (`mention`, `stale_pr`, `pr_proposed`, …) ever
 * appears between a `>` and a `<`. Hoisting the copy into a table would leave
 * that last check matching nothing at all — green, and no longer testing
 * anything.
 */
export function AlertsSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="alerts" className="hidden">
      <div id="settings-alerts-section">
        <SectionHeading title={t('settings:alerts.title')}>
          {t('settings:alerts.intro')}
        </SectionHeading>
        <SwitchRow id="devchat-alerts-toggle">
          {t('settings:alerts.toggle.label')}
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          {t('settings:alerts.toggle.description')}
        </p>
        <button
          id="devchat-alerts-test"
          type="button"
          className="mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          {t('settings:alerts.test')}
        </button>
        <StatusLine
          as="p"
          id="devchat-alerts-test-status"
          size="xs"
          className="text-zinc-500 dark:text-zinc-400"
        />

        <div
          id="settings-mobile-push-preferences"
          className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
        >
          <SectionHeading title={t('settings:alerts.push.title')} blurbClassName="leading-relaxed">
            {t('settings:alerts.push.intro')}
          </SectionHeading>
          <div className="space-y-3">
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="messages">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.messages.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.messages.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="builds">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.builds.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.builds.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="invite_activity">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.inviteActivity.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.inviteActivity.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="direct_interactions">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.directInteractions.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.directInteractions.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="invitations">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.invitations.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.invitations.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="shared_work">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.sharedWork.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.sharedWork.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="developer_sessions">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.developerSessions.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.developerSessions.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="proposal_alerts">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.proposalAlerts.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.proposalAlerts.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="app_alerts">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.appAlerts.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.appAlerts.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="lightweight_activity">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('settings:alerts.push.lightweightActivity.label')}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings:alerts.push.lightweightActivity.description')}</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
          </div>
          <p data-mobile-push-status aria-live="polite" className="text-xs mt-3 text-zinc-500 dark:text-zinc-400">
            {t('settings:alerts.push.loading')}
          </p>
        </div>
        <div
          id="settings-notification-prefs"
          className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
        >
          <SectionHeading title={t('settings:alerts.apps.title')} blurbClassName="leading-relaxed">
            {t('settings:alerts.apps.intro')}
          </SectionHeading>
          <div id="notification-prefs-list">
            <NotificationPrefsList />
          </div>
          <StatusLine id="notification-prefs-status" />
        </div>
      </div>
    </div>
  );
}