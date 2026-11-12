import { SectionHeading, StatusLine } from '@/components/ui/field';

import { AppPermissionsList } from '../app-permissions-list';
import { useMessages } from '../../../lib/i18n/react';

/**
 * App device permissions (#2219). Lists every app the user has let reach a
 * gated browser capability — location, microphone, camera, screen sharing, or
 * a USB / serial / input / Bluetooth / MIDI device — with Revoke, and
 * Re-enable on a revoked row.
 *
 * The one thing this copy must be honest about is WHEN a revoke bites. A
 * frame's Permissions Policy is computed from its `allow` attribute at
 * navigation and cannot be narrowed afterwards, so a running app keeps what
 * it already holds until it is reopened. Saying "takes effect immediately"
 * here, as the AI section truthfully can, would be wrong. What this tab CAN
 * do is close the app (#6512): a revoke for an app open in it, on screen or
 * kept running behind it, closes its frame, and the intro says so. Another
 * tab or device keeps its frame, kept frames resume the same document, so
 * there the app keeps access until it is closed and opened again. This
 * browser's other tabs drop their cached grant set when told
 * (AppView.forgetToken); another device cannot be told, so a reopen there
 * within its one-minute token cache can still get it, and the copy says so.
 *
 * `#app-permissions-list` is React-owned end to end (../app-permissions-list.tsx);
 * Settings._renderAppPermissions() does the fetching on section open and
 * publishes a view model. The host stays an EMPTY div at first render, which
 * is what the prerender emits and what hydration has to match.
 */
export function AppPermissionsSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="app-permissions" className="hidden">
      <div id="app-permissions-section">
        <SectionHeading title={t('settings:appPermissions.title')} blurbClassName="dark:text-zinc-400">
          {t('settings:appPermissions.intro')}
        </SectionHeading>
        <div id="app-permissions-list" className="space-y-2">
          <AppPermissionsList />
        </div>
        <StatusLine id="app-permissions-status" />
      </div>
    </div>
  );
}
