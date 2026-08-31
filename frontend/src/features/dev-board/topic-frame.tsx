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
 * kept its copy; it does not any more, and there is no in-page back left in
 * the Dev area to find.
 *
 * What is left is `#dev-topic-thread`, which `GroupChat.mountThread` fills
 * with the thread panel (and, inside that, the topic card app-view.js paints
 * into `#gc-thread-head`).
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
 * (`backHref` from `AppView._devPageHref()` and the plain-click handler), and
 * the header's own chevron is a real `<a href>` with the same modified-click
 * guard — so what #1036 bought that anchor is not lost, it is simply provided
 * once instead of twice.
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
    <div className="flex flex-col h-full min-h-0">
      {/*
          The thread panel's host. `GroupChat.mountThread` mounts
          features/group-chat/thread-shell.tsx into it, so React renders it as
          an empty leaf and never looks inside — the same arrangement
          `#dev-chat-body` has in ./chat-frame.tsx.
      */}
      <div
        id="dev-topic-thread"
        className="flex-1 min-h-0"
        dangerouslySetInnerHTML={THREAD_INITIAL}
      />
    </div>
  );
}
