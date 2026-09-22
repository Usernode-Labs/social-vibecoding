/**
 * The platform tab bar (#platform-tabs). See ./tab-bar.tsx for the whole of
 * why it exists; ./mount.ts installs the bridge public/js/app.js writes to,
 * and is imported HERE rather than by Shell.tsx so the seam is installed by
 * the act of rendering the bar, the way ../header/ does it.
 */

import './mount';

export { PlatformTabs } from './tab-bar';
export { ParkedStrip } from './parked-strip';
export { navStore, tabForScreen, TAB_FOR_SCREEN } from './nav-store.js';
export { parkedStore, readParked, setParked, PARKED_KEY } from './parked-store.js';
