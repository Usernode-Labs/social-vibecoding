/**
 * #4666: WHO CAN CHANGE IT, AS YOU MAKE A PROJECT.
 *
 * A new project starts on You or the group (src/services/create-options.js),
 * and while it is just its maker every preset behaves the same, so making a
 * project asks nothing: it says the rule in one line under the description
 * and the name (features/first-session/make.tsx), with Change,
 *
 *   "Who can change it: You or the group"   Change
 *
 * and Change opens the four presets alone, with how each plays out, and the
 * reminder that it can be changed later on the project's page. A pick is
 * only the screen's until Make it sends it as the new project's own
 * `governance` block, so nothing is proposed. The invite sheet that follows
 * says nothing about it (owner, 11 Oct 2026: said once, where the project is
 * made); afterwards it is the Who can see & change it sheet's.
 *
 * The presets sheet is drawn through a portal on <body>: the make screen's
 * form rises on a transform, which would trap a fixed overlay inside it.
 *
 * #5266: a small ⓘ sits right after the rule's words, before Change. Tapping
 * or clicking it opens the "What happens next" tip, what happens after Make
 * it and what the rule means; on a computer it also opens on hover and
 * closes when the pointer leaves the line. The tip is a small card drawn
 * inside this module, absolute over the fields (nothing here covers the
 * form until someone asks for it) — not a side panel (Evan, 16 Oct 2026,
 * the navigation review). It is absolute, not fixed, so the form's
 * transform does not trap it, and no portal is needed for it.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { InfoCircleIcon, ShieldCheckIcon, XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { presetName, type PresetKey } from './model';
import { PlaysOut, PresetTiles, type Viewer } from './parts';

/** The sheet's slide, each way (`duration-200` below). */
export const SHEET_SLIDE_MS = 200;

function reducedMotion(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * #5266: does the pointer really hover? A mouse opens the tip on entering
 * the rule line and closes it on leaving; a touch screen only opens it with
 * a tap. Same guard as reducedMotion(). Pure.
 */
function hoverable(): boolean {
  try { return !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches; } catch { return false; }
}

/**
 * IT LEAVES THE WAY IT CAME (polish board #8, 19 Oct 2026). It slid up over
 * 200ms and every way out (✕, Done, Use, the scrim, Escape) unmounted it in
 * the same frame, so it vanished. Now a way out slides it down first and
 * `onGone` takes it off the page when the slide has run (its transitionend,
 * or SHEET_SLIDE_MS and a little after, whichever comes first). With
 * reduced motion it goes at once.
 */
function PresetsSheet({ now, viewer, onPick, onGone }: {
  now: PresetKey;
  viewer: Viewer;
  onPick: (key: PresetKey) => void;
  onGone: () => void;
}) {
  const t = useMessages('onboarding');
  const [picked, setPicked] = useState<PresetKey>(now);
  const [shown, setShown] = useState(false);
  const leaving = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const close = () => {
    if (leaving.current) return;
    leaving.current = true;
    const panel = panelRef.current;
    if (reducedMotion() || !panel) { goneRef.current(); return; }
    let done = false;
    const gone = () => {
      if (done) return;
      done = true;
      panel.removeEventListener('transitionend', onEnd);
      goneRef.current();
    };
    const onEnd = (e: TransitionEvent) => { if (e.target === panel && e.propertyName === 'transform') gone(); };
    panel.addEventListener('transitionend', onEnd);
    window.setTimeout(gone, SHEET_SLIDE_MS + 60);
    setShown(false);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const changed = picked !== now;
  return (
    <div className="fixed inset-0 z-[9002]" data-make-rule-sheet="">
      <div aria-hidden="true" onClick={close}
        className={`absolute inset-0 bg-[color:var(--pane-scrim)] transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="make-rule-sheet-title"
        className={`absolute inset-x-0 bottom-0 mx-auto max-h-[92%] max-w-lg overflow-y-auto rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-2 text-left transition-transform duration-200 ease-out ${shown ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="make-rule-sheet-title" className="min-w-0 flex-1 text-[17px] font-semibold">{t('onboarding:firstSession.make.rule.title')}</h2>
          <button type="button" onClick={close} aria-label={t('onboarding:firstSession.make.rule.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-1 text-[14px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.make.rule.intro')}</p>
        <div className="mt-4">
          <PresetTiles picked={picked} now={now} viewer={viewer} onPick={setPicked} labelId="make-rule-sheet-title" />
        </div>
        <SectionHeader className="px-1 pb-1.5 pt-4">{t('onboarding:firstSession.make.rule.plays')}</SectionHeader>
        <PlaysOut preset={picked} viewer={viewer} />
        <Button type="button" layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="mt-4 flex items-center justify-center"
          data-make-rule-done=""
          onClick={() => { if (changed) onPick(picked); close(); }}>
          {changed ? t('onboarding:firstSession.make.rule.use', { preset: presetName(picked, viewer) }) : t('onboarding:firstSession.make.rule.done')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The Make it step's line, under the description and the name: who can
 * change the project it is about to make, and Change. `preset` is the
 * screen's own pick (You or the group until another is chosen); `who` is the
 * maker, who is its creator once it is made.
 */
export function MakeRuleLine({ preset, onPick, who }: { preset: PresetKey; onPick: (key: PresetKey) => void; who: string }) {
  const t = useMessages('onboarding');
  const [open, setOpen] = useState(false);
  // #5266: the "What happens next" tip, behind the ⓘ. Closed until asked
  // for, so the first render is unchanged.
  const [tipOpen, setTipOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // While the tip is open, Escape and a press outside the line close it.
  // (With the presets sheet up, Escape is the sheet's: Change closes the
  // tip as it opens the sheet.)
  useEffect(() => {
    if (!tipOpen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTipOpen(false); };
    const onDown = (e: PointerEvent) => {
      const wrap = wrapRef.current;
      if (!wrap || (e.target instanceof Node && !wrap.contains(e.target))) setTipOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [tipOpen]);
  const viewer: Viewer = { isCreator: true, creator: who || null };
  return (
    <>
      <div ref={wrapRef} className="relative"
        onMouseEnter={() => { if (hoverable()) setTipOpen(true); }}
        onMouseLeave={() => { if (hoverable()) setTipOpen(false); }}
      >
        {tipOpen ? (
          <div id="make-rule-tip" role="note" data-make-rule-tip=""
            className="absolute bottom-full right-0 z-10 mb-1.5 w-[min(20rem,calc(100vw-2rem))] rounded-2xl bg-white px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_8px_24px_rgba(0,0,0,0.14)] dark:bg-zinc-900">
            <p className="text-[15px] font-[650] leading-tight text-zinc-900 dark:text-zinc-100">{t('onboarding:firstSession.make.next.title')}</p>
            <ul className="mt-1.5 list-disc pl-4 text-[13px] leading-[1.4] text-zinc-600 dark:text-zinc-300">
              <li className="mt-1 first:mt-0">
                <RichMessage id="onboarding:firstSession.make.next.readyMade" components={[<b className="font-semibold text-zinc-900 dark:text-zinc-100" />]} />
              </li>
              <li className="mt-1">
                <RichMessage id="onboarding:firstSession.make.next.custom" components={[<b className="font-semibold text-zinc-900 dark:text-zinc-100" />]} />
              </li>
              <li className="mt-1">
                <RichMessage id="onboarding:firstSession.make.next.invite" components={[<b className="font-semibold text-zinc-900 dark:text-zinc-100" />]} />
              </li>
              <li className="mt-1">
                <RichMessage id="onboarding:firstSession.make.next.rule" components={[<b className="font-semibold text-zinc-900 dark:text-zinc-100" />]} />
              </li>
            </ul>
          </div>
        ) : null}
        <p data-make-rule={preset} className="mt-3 flex items-center gap-2 px-1 text-[13px] leading-[1.4] text-zinc-600 dark:text-zinc-300">
          <ShieldCheckIcon className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
          <span className="min-w-0 truncate">
            <RichMessage
              id="onboarding:firstSession.make.rule.line"
              values={{ preset: presetName(preset, viewer) }}
              components={[<b className="font-semibold text-zinc-900 dark:text-zinc-100" />]}
            />
          </span>
          <button type="button" data-make-rule-info="" aria-expanded={tipOpen} aria-controls="make-rule-tip"
            aria-label={t('onboarding:firstSession.make.next.open')} onClick={() => setTipOpen((v) => !v)}
            className="-mx-2.5 -my-3.5 flex h-11 w-11 shrink-0 items-center justify-center text-zinc-500 dark:text-zinc-400">
            <InfoCircleIcon className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => { setTipOpen(false); setOpen(true); }} data-make-rule-change=""
            className="ml-auto shrink-0 font-semibold text-violet-700 dark:text-violet-400">
            {t('onboarding:firstSession.make.rule.change')}
          </button>
        </p>
      </div>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <PresetsSheet now={preset} viewer={viewer} onPick={onPick} onGone={() => setOpen(false)} />,
          document.body,
        )
        : null}
    </>
  );
}
