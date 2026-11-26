/**
 * A change's before and after viewer, inside the detail column (#6230).
 *
 * It used to be a popover, which covered the thread it belonged to. It is
 * the one viewer every surface draws (../review-flow/shots-viewer.tsx),
 * larger here, from the change's shots carried in the store's payload.
 *
 * #6381: the viewer's own toolbar has no way out of the column, so a small
 * head above it closes the before and after, as the design preview beside it
 * does: an × where the column is a column, a back arrow where it is the whole
 * screen (`layout` is the detail store's, ../ai/detail.ts). Clicking it only
 * closes the column: the before and after themselves are untouched.
 */

import type { ReactNode } from 'react';

import { ChevronLeftIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { closeDetail, type DetailEntry, type DetailLayout } from '../ai/detail';
import { ShotsViewer } from '../review-flow/shots-viewer';
import { useDetailCard, useDetailLabel } from './detail-card';

export function DetailPaneShots({ entry, layout = 'three' }: { entry: DetailEntry; layout?: DetailLayout }): ReactNode {
  const t = useMessages('chat');
  const c = useMessages('changes');
  const shots = entry.payload?.shots || null;
  const back = layout === 'full';
  // Beside a thread on the bot tab (20 Nov 2026): the head card says it and closes it.
  const card = useDetailCard();
  const m = useMessages('messages');
  useDetailLabel({ title: m('messages:detail.kind.shots'), line: null });
  const head = card ? null : (
    <div className="gc-detail-shots-head">
      {back ? (
        <button
          type="button"
          className="gc-detail-back"
          onClick={closeDetail}
          aria-label={c('changes:shots.pane.back')}
          title={c('changes:shots.pane.back')}
          data-shots-close="back"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className="gc-detail-shots-close"
          onClick={closeDetail}
          aria-label={c('changes:shots.pane.close')}
          title={c('changes:shots.pane.close')}
          data-shots-close="close"
        >
          <XIcon aria-hidden="true" />
        </button>
      )}
    </div>
  );
  if (!shots) {
    // A reload's restored entry has no shots yet: the request page fills it
    // when the change's ShotsPair renders. Say so rather than draw a blank.
    return (
      <>
        {head}
        <div className="gc-spec-panel-body">
          <div className="gc-spec-panel-error">{t('chat:group.spec.loading')}</div>
        </div>
      </>
    );
  }
  return (
    <>
      {head}
      <div className="gc-detail-shots">
        <ShotsViewer source={shots.source} captions={shots.captions || null} expanded />
      </div>
    </>
  );
}
