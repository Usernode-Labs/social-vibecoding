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
 */

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ArrowRightIcon, XIcon } from '@/components/ui/icons';

import { callAppView } from '../card/fold';
import type { TopicRef } from './work-row';

export function TopicSidePanel({ item, onClose }: { item: TopicRef; onClose: () => void }): ReactNode {
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
  // Escape closes it, as it closes a sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const openFull = () => {
    onClose();
    callAppView('openTopic', item.kind, item.id);
  };
  if (typeof document === 'undefined') return null;
  // Into <body>: the Workshop sits inside the page's frosted layers, whose
  // transforms would make `position: fixed` relative to them.
  return createPortal((
    <aside className="dev-ws-side" data-ws-side={`${item.kind}:${item.id}`} aria-label="The item's page">
      <div className="dev-ws-side-bar">
        <button type="button" className="dev-ws-side-btn dev-ws-side-close" aria-label="Close" data-ws-side-close="" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </button>
        <button type="button" className="dev-ws-side-btn dev-ws-side-full" data-ws-side-full="" onClick={openFull}>
          Open as a page
          <ArrowRightIcon aria-hidden="true" />
        </button>
      </div>
      <div key={`${item.kind}:${item.id}`} id="dev-topic-thread" className="dev-ws-side-page" />
    </aside>
  ), document.body);
}
