/**
 * The app-context island: the sheet plus its document-level bindings —
 * Escape, and on the web presentation the anchor under the Homeroom mark
 * and the outside click that dismisses it (#2784).
 *
 * Mirrors ../improve/index.tsx — the sheet body is ./app-context-sheet.tsx,
 * its flag is ./app-context-store.js, and importing ./mount here is what
 * installs the flush and (via the controller's module scope) publishes
 * `window.AppContext` before public/js/** looks for it.
 */

import { useEffect } from 'react';

import { placeUnderAnchor } from '../../lib/anchor-popover';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { AppsSwitcherSheet } from './app-context-sheet';
import { appContextStore, AppContext } from './mount';

export { appContextStore, AppContext } from './mount';

/** The trigger the desktop popover hangs from (../header/platform-mark.tsx). */
const MARK_ID = 'platform-mark-btn';

/**
 * Pin the web presentation under the mark: right edges aligned, 6px below it,
 * exactly the vote popover's placement. Written as two custom properties the
 * `min-width: 640px` rule in app.css reads, so the sheet's own class string
 * stays the constant the kit writes to, and the phone presentation — which
 * never reads them — is untouched. No flip: the mark is in the header, and
 * "above the header" is off the screen, so the rule caps the height instead.
 */
function anchorUnderMark(sheet: HTMLElement): void {
  const mark = document.getElementById(MARK_ID);
  if (!mark) return;
  const r = mark.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const { top, left } = placeUnderAnchor(
    r,
    { width: sheet.offsetWidth, height: sheet.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    { flip: false },
  );
  sheet.style.setProperty('--menu-anchor-top', `${top}px`);
  sheet.style.setProperty('--menu-anchor-left', `${left}px`);
}

export function AppContextIsland() {
  const { open, adopted } = useStoreState(appContextStore);

  // PLACED BEFORE THE FIRST OPEN PAINT. A layout effect, so the panel never
  // shows a frame at the rule's fallback position before jumping under the
  // mark; and re-placed on resize rather than closed, because a menu that
  // follows its trigger is less surprising than one that vanishes when the
  // window is dragged. Adopted into a kit sheet the kit positions it, and the
  // properties are simply never read.
  useIsomorphicLayoutEffect(() => {
    if (!open || adopted) return undefined;
    const sheet = document.getElementById('apps-switcher-sheet');
    if (!sheet) return undefined;
    const place = () => anchorUnderMark(sheet);
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, adopted]);

  // AN OUTSIDE CLICK DISMISSES IT, AND STILL LANDS. The popover has no scrim
  // on desktop, so its backdrop no longer takes the pointer there (app.css)
  // and the header stays live: pressing the bell closes this and opens the
  // notifications in one click, the way the vote popover lets the board
  // keep working. Capture phase, so the menu is gone before whatever was
  // clicked reacts. The mark itself is spared — its own click toggles.
  // Below `sm` the backdrop still catches the click first and closes the
  // sheet through its onClick; this listener then finds it already shut.
  useEffect(() => {
    if (!open || adopted) return undefined;
    const onDoc = (event: Event) => {
      const t = event.target as Node | null;
      const sheet = document.getElementById('apps-switcher-sheet');
      const mark = document.getElementById(MARK_ID);
      if (t && (sheet?.contains(t) || mark?.contains(t))) return;
      if (AppContext._sheet) return;
      void AppContext.close();
    };
    document.addEventListener('click', onDoc, true);
    return () => document.removeEventListener('click', onDoc, true);
  }, [open, adopted]);

  // Escape closes the sheet — web presentation only; adopted into a kit
  // sheet the kit's modal stack owns the key. Same rule as the Improve panel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (AppContext._sheet) return;
      AppContext.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return <AppsSwitcherSheet />;
}
