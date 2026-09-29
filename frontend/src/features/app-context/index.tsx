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
import { menuItems, roveMenuFocus } from '../../lib/menu-keys';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { AppsSwitcherSheet } from './app-context-sheet';
import { appContextStore, AppContext } from './mount';

export { appContextStore, AppContext } from './mount';

/** The trigger the desktop popover hangs from (../header/platform-mark.tsx). */
const MARK_ID = 'platform-mark-btn';

/** `?shot=app-about` — see the effect below. */
const ABOUT_SHOT = 'app-about';
/** ~10s at 100ms: a cold route publishes its subject after a fetch or two. */
const ABOUT_SHOT_TRIES = 100;

/** The welcome tour's overlay (../home/tour/index.tsx), which drives this menu. */
const TOUR_ID = 'home-tour';

/** What the arrow keys move between in the menu: its buttons and links. */
const SHEET_ROWS = 'a[href], button:not([disabled])';

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
  //
  // THE WELCOME TOUR IS SPARED TOO. Its steps 4 and 5 point at rows inside
  // this menu, and its card — Next included — sits outside it, so a Next
  // that counted as an outside click shut the menu and the tour fell back
  // to the step that asks for it again ("Next on step 4 goes back to step
  // 3"). While the tour is up it decides when the menu closes: its
  // `closesPanel` steps shut it through AppContext.close().
  useEffect(() => {
    if (!open || adopted) return undefined;
    const onDoc = (event: Event) => {
      const t = event.target as Node | null;
      const sheet = document.getElementById('apps-switcher-sheet');
      const mark = document.getElementById(MARK_ID);
      const tour = document.getElementById(TOUR_ID);
      if (t && (sheet?.contains(t) || mark?.contains(t) || tour?.contains(t))) return;
      if (AppContext._sheet) return;
      void AppContext.close();
    };
    document.addEventListener('click', onDoc, true);
    return () => document.removeEventListener('click', onDoc, true);
  }, [open, adopted]);

  // `?shot=app-about`: the menu open on its About pane, for the declared
  // checks and the review captures. About is a tap inside a menu that is
  // itself a tap away, so no URL reached it — the same gap ?shot=app-context
  // (public/js/app.js) closes for the menu's first pane. It waits for the
  // route to publish a subject, then opens; bounded, so a route that never
  // publishes one still shows the pane rather than spinning. Pure UI state:
  // nothing is fetched here or written, and it is not env-gated, so the
  // production "before" side works the moment it ships.
  useEffect(() => {
    let shot: string | null = null;
    try { shot = new URLSearchParams(window.location.search).get('shot'); } catch { /* ignore */ }
    if (shot !== ABOUT_SHOT) return undefined;
    let tries = ABOUT_SHOT_TRIES;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (improveStore.get().slug || --tries <= 0) {
        void AppContext.open();
        AppContext.showAbout();
        return;
      }
      timer = setTimeout(attempt, 100);
    };
    timer = setTimeout(attempt, 50);
    return () => { if (timer) clearTimeout(timer); };
  }, []);

  // Escape closes the sheet — web presentation only; adopted into a kit
  // sheet the kit's modal stack owns the key. Same rule as the Improve panel.
  //
  // KEYBOARD (QA 2026-09-24 Q18), web presentation only as well. Opening it
  // from the mark moves focus to the menu's first row, the arrows (and Home,
  // End) move between its rows, and Escape hands focus back to the mark —
  // before, focus stayed on the mark and the rows were a Tab-hunt away.
  // Focus is only moved in when the MARK opened it (or nothing had focus):
  // the welcome tour opens this menu too, and its card keeps focus.
  useEffect(() => {
    if (!open) return undefined;
    const sheet = () => document.getElementById('apps-switcher-sheet');
    // The tour's root is always in the document and carries `hidden` while
    // it is not running.
    const tour = document.getElementById(TOUR_ID);
    const touring = !!tour && !tour.classList.contains('hidden');
    if (!adopted && !window.PlatformUI?.isTouch?.() && !touring) {
      const was = document.activeElement;
      if (!was || was === document.body || was.id === MARK_ID) {
        const first = menuItems(sheet(), SHEET_ROWS).find((el) => el.id !== 'apps-switcher-close');
        first?.focus({ preventScroll: true });
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (AppContext._sheet) return;
      const el = sheet();
      const inside = !!el && el.contains(event.target as Node);
      if (event.key === 'Escape') {
        AppContext.close();
        if (inside) document.getElementById(MARK_ID)?.focus({ preventScroll: true });
        return;
      }
      if (inside) roveMenuFocus(event, el, SHEET_ROWS);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, adopted]);

  return <AppsSwitcherSheet />;
}
