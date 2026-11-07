/**
 * Settings › Privacy, its last block: Usage analytics, and Leave me out. It
 * sits under who can reach you and who can find you (./privacy.tsx, #5104),
 * on the same page.
 *
 * It says plainly what Homeroom keeps: what it always keeps because the
 * product runs on it, the screen usage data it also records, and what it
 * never records. Screen usage data is recorded for everyone unless they
 * leave themselves out (users.usage_left_out_at, GET/PUT
 * /api/me/usage-analytics), which also erases what was recorded and stops
 * Google Analytics counting them (src/services/usage-analytics.js). It
 * replaces #5593's "Share usage analytics", which was off for everyone and
 * whose Off line said nothing was kept.
 *
 * Stateful like the rest of that page: settings.js binds nothing inside it.
 * The initial render is the switch off and disabled, exactly the markup the
 * prerender ships; the saved choice is read in an effect.
 *
 * Switching it tells the shell's telemetry and its Google Analytics tag at
 * once (UITelemetry.setUser with the server's new uiTelemetryEligible, and
 * the tag's setSession with analyticsCounted), so the page stops or starts
 * sending without a reload. Leaving out clears what this page had queued.
 */

import { useCallback, useEffect, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';

import { useMessages } from '../../../lib/i18n/react';
import { useWindowEvent } from '../../../lib/legacy-dom';

import { HELP, PrivacySwitch, SaveStatus, useSavedFlash } from './privacy-text';

type Answer = {
  leftOut?: unknown;
  leftOutAt?: unknown;
  uiTelemetryEligible?: unknown;
  analyticsCounted?: unknown;
};

type ShellHost = {
  UITelemetry?: { setUser?(user: unknown, verifiedSession?: boolean): void };
  UsernodeReact?: { googleAnalytics?: { setSession?(user: unknown, verified?: boolean): void } };
};

/** Tell the shell's telemetry, its Google Analytics tag and App.user what the server now says. */
function publish(eligible: boolean, counted: boolean): void {
  const user = window.App?.user;
  if (!user || typeof user !== 'object') return;
  user.uiTelemetryEligible = eligible;
  user.analyticsCounted = counted;
  const host = window as unknown as ShellHost;
  try {
    host.UITelemetry?.setUser?.({ ...user, uiTelemetryEligible: eligible }, true);
  } catch { /* the setting is saved either way */ }
  try {
    host.UsernodeReact?.googleAnalytics?.setSession?.({ ...user, analyticsCounted: counted, justSignedUp: false }, true);
  } catch { /* the setting is saved either way */ }
}

/** "7 Nov", in the person's own language. */
function shortDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch {
    return iso.slice(0, 10);
  }
}

export function UsageAnalyticsSection() {
  const t = useMessages('settings');
  const [leftOut, setLeftOut] = useState(false);
  const [leftOutAt, setLeftOutAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { saved, flash, clear } = useSavedFlash();

  const take = useCallback((body: Answer) => {
    setLeftOut(body.leftOut === true);
    setLeftOutAt(typeof body.leftOutAt === 'string' ? body.leftOutAt : null);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me/usage-analytics', { credentials: 'same-origin' });
      if (!res.ok) return;
      take((await res.json()) as Answer);
      setLoaded(true);
    } catch { /* stays as it was; the next visit reads it again */ }
  }, [take]);

  useEffect(() => { void load(); }, [load]);
  // Read again each time the page is opened: another device may have
  // changed it.
  useWindowEvent('usernode:settings-section', (event) => {
    if ((event as CustomEvent<{ section?: string }>).detail?.section === 'contact-privacy') void load();
  });

  async function change(next: boolean) {
    const previous = { leftOut, leftOutAt };
    setLeftOut(next);
    setSaving(true);
    setError('');
    clear();
    try {
      const res = await fetch('/api/me/usage-analytics', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leftOut: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Answer;
      take(body);
      publish(body.uiTelemetryEligible === true, body.analyticsCounted === true);
      flash();
    } catch {
      setLeftOut(previous.leftOut);
      setLeftOutAt(previous.leftOutAt);
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
      <div className={`${HELP} mt-3 space-y-3`} data-usage-analytics-kept>
        <div>
          <p className="font-medium text-zinc-700 dark:text-zinc-300">{t('settings:privacy.usageAnalytics.alwaysKept.title')}</p>
          <ul className="mt-1 list-disc ps-5 space-y-0.5">
            <li>{t('settings:privacy.usageAnalytics.alwaysKept.apps')}</li>
            <li>{t('settings:privacy.usageAnalytics.alwaysKept.acts')}</li>
            <li>{t('settings:privacy.usageAnalytics.alwaysKept.challenges')}</li>
          </ul>
        </div>
        <div data-usage-analytics-recorded={leftOut ? 'off' : 'on'}>
          <p className="font-medium text-zinc-700 dark:text-zinc-300">
            {t(leftOut ? 'settings:privacy.usageAnalytics.alsoRecorded.titleLeftOut' : 'settings:privacy.usageAnalytics.alsoRecorded.title')}
          </p>
          <ul className={`mt-1 list-disc ps-5 space-y-0.5 ${leftOut ? 'line-through' : ''}`}>
            <li>{t('settings:privacy.usageAnalytics.alsoRecorded.screens')}</li>
            <li>{t('settings:privacy.usageAnalytics.alsoRecorded.speed')}</li>
          </ul>
        </div>
        <p>{t('settings:privacy.usageAnalytics.neverRecorded')}</p>
        <p>{t(leftOut ? 'settings:privacy.usageAnalytics.googleAnalyticsLeftOut' : 'settings:privacy.usageAnalytics.googleAnalytics')}</p>
      </div>
      <div className="mt-4">
        <PrivacySwitch
          id="settings-usage-analytics"
          label={t('settings:privacy.usageAnalytics.leaveOut.label')}
          checked={leftOut}
          disabled={!loaded || saving}
          describedBy="settings-usage-analytics-description"
          description={(
            // What turning it on does and what it leaves in place; once on,
            // since when, and what turning it off does. Including again only
            // records from then on: nothing erased comes back.
            <>
              <span className="block">
                {leftOut
                  ? t('settings:privacy.usageAnalytics.leaveOut.onSince', { date: leftOutAt ? shortDay(leftOutAt) : '' })
                  : t('settings:privacy.usageAnalytics.leaveOut.offWhat')}
              </span>
              <span className="block">
                {t(leftOut ? 'settings:privacy.usageAnalytics.leaveOut.onStill' : 'settings:privacy.usageAnalytics.leaveOut.offStill')}
              </span>
            </>
          )}
          onChange={(e) => void change(e.currentTarget.checked)}
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      <SaveStatus saved={saved} />
    </div>
  );
}
