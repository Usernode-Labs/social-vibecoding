/**
 * The running app's TONE, and how the bar above it follows (#1945).
 *
 * Inside an app the platform header has no surface of its own: the page
 * wallpaper runs up behind its controls, and the app arrives as a raised
 * sheet underneath (see "THE BAR OVER THE WALLPAPER" and "THE APP SHEET" in
 * public/css/app.css). That wallpaper follows the SHELL's theme, so a viewer
 * on the light shell who opens a dark app gets a cream strip over a black
 * page, and a viewer on the dark shell gets the mirror image over a light
 * one. The request asks for the bar to take the tone of what is under it.
 *
 * The shell cannot look inside the frame — it is another origin — but it
 * does not have to: the app's bridge already reports the document's opaque
 * page colour to the shell (`__usernode_background`, #1581, kept on
 * appFrameStore as `background`, and re-sent on every theme change inside
 * the app). This module turns that colour into a tone, `dark` or `light`,
 * and publishes it as `data-app-tone` on <html>. app.css keys the
 * wallpaper, the sheet tokens and the header's brand tokens off that
 * attribute, next to `.dark`, so the strip repaints without the shell's own
 * theme moving: `.dark` on <html> stays the theme module's alone
 * (frontend/src/head.html).
 *
 * The sheets, dialogs and menus opened over a dark app follow it too (#2803,
 * which reversed the earlier rule that they keep the viewer's own mode):
 * lib/surface-tone.ts reads this same attribute and puts `.dark` on each
 * floating surface rather than on <html>, so they are drawn in the shell's
 * dark palette while the page under the frame keeps the shell's theme. A
 * light app under the dark shell leaves them in the shell's dark mode.
 *
 * Plain JS with no React import, like app-frame-store.js and for the same
 * reason: tests/app-tone.test.js drives this code directly.
 */

export const APP_TONE_ATTR = 'data-app-tone';

/**
 * The page grounds the head's theme module paints (`GROUND` in
 * frontend/src/head.html), repeated here for the theme-color meta: the
 * browser chrome above the bar is part of the strip, so it takes the tone
 * too. Keep the two in step.
 */
export const TONE_GROUND = { light: '#f4f2e4', dark: '#0b0d1b' };

/**
 * The luminance below which a page colour reads as dark.
 *
 * WCAG's own rule for "does white text contrast better than black on this
 * colour": white wins when relative luminance is under 0.179, and that is
 * the same question the bar is asking. #808080 (L 0.22) stays light;
 * #4a4a4a (L 0.07) is dark; the platform's two grounds sit far to either
 * side (cream 0.88, night 0.003).
 */
export const DARK_LUMINANCE = 0.179;

const HEX = /^#([0-9a-f]{6})$/i;

/** WCAG relative luminance of an opaque `#rrggbb`, or null when it is not one. */
export function luminanceOf(hex) {
  const m = HEX.exec(typeof hex === 'string' ? hex.trim() : '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255)
    + 0.7152 * channel((n >> 8) & 255)
    + 0.0722 * channel(n & 255);
}

/**
 * 'dark' | 'light' for an opaque page colour; null for anything else — an
 * empty report (the app paints no opaque ground, so nothing is known) or a
 * malformed one.
 */
export function toneOf(hex) {
  const l = luminanceOf(hex);
  if (l === null) return null;
  return l < DARK_LUMINANCE ? 'dark' : 'light';
}

/** The router's id for the screen a running app is shown on. */
export const APP_SCREEN = 'app-view';

/**
 * The tone the shell should show for a frame-store state: the mounted app's
 * page colour, but only while that app is actually ON SCREEN. A parked frame
 * (the Dev tab over it) and an empty store both answer null, so the strip
 * goes back to the shell's own theme the moment the app is not what is
 * under it.
 *
 * `screen` is the root the router has revealed (the nav store's `screen`).
 * The frame's `active` flag alone does not say the app is on screen: only the
 * ✕ back to Home retires the frame, and every other way out (a tab, the rail,
 * New change from the app's menu) hides #app-view with the frame still
 * active, so a dark app's tone stayed on <html> and the next screen drew the
 * dark wallpaper under the light shell's panes. Leaving the argument out
 * keeps the frame's answer alone, for callers that have no router.
 */
export function toneForState(state, screen) {
  if (!state || !state.slug || !state.active) return null;
  if (screen !== undefined && screen !== APP_SCREEN) return null;
  return toneOf(state.background);
}

/**
 * Write the tone onto the document (`data-app-tone` on <html>, and the
 * theme-color meta the browser chrome reads), or clear both when there is
 * none. Idempotent: a repeat publish of the same tone touches nothing, so a
 * background re-report from the app that lands on the same side costs no
 * style recalculation.
 *
 * Clearing hands the meta back to the theme module (`window.Theme.apply()`
 * re-derives it from the shell's own mode) rather than guessing a colour
 * here; when the module is absent the meta is left as it stands.
 *
 * `force` re-writes the meta even when the tone is unchanged: the theme
 * module rewrites that meta from the shell's mode on every theme change, so
 * the listener mount.ts registers on it passes `force` to put the app's
 * tone back on top.
 *
 * `screen` is passed through to `toneForState`.
 *
 * Returns the tone written, or null.
 */
export function publishAppTone(doc, state, win, force = false, screen) {
  const tone = toneForState(state, screen);
  const root = doc && doc.documentElement;
  if (!root) return tone;
  const current = root.getAttribute(APP_TONE_ATTR);
  if (tone === current && !(force && tone)) return tone;
  if (tone) root.setAttribute(APP_TONE_ATTR, tone);
  else root.removeAttribute(APP_TONE_ATTR);
  let meta = null;
  try { meta = doc.querySelector('meta[name="theme-color"]'); } catch { /* no querySelector */ }
  if (tone) {
    if (meta) meta.setAttribute('content', TONE_GROUND[tone]);
  } else {
    const theme = win && win.Theme;
    if (theme && typeof theme.apply === 'function') {
      try { theme.apply(); } catch { /* the meta keeps its last value */ }
    }
  }
  return tone;
}
