import { SectionHeading, StatusLine } from '@/components/ui/field';

import { AppPermissionsList } from '../app-permissions-list';

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
 * here, as the AI section truthfully can, would be wrong.
 *
 * `#app-permissions-list` is React-owned end to end (../app-permissions-list.tsx);
 * Settings._renderAppPermissions() does the fetching on section open and
 * publishes a view model. The host stays an EMPTY div at first render, which
 * is what the prerender emits and what hydration has to match.
 */
export function AppPermissionsSection() {
  return (
    <div data-settings-section="app-permissions" className="hidden">
      <div id="app-permissions-section">
        <SectionHeading title="App device permissions">
          Apps you've allowed to use your location, microphone, camera, screen or connected devices. Each app is asked for separately, and only the app you granted gets it. Revoking stops the app the next time it opens, because a running app keeps what it was given until then.
        </SectionHeading>
        <div id="app-permissions-list" className="space-y-2">
          <AppPermissionsList />
        </div>
        <StatusLine id="app-permissions-status" />
      </div>
    </div>
  );
}
