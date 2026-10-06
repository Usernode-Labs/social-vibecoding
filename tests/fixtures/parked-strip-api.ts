// Bundle the strip and the store it reads together, for the reason
// ./app-context-sheet-api.ts gives: tests/lib/render-tsx.js bundles each entry
// on its own, so a store imported separately is a SECOND copy and setting it
// changes nothing the component can see.
export { ParkedStrip, forgetParked } from '../../frontend/src/features/nav/parked-strip';
export { parkedStore, readParked, setParked, PARKED_KEY } from '../../frontend/src/features/nav/parked-store.js';
// #4025: the strip reads the rail's recency list for its last-opened stamp,
// so the store it reads has to be the same copy the component sees.
export { recentAppsStore, readRecentApps } from '../../frontend/src/features/nav/recent-apps-store.js';
