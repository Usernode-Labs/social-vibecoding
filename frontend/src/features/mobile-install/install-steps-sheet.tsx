import { useRef, type Ref } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { GroupedList } from '@/components/ui/grouped-list';
import { ArrowUpTrayIcon, EllipsisVerticalIcon, XIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { useSheet } from '../../lib/sheet';
import { A2HS_STEP_LIST, type A2hsStep, type MobileOs } from './detect';

/**
 * `#mobile-install-steps` — the install banner's "How" sheet (#4400).
 *
 * The banner used to swap its second line for the steps in place, which on a
 * one-line strip meant a truncated sentence. "How" opens this instead: a
 * small sheet from the floor with the steps for the reader's OS, numbered,
 * and a "Got it" that closes it. Closing it does not dismiss the banner; the
 * banner's own ✕ still does that.
 *
 * Presented the way the staking sheet and the community switcher are, by the
 * Sheet (lib/sheet.ts): the native kit's `sheet` when one is there, and a CSS
 * sheet over a scrim when not. Back, Escape, the scrim, ✕ and "Got it" all
 * close it.
 *
 * Island rules: rendered only while open, into document.body, from state that
 * only changes after the first paint, so nothing here is in the prerendered
 * shell.
 */
export function InstallStepsSheet({ os, onClose }: { os: MobileOs; onClose: () => void }) {
  const done = useRef<HTMLButtonElement | null>(null);
  const { panelRef: panel, adopted, scrimProps } = useSheet({
    kind: 'sheet',
    onClose,
    initialFocus: () => done.current,
  });

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={adopted ? 'contents' : 'fixed inset-0 z-[70] bg-black/60 flex items-end justify-center'}
      {...scrimProps}
    >
      <div
        ref={panel}
        id="mobile-install-steps"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-install-steps-title"
        // A constant: the kit writes `platform-sheet-adopted` to this node, and
        // a className that changed on adoption would erase it. A column: that
        // class makes the node `display: flex` (public/css/app.css), and in a
        // row the title, the steps and Got it stood side by side, the steps
        // cut off in a narrow strip (shots of #5695).
        className="w-full max-w-md rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] flex flex-col"
      >
        <InstallStepsContent os={os} onClose={onClose} doneRef={done} />
      </div>
    </div>,
    document.body,
  );
}

/**
 * What the sheet shows: the title and its ✕, the numbered steps for `os` in
 * one white card, and "Got it". Separate from the presentation so a test can
 * render it without a document.
 */
export function InstallStepsContent({ os, onClose, doneRef }: {
  os: MobileOs;
  onClose: () => void;
  doneRef?: Ref<HTMLButtonElement>;
}) {
  const t = useMessages('agent');
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <h2 id="mobile-install-steps-title" className="flex-1 min-w-0 text-[17px] font-bold leading-snug text-zinc-900 dark:text-zinc-100">
          {t('agent:install.steps.title')}
        </h2>
        <button
          id="mobile-install-steps-close"
          type="button"
          onClick={onClose}
          aria-label={t('core:common.close')}
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors un-touch-target"
        >
          <XIcon className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <GroupedList className="mx-0">
        <ol data-a2hs-os={os}>
          {A2HS_STEP_LIST[os].map((step, i) => (
            <StepRow key={step.text} n={i + 1} step={step} last={i === A2HS_STEP_LIST[os].length - 1} />
          ))}
        </ol>
      </GroupedList>
      <Button
        id="mobile-install-steps-done"
        ref={doneRef}
        type="button"
        layout="full"
        className="mt-4 min-h-[44px]"
        onClick={onClose}
      >
        {t('agent:install.steps.done')}
      </Button>
    </>
  );
}

function StepRow({ n, step, last }: { n: number; step: A2hsStep; last: boolean }) {
  const t = useMessages('agent');
  const Glyph = step.glyph === 'share' ? ArrowUpTrayIcon : step.glyph === 'menu' ? EllipsisVerticalIcon : null;
  return (
    <li className={last
      ? 'flex items-center gap-3 px-4 py-3'
      : 'flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800'}
    >
      <span
        aria-hidden="true"
        className="shrink-0 w-6 h-6 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-[13px] font-semibold text-zinc-600 dark:text-zinc-300"
      >
        {n}
      </span>
      <span className="flex-1 min-w-0 text-[15px] text-zinc-900 dark:text-zinc-100">
        {t(step.text)}
      </span>
      {Glyph ? (
        <Glyph className="shrink-0 w-5 h-5 text-violet-600 dark:text-violet-400" aria-hidden="true" />
      ) : null}
    </li>
  );
}
