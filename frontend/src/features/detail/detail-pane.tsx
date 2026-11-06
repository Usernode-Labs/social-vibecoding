/**
 * THE DETAIL COLUMN'S CONTENTS (#6230, 3 Nov 2026): what a thread opened to
 * read beside it, drawn by kind. One column, three tenants —
 *
 *   design   a design's preview, ../messages/design-pane.tsx, unchanged
 *   plan     the shared-spec reader's contents, ../group-chat/spec-panel.tsx,
 *            unchanged (its two tabs, Copy markdown, its ×)
 *   shots    a change's before and after viewer, rendered inline instead of
 *            in the popover it used to open
 *
 * The store is ../ai/detail.ts; this module only draws it.
 */

import type { ReactNode } from 'react';

import { DetailPaneShots } from './shots';
import { DesignPane } from '../messages/design-pane';
import { SpecPanelView } from '../group-chat/spec-panel';
import { closeDetail, useDetailState, type DetailLayout } from '../ai/detail';

export function DetailPane({ layout }: { layout: DetailLayout }): ReactNode {
  const state = useDetailState();
  const entry = state.entry;
  if (!entry) return null;
  if (entry.kind === 'design') {
    return (
      <DesignPane
        conversationId={entry.ref.conversationId!}
        rootId={entry.ref.rootId!}
        view="preview"
        onView={() => {}}
        version={entry.version}
        seq={entry.seq}
        onClose={closeDetail}
        closeAs={layout === 'full' ? 'back' : 'close'}
      />
    );
  }
  if (entry.kind === 'shots') return <DetailPaneShots entry={entry} layout={layout} />;
  return (
    <SpecPanelView
      open
      title={state.title}
      subtitle={state.subtitle}
      canCopy={state.canCopy}
      body={state.body}
      raw={state.raw}
      closeAs={layout === 'full' ? 'back' : 'close'}
    />
  );
}
