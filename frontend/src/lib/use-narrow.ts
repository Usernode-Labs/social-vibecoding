/**
 * Is the viewport narrow enough that the kanban board shows ONE column?
 *
 * 639px is not a guess: `.dev-kanban-col` layout in public/css/app.css puts
 * every column but `.dev-kanban-col-active` at `display:none` below 640px,
 * and the tab strip is `sm:hidden`. This hook is the same threshold read
 * from JS, so the component can skip building cards the CSS is only going
 * to hide.
 *
 * Live, not read once: a rotation or a resized window crosses the boundary
 * and the columns have to fill in.
 *
 * `false` when there is no matchMedia (server render, ancient WebView), so
 * the wide behaviour — render everything — is what a caller gets by default.
 * That is the safe direction: it is what shipped before this existed, and
 * it is what the proposal-checks runner sees, since the assertion suite runs
 * in the capture container's fixed 1280x800 frame (src/services/visuals.js).
 */
import { useEffect, useState } from 'react';

export const NARROW_QUERY = '(max-width: 639px)';

function readNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try { return window.matchMedia(NARROW_QUERY).matches; } catch { return false; }
}

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(readNarrow);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    let mql: MediaQueryList;
    try { mql = window.matchMedia(NARROW_QUERY); } catch { return undefined; }
    const onChange = () => setNarrow(mql.matches);
    // Re-read on mount too: the first paint may have happened before the
    // effect ran, and a rotation can land in that gap.
    onChange();
    // addEventListener is the modern spell; addListener is the Safari<14 one.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof (mql as any).addListener === 'function') {
      (mql as any).addListener(onChange);
      return () => (mql as any).removeListener(onChange);
    }
    return undefined;
  }, []);
  return narrow;
}
