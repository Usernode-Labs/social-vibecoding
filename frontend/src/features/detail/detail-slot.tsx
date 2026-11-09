/**
 * THE DETAIL COLUMN'S HOST, IN REACT (#6230, 3 Nov 2026).
 *
 * `#gc-spec-side-panel` and its `#gc-spec-resizer` handle used to be empty
 * leaves written by group-chat.js: the class that opened the panel, its inline
 * width, the drag and the Escape were all that module's, and React only
 * filled the host's contents. The column is one detail now — a design, a plan
 * or a change's before and after — and everything inside it is drawn from one
 * store (../ai/detail.ts), so the host and its open state belong to React too.
 *
 * The ids and classes stay exactly where they were: app.css lays the slot out
 * by them on a request's own page (docked beside the page at 1024px and up,
 * over it below) and in the general chat, and no dapp.json check selects on
 * them. The resizer keeps the remembered width (`gc-spec-panel-width-v1`) and
 * the 280px minimum with 320px left for the chat.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { useDetailLayout, useDetailState, type DetailEntry, type DetailKind, type DetailSurface } from '../ai/detail';
import { DetailPane } from './detail-pane';

const WIDTH_KEY = 'gc-spec-panel-width-v1';
const MIN_WIDTH = 280;
const CHAT_FLOOR = 320;

function readWidth(): number | null {
  try {
    const v = parseInt(localStorage.getItem(WIDTH_KEY) || '', 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeWidth(px: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(px))); } catch { /* private mode */ }
}

/**
 * The kinds this column can draw (./detail-pane.tsx draws each one): a design's
 * preview, a plan, a change's before and after. #6315: the slot used to open
 * for a plan alone, so Expand on a request's page put a shots entry into the
 * store and drew nothing.
 */
const DRAWN: ReadonlySet<DetailKind> = new Set<DetailKind>(['design', 'plan', 'shots']);

/** Pure: whether the slot opens for this entry. Nothing open means nothing drawn. */
export function slotOpens(entry: Pick<DetailEntry, 'kind'> | null | undefined): boolean {
  return !!entry && DRAWN.has(entry.kind);
}

export interface DetailSlotProps {
  surface: DetailSurface | 'chat';
  /** The host's extra classes, where a frame has always spelled them. */
  className?: string;
  /** The handle's label (the frame's own wording). */
  resizerLabel: string;
}

/**
 * The slot: the divider and the panel, empty and closed until something opens.
 * In `halves` and `full` the divider is not drawn (there is nothing to size:
 * the two share the room), which is the rule app.css has always had.
 */
export function DetailSlot({ surface, className, resizerLabel }: DetailSlotProps): ReactNode {
  const layout = useDetailLayout(surface === 'workshop' ? 'workshop' : 'topic');
  const state = useDetailState();
  const open = slotOpens(state.entry);
  const [width, setWidth] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setWidth(readWidth()); }, []);

  const onDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    const handle = e.currentTarget;
    const tabBody = handle.parentElement;
    if (!panel || !tabBody) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const maxWidth = Math.max(MIN_WIDTH + 1, tabBody.getBoundingClientRect().width - CHAT_FLOOR);
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('gc-spec-resizer-active');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      // Dragging right shrinks the panel (its left edge moves right).
      const next = Math.max(MIN_WIDTH, Math.min(maxWidth, startWidth - (ev.clientX - startX)));
      panel.style.width = `${next}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      handle.classList.remove('gc-spec-resizer-active');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      const final = panel.getBoundingClientRect().width;
      writeWidth(final);
      setWidth(final);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, []);

  const style = open && layout === 'three' && width ? { width: `${width}px` } : undefined;
  return (
    <>
      <div
        id="gc-spec-resizer"
        className={open && layout === 'three' ? 'gc-spec-resizer gc-spec-resizer-open' : 'gc-spec-resizer'}
        role="separator"
        aria-orientation="vertical"
        aria-label={resizerLabel}
        onPointerDown={onDown}
      />
      <div
        ref={panelRef}
        id="gc-spec-side-panel"
        className={[className, 'gc-spec-side-panel', open ? 'gc-spec-side-panel-open' : ''].filter(Boolean).join(' ')}
        data-detail={layout}
        data-detail-kind={state.entry?.kind || undefined}
        data-detail-surface={surface}
        style={style}
      >
        <DetailPane layout={layout} />
      </div>
    </>
  );
}
