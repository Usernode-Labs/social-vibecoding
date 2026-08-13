/**
 * The staging-preview and before/after-compare overlays (#1085 chunk H, step 1).
 *
 * `./mount` is imported by main.tsx, not from here: the bridge must publish
 * before `hydrateRoot`, independently of when this module's components are
 * first rendered.
 */

export { StagingOverlay } from './staging-overlay';
export { VisualCompareOverlay } from './visual-compare-overlay';
