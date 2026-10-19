/**
 * Settings → Privacy: "Share usage analytics" (#5097).
 *
 * Off for everyone until they switch it on. The choice is the account's,
 * stored on the server (users.usage_analytics, GET/PUT
 * /api/me/usage-analytics), which drops the events of anybody who has it off
 * whatever the browser sends (src/services/usage-analytics.js lists them).
 *
 * A STATEFUL pane like ./accessibility.tsx: settings.js binds nothing inside
 * it. The initial render is the switch off and disabled, exactly the markup
 * the prerender ships; the saved choice is read in an effect.
 *
 * Switching it tells the shell's telemetry at once (UITelemetry.setUser with
 * the server's new uiTelemetryEligible), so the page starts or stops sending
 * without a reload. Switching it off clears what this page had queued.
 */

import { useCallback, useEffect, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

import { useMessages } from '../../../lib/i18n/react';
import { useWindowEvent } from '../../../lib/legacy-dom';

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

export function PrivacySection() {
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
    if ((event as CustomEvent<{ section?: string }>).detail?.section === 'privacy') void load();
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
    <div data-settings-section="privacy" className="hidden">
      <SectionHeading title={t('settings:privacy.title')}>
        {t('settings:privacy.intro')}
      </SectionHeading>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          id="settings-usage-analytics"
          checked={on}
          disabled={!loaded || saving}
          aria-describedby="settings-usage-analytics-description"
          onChange={(e) => void change(e.currentTarget.checked)}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:privacy.usageAnalytics.label')}
        </span>
      </label>
      <p id="settings-usage-analytics-description" className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:privacy.usageAnalytics.description')}
      </p>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
