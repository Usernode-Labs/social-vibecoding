/**
 * The line at the top of Settings > App permissions (#6512 item 10): how many
 * apps hold a device permission and how many may use AI, in words.
 *
 * It reads the two view models the page already loads (the device rows of
 * ./app-permissions-store.js and the AI rows of ./grants-store.js) and
 * fetches nothing. Only what is ACTIVE counts: a revoked row is still drawn
 * below, with its way back, but the app holds nothing.
 *
 * A zero says nothing, and with both at zero the line is not drawn at all, so
 * the first render (both stores idle) is exactly the markup the section had
 * before, which is what the prerender emits and hydration has to match.
 *
 * Each half is a whole message with its own count, set side by side: two
 * counts in one sentence would need a plural form per pair.
 */

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { appPermissionsStore } from './app-permissions-store.js';
import { grantsStore } from './grants-store.js';

type DeviceState = { phase: string; apps: { items: { revoked: boolean }[] }[] };
type AiState = { phase: string; grants: { revoked: boolean }[] };

export function PermissionsSummaryView({ deviceApps, aiApps }: { deviceApps: number; aiApps: number }) {
  const t = useMessages('settings');
  if (!(deviceApps > 0) && !(aiApps > 0)) return null;
  return (
    <p data-role="permissions-summary" className="mb-3 text-[13px] text-zinc-600 dark:text-zinc-400">
      {deviceApps > 0 ? (
        <span data-role="summary-device">{t('settings:appPermissions.summary.device', { count: deviceApps })}</span>
      ) : null}
      {deviceApps > 0 && aiApps > 0 ? <span aria-hidden="true"> · </span> : null}
      {aiApps > 0 ? (
        <span data-role="summary-ai">{t('settings:appPermissions.summary.ai', { count: aiApps })}</span>
      ) : null}
    </p>
  );
}

export function PermissionsSummary() {
  const device = useStoreState<DeviceState>(appPermissionsStore);
  const ai = useStoreState<AiState>(grantsStore);
  const deviceApps = device.phase === 'ready'
    ? device.apps.filter((app) => app.items.some((item) => !item.revoked)).length : 0;
  const aiApps = ai.phase === 'ready' ? ai.grants.filter((g) => !g.revoked).length : 0;
  return <PermissionsSummaryView deviceApps={deviceApps} aiApps={aiApps} />;
}
