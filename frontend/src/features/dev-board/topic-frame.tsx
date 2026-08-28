/**
 * The Dev topic sub-view's frame — the back bar and the thread's host —
 * converted from `AppView._renderTopicSubView()`'s `innerHTML` template.
 *
 * It is the sibling of ./chat-frame.tsx and reads almost the same, which is
 * the point: both are the shell's SECOND BAR over a host something else
 * mounts into. The bar is features/shell/screen-bar.tsx in both — this one
 * drew its own `← Back` strip at `py-1.5`, which made the topic the one
 * screen in the app with a bar of its own shape and its own height, sitting
 * under a chip that was meanwhile still saying "Board".
 *
 * The bar names the KIND of thing you opened rather than repeating its title:
 * the card immediately below carries the title, the number and the author,
 * and a heading that restates them is the subtitle problem again one level
 * down. Its host is `#dev-topic-thread`, which `GroupChat.mountThread` fills
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
 * `#dev-topic-back` stays a real `<a href>` (#1036), so a modified click is
 * left to the browser and only a plain click is intercepted. The `href` comes
 * from `AppView._devPageHref()` — it depends on `App.currentApp` and the
 * self-app's hash-routing rules, which are the router's business.
 */

import { ScreenBar } from '../shell/screen-bar';
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

export interface DevTopicSubViewProps {
  /** `AppView._devPageHref()`. */
  backHref: string;
  /**
   * What kind of thing is open — "Issue" or "Change". From
   * `AppView._devTopic.kind`, which is resolved before the frame mounts, so
   * the bar is never briefly blank on a cold deep link.
   */
  title: string;
  /**
   * Plain-click handler. The caller keeps the `NavLink.isNativeClick(e)` guard
   * and the `App.switchTab('dev')` call, so the behaviour is the template's.
   */
  onBackClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}

export function DevTopicSubView({ backHref, title, onBackClick }: DevTopicSubViewProps) {
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* `#dev-topic-back` keeps its id and its `<a href>` (#1036) — only the
          bar around it changed, from this screen's own strip to the one every
          screen uses. */}
      <ScreenBar
        title={title}
        backId="dev-topic-back"
        backHref={backHref}
        backTitle="Back to the board"
        onBackClick={onBackClick}
      />
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
