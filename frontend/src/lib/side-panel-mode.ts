/**
 * Is THIS document the side panel beside a running app (`?panel=1`)?
 *
 * The desktop side panel (features/side-panel/) is the platform itself,
 * loaded a second time in a same-origin <iframe> beside the running app. That
 * second document boots the whole shell, and a good part of the shell writes
 * state the top-level document owns: the parked app, the remembered header,
 * the service worker, the first-run gates, the tour, the one-shot reload
 * latch. Each of those asks this question and stands down.
 *
 * The answer is a class on <html>, put there by the head-blocking inline
 * script in frontend/src/head.html before anything paints, and only when the
 * document really is framed by a same-origin top window — a `?panel=1`
 * address opened in a tab of its own is the ordinary platform. Reading the
 * class rather than re-deriving it keeps exactly one decision about what
 * "embedded" means.
 *
 * `false` wherever there is no document: the prerender evaluates this graph
 * in Node, and the prerendered shell is never the panel.
 */
export const EMBEDDED_PANEL_CLASS = 'in-side-panel';

export function isEmbeddedPanel(): boolean {
  try {
    return typeof document !== 'undefined'
      && !!document.documentElement
      && document.documentElement.classList.contains(EMBEDDED_PANEL_CLASS);
  } catch {
    return false;
  }
}
