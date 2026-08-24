/**
 * #header-title as a React-owned control (Streamlined Concept).
 *
 * The Figma board makes the center of the top bar a tappable "app name ⌄"
 * tab: while an app context is on screen, tapping the title opens the
 * app-context sheet (Use the app / Activity / Board / changes). On every
 * other screen the title is exactly the inert <h1> it always was.
 *
 * ── Ownership ──────────────────────────────────────────────────────────
 *
 * The title's text used to be a `textContent` write from App.setHeaderTitle
 * (public/js/app.js). A tappable control with a conditional chevron is
 * state, and React may only render state it owns — so setHeaderTitle now
 * publishes through window.UsernodeReact.headerTitle (./mount.ts) into
 * ./header-title-store.js, and this component is the single renderer. The
 * direct DOM write is gone in the same change.
 *
 * Two constants survive from the plain <h1>:
 *   - the id and className are byte-identical to what the shell shipped;
 *     the className is a CONSTANT prop because ./use-header-layout.ts
 *     toggles `.is-centered` on this node via classList, and a re-rendered
 *     class attribute would drop it.
 *   - `pointer-events-none` stays on the h1 — the title is absolutely
 *     centered and may overlap the icon groups, so only the inner tab
 *     (`pointer-events-auto`, content-sized) takes taps, never the
 *     overlap.
 *
 * ── When is it a tab? ──────────────────────────────────────────────────
 *
 * Exactly when the Improve store carries an app target (the same gate as
 * #improve-btn): `slug` names the app whose context sheet would open. The
 * initial store state has no target and the text is 'dApps', so the SSG
 * prerender and the hydrating render both emit the plain heading.
 */

import type { RefObject } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { headerTitleStore } from './header-title-store.js';
import { improveStore } from '../improve/improve-store.js';

export function HeaderTitleTab({ titleRef }: { titleRef: RefObject<HTMLHeadingElement | null> }) {
  const { text } = useStoreState(headerTitleStore);
  const { target, slug } = useStoreState(improveStore);
  // Same gate as #improve-btn: a context exists when something improvable is
  // on screen. The platform's own self-hosted row counts — its context sheet
  // is how home reaches the platform's Activity and Board.
  const interactive = !!(target && slug);

  return (
    <h1
      ref={titleRef}
      id="header-title"
      className={"flex-1 min-w-0 text-lg font-bold pointer-events-none truncate\n               text-left"}
    >
      {interactive ? (
        <button
          id="header-title-tab"
          type="button"
          className={'pointer-events-auto inline-flex items-center gap-1 max-w-full h-7 '
            + 'align-middle un-touch-target'}
          aria-haspopup="dialog"
          aria-label={`${text} — open app views`}
          onClick={() => (window as unknown as {
            AppContext?: { toggle?: () => void };
          }).AppContext?.toggle?.()}
        >
          <span className="truncate">
            {text}
          </span>
          <ChevronDownIcon className="w-4 h-4 shrink-0 text-zinc-400" aria-hidden="true" />
        </button>
      ) : text}
    </h1>
  );
}
