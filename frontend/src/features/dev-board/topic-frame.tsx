/**
 * The Dev topic sub-view's frame — the back bar and the thread's host —
 * converted from `AppView._renderTopicSubView()`'s `innerHTML` template.
 *
 * It is the sibling of ./chat-frame.tsx and reads almost the same, which is
 * the point: both are a slim back-button header over a host something else
 * mounts into. The differences are the ones the two pages actually have — this
 * bar carries a hairline and a wider `← Back` label, and its host is
 * `#dev-topic-thread`, which `GroupChat.mountThread` fills with the thread
 * panel (and, inside that, the topic card app-view.js paints into
 * `#gc-thread-head`).
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
   * Plain-click handler. The caller keeps the `NavLink.isNativeClick(e)` guard
   * and the `App.switchTab('dev')` call, so the behaviour is the template's.
   */
  onBackClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}

export function DevTopicSubView({ backHref, onBackClick }: DevTopicSubViewProps) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <a
          id="dev-topic-back"
          className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 text-sm shrink-0 dark:text-zinc-300"
          title="Back to the dev page"
          href={backHref}
          onClick={onBackClick}
        >
          ← Back
        </a>
      </div>
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
