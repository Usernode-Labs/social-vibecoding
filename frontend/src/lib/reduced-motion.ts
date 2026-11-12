type MotionWindow = {
  document?: { documentElement?: { getAttribute(name: string): string | null } | null } | null;
  matchMedia?: (query: string) => { matches: boolean };
};

/**
 * Should this motion be skipped? (#6510)
 *
 * Two things say yes: Settings › Accessibility › Reduce motion, which the
 * head module (window.Display in ../head.html) writes onto <html> as
 * data-motion="reduce" before first paint, and the device's own
 * `prefers-reduced-motion: reduce`. Every script decision about animating
 * asks this rather than the media query alone, so the setting is honoured
 * wherever the device's preference is. CSS reads the same attribute: each
 * reduced-motion rule in app.css and native.css has a
 * `:where(html[data-motion="reduce"])` twin, and scripts/build-tailwind.js gives
 * Tailwind's motion-reduce: and motion-safe: variants the same.
 *
 * `win` is for code that runs against another window (a frame); it defaults
 * to this one (a stub with only matchMedia is fine). Never throws: no
 * window is "animate"; a matchMedia that throws answers `unreadable`
 * (default "animate"; a caller that would rather stay still passes true).
 */
/**
 * Call `fn` whenever the answer may have changed: the setting written onto
 * <html> (here, or by another tab through the head module's storage
 * listener) or the device's preference. Returns the unsubscribe.
 */
export function onReducedMotionChange(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const offs: Array<() => void> = [];
  try {
    const observer = new MutationObserver(() => fn());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    offs.push(() => observer.disconnect());
  } catch { /* no observer: the media query below still answers */ }
  try {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    query.addEventListener('change', fn);
    offs.push(() => query.removeEventListener('change', fn));
  } catch { /* no matchMedia */ }
  return () => { for (const off of offs) off(); };
}

export function reducedMotion(win?: MotionWindow | null, unreadable = false): boolean {
  const w: MotionWindow | null = win === undefined ? (typeof window === 'undefined' ? null : window) : win;
  if (!w) return false;
  try {
    if (w.document?.documentElement?.getAttribute('data-motion') === 'reduce') return true;
  } catch { /* a cross-origin frame: the media query below still answers */ }
  try {
    return !!w.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return unreadable;
  }
}
