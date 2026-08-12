/**
 * The App/Dev screen and its embedded app frame (#1085 chunk H, step 2).
 *
 * `./mount` is imported by main.tsx, not from here: the bridge must publish
 * before `hydrateRoot`, independently of when this module's components are
 * first rendered.
 */

export { AppViewIsland } from './app-view-island';
