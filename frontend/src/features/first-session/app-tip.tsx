/**
 * One tip in the app (Evan, 15 Oct 2026, the onboarding canvas's "A tip in
 * the app, then 1, 2, 3 on Home"): the first time a newcomer opens their app
 * after the first session's hand-off (./first-visit.ts), one small card
 * under the Homeroom mark in the app's header, pointing up at it.
 *
 *   maker    "Welcome to your app" / "Tap [H] to suggest a change, or to go
 *            to Homeroom."
 *   invited  "Welcome to <app>" / "<inviter> invited you. Tap [H] to ..."
 *            ("Tap [H] ..." alone when who sent it is not known).
 *
 * "or to go to Homeroom" while the mark's menu offers "Go to Homeroom" in
 * place of "Go to community": the walk on Home still owed to them, or a
 * private member who has not been Home yet (../app-context/about-data.ts).
 * That is nearly every newcomer, and the menu's one way on is Homeroom,
 * where the walk runs (Evan, sign-up test, 19 Oct 2026). Otherwise (a maker
 * whose first version was still being built, whose walk ran on Home first;
 * somebody who had an account before the invite) the menu has both, and the
 * line says "or to go to the community and Homeroom".
 *
 * [H] is the mark itself, the header's own artwork at the size of the text
 * (MarkGlyph), named for a screen reader by the mark button's own label.
 *
 * It asks for nothing. A small ✕ closes it, and so does any tap anywhere:
 * a press on the page outside it goes on to what it pressed (a tap on the
 * mark opens its menu as usual), a tap on the card is the card's own, and a
 * tap in the app, which is another document, is heard as the window giving
 * its focus to the app's frame (../app-context/index.tsx reads the menu's
 * outside tap the same way, #4260). Leaving the app takes it down too.
 *
 * The island (./index.tsx) mounts it only once it is due, client-side, so it
 * adds nothing to the prerendered document; nothing in `public/js/**`
 * writes into it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { offeringGoToHomeroom, owedHomeWalk } from '../app-context/about-data';
import type { TipRecord } from './first-visit';

/** The mark's own artwork, and its button (../header/platform-mark.tsx). */
export const MARK_SRC = '/brand/homeroom-mark.png';
export const MARK_BUTTON = 'platform-mark-btn';

/** The card's widest, and how far it keeps from the screen's sides. */
export const TIP_WIDTH = 320;
export const TIP_EDGE = 16;
/** From the mark's foot to the card's top edge; the pointer stands in it. */
export const TIP_GAP = 10;
/** A focus the app's frame takes this soon after the tip shows is the app's own (an autofocus), not a tap. */
export const BLUR_GRACE_MS = 400;

export type TipBox = { left: number; top: number; width: number; height: number };

/**
 * Pure: where the card goes for the mark's box. Under it, as wide as
 * TIP_WIDTH allows, its left edge a little left of the mark's middle and
 * kept on screen; `pointer` is the middle of the mark, measured from the
 * card's left edge, kept off its rounded corners.
 */
export function tipPlacement(mark: TipBox, viewport: { width: number; height: number }): { top: number; left: number; width: number; pointer: number } {
  const width = Math.max(0, Math.min(TIP_WIDTH, viewport.width - TIP_EDGE * 2));
  const middle = mark.left + mark.width / 2;
  const left = Math.max(TIP_EDGE, Math.min(middle - 28, viewport.width - TIP_EDGE - width));
  const pointer = Math.max(20, Math.min(middle - left, width - 20));
  return { top: mark.top + mark.height + TIP_GAP, left, width, pointer };
}

/**
 * The tip's words, as message ids and their values: the maker's, or an
 * invited person's with or without who sent it. `homeroomOnly`: the mark's
 * menu offers "Go to Homeroom" and not "Go to community" (homeroomOnlyNow),
 * so the line names Homeroom alone.
 */
export function tipWords(tip: Pick<TipRecord, 'who' | 'name' | 'inviter'>, homeroomOnly = false): {
  title: string; titleValues: Record<string, string>; line: string; lineValues: Record<string, string>;
} {
  const line = homeroomOnly ? 'onboarding:firstSession.tip.lineHomeroom' : 'onboarding:firstSession.tip.line';
  if (tip.who !== 'invited') {
    return { title: 'onboarding:firstSession.tip.title', titleValues: {}, line, lineValues: {} };
  }
  const inviter = (tip.inviter || '').trim();
  const lineInvited = homeroomOnly ? 'onboarding:firstSession.tip.lineInvitedHomeroom' : 'onboarding:firstSession.tip.lineInvited';
  return {
    title: 'onboarding:firstSession.tip.titleInvited',
    titleValues: { app: tip.name },
    line: inviter ? lineInvited : line,
    lineValues: inviter ? { inviter } : {},
  };
}

/**
 * Whether the mark's menu offers "Go to Homeroom" in place of "Go to
 * community" now, as ../app-context/app-context-sheet.tsx decides it: the
 * walk on Home owed to this person, or a private member not yet Home.
 */
export function homeroomOnlyNow(): boolean {
  const app = typeof window === 'undefined' ? null : (window as unknown as { App?: { user?: { privateMember?: boolean } | null } }).App;
  return owedHomeWalk() || offeringGoToHomeroom(!!app?.user?.privateMember);
}

/** The Homeroom mark at the size of the text around it. */
export function MarkGlyph({ label }: { label: string }) {
  return (
    <img
      src={MARK_SRC}
      alt={label}
      draggable="false"
      width={18}
      height={18}
      data-first-session-tip-mark=""
      className="platform-mark-tile mx-0.5 inline-block h-[1.2em] w-[1.2em] rounded-[0.3em] align-[-0.25em]"
    />
  );
}

/** The mark's box on screen: its tile when drawn, else the button, else null. */
function markBox(): TipBox | null {
  const button = document.getElementById(MARK_BUTTON);
  if (!button) return null;
  const tile = button.querySelector('.platform-mark-tile') || button;
  const r = tile.getBoundingClientRect();
  const b = button.getBoundingClientRect();
  if (!r.width || !r.height || !b.width || !b.height) return null;
  return { left: r.left, top: b.top, width: r.width, height: b.height };
}

type Shell = { App?: { _isScreenVisible?: (id: string) => boolean } };

export function AppTip({ tip, onClose }: { tip: TipRecord; onClose: () => void }) {
  const t = useMessages('onboarding');
  const rootRef = useRef<HTMLDivElement>(null);
  // Under the mark from its first paint (it mounts only once it is due,
  // client-side), and following it every frame after: the header settles as
  // the app opens. Gone from the screen, or the app no longer the screen:
  // the tip goes with it.
  const [mark, setMark] = useState<TipBox | null>(() => { try { return markBox(); } catch { return null; } });
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  // Read once, as it shows: the walk it names Homeroom for is still owed.
  const [homeroomOnly] = useState(homeroomOnlyNow);
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    let raf = 0;
    let last = '';
    let missing = 0;
    const tick = () => {
      try {
        const box = markBox();
        const appUp = !!(window as unknown as Shell).App?._isScreenVisible?.('app-view');
        missing = box && appUp ? 0 : missing + 1;
        // A few frames' grace: a header redrawn in place is not leaving.
        if (missing > 10) { close(); return; }
        const key = box ? `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}` : '';
        if (box && key !== last) { last = key; setMark(box); }
        if (window.innerWidth !== viewport.width || window.innerHeight !== viewport.height) {
          setViewport({ width: window.innerWidth, height: window.innerHeight });
        }
      } catch { /* looked at again next frame */ }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [close, viewport.width, viewport.height]);

  // Any tap anywhere closes it. On the page, a press outside the card goes
  // on to what it pressed (the mark opens its menu); the card's own taps
  // are its onClick, so nothing under the card is pressed as it goes. In
  // the app, the frame taking the focus is the tap (BLUR_GRACE_MS aside).
  useEffect(() => {
    const shownAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onBlur = () => {
      // The active element moves after the blur event, not before it.
      timer = setTimeout(() => {
        if (Date.now() - shownAt < BLUR_GRACE_MS) return;
        if (document.activeElement?.tagName === 'IFRAME') close();
      }, 0);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('hashchange', close);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('hashchange', close);
      if (timer) clearTimeout(timer);
    };
  }, [close]);

  if (!mark) return null;
  const place = tipPlacement(mark, viewport);
  const words = tipWords(tip, homeroomOnly);
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-labelledby="first-session-tip-title"
      data-first-session-tip={tip.who}
      onClick={close}
      className="fixed z-[9000] rounded-[20px] bg-white py-3.5 pl-4 pr-11 text-left text-zinc-900 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)] dark:bg-zinc-800 dark:text-zinc-100"
      style={{ top: place.top, left: place.left, width: place.width }}
    >
      {/* The pointer, up at the mark's middle. */}
      <span
        aria-hidden="true"
        data-first-session-tip-pointer=""
        className="absolute -top-1.5 h-3 w-3 rotate-45 rounded-[2px] bg-white dark:bg-zinc-800"
        style={{ left: place.pointer - 6 }}
      />
      <p id="first-session-tip-title" className="text-[17px] font-semibold leading-snug">{t(words.title, words.titleValues)}</p>
      <p className="mt-1 text-[15px] leading-snug text-zinc-600 dark:text-zinc-300">
        <RichMessage id={words.line} values={words.lineValues} components={[<MarkGlyph label={t('core:header.homeroomMenu')} />]} />
      </p>
      <button
        type="button"
        data-first-session-tip-close=""
        aria-label={t('core:common.close')}
        onClick={(e) => { e.stopPropagation(); close(); }}
        className="un-touch-target absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 active:bg-zinc-100 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:active:bg-zinc-700"
      >
        <XIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
