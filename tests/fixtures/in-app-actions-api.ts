// Bundle the running app's header controls and the stores they read together,
// so a render test can set store state on the SAME instances the controls
// subscribe to rather than on second copies from separate bundles (see
// about-pane-api.ts for the same arrangement).
export { InAppActions, InAppControls } from '../../frontend/src/features/header/in-app-actions';
export { improveStore } from '../../frontend/src/features/improve/improve-store.js';
export { communityScopeStore } from '../../frontend/src/features/workshop/community-scope';
export { navStore } from '../../frontend/src/features/nav/nav-store.js';
