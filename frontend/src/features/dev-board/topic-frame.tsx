import { Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * The Dev topic sub-view's frame — the thread's host, and nothing above it —
 * converted from `AppView._renderTopicSubView()`'s `innerHTML` template.
 *
 * ── THE BACK BAR IS GONE, AND THIS IS THE LAST ONE ────────────────────
 *
 * It was a full-width bar with a hairline whose entire content was `← Back`,
 * sitting directly under a platform header that, since the back/home rule,
 * carries a chevron to the same Board on this very route. Two back controls
 * one row apart, and the page opened with a strip of chrome instead of the
 * proposal you came to read.
 *
 * ./chat-frame.tsx retired its own for the same reason ("Activity is a row,
 * the header's title tab names it"), and the dev session's strip retired its
 * `←` too — see features/dev-chat/session-header.tsx, whose note reads "one
 * back control, in the bar the board draws it in". This page was the one that
 * kept its copy; it does not any more.
 *
 * ── #2916 PUT BACK INSIDE THE PANE, AND NOT HERE ──────────────────────
 *
 * The header's chevron was then asked to sit "inside" the Workshop pane, and
 * it does: the "‹ Workshop" chip at the top of the topic, with the header
 * drawing no arrow on these routes. Still ONE back control, and still not
 * this frame's: it is the first child of `.dev-topic`
 * (./topic/topic-back.tsx, rendered by TopicHead), so it scrolls with the
 * card it sits on instead of being pinned above the thread as this bar was.
 * The frame keeps taking no props.
 *
 * What is left is `#dev-topic-thread`: change routes mount the full card
 * with conversation tabs here; issue/governance routes mount the thread
 * panel and put their topic card into its `#gc-thread-head` slot.
 *
 * ── The shared-spec reader has a slot here too ────────────────────────
 *
 * Both of those Discussions draw spec cards (the Homeroom bot posts its spec
 * into a request's thread and into its proposal's), and "View full spec"
 * opens `GroupChat._showSpecPanel`, which fills `#gc-spec-side-panel` and
 * does nothing at all when that slot is not in the document. It used to be
 * only in the general chat pane (../group-chat/general-chat.tsx), so every
 * spec card in a request's or a proposal's Discussion had a button that
 * went dead. The row below is that pane's row, repeated: the topic column,
 * the divider, the panel, with the same ids and classes, so app.css lays it
 * out the same way (docked beside the topic at 1024px and up, over it
 * below) and group-chat.js fills, resizes and closes it the same way. The
 * two frames are sub-views of the same `#app-content`, never on screen
 * together, so the ids stay unique. Both hosts are empty leaves React never
 * looks inside: the panel's contents are the spec reader's portal
 * (../group-chat/spec-panel.tsx), and its open class is group-chat.js's.
 *
 * ── Why this was the LAST hand-written #app-content in Dev ────────────
 *
 * Three of the four Dev sub-views were already React frames; this one stayed a
 * template, and `renderDevView` had a branch just for it — `if (subTab ===
 * 'topic' …) AppView._teardownDevRoots()` — because replacing `#app-content`
 * by hand under a live React root reconciles against nodes that are no longer
 * in the document. Mounting a portal instead is what retires that branch: the
 * root is re-rendered rather than torn out from under.
 *
 * The frame takes NO props now. It had two, both only for the retired anchor
 * (`backHref` from `AppView._devPageHref()` and the plain-click handler). The
 * chip that replaced it is a real `<a href>` with the same modified-click
 * guard, so what #1036 bought that anchor is not lost; it is provided once.
 */

import { skeletonListHtml } from './card/skeleton';

/**
 * The thread host's initial content, as a constant string.
 *
 * `openTopic` mounts this frame, THEN awaits `_loadDevData()`, and only paints
 * the topic card once that resolves — so on a cold deep link (or a slow link)
 * the page was a back bar over nothing at all for the whole fetch. One
 * card-shaped placeholder stands in for the topic card that is coming.
 *
 * Module-level for prop IDENTITY, the same reason board-frame.tsx's is: React
 * 19 assigns `innerHTML` unconditionally when the prop object differs, so an
 * inline literal would rewrite this host on every re-render of the frame —
 * including ones that happen after `GroupChat.mountThread` has filled it.
 */
const THREAD_INITIAL = { __html: skeletonListHtml(1) };

export function DevTopicSubView() {
  return (
    <div className="flex flex-col h-full min-h-0 dc-lift dc-lift-strip">
      <div className="gc-tab-body flex-1 flex min-h-0">
        {/*
            The topic page's host. The dev-board or group-chat bridge mounts
            its page into it, so React renders it as
            an empty leaf and never looks inside — the same arrangement
            `#dev-chat-body` has in ./chat-frame.tsx. `min-w-0` lets it give
            way to the spec panel beside it rather than push it off screen.
        */}
        <div
          id="dev-topic-thread"
          className="flex-1 min-w-0 min-h-0"
          dangerouslySetInnerHTML={THREAD_INITIAL}
        />
        <Localized element={<div
          id="gc-spec-resizer"
          className="gc-spec-resizer"
          role="separator"
          aria-orientation="vertical" aria-label={catalogText("workshop:resize_spec_panel_55a5d1c7")}
        />} messages={{"aria-label":"workshop:resize_spec_panel_55a5d1c7"}} />
        <div id="gc-spec-side-panel" className="gc-spec-side-panel" />
      </div>
    </div>
  );
}
