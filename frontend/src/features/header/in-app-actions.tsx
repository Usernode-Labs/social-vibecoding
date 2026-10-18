/**
 * The one control a RUNNING APP's header carries besides the bell and the
 * mark: Suggest (#3702).
 *
 * ── Why here and not in the menu ───────────────────────────────────────
 *
 * Suggest was reachable before, and only from the Homeroom mark's menu: its
 * blue button is Suggest (../improve/actions.tsx). But the running app is
 * where a person notices what they would change — the thing on screen is the
 * thing the suggestion is about — so it takes one tap from the bar rather
 * than two through a menu. The menu's own rows are unchanged.
 *
 * On a phone the bar was too crowded with the old pair of controls (#5367),
 * so Suggest is hidden below `sm` and reached there through the mark's menu;
 * it keeps its place in the header on wider windows.
 *
 * The header's "N to vote" pill was removed in #5419: most of the bar
 * belongs to the app, and a count asking for a vote pulled attention away
 * from it. The count still shows on the mark's menu's "Go to community hub"
 * row (../app-context/app-context-sheet.tsx) and in the Communities tab's
 * Needs you feed, which load their own counts, and the loading this component
 * used to do existed only to feed the pill, so it went with it.
 *
 * ── Post-mount only, like the sheet's own conditional rows ─────────────
 *
 * The component ships NOTHING in the prerendered document — no id, no
 * element — and renders null on the hydrating render too (`mounted`), so the
 * two agree whatever the stores say by then (a deep link into an app has
 * app.js publish the target before this bundle hydrates). `InAppControls` is
 * what those gates resolve TO, exported so the render pass can be exercised
 * against real store state without an effect to click through.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { PencilSquareIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { Improve } from '../improve/improve-controller.js';

/**
 * The back button's own frame — the tinted round disc, the header's ink —
 * narrowed on a phone (`px-1.5` and the word `hidden sm:inline`) so the
 * app's name keeps some room.
 */
const SUGGEST_CLASS = 'shrink-0 hidden sm:inline-flex items-center justify-center gap-1.5 h-7 '
  + 'min-w-7 px-1.5 sm:px-2.5 rounded-full border border-[color:var(--brand-line)] '
  + 'bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] '
  + 'text-[0.8125rem] font-semibold un-touch-target';

/** Whether the running-app controls have somewhere to stand right now. */
function useInAppShown(): boolean {
  const { target, slug, tab, selfHosted } = useStoreState(improveStore);
  return target === 'app' && tab === 'app' && !!slug && !selfHosted;
}

export function InAppActions(): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return <InAppControls />;
}

/**
 * The control itself, drawn for the current store state. Everything here is
 * post-mount, so a store value arriving late simply changes a subtree React
 * already owns.
 */
export function InAppControls(): ReactNode {
  const t = useMessages();
  const shown = useInAppShown();
  const { slug } = useStoreState(improveStore);

  if (!shown || !slug) return null;

  return (
    <>
      {/*
          Drawn like the back button, per the header's own controls; on a
          phone the word goes and the pencil stands alone.
      */}
      <button
        id="header-in-app-suggest"
        type="button"
        className={SUGGEST_CLASS}
        aria-label={t('core:header.inApp.suggestLabel')}
        onClick={() => Improve.giveFeedback({ target: 'app' })}
      >
        <PencilSquareIcon className="w-4 h-4" aria-hidden="true" />
        <span className="hidden sm:inline">{t('core:header.inApp.suggest')}</span>
      </button>
    </>
  );
}