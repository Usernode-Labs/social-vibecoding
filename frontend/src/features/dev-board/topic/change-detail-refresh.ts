// What a change page (topic-head.tsx's ChangeDetail) does with a
// `change-detail-refresh` event, and which row it then shows.
//
// Kept apart from the component so tests/change-page-live-states.test.js can
// drive the real rules with the real app-view.js events (#6016): the board,
// a release and a live burst each tell the page in one of three ways.
//   - a bare id: re-read the row (a vote, a session change, a verdict, a
//     release that names the app and not the change);
//   - `{ id, row }`: adopt a row the Workshop just read for this page;
//   - `{ id, patch }`: merge a patch (a checks tick, a board reload that
//     moved the row), which this page's older read would otherwise paint over.

export type ChangeDetailAsk =
  | { reread: true }
  | { row: any }
  | { patch: Record<string, unknown> }
  | null;

/** What `detail` asks of the page showing change `id`; null when nothing. */
export function changeDetailAsk(detail: unknown, id: unknown): ChangeDetailAsk {
  if (detail && typeof detail === 'object') {
    const d = detail as { id?: unknown; row?: any; patch?: Record<string, unknown> };
    if (Number(d.id) !== Number(id)) return null;
    if (d.row) return { row: d.row };
    if (d.patch) return { patch: d.patch };
    return null;
  }
  return Number(detail) === Number(id) ? { reread: true } : null;
}

/**
 * #6139: a request's page says whether a change underway has finished from its
 * read of the thread, so it reads the thread again when it hears news of one,
 * once for a burst: `change-detail-refresh` (a verdict, a move in its life),
 * and SessionState's raw `session_state` events (a turn starting or ending,
 * which a change's status does not show, so app.js forwards none of them).
 * The result stops listening.
 */
export function rereadOnChangeNews(
  target: EventTarget,
  changes: ReadonlyArray<{ id: number; state?: string }>,
  reread: () => void,
  sessionState: { onEvent?: (cb: (payload: any) => void) => () => void } | null = null,
  waitMs = 500,
): () => void {
  const underway = changes.filter((c) => c.state === 'underway');
  if (!underway.length) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (!timer) timer = setTimeout(() => { timer = null; reread(); }, waitMs);
  };
  const hear = (event: Event) => {
    if (underway.some((c) => changeDetailAsk((event as CustomEvent).detail, c.id))) soon();
  };
  const hearState = (payload: any) => {
    if (underway.some((c) => Number(c.id) === Number(payload?.sessionId))) soon();
  };
  target.addEventListener('change-detail-refresh', hear);
  const offState = sessionState?.onEvent?.(hearState);
  return () => {
    target.removeEventListener('change-detail-refresh', hear);
    offState?.();
    if (timer) clearTimeout(timer);
  };
}

/** The page's read with `patch` merged over it, when that read is this change's. */
export function mergeChangePatch(current: any, id: unknown, patch: Record<string, unknown>): any {
  return current && Number(current.id) === Number(id) ? { ...current, ...patch } : current;
}

/** The row the page shows: its own read wins over the lighter cached row. */
export function changeDetailRow(item: any, loaded: any): any {
  return item && loaded?.id === item.id ? { ...item, ...loaded } : item;
}
