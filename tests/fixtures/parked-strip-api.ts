// Bundle the strip and the store it reads together, for the reason
// ./app-context-sheet-api.ts gives: tests/lib/render-tsx.js bundles each entry
// on its own, so a store imported separately is a SECOND copy and setting it
// changes nothing the component can see.
export { ParkedStrip } from '../../frontend/src/features/nav/parked-strip';
export { parkedStore, readParked, setParked, PARKED_KEY } from '../../frontend/src/features/nav/parked-store.js';
