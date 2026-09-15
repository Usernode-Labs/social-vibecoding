/**
 * `#notification-prefs-list` — your account-wide notification defaults and
 * every app you have set differently (#1374).
 *
 * Two lists because there are two layers. The top one is what every app does
 * unless told otherwise; the bottom one is the exceptions, and it is the
 * reason this roll-up exists at all — without it there is no way to find an
 * app you muted months ago short of opening its tile menu and looking.
 *
 * settings.js keeps every fetch and every PATCH; this file keeps the markup,
 * and calls the handlers BY NAME on `window.Settings` for the same reason
 * ./grants-list.tsx does.
 */

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { notificationPrefsStore } from './notification-prefs-store.js';

type AccountCategory = {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  source: 'account' | 'default';
  appScoped: boolean;
};
type AppOverride = {
  appId: number;
  appSlug: string;
  appName: string;
  categories: { key: string; label: string; enabled: boolean }[];
};
type State = {
  phase: 'idle' | 'loading' | 'error' | 'ready';
  categories: AccountCategory[];
  apps: AppOverride[];
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

/** Matches ROW_CLASS in ./grants-list.tsx — one row language on this screen. */
const ROW_CLASS = 'rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 text-xs';

export function NotificationPrefsList() {
  const state = useStoreState<State>(notificationPrefsStore);
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }
  if (state.phase === 'error') {
    return <p className="text-xs text-red-700 dark:text-red-400">Could not load notification settings.</p>;
  }
  return (
    <>
      <div className="space-y-3">
        {state.categories.map((category) => (
          <label
            key={category.key}
            className="flex items-start justify-between gap-4 cursor-pointer select-none"
            data-notification-default={category.key}
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {category.label}
              </span>
              <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {category.description}
              </span>
            </span>
            <input
              type="checkbox"
              className="un-switch mt-0.5 shrink-0"
              checked={category.enabled}
              onChange={(event) => {
                void controller()?._onNotificationDefaultChange?.(
                  category.key, event.currentTarget.checked
                );
              }}
            />
          </label>
        ))}
      </div>

      <div className="mt-5 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-800 mb-2 dark:text-zinc-200">Apps set differently</p>
        {state.apps.length ? (
          <div className="space-y-2">
            {state.apps.map((app) => (
              <div key={app.appId} className={ROW_CLASS}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {app.appName}
                  </span>
                  <Button
                    type="button"
                    data-role="reset-app-notifications"
                    layout="shrink"
                    variant="compact"
                    size="xs"
                    onClick={() => {
                      void controller()?._onNotificationAppReset?.(app.appId, app.appSlug);
                    }}
                  >
                    Use my defaults
                  </Button>
                </div>
                <ul className="mt-1 text-zinc-500 dark:text-zinc-400">
                  {app.categories.map((category) => (
                    <li key={category.key}>
                      {`${category.label}: ${category.enabled ? 'on' : 'off'}`}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            No app is set differently. Change one from its Notifications entry in the app menu.
          </p>
        )}
      </div>
    </>
  );
}
