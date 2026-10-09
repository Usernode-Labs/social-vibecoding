/**
 * The thread panel — the scroller, the messages host, the typing slot and the
 * composer — as the only React writer below the container `GroupChat.mountThread`
 * is given.
 *
 * ── Props, not a store ────────────────────────────────────────────────
 *
 * Everything here is fixed for the life of one mount: which layout, whether
 * there is an in-scroll header slot, whether the thread is read-only and with
 * what wording. It only changes when `mountThread` runs again, and
 * `mountLegacyPortal` re-renders with a new node and commits synchronously —
 * so the props ARE the publish, and a store would be a second thing to keep in
 * step for no gain.
 *
 * ── Two layouts, and the difference is load-bearing ───────────────────
 *
 * `fill` (#194 card-list revision) is the topic sub-view's thread: it fills its
 * flex container and mirrors the general chat pane — full-width message list,
 * an h-5 typing slot, a bordered-top composer at the bottom of the screen. The
 * other is the boxed inline layout kept for any legacy caller, where the
 * message list is itself a 40vh scroller.
 *
 * In fill mode an optional header slot and the messages list share ONE scroll
 * container (#363), so a topic's card and its discussion scroll as one area.
 * The messages list does not scroll; the typing slot and composer are pinned
 * `shrink-0` siblings outside the scroller.
 *
 * ── The composer is shared with the general chat ──────────────────────
 *
 * The staged-reply chip, the attachment error, the pending-upload strip, the
 * form and the status line are ./composer.tsx's, rendered here with
 * `scope="thread"`. They were one renderer in public/js/group-chat.js — each
 * of them opening with `thread ? 'gc-thread-…' : 'gc-…'` — and they stay one
 * here. What this file keeps is the BAR around them, which really does differ
 * between the two panes: here the read-only notice REPLACES the bar, and in
 * the chat pane it sits inside it.
 *
 * ── Two hosts stay other owners' ──────────────────────────────────────
 *
 * Rendered once as empty elements with constant `className`, never looked
 * inside — the controller-host seam AGENTS.md documents:
 *
 *   * `#gc-thread-head` — the topic card, `innerHTML`'d by
 *     `AppView._renderTopicHead`. It is inside the scroller precisely so it
 *     survives the message list's rewrites.
 *   * `#gc-thread-messages` — the transcript's portal target. React renders
 *     the element and nothing else; `GroupChat.renderThread` mounts
 *     ./transcript.tsx into it.
 *
 * ── The composer's listeners are still attached, not props ────────────
 *
 * `mountThread` binds submit, input, keydown, the attachment wiring and both
 * autocompletes to the elements below, on the line after this renders. They
 * are LISTENERS on nodes — they write no markup — which is the split
 * app-grid.tsx makes for the canvas recognizer, and it keeps one owner for the
 * draft, the typing ping, the multi-line submit semantics and the Escape rule.
 */

import { useRef } from 'react';

import { JumpToLatest } from '../messages/jump-to-latest';
import { ComposerForm, ComposerSlots, StatusLine } from './composer';

const SAFE_BAR = 'platform-safe-bar';

/**
 * How near the bottom a thread counts as followed: a live reply, the reader's
 * own included, sticks to it within 80px, and so does the composer growing
 * (`THREAD_FOLLOW_PX`, `_handleThreadIncoming` and `_attachThreadFollow` in
 * public/js/group-chat.js).
 */
export const THREAD_FOLLOW_PX = 80;

export interface ThreadShellProps {
  /** The topic sub-view's full-height layout; false is the boxed one. */
  fill: boolean;
  /** Fill mode only: emit the in-scroll header slot the topic card fills. */
  withHeader: boolean;
  readOnly: boolean;
  /** The read-only wording, which replaces the composer entirely. */
  notice: string;
  placeholder: string;
  /** GC_MAX_MESSAGE_LEN, passed through so the module owns the number. */
  maxLength: number;
  /**
   * #4453: a request's page, drawn as the sheet Messages opens a reply thread
   * in. Fill mode only. See `RequestShell` below.
   */
  request?: boolean;
  /**
   * #4455: a change's page, the same sheet (`RequestShell`) with the change
   * as its root post. Fill mode only.
   */
  change?: boolean;
}

function Composer({ fill, readOnly, notice, placeholder, maxLength, request = false, change = false }: ThreadShellProps) {
  // `platform-safe-bar` on BOTH variants: in fill mode this block is the
  // bottom of the screen, so it carries the home-indicator inset above its own
  // padding, and the read-only notice that replaces it needs the identical
  // clearance. In the boxed layout the bar is not screen-bottom-anchored, so
  // the inset is inert — harmless, and it keeps one class per role.
  if (readOnly) {
    return (
      <div
        className={`px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 shrink-0 ${SAFE_BAR}`}
      >
        {notice}
      </div>
    );
  }
  if (request || change) {
    return (
      <div className={`messages-composer messages-composer-thread ${SAFE_BAR}`}>
        <ComposerSlots scope="thread" />
        <ComposerForm scope="thread" fill={fill} placeholder={placeholder} maxLength={maxLength} messages />
      </div>
    );
  }
  return (
    <div className={`shrink-0 px-3 pt-1 pb-2 ${SAFE_BAR}`}>
      <ComposerSlots scope="thread" />
      <ComposerForm scope="thread" fill={fill} placeholder={placeholder} maxLength={maxLength} />
    </div>
  );
}

/**
 * #4453: a request's page — the sheet Messages opens a reply thread in
 * (features/messages/index.tsx `ReplyThreadPanel`): its header, a scroller
 * holding the request as the root post and the replies under it, and the
 * thread's composer at its foot. The page's back chip sits above the sheet.
 *
 * Two more empty hosts than the topic layout, both the topic head's
 * (features/dev-board/topic/request-head.tsx portals into them), rendered
 * once with a constant className and never looked inside:
 *
 *   * `#gc-thread-back` — the "‹ Workshop" chip, above the sheet.
 *   * `#gc-thread-bar` — the sheet's header: "Request #N", its category,
 *     and the ⋯ disc. Outside the scroller, so it stays put.
 *
 * Messages' tokens (`--messages-surface` and the rest) are defined on
 * `.dev-request` in app.css, as they are on `.messages-layout`.
 *
 * #4455: a change's page is the same sheet, with the change as its root post
 * (features/dev-board/topic/change-head.tsx). `.dev-change` beside
 * `.dev-request` is what app.css tells the two apart by.
 */
function RequestShell(props: ThreadShellProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const change = !!props.change;
  return (
    <div className={change ? 'dev-request dev-change platform-kb-column' : 'dev-request platform-kb-column'}>
      <div id="gc-thread-back" className="dev-request-back" />
      <section className="dev-request-sheet dc-lift dc-lift-session" aria-label={change ? 'Change' : 'Request'}>
        <div id="gc-thread-bar" className="dev-request-bar" />
        <div ref={scroll} id="gc-thread-scroll" className="messages-thread-scroll dev-request-scroll overscroll-contain">
          <div id="gc-thread-head" />
          <div id="gc-thread-messages" />
        </div>
        <JumpToLatest scroller={scroll} slack={THREAD_FOLLOW_PX} />
        <StatusLine scope="thread" className="px-4 text-xs text-zinc-500 dark:text-zinc-400 h-5 shrink-0" />
        <Composer {...props} />
      </section>
    </div>
  );
}

export function ThreadShell(props: ThreadShellProps) {
  const { fill, withHeader } = props;
  const scroll = useRef<HTMLDivElement>(null);
  if (fill && (props.request || props.change)) return <RequestShell {...props} />;
  if (fill) {
    return (
      // `platform-kb-column` is what app.css hangs the keyboard reservation
      // on (#1937). It has to be the COLUMN, not the composer: the composer is
      // a `shrink-0` sibling below the scroller, so the kit's `.un-kb-avoid`
      // padding — which lands inside the scroller — can never lift it. The
      // boxed variant below does NOT take it: it is not screen-bottom-anchored,
      // so reserving keyboard space there would be dead space mid-page.
      <div className="dev-thread dev-thread-fill platform-kb-column flex flex-col h-full min-h-0 dc-lift dc-lift-session">
        <div
          ref={scroll}
          id="gc-thread-scroll"
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pt-3"
        >
          {withHeader ? <div id="gc-thread-head" /> : null}
          <div id="gc-thread-messages" className="py-2 space-y-0.5" />
        </div>
        {/* A topic opens at its card (#363), so the way down is up from the
            start whenever the discussion runs past the screen. */}
        <JumpToLatest scroller={scroll} slack={THREAD_FOLLOW_PX} />
        <StatusLine scope="thread" className="px-3 text-xs text-zinc-500 dark:text-zinc-400 h-5 shrink-0" />
        <Composer {...props} />
      </div>
    );
  }
  return (
    <div className="dev-thread border border-zinc-200 dark:border-zinc-800 rounded-xl flex flex-col bg-zinc-50/50 dark:bg-zinc-900/40">
      <div
        id="gc-thread-messages"
        className="overflow-y-auto px-2 py-1 space-y-0.5"
        style={{ maxHeight: '40vh', minHeight: '60px' }}
      />
      <StatusLine scope="thread" className="px-3 text-xs text-zinc-500 dark:text-zinc-400 h-4 shrink-0" />
      <Composer {...props} />
    </div>
  );
}
