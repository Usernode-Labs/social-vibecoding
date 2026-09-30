/**
 * The Dev general-chat sub-view's frame — the ACTIVITY screen's chassis
 * (Streamlined Concept).
 *
 * It used to carry a "← General chat" back bar above the pane; Activity is a
 * first-class destination now (#app/<slug>/activity, an app-context sheet
 * row), the header's title tab names it, and the eye button is the way back
 * to the app — so the bar is gone and the frame is just the legacy-owned
 * host. `AppView.renderGroupChatTab()` still mounts into `#dev-chat-body`
 * exactly as it always did — spec side-panel, autocomplete, drafts and
 * scroll restore all unchanged — so React renders it as an empty leaf and
 * never looks inside it again.
 *
 * #3407 put the page head back — but the page's own, not the retired bar:
 * the channel is a level inside the project's hub (a notification, the
 * board's discussion card or a link lands on it full-screen), and like the
 * Needs you page it carries the round chevron and its name at the top. The
 * destination is the hub itself, not the tab that project page was last left
 * on, so a plain click calls `AppView._landOnHub` before following the href
 * (`App._hubHref` spells it); cmd/ctrl-click stays the browser's, so the
 * control is a real `<a>` (the same contract `TopicBack` follows). The
 * Messages-side pane and threads get no head — this frame is the
 * full-screen channel alone. Mounted client-side only, so reading the
 * open app from the store cannot mismatch hydration.
 */

import type { MouseEvent, ReactNode } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';

// The project's hub address, the page the channel hangs off. `App._hubHref`
// is the owner of the spelling; the same spelling inline keeps this frame
// testable without the global (apps/browse.js rowHref does the same).
function hubHref(slug: string): string {
  const win = window as unknown as {
    App?: { _hubHref?: (slug: string) => string };
  };
  return win.App?._hubHref?.(slug) ?? `#app/${encodeURIComponent(slug)}/workshop`;
}

// A plain click opens the hub directly: guard modified clicks first (the
// browser's new tab), then set the Workshop tab to the hub before following
// the href, exactly what the board rows do (`apps/browse.js openRow`). The
// hash assignment pushes a history entry, so device Back returns here.
function onBackClick(event: MouseEvent<HTMLAnchorElement>, slug: string): void {
  const nav = (window as unknown as {
    NavLink?: { isNativeClick?: (e: unknown) => boolean };
  }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  const win = window as unknown as {
    AppView?: { _landOnHub?: (slug: string) => void };
  };
  event.preventDefault();
  win.AppView?._landOnHub?.(slug);
  window.location.hash = hubHref(slug);
}

export function DevChatSubView(): ReactNode {
  const { slug, name } = useStoreState(improveStore);
  const href = slug ? hubHref(slug) : null;
  return (
    <div className="flex flex-col h-full min-h-0 dc-lift dc-lift-strip">
      {href && slug ? (
        <div className="px-4 pb-2">
          <div className="dev-ws-pagehead">
            <a
              className="dev-ws-page-back un-touch-target"
              href={href}
              aria-label={`Back to ${name || slug}`}
              title={`Back to ${name || slug}`}
              onClick={(event) => onBackClick(event, slug)}
            >
              <ChevronLeftIcon className="dev-ws-page-back-glyph" aria-hidden="true" />
            </a>
            <div className="dev-ws-pagehead-text">
              <span className="dev-ws-pagehead-over">{name || slug}</span>
              <h2 className="dev-ws-pagehead-title">Channel</h2>
            </div>
          </div>
        </div>
      ) : null}
      {/* app.css gives this host the 12px of strip shoulder that shows above
          the Discussion sheet ../group-chat/general-chat.tsx mounts here — the
          same band a Messages thread shows above its sheet. Its class string
          stays the empty-host one tests/dev-board-island.test.js pins. */}
      <div id="dev-chat-body" className="flex-1 min-h-0"></div>
    </div>
  );
}
