import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
/**
 * Per-app notification settings (#app-notifications-modal), for #1374.
 *
 * ── Why this is here and not in App settings ──────────────────────────
 *
 * The obvious home was `./app-settings.tsx` — it is already the per-app
 * dialog. It is also gated: the tile menu only offers it to an admin, the
 * creator, or somebody whose app has other contributors. Notification
 * preferences belong to everybody who USES an app, and most of those people
 * are none of those things, so putting the switches there would have hidden
 * them from nearly everyone who wants them.
 *
 * So this is its own dialog, opened from the ungated part of the same tile
 * menu, next to "Add to Your apps" — which is the closest thing the platform
 * already had to a per-app subscription control.
 *
 * ── One switch, both places ───────────────────────────────────────────
 *
 * Each row governs the on-platform notification AND the phone push
 * together. That is not two writes kept in agreement: the preference gates
 * whether the notification is CREATED, and mobile_push_deliveries references
 * notifications(id), so a row that never exists can never be pushed. See
 * services/notification-preferences.js.
 *
 * ── `source` is why there are three states and two controls ───────────
 *
 * A category can be ON, OFF, or FOLLOWING YOUR DEFAULT, and the third is not
 * a third switch position — it is the ABSENCE of a per-app row. The switch
 * shows the resolved answer and flipping it writes an override; "Follow my
 * default" clears it again. Storing the default's current value instead
 * would freeze it, so an app set to "follow" would quietly stop following
 * the first time a default changed.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';

import { useDialog } from './use-dialog';

type Category = {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  enabled: boolean;
  source: 'app' | 'account' | 'default';
};

export function AppNotificationsDialog(): ReactNode {
  useUiLanguage();
  const [appName, setAppName] = useState('');
  const [slug, setSlug] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(target: string) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(target)}/notification-preferences`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || tr("core:could_not_load_notification_settings_9b7eaff0"));
      setAppName(data.app?.name || target);
      setCategories(data.categories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("core:could_not_load_notification_settings_9b7eaff0"));
    } finally {
      setLoading(false);
    }
  }

  const dialog = useDialog<{ slug: string }>('appNotifications', {
    onOpen: (payload) => {
      const target = payload?.slug || '';
      setSlug(target);
      setCategories([]);
      setError('');
      if (target) void load(target);
    },
    onClose: () => {
      setCategories([]);
      setError('');
    },
  });

  // `null` CLEARS the override, which is the "follow my default" path — see
  // the header. Optimistic, then reconciled with the server's own answer,
  // because the resolved value after a clear is the account layer's and this
  // component does not know it.
  async function write(key: string, value: boolean | null) {
    if (!slug) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/notification-preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { [key]: value } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || tr("core:could_not_save_that_593417b9"));
      setCategories(data.categories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("core:could_not_save_that_593417b9"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot
      id="app-notifications-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
      layout="scroll"
    >
      <DialogCard size="md" relative>
        <h2 className="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100"><Message id="core:notifications_78801183" /></h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
          <LocalizedValue render={() => (appName
            ? tr("core:what_value1_can_tell_you_about_each_of_these_cov_2e8b14dc", { value1: appName })
            : tr("core:what_this_app_can_tell_you_about_680a9344"))} />
        </p>

        {loading ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="core:loading_ba3bbbe1" /></p>
        ) : null}

        <div className="space-y-3">
          {categories.map((category) => (
            <div key={category.key} className="flex items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                  {category.label}
                </span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {category.description}
                </span>
                {category.source === 'app' ? (
                  <button
                    type="button"
                    className="mt-1 text-xs text-violet-700 underline dark:text-violet-300"
                    onClick={() => { void write(category.key, null); }}
                  ><Message id="core:follow_my_default_989794b6" /></button>
                ) : (
                  <span className="block text-xs text-zinc-400 mt-1 dark:text-zinc-500">
                    <LocalizedValue render={() => (category.source === 'account' ? tr("core:your_default_for_all_apps_e8c9643f") : tr("core:default_21b111cb"))} />
                  </span>
                )}
              </span>
              <input
                type="checkbox"
                className="un-switch mt-0.5 shrink-0"
                data-app-notification-category={category.key}
                checked={category.enabled}
                disabled={busy}
                onChange={(event) => { void write(category.key, event.currentTarget.checked); }}
              />
            </div>
          ))}
        </div>

        {error ? (
          <div id="app-notifications-error" className="text-sm text-red-700 mt-3 dark:text-red-400">
            {error}
          </div>
        ) : null}

        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-4 leading-relaxed"><Message id="core:turning_something_off_stops_the_notification_not_3ee92c35" /></p>

        <div className="flex justify-end mt-5">
          <Button
            type="button"
            id="app-notifications-done"
            variant="neutral"
            ink="neutral"
            onClick={() => dialog.close()}
          ><Message id="core:done_11a6767d" /></Button>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
