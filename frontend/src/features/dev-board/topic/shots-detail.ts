/**
 * Expand on a change's before & after: the same viewer, larger, in the
 * detail column beside the thread (#6230), as a design's preview and a plan
 * open there. The entry carries the change's shots view model, so the column
 * draws it with nothing to fetch (../../detail/shots.tsx).
 */

import type { ShotsSource } from '../../review-flow/shots-viewer';

export function openShotsDetail(source: ShotsSource, captions: { before: string; after: string } | null = null): void {
  (window as any).UsernodeReact?.detail?.open({
    kind: 'shots',
    ref: { changeId: source.sessionId },
    version: null,
    payload: { shots: { source, captions } },
  });
}
