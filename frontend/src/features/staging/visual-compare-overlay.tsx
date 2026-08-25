/**
 * `#visual-compare-overlay` — #353's before/after comparison, as a React island
 * (#1085 chunk H, step 1).
 *
 * This overlay is not one of the nine dialogs, so it does not go through
 * `frontend/src/lib/static-modal.ts`: nothing lifts its card into a kit shell,
 * and it holds state directly. The body is still built
 * as a string by `AppView.openVisualComparison` (server-side capture ids
 * validated against /^[a-f0-9]{32}$/, everything else escaped there) and handed
 * over as HTML — converting that markup generator is not in chunk H's scope.
 *
 * `data-opened-at` is the reason the open time is state: `revealModal` used to
 * stamp `dataset.openedAt` on this element, and `modalDismissGuarded` reads it
 * to swallow the opening tap's trailing ghost click. Rendering it keeps that
 * guard working without a write into React-owned DOM.
 */

import { useRef, type ReactNode } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { visualCompareHandlers, visualCompareStore } from './staging-store.js';

export function VisualCompareOverlay(): ReactNode {
  const state = useStoreState(visualCompareStore);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useHiddenClass(overlayRef, !state.open);

  return (
    <div
      id="visual-compare-overlay"
      ref={overlayRef}
      className="hidden fixed inset-0 z-50 bg-zinc-950/95 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Before / after comparison"
      data-opened-at={state.openedAt ? String(state.openedAt) : undefined}
      onClick={(event) => {
        // Backdrop only: the overlay root itself, never a child (same test the
        // hand-written handler made with `e.target === overlay`).
        if (event.target !== event.currentTarget) return;
        visualCompareHandlers.onBackdrop?.();
      }}
    >
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 shrink-0">
        <button
          id="visual-compare-back"
          className="text-zinc-500 hover:text-zinc-100 text-sm flex items-center gap-1 dark:text-zinc-400"
          onClick={() => visualCompareHandlers.onBack?.()}
        >
          <ChevronLeftIcon className="w-4 h-4" />
          Close
        </button>
        <span className="flex-1">
        </span>
        <span id="visual-compare-label" className="text-xs text-zinc-500 font-mono truncate dark:text-zinc-400">
          {state.label}
        </span>
      </div>
      {/*
          #353: cleared (not just hidden) on close, so a looping <video> in a
          comparison actually stops — the store's `bodyHtml` goes back to ''.
      */}
      <div
        id="visual-compare-body"
        className="usn-compare-body flex-1 overflow-auto p-4"
        dangerouslySetInnerHTML={{ __html: state.bodyHtml }}
      >
      </div>
    </div>
  );
}
