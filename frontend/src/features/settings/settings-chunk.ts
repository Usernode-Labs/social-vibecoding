/**
 * The Settings module as ONE lazy chunk: the controller (./settings.js, via
 * ./mount which plants its two seams on it) and the sixteen panes
 * (./sections). ./facade.js is the eager half that loads this — through a
 * dynamic import, which is what makes Vite emit it as
 * /shell/assets/shell-settings-chunk.js instead of folding ~200KB into the
 * entry every visitor downloads.
 *
 * Order matters inside: ./mount evaluates settings.js, which takes over
 * window.Settings from the façade and adopts its state; the panes come after
 * so their init() (a layout effect in ./sections) always finds the module.
 *
 * Deliberately NOT in public/sw.js's SHELL_ASSETS, like the admin console's
 * sections chunk: index.html does not load it, the module graph does, on the
 * route that needs it — and the worker caches it under its (build-scoped)
 * URL on that first load. See the LAZY CHUNKS note there.
 */
import './mount';

export { SettingsSections } from './sections';
