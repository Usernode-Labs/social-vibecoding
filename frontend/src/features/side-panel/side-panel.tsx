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
 *
 * ── The divider (#2886) ────────────────────────────────────────────────
 *
 * The panel's left edge is a handle: drag it (or focus it and use the arrow
 * keys) to share the window differently between the app and the panel, and
 * double-click it to go back to the default. ./resize.ts carries the width's
 * rules. Its first render is the prerender too — no width, no value — and
 * the stored width is read in an effect, never in render.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { Button } from '@/components/ui/button';
import { ChevronLeftIcon, ExpandIcon, XIcon } from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { SidePanel as controller } from './controller';
import {
  KEY_STEP,
  applyWidth,
  bounds,
  clampWidth,
  clearStoredWidth,
  probeLayout,
  readStoredWidth,
  writeStoredWidth,
} from './resize';
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
      <SidePanelDivider panelRef={rootRef} shown={s.open && !!s.frameSrc} />
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

interface WidthRange {
  now: number;
  min: number;
  max: number;
}

/**
 * The handle on the panel's left edge. A `separator` whose value is the
 * panel's width in pixels: the arrows move the divider the way they point
 * (Left widens the panel), Home and End go to the narrowest and the widest,
 * and a double-click forgets the chosen width.
 *
 * The value is published only once it is known — after mount, while the panel
 * is on screen — so the prerender and the first client render carry none.
 */
function SidePanelDivider({
  panelRef,
  shown,
}: {
  panelRef: RefObject<HTMLElement | null>;
  shown: boolean;
}): ReactNode {
  const [range, setRange] = useState<WidthRange | null>(null);
  const drag = useRef<{ id: number; startX: number; startW: number; width: number | null } | null>(null);

  // What is on screen now: the stored width, held inside this window, or the
  // stylesheet's default when there is none. Never writes the store — a
  // window that narrows gives the width back, and one that grows returns it.
  const settle = useCallback(() => {
    const b = bounds(probeLayout());
    const stored = readStoredWidth();
    applyWidth(stored == null ? null : clampWidth(stored, b));
    const panel = panelRef.current;
    const now = panel ? Math.round(panel.getBoundingClientRect().width) : 0;
    setRange(now > 0 ? { now, ...b } : null);
  }, [panelRef]);

  useEffect(() => {
    settle();
    if (!shown) return undefined;
    window.addEventListener('resize', settle);
    return () => window.removeEventListener('resize', settle);
  }, [shown, settle]);

  // A drag that never ended (the island unmounting mid-drag) must not leave
  // the whole document stuck in the resize cursor.
  useEffect(() => () => {
    document.documentElement.classList.remove('side-panel-resizing');
  }, []);

  const set = (width: number, persist: boolean): number => {
    const b = bounds(probeLayout());
    const next = clampWidth(width, b);
    applyWidth(next);
    setRange({ now: next, ...b });
    if (persist) writeStoredWidth(next);
    return next;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still drags while over the handle */ }
    drag.current = {
      id: e.pointerId,
      startX: e.clientX,
      startW: panel.getBoundingClientRect().width,
      width: null,
    };
    // Frames swallow pointer events that cross them; while a drag is on, the
    // app's and the panel's both stand aside (app.css).
    document.documentElement.classList.add('side-panel-resizing');
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // The panel is pinned to the right edge, so moving left widens it.
    d.width = set(d.startW + (d.startX - e.clientX), false);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    document.documentElement.classList.remove('side-panel-resizing');
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // A press that never moved is half of a double-click, not a choice.
    if (d.width != null) writeStoredWidth(d.width);
  };

  const onDoubleClick = () => {
    clearStoredWidth();
    settle();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const now = panel.getBoundingClientRect().width;
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = now + step;
    else if (e.key === 'ArrowRight') next = now - step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = Number.POSITIVE_INFINITY;
    if (next == null) return;
    e.preventDefault();
    set(next, true);
  };

  return (
    <div
      id="side-panel-divider"
      className="side-panel-divider"
      role="separator"
      aria-orientation="vertical"
      aria-controls="platform-side-panel"
      aria-label="Resize panel"
      aria-valuenow={range ? range.now : undefined}
      aria-valuemin={range ? range.min : undefined}
      aria-valuemax={range ? range.max : undefined}
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    ></div>
  );
}
