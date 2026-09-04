/**
 * `#dc-view`'s children — the dev chat's screen.
 * See ./view-store.ts for what it absorbed and what stays legacy-owned.
 */

import { type ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { DevChatBanners } from './banners';
import { DevComposer } from './composer';
import { SessionHeader } from './session-header';
import { SessionList } from './session-list';
import { SpecViewer } from './spec-viewer';
import { DevChatTranscript } from './transcript';
import { devViewStore, type DevViewState, type PaneView } from './view-store';

const HINT
  = 'mx-3 mt-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20'
  + ' text-xs text-zinc-600 dark:text-zinc-300 shrink-0';

const HINT_TEXT
  = 'Describe the change you want. When it’s ready, promoting this'
  + " session's PR is what creates the proposal everyone votes on.";

/** The composer bar's two class runs, as complete literals for Tailwind. */
const BAR = {
  framed: 'shrink-0 platform-safe-bar border-t border-zinc-200 dark:border-zinc-800 p-2',
  bare: 'shrink-0 platform-safe-bar',
} as const;

/**
 * Every pane's `-open` string, likewise.
 *
 * The `off` values keep the trailing space the template produced —
 * `class="dc-spec-viewer ${open ? '…' : ''}"` — because this conversion's
 * contract is that the rendered attribute does not move. It is inert: the
 * parser splits a class attribute on whitespace.
 */
const PANE = {
  specResizer: { on: 'dc-spec-resizer dc-spec-resizer-open', off: 'dc-spec-resizer ' },
  specViewer: { on: 'dc-spec-viewer dc-spec-viewer-open', off: 'dc-spec-viewer ' },
  stagingResizer: { on: 'dc-staging-resizer dc-staging-resizer-open', off: 'dc-staging-resizer ' },
  stagingPanel: { on: 'dc-staging-panel dc-staging-panel-open', off: 'dc-staging-panel ' },
} as const;

/**
 * A pane's inline width, saved from a previous drag.
 *
 * Only emitted while the pane is OPEN, exactly as the template did: a closed
 * pane is `width: 0` in app.css and a stale inline width would fight it. CSS
 * clamps the value to a min/max, so a bad one cannot make the chat unusable.
 */
function paneStyle(p: PaneView): { width: string } | undefined {
  return p.open && p.width ? { width: `${p.width}px` } : undefined;
}

function SessionView({ s }: { s: Extract<DevViewState, { kind: 'session' }> }): ReactNode {
  return (
    <>
      {/* #194: the one-shot "what a proposal is" hint, above everything. */}
      {s.proposalHint ? <div className={HINT}>{HINT_TEXT}</div> : null}
      {/* The ELEMENT keeps a CONSTANT className: `PlatformUI.attachScreenFx`
          writes a hairline/blur class onto it once the chat scrolls, and
          React never rewrites a className whose prop has not changed.

          `rounded-b-2xl` is #1588. This strip is the second bar on the screen —
          the platform header sits directly above it and curves its own bottom
          corners away (`rounded-b-2xl` there too, the same 1rem token), so a
          square-cornered bar underneath read as an unfinished copy of it. Both
          bars now let the page ground show through the same two notches.
          It was `rounded-b-lg` on both until #1571 enlarged the header's
          corner; this one moves with it by construction, not by coincidence
          — tests/dev-chat-view.test.js asserts the two files carry the same
          token so they cannot drift apart.

          The header's `-mb-2` companion is deliberately NOT copied. That
          overlap exists to make the SCREEN below it read as rounded-topped,
          and what sits below this strip is the transcript's own scroller;
          pulling it 8px up under the curve would put a message row in the
          notch. The corners are what was asked for and what matches.

          No `overflow-hidden` here either, for the reason the header's own
          note gives. */}
      <div
        id="dc-session-header"
        className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0 rounded-b-2xl"
      >
        <SessionHeader />
      </div>
      {/* `display: contents` — #dc-view is a flex column and each banner has
          to stay exactly the flex child it was, rather than becoming a block
          child of a wrapper. */}
      <div id="dc-banners" className="contents"><DevChatBanners /></div>
      <div className="dc-session-body flex-1 flex min-h-0">
        <div id="dc-tab-chat" className="dc-chat-pane flex-1 flex flex-col min-h-0">
          {/* #1348: the launchpad is PINNED TO THE TOP of the chat area. It
              stood in the composer's place at the bottom (#1281), which is
              where you look to type — but a launchpad is not a composer: it
              is the screen's subject, a walkthrough you work down while the
              transcript behind it is the reference. At the bottom the first
              step sat furthest from the eye and a long card pushed itself off
              the fold. Above the scroller it holds still while the transcript
              moves under it, and step 1 is the first thing on screen.

              It stays OUTSIDE #dc-messages on purpose: inside, it would
              scroll away with the transcript and stop being a launchpad. The
              slot collapses when empty (.dc-launchpad-slot:empty), so an
              ordinary session's chat pane is exactly what it was — which is
              why an empty `__html` is the right way to draw nothing here. */}
          <div
            id="dc-launchpad-slot" className="dc-launchpad-slot"
            dangerouslySetInnerHTML={{ __html: s.launchpadHtml }}
          />
          {/* The element carries the pane's scroll geometry and
              `initScrollTracking` binds click, keydown and scroll on it. */}
          <div id="dc-messages" className="dc-messages-container flex-1 overflow-y-auto py-2">
            <DevChatTranscript />
          </div>
          {/* platform-safe-bar (app.css): this block is the bottom of the
              screen on a phone, so it carries the home-indicator inset on top
              of its own p-2 — the strip below the Send row is part of this bar
              rather than dead space under it. */}
          <div id="dc-composer-bar" className={s.barEmpty ? BAR.bare : BAR.framed}>
            <DevComposer />
          </div>
        </div>
        <div
          id="dc-spec-resizer" className={s.spec.open ? PANE.specResizer.on : PANE.specResizer.off}
          role="separator" aria-orientation="vertical" aria-label="Resize spec viewer"
        ></div>
        {/* The pane's `width` is the DRAG's inline style and its `-open`
            class is this model's; the reader inside it is its own island,
            with its own store — see ./spec-viewer-store.ts. */}
        <div
          id="dc-spec-viewer" className={s.spec.open ? PANE.specViewer.on : PANE.specViewer.off}
          style={paneStyle(s.spec)}
        ><SpecViewer /></div>
        <div
          id="dc-staging-resizer"
          className={s.staging.open ? PANE.stagingResizer.on : PANE.stagingResizer.off}
          role="separator" aria-orientation="vertical" aria-label="Resize staging preview"
        ></div>
        {/* #771: a SLOT, not a container. The docked preview is an overlay
            positioned over this element's rect, so it stays empty. */}
        <div
          id="dc-staging-panel"
          className={s.staging.open ? PANE.stagingPanel.on : PANE.stagingPanel.off}
          style={paneStyle(s.staging)}
        ></div>
      </div>
    </>
  );
}

export function DevChatViewView({ s }: { s: DevViewState }): ReactNode {
  if (s.kind === 'none') {
    return (
      <div
        id="dc-session-list"
        className="divide-y divide-zinc-200 dark:divide-zinc-800 platform-safe-scroll"
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        <SessionList />
      </div>
    );
  }
  return <SessionView s={s} />;
}

export function DevChatView(): ReactNode {
  return <DevChatViewView s={useStoreState(devViewStore)} />;
}
