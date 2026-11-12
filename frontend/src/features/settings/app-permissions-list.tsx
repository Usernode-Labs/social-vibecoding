/**
 * `#app-permissions-list` — the App device permissions rows (#2219).
 *
 * The sibling of ./grants-list.tsx, written the same way: the host is STATIC
 * in the React tree (sections/app-permissions.tsx), settings.js keeps every
 * fetch and every DELETE/POST, and the handlers are called BY NAME on
 * `window.Settings` because that module is a classic script this bundle
 * cannot import.
 *
 * Rows are grouped BY APP rather than listed flat. A grant is per capability,
 * so a flat list would repeat the same app name four times and bury the
 * question a person actually came here to answer, which is "what does this
 * app have?".
 */

import { Button } from '@/components/ui/button';

import { closeLiveApp, isLiveApp } from '../app-frame/live-apps';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { appPermissionsStore } from './app-permissions-store.js';

type PermissionItem = { capability: string; label: string; revoked: boolean };
type PermissionAppView = {
  appId: number;
  appName: string;
  appSlug: string;
  items: PermissionItem[];
};
type AppPermissionsState = { phase: 'idle' | 'loading' | 'error' | 'ready'; apps: PermissionAppView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

/** Matches ROW_CLASS in ./grants-list.tsx — one row language on this screen. */
const ROW_CLASS = 'rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 text-xs';

/**
 * #6512: what the riskier capabilities actually let an app do, in a line
 * under the row. Only these three: they see or hear the person and what is
 * around them, where a USB or MIDI device is a thing they plugged in on
 * purpose and location is already named by its label. Microphone is here
 * with the camera because it hears the room as well as the person, and
 * nothing on screen shows what it picked up.
 *
 * Each note says what the PERMISSION lets the app do, so it stays true on a
 * revoked row beside Re-enable, and it says the browser must allow it too:
 * the grant here only delegates the capability to the frame.
 *
 * Screen sharing is worded for how it is granted: the frame's `allow` only
 * DELEGATES `display-capture`, and `getDisplayMedia` opens the browser's own
 * picker on every call, so the app sees the screen, window or tab the
 * person picks there, never "your screen" on its own say-so.
 */
function capabilityNote(t: ReturnType<typeof useMessages>, capability: string): string {
  switch (capability) {
    case 'camera': return t('settings:appPermissions.note.camera');
    case 'microphone': return t('settings:appPermissions.note.microphone');
    case 'display-capture': return t('settings:appPermissions.note.screen');
    default: return '';
  }
}

function CapabilityRow({ app, item }: { app: PermissionAppView; item: PermissionItem }) {
  const t = useMessages('settings');
  const note = capabilityNote(t, item.capability);
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="min-w-0 flex-1">
        <span
          className={item.revoked
            ? 'block truncate text-zinc-400 line-through dark:text-zinc-500'
            : 'block truncate text-zinc-700 dark:text-zinc-300'}
        >
          {item.label}
        </span>
        {/* 12px like the label above it (ROW_CLASS is text-xs): the "15 over 13"
            rule is ListRow's, and a 13px note would outsize its own label. */}
        {note ? (
          <span data-role="capability-note" className="mt-0.5 block text-zinc-500 dark:text-zinc-400">
            {note}
          </span>
        ) : null}
      </div>
      {item.revoked ? (
        // The way back, for the same reason grants-list.tsx grew one (#1957):
        // re-approving otherwise depends on the app asking again, and an app
        // that never asks again never opens the prompt. Same control as that
        // file's Re-enable, because the two sections sit next to each other.
        <Button
          type="button"
          data-role="re-enable"
          layout="shrink"
          variant="compact"
          size="xs"
          onClick={() => { void controller()?._onPermissionReenable?.(app.appId, app.appSlug, item.capability); }}
        >
          {t('settings:appPermissions.reEnable')}
        </Button>
      ) : (
        /*
            The red-tinted box from grants-list.tsx's Revoke, not an outlined
            Button: the language draws no outlined control (see the `neutral`
            variant in @/components/ui/button.tsx), and these rows render
            directly beside that section's.
        */
        <button
          type="button"
          data-role="revoke"
          className="rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 py-0.5 font-medium text-red-700 dark:text-red-400 transition-colors touch-target-32"
          onClick={() => {
            // #6512: an app open in this tab keeps what its frame was given
            // until the frame goes, so the revoke closes it too. A question,
            // not a value: Settings asks it when the dialog opens and again
            // once the revoke is through, since the app can open or close
            // in between.
            const target = {
              slug: app.appSlug,
              name: app.appName,
              isOpen: () => isLiveApp(app.appSlug),
              close: () => closeLiveApp(app.appSlug),
            };
            void controller()?._onPermissionRevoke?.(app.appId, item.capability, target);
          }}
        >
          {t('settings:appPermissions.revoke')}
        </button>
      )}
    </div>
  );
}

export function AppPermissionsListView(state: AppPermissionsState) {
  const t = useMessages('settings');
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('core:common.loading')}</p>;
  }
  if (state.phase === 'error') {
    return <p className="text-xs text-red-700 dark:text-red-400">{t('settings:appPermissions.loadFailed')}</p>;
  }
  if (!state.apps.length) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {t('settings:appPermissions.empty')}
      </p>
    );
  }
  return (
    <>
      {state.apps.map((app) => (
        <div key={app.appId} className={ROW_CLASS}>
          <div className="font-medium text-zinc-900 mb-1 dark:text-zinc-100">{app.appName}</div>
          {app.items.map((item) => (
            <CapabilityRow key={item.capability} app={app} item={item} />
          ))}
        </div>
      ))}
    </>
  );
}

export function AppPermissionsList() {
  return <AppPermissionsListView {...useStoreState<AppPermissionsState>(appPermissionsStore)} />;
}
