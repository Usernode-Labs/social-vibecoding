/**
 * The panel beside the Workshop tab's list, on a wide window (#4457).
 *
 * A row opens its item's page here, so the list stays where it was and the
 * next row is one tap away: go down your work, or a week's changes, one
 * after another. The row you are on is highlighted in the list, ✕ closes
 * the panel, and "Open as a page" gives the page the whole tab (its own
 * route, with its "‹ Workshop" chip).
 *
 * ── The SAME page, not a copy ─────────────────────────────────────────
 *
 * The page in here is the request's or the change's page itself: the panel
 * renders `#dev-topic-thread`, the host the full page's frame renders
 * (../topic-frame.tsx), and `AppView.openTopicInPanel` mounts into it
 * exactly what `_renderTopicSubView` mounts there — the request's Messages
 * thread (GroupChat.mountThread, RequestShell) or the change page
 * (mountChangePage). The topic sub-view is never up while the Workshop is,
 * so the id stays unique.
 *
 * The panel is portalled into <body>, out of the page's frosted layers,
 * whose transforms would pin a `position: fixed` box to them.
 *
 * The host is an empty leaf React never looks inside, like the full page's.
 * It is KEYED by the item, so another row gets a fresh host rather than a
 * second page mounted over the first one's portal (the NotFoundError
 * `_renderTopicHead`'s header describes).
 *
 * ── The plan reader has a slot here too (#4875) ───────────────────────
 *
 * A request's page shows its plan card, and its Read (like "View full
 * spec" on a spec card in the thread, and an attached file) opens
 * `GroupChat._showSpecPanel`, which fills `#gc-spec-side-panel` and does
 * nothing at all when that slot is not in the document. The full page's
 * frame has one (../topic-frame.tsx, #3495); this panel had none, so Read
 * here did nothing. The slot sits over the page, inside the panel: the
 * panel is too narrow to dock the reader beside it, so it takes the
 * reader's narrow-window layout, filling the panel below its bar until ✕
 * closes it. The topic frame is never up while this panel is, so the id
 * stays unique. Escape closes the reader before the panel, and the panel
 * closes the reader on its way out, so a plan read here is not left open
 * for the next screen to restore.
 */

import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ArrowRightIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { callAppView } from '../card/fold';
import type { TopicRef } from './work-row';

export function TopicSidePanel({ item, onClose }: { item: TopicRef; onClose: () => void }): ReactNode {
  const t = useMessages('project');
  // Mount the page once the host is in the document, and take it down with
  // the panel (or before the next item's).
  //
  // IN A MICROTASK, the defer actions-row.tsx already gives the kanban
  // filter bar: the mount publishes through a `flushSync`
  // (lib/legacy-portals.tsx), which React drops while it is still
  // committing — and an effect body is inside the commit. mountThread then
  // reads its container before the shell is in the DOM, finds no
  // `#gc-thread-input`, and skips the whole composer wiring (submit, the
  // draft, Enter, attachments and the three autocomplete controllers), so
  // typing @, # or : in the panel's Reply box opened nothing (#4629).
  // From the microtask the flushSync runs and the composer is wired.
  useEffect(() => {
    let live = true;
    queueMicrotask(() => { if (live) void callAppView('openTopicInPanel', item.kind, item.id); });
    return () => { live = false; callAppView('closeTopicPanel', item.kind, item.id); };
  }, [item.kind, item.id]);
  // A plan open in this panel's reader closes with the panel (or before the
  // next item's page). A LAYOUT cleanup, so it runs while the slot is still
  // in the document: `_closeSpecPanel` finds the host by id, and a passive
  // cleanup runs after the panel has already left.
  useLayoutEffect(() => () => {
    const gc = (window as any).GroupChat;
    if (gc && gc._specPanelRaw != null) gc._closeSpecPanel?.();
  }, [item.kind, item.id]);
  // Escape closes it, as it closes a sheet: but a plan open over the page
  // goes first. Listened for in the capture phase, ahead of group-chat.js's
  // own Escape on `document`, which closes the reader, so the panel can see
  // the reader was open and stay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('input, textarea, [contenteditable="true"]')) return;
      if (document.querySelector('.dev-ws-side .gc-spec-side-panel-open')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const openFull = () => {
    onClose();
    callAppView('openTopic', item.kind, item.id);
  };
  if (typeof document === 'undefined') return null;
  // Into <body>: the Workshop sits inside the page's frosted layers, whose
  // transforms would make `position: fixed` relative to them.
  return createPortal((
    <aside className="dev-ws-side" data-ws-side={`${item.kind}:${item.id}`} aria-label={t('project:sidePanel.label')}>
      <div className="dev-ws-side-bar">
        <button type="button" className="dev-ws-side-btn dev-ws-side-close" aria-label={t('core:common.close')} data-ws-side-close="" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </button>
        <button type="button" className="dev-ws-side-btn dev-ws-side-full" data-ws-side-full="" onClick={openFull}>
          {t('project:sidePanel.openAsPage')}
          <ArrowRightIcon aria-hidden="true" />
        </button>
      </div>
      <div className="dev-ws-side-body">
        <div key={`${item.kind}:${item.id}`} id="dev-topic-thread" className="dev-ws-side-page" />
        {/* #4875: the plan reader's slot, over the page. An empty leaf, keyed
            like the page's host: its contents are the reader's portal
            (../../group-chat/spec-panel.tsx), its open class group-chat.js's. */}
        <div key={`spec:${item.kind}:${item.id}`} id="gc-spec-side-panel" className="gc-spec-side-panel" />
      </div>
    </aside>
  ), document.body);
}
