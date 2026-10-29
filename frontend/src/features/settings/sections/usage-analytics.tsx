/**
 * Settings › Privacy, its last block: "Share usage analytics" (#5097). It
 * sits under who can reach you and who can find you (./privacy.tsx, #5104),
 * on the same page.
 *
 * Off for everyone until they switch it on. The choice is the account's,
 * stored on the server (users.usage_analytics, GET/PUT
 * /api/me/usage-analytics), which drops the events of anybody who has it off
 * whatever the browser sends (src/services/usage-analytics.js lists them).
 *
 * Stateful like the rest of that page: settings.js binds nothing inside it.
 * The initial render is the switch off and disabled, exactly the markup the
 * prerender ships; the saved choice is read in an effect.
 *
 * Switching it tells the shell's telemetry at once (UITelemetry.setUser with
 * the server's new uiTelemetryEligible), so the page starts or stops sending
 * without a reload. Switching it off clears what this page had queued.
 */

import { useCallback, useEffect, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';

import { useMessages } from '../../../lib/i18n/react';
import { useWindowEvent } from '../../../lib/legacy-dom';

import { HELP, PrivacySwitch } from './privacy-text';

type Answer = { enabled?: unknown; uiTelemetryEligible?: unknown };

type TelemetryHost = {
  UITelemetry?: { setUser?(user: unknown, verifiedSession?: boolean): void };
};

/** Tell the shell's telemetry and App.user what the server now says. */
function publish(eligible: boolean): void {
  const user = window.App?.user;
  if (!user || typeof user !== 'object') return;
  user.uiTelemetryEligible = eligible;
  try {
    (window as unknown as TelemetryHost).UITelemetry?.setUser?.({ ...user, uiTelemetryEligible: eligible }, true);
  } catch { /* the setting is saved either way */ }
}

export function UsageAnalyticsSection() {
  const t = useMessages('settings');
  const [on, setOn] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me/usage-analytics', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = (await res.json()) as Answer;
      setOn(body.enabled === true);
      setLoaded(true);
    } catch { /* stays as it was; the next visit reads it again */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Read again each time the page is opened: another device may have
  // changed it.
  useWindowEvent('usernode:settings-section', (event) => {
    if ((event as CustomEvent<{ section?: string }>).detail?.section === 'contact-privacy') void load();
  });

  async function change(next: boolean) {
    const previous = on;
    setOn(next);
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/me/usage-analytics', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Answer;
      setOn(body.enabled === true);
      publish(body.uiTelemetryEligible === true);
    } catch {
      setOn(previous);
      setError(t('settings:privacy.usageAnalytics.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="settings-usage-analytics-section" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      <SectionHeading title={t('settings:privacy.usageAnalytics.title')} blurbClassName="dark:text-zinc-400">
        {t('settings:privacy.usageAnalytics.intro')}
      </SectionHeading>
      <PrivacySwitch
        id="settings-usage-analytics"
        label={t('settings:privacy.usageAnalytics.label')}
        checked={on}
        disabled={!loaded || saving}
        describedBy="settings-usage-analytics-description"
        onChange={(e) => void change(e.currentTarget.checked)}
      />
      {/* #5926: what is true now, then what it records and what it never
          records, each on its own line. */}
      <div id="settings-usage-analytics-description" className={`${HELP} mt-2 space-y-1`}>
        <p>{t(on ? 'settings:privacy.usageAnalytics.stateOn' : 'settings:privacy.usageAnalytics.stateOff')}</p>
        <p>{t('settings:privacy.usageAnalytics.records')}</p>
        <p>{t('settings:privacy.usageAnalytics.neverRecords')}</p>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
