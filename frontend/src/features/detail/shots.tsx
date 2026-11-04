/**
 * A change's before and after viewer, inside the detail column (#6230).
 *
 * It used to be a popover (`popover` on `.dev-thread-shots-viewer`, opened by
 * thread-changes.tsx's Expand), which covered the thread it belonged to. The
 * markup is the same — `AppView.shotsHtml`'s thread reading, carried in the
 * store's payload — but it is drawn here, as the column's contents.
 */

import { useMemo, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import type { DetailEntry } from '../ai/detail';

export function DetailPaneShots({ entry }: { entry: DetailEntry }): ReactNode {
  const t = useMessages('chat');
  const html = String((entry.payload as { html?: string } | undefined)?.html || '');
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  if (!html) {
    // A reload's restored entry has no HTML yet: the request page fills it
    // when the change's ShotsPair renders. Say so rather than draw a blank.
    return (
      <div className="gc-spec-panel-body">
        <div className="gc-spec-panel-error">{t('chat:group.spec.loading')}</div>
      </div>
    );
  }
  return (
    <div
      className="dev-thread-shots-viewer gc-detail-shots"
      dangerouslySetInnerHTML={wrapper}
    />
  );
}
