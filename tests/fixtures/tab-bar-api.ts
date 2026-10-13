// Bundle the tab bar, the nav store it reads and the bridge that writes it
// together, for the reason ./parked-strip-api.ts gives: tests/lib/render-tsx.js
// bundles each entry on its own, so a store imported separately is a SECOND
// copy and setting it changes nothing the component can see. The bridge is
// installed only where a `window` exists at load time (see ../nav-tab-bar-viewer.test.js).
import '../../frontend/src/features/nav/mount';

export { PlatformTabs, tabLabel, communitiesAriaLabel } from '../../frontend/src/features/nav/tab-bar';
export { navStore } from '../../frontend/src/features/nav/nav-store.js';
// The community the fourth tab is on (../communities-tab-label.test.js), from
// this same bundle for the reason above.
export { communityScopeStore } from '../../frontend/src/features/workshop/community-scope';
