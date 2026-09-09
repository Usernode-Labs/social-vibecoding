// Bundle the header and its stores together so render tests drive the same
// store instances the real components subscribe to, not separate bundles.
export { PlatformHeader } from '../../frontend/src/features/header/platform-header';
export { backButtonStore } from '../../frontend/src/features/header/back-button-store.js';
export { headerTitleStore } from '../../frontend/src/features/header/header-title-store.js';
export { improveStore } from '../../frontend/src/features/improve/improve-store.js';
