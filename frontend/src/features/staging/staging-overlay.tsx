/**
 * `#staging-overlay` — the staging-preview overlay, as a React island
 * (#1085 chunk H, step 1).
 *
 * ── Why this region goes first ─────────────────────────────────────────
 *
 * It is the rehearsal for `#app-view`. This overlay holds `#staging-iframe`,
 * whose `src` app-view.js clears (`iframe.src = ''`) on every open and close,
 * re-points on a "Test this change" jump, and which #771 toggles between a
 * fullscreen overlay and a docked side panel — all of it on the SAME element,
 * because reparenting or re-creating an iframe reloads it and a reload throws
 * away whatever the user was doing inside the previewed app. Proving a
 * React-owned iframe survives every one of those state changes here is the
 * evidence the app viewer needs before anyone touches it.
 *
 * ── How the identity guarantee is kept ─────────────────────────────────
 *
 * 1. The `<iframe>` is rendered UNCONDITIONALLY, in a fixed position, with no
 *    `key`, and its `src` is not a prop — see staging-store.js. Nothing in this
 *    component's state can change the element's identity, so React only ever
 *    reconciles attributes around it.
 * 2. Every class the shell toggles at runtime (`hidden` on the overlay, the
 *    loader and the testing panel; `staging-overlay-docked`) is applied through
 *    the `useHiddenClass` / `useClassToggle` refs from lib/legacy-dom.ts, never
 *    a rendered `className`. That keeps the `className` props CONSTANT, which is
 *    what makes the prerendered markup byte-identical to the hand-written shell
 *    and what stops React from fighting `app.css`'s runtime classes.
 * 3. `#staging-dev-console-btn` and `#staging-dev-console-badge` are still
 *    written by features/dev-console/store.ts (`hidden` + `textContent`). That
 *    is sanctioned for exactly the same reason: their `className` is constant
 *    and they render no children, so React never issues a write that could
 *    reconcile the dev console's away.
 */

import { useRef, type ReactNode } from 'react';

import { ChevronLeftIcon, TerminalIcon } from '@/components/ui/icons';

import { useClassToggle, useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { stagingHandlers, stagingRefs, stagingStore } from './staging-store.js';
import { useStoreState } from '../../lib/use-store-state';

export function StagingOverlay(): ReactNode {
  const state = useStoreState(stagingStore);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const loaderRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const testBtnRef = useRef<HTMLButtonElement | null>(null);
  const fsBtnRef = useRef<HTMLButtonElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Publish the element the bridge mutates. Registered once — this component
  // never unmounts, and the ref never points at a different node.
  useIsomorphicLayoutEffect(() => {
    stagingRefs.iframe = iframeRef.current;
    return () => { stagingRefs.iframe = null; };
  }, []);

  useHiddenClass(overlayRef, !state.open);
  useClassToggle(overlayRef, 'staging-overlay-docked', state.mode === 'docked');
  useHiddenClass(loaderRef, !state.loaderVisible);
  useHiddenClass(panelRef, state.testPanelHidden);
  useHiddenClass(testBtnRef, state.testBtnHidden);
  useHiddenClass(fsBtnRef, state.fsBtnHidden);

  // #771: the docked overlay is pinned over #dc-staging-panel's bounding rect.
  // Fullscreen carries NO inline style at all (the CSS `inset: 0` does it), so
  // the prerendered element has no style attribute — same as the hand-written
  // shell — and React removes the four properties again on the way back out.
  const rect = state.dockRect;
  const style = rect
    ? { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` }
    : undefined;

  return (
    <div
      id="staging-overlay"
      ref={overlayRef}
      className="hidden fixed inset-0 z-40 bg-zinc-950 flex flex-col"
      style={style}
    >
      {/*
          `staging-chrome-bar` is a STYLE HOOK, not decoration: fullscreen,
          this overlay is `inset: 0` and covers the status bar, so app.css
          adds the top safe-area inset to this bar (and only in the
          non-docked state — a docked panel is pinned mid-page and needs
          none). The bar's bottom edge needs nothing: everything below it
          is the staging iframe, which reaches the true bottom edge and
          receives the real insets over the safe-area bridge.
      */}
      <div className="staging-chrome-bar flex items-center gap-3 px-4 py-2 border-b border-zinc-800 shrink-0">
        <button
          id="staging-back"
          className="text-zinc-500 hover:text-zinc-100 text-sm flex items-center gap-1 dark:text-zinc-400"
          onClick={() => stagingHandlers.onBack?.()}
        >
          <ChevronLeftIcon className="w-4 h-4" />
          Back to session
        </button>
        <span className="flex-1">
        </span>
        {/*
            #127: bot-generated testing guidance. Hidden unless the session
            carries testing_md / testing_path; wired in AppView.swapToStaging.
        */}
        <button
          id="staging-test-btn"
          ref={testBtnRef}
          className="hidden text-xs font-medium px-2.5 py-1 rounded bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 shrink-0"
          title={state.testBtnTitle || undefined}
          onClick={() => stagingHandlers.onTest?.()}
        >
          Test this change
        </button>
        {/*
            #771: docked-mode toggle. In the docked side panel it reads
            "Full screen" (expand to today's fullscreen overlay); in
            fullscreen — when the preview was opened from dev chat and can
            re-dock — it reads "Exit full screen". Same element, same
            iframe: toggling never reloads the preview. Wired in
            AppView._updateStagingModeUi.
        */}
        <button
          id="staging-fullscreen-btn"
          ref={fsBtnRef}
          className="hidden text-xs font-medium px-2.5 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 shrink-0"
          title={state.fsBtnTitle || undefined}
          onClick={() => stagingHandlers.onFullscreen?.()}
        >
          {state.fsBtnText}
        </button>
        <span id="staging-url-label" className="text-xs text-zinc-500 font-mono truncate dark:text-zinc-400">
          {state.urlLabel}
        </span>
        {/*
            Mirror of the main dev-console button. The overlay covers the
            global header (z-40), so the original button is obscured —
            we surface a duplicate inside the overlay's own chrome and
            delegate its click to DevConsole.toggle(). features/dev-console
            binds the click and owns this button's `hidden` class and the
            badge's text: see the note in the file header.
        */}
        <button
          id="staging-dev-console-btn"
          className="relative text-zinc-500 hover:text-zinc-200 dark:text-zinc-400"
          aria-label="Open developer console"
        >
          <TerminalIcon className="w-5 h-5" />
          <span
            id="staging-dev-console-badge"
            className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-bold flex items-center justify-center"
          >
          </span>
        </button>
        {/*
            #771: close button for the docked side panel. CSS shows it only
            in docked mode (where "Back to session" is hidden — closing the
            panel IS going back to the session, which never left).
        */}
        <button
          id="staging-dock-close"
          className="staging-dock-only text-zinc-500 hover:text-zinc-100 text-lg leading-none px-1 shrink-0 dark:text-zinc-400"
          aria-label="Close preview"
          onClick={() => stagingHandlers.onDockClose?.()}
        >
          &times;
        </button>
      </div>
      {/*
          Explains why this change isn't live yet — a common point of
          confusion the first time someone previews their own PR.
      */}
      <div className="px-4 py-1.5 bg-violet-500/10 border-b border-violet-500/20 text-xs text-zinc-500 shrink-0 dark:text-zinc-400">
        Private preview. Only you can see this until the app's users vote your change in.
      </div>
      <div className="relative flex-1">
        {/*
            THE element. Rendered once, never keyed, never conditionally
            wrapped, `src` assigned only through stagingBridge.setSrc — see the
            file header. tests/staging-iframe-identity.test.js pins this.
        */}
        <iframe
          id="staging-iframe"
          ref={iframeRef}
          className="absolute inset-0 w-full h-full border-0"
          style={{ background: "#08080f" }}
          allow="pointer-lock"
        >
        </iframe>
        {/*
            #127: collapsible "How to test" panel overlaying the top of the
            preview. Hidden until requested via the "Test this change" button
            (auto-shown only for that explicit entry path, #237). Content is
            bot-authored markdown rendered through the escaping markdown
            pipeline in AppView._renderTestingControls.
        */}
        <div
          id="staging-testing-panel"
          ref={panelRef}
          className="hidden absolute top-2 left-2 right-2 sm:left-auto sm:w-96 z-10 rounded-lg border border-violet-500/30 bg-zinc-900/95 backdrop-blur shadow-xl"
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
            <span className="text-xs font-semibold text-violet-300">
              How to test
            </span>
            <span className="flex-1">
            </span>
            <button
              id="staging-testing-close"
              className="text-zinc-500 hover:text-zinc-200 text-sm leading-none px-1 dark:text-zinc-400"
              aria-label="Dismiss testing instructions"
              onClick={() => stagingHandlers.onTestingClose?.()}
            >
              &times;
            </button>
          </div>
          <div
            id="staging-testing-content"
            className="px-3 py-2 text-xs text-zinc-300 leading-relaxed max-h-48 overflow-y-auto"
            dangerouslySetInnerHTML={{ __html: state.testHtml }}
          >
          </div>
        </div>
        {/*
            Spinner shown over the iframe while a preview is being opened, so
            the load never reads as a black void. app-view.js owns the copy:
            a neutral "Opening preview…" while ensure-staging is asked,
            "Loading the preview…" across the iframe's own render, the
            rebuild estimate ONLY when a rebuild is genuinely running, and a
            waiting state when the host hasn't answered yet. The defaults
            below are neutral on purpose (#816) — a first paint before JS
            sets the text must not promise a wait that isn't happening.
        */}
        <div
          id="staging-loader"
          ref={loaderRef}
          className="hidden absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950 text-center px-6"
        >
          <div className="w-9 h-9 border-2 border-zinc-700 border-t-violet-400 rounded-full animate-spin">
          </div>
          <div id="staging-loader-title" className="text-sm text-zinc-200 font-medium">
            {state.loaderTitle}
          </div>
          <div id="staging-loader-sub" className="text-xs text-zinc-500 max-w-xs leading-relaxed dark:text-zinc-400">
            {state.loaderSub}
          </div>
        </div>
      </div>
    </div>
  );
}
