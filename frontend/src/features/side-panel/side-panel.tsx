/**
 * #platform-side-panel — the panel beside a running app, on a desktop-width
 * window. ./controller.ts carries the whole of why and how; this is its
 * markup.
 *
 * ── The first render is the prerender, exactly ────────────────────────
 *
 * The store is at its initial state at hydration — closed, no frame, no
 * title — and nothing writes it before App.init has run. So this renders the
 * same markup the static document carries: the root hidden, the header row's
 * four controls with Back hidden, an empty title and an empty body. The
 * `hidden` classes are CONSTANT in the rendered className and toggled through
 * refs (lib/legacy-dom.ts useHiddenClass), never derived from the store in
 * render — the rule every island in this shell keeps.
 *
 * ── The frame ──────────────────────────────────────────────────────────
 *
 * The <iframe> exists only while there is a panel document (`frameSrc`), and
 * it is created ONCE per panel: keyed by `frameKey`, its `src` constant for
 * its whole life. Every later page is a navigation INSIDE it (the controller
 * talks to its document), because a new `src` would be a reload. It is the
 * body's first child and the spinner the second, so the spinner coming and
 * going can never move it.
 *
 * ── The header row ─────────────────────────────────────────────────────
 *
 * Back, the page's title, Expand, Close — the shell's own Button primitive
 * and glyphs, in the header's disc style (the app header's ✕ is the same
 * disc), so the row reads as the platform's rather than as the page's.
 */

import { useCallback, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ChevronLeftIcon, ExpandIcon, XIcon } from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { SidePanel as controller } from './controller';
import { sidePanelRefs, sidePanelStore } from './store.js';

/** The app header's round control, as its #back-btn draws it — less its
 *  display, which the two ways of drawing it below each supply. */
const DISC_BOX = 'items-center justify-center w-7 h-7 shrink-0 rounded-full'
  + ' border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]'
  + ' text-[color:var(--brand-ink)] un-touch-target';

/** Expand and Close: always there. */
const DISC = `inline-flex ${DISC_BOX}`;

/**
 * Back: SHIPS HIDDEN, and `hidden` cannot share a className with
 * `inline-flex` here — the Button primitive merges its classes with
 * tailwind-merge, which keeps only the last display utility and would drop
 * `hidden` from the prerender. So Back carries no display utility at all:
 * `hidden` while there is nowhere to go (toggled through its ref), and
 * app.css's `.side-panel-head > #side-panel-back:not(.hidden)` supplies the
 * inline-flex the other two spell out.
 */
const BACK = `hidden ${DISC_BOX}`;

export function SidePanel(): ReactNode {
  const s = useStoreState(sidePanelStore);
  const rootRef = useRef<HTMLElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const loadingRef = useRef<HTMLDivElement | null>(null);

  useHiddenClass(rootRef, !(s.open && !!s.frameSrc));
  useHiddenClass(backRef, !s.canBack);
  useHiddenClass(loadingRef, !s.loading);

  // React detaches the old frame's ref before it attaches a new one, so this
  // always holds the frame on screen, or null.
  const frameRef = useCallback((el: HTMLIFrameElement | null) => {
    sidePanelRefs.frame = el;
  }, []);

  return (
    <aside
      id="platform-side-panel"
      ref={rootRef}
      className="side-panel hidden"
      aria-labelledby="side-panel-title"
    >
      <div className="side-panel-head flex items-center gap-2 shrink-0">
        <Button
          id="side-panel-back"
          ref={backRef}
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={BACK}
          aria-label="Back"
          title="Back"
          onClick={() => controller.back()}
        >
          <ChevronLeftIcon className="w-5 h-5" aria-hidden="true" />
        </Button>
        <h2
          id="side-panel-title"
          className="flex-1 min-w-0 truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100"
        >
          {s.title}
        </h2>
        <Button
          id="side-panel-expand"
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={DISC}
          aria-label="Open full width, leaving the app"
          title="Open full width"
          onClick={() => controller.expand()}
        >
          <ExpandIcon className="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button
          id="side-panel-close"
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={DISC}
          aria-label="Close panel"
          title="Close panel"
          onClick={() => controller.close()}
        >
          <XIcon className="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>
      <div id="side-panel-body" className="side-panel-body">
        {s.frameSrc ? (
          <iframe
            key={s.frameKey}
            ref={frameRef}
            id="side-panel-frame"
            title="Side panel"
            src={s.frameSrc}
            className={s.loading ? 'side-panel-frame' : 'side-panel-frame side-panel-frame-ready'}
          />
        ) : null}
        <div
          id="side-panel-loading"
          ref={loadingRef}
          className="side-panel-loading hidden"
          aria-hidden="true"
        >
          <div className="dc-status-spinner-arc side-panel-spinner"></div>
        </div>
      </div>
    </aside>
  );
}
