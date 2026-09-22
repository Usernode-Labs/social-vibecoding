// Bundle the About pane and the store it reads together, for the reason
// ./app-context-sheet-api.ts gives: tests/lib/render-tsx.js bundles each entry
// on its own, so a store imported separately is a SECOND copy and setting it
// changes nothing the component can see.
export { AboutPane } from '../../frontend/src/features/app-context/about-pane';
export { improveStore } from '../../frontend/src/features/improve/improve-store.js';
