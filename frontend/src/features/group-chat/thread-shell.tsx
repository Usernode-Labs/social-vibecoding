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

import { ComposerForm, ComposerSlots, StatusLine } from './composer';

const SAFE_BAR = 'platform-safe-bar';

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
}

function Composer({ fill, readOnly, notice, placeholder, maxLength }: ThreadShellProps) {
  // `platform-safe-bar` on BOTH variants: in fill mode this block is the
  // bottom of the screen, so it carries the home-indicator inset above its own
  // padding, and the read-only notice that replaces it needs the identical
  // clearance. In the boxed layout the bar is not screen-bottom-anchored, so
  // the inset is inert — harmless, and it keeps one class per role.
  //
  // The two variants also agree horizontally now. The notice was always at
  // `px-3` — the shell's content keyline — while the composer bar it replaces
  // sat at `p-2`, so which branch rendered decided where the left edge was.
  // The composer bar spells that keyline as `px-gutter` (app.css's
  // --screen-gutter, the same declaration `px-3` computes to) and keeps
  // `py-2`, which is the 0.5rem `.platform-safe-bar`'s calc() adds its inset
  // below.
  if (readOnly) {
    return (
      <div
        className={`px-3 py-2 text-xs text-zinc-500 dark:text-zinc-300 border-t border-zinc-200 dark:border-zinc-800 shrink-0 ${SAFE_BAR}`}
      >
        {notice}
      </div>
    );
  }
  return (
    <div className={`shrink-0 border-t border-zinc-200 dark:border-zinc-800 py-2 px-gutter ${SAFE_BAR}`}>
      <ComposerSlots scope="thread" />
      <ComposerForm scope="thread" fill={fill} placeholder={placeholder} maxLength={maxLength} />
    </div>
  );
}

export function ThreadShell(props: ThreadShellProps) {
  const { fill, withHeader } = props;
  if (fill) {
    return (
      <div className="dev-thread flex flex-col h-full min-h-0">
        {/*
            The scroller carries NO horizontal inset, because its two children
            are different KINDS and a shared gutter cannot serve both.

            `#gc-thread-head` is a SURFACE — AppView.DEV_CARD_CLS is a
            `rounded-2xl bg-white` card — so it needs 12px around it or its
            rounded edge sits flush to the screen. `#gc-thread-messages` holds
            full-bleed transcript rows that carry the keyline themselves (see
            @/components/ui/chat.tsx), so 12px here would land them at 24 and
            clip `.gc-msg:hover`'s edge-to-edge band.

            So the inset moved DOWN, onto the head slot, and the scroller kept
            only its scrolling. The slot spelling `px-gutter` for markup another
            owner mounts inside it is `.dc-launchpad-slot`'s arrangement in
            tests/screen-keyline.test.js's manifest — and by REFERENCE, not as
            the `px-3` this was, because a slot is a keyline-bearing container
            and the token is the thing it should track. `_renderTopicHead` is
            unaffected: it only ever `innerHTML`s BELOW this node.
        */}
        <div
          id="gc-thread-scroll"
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        >
          {withHeader ? <div id="gc-thread-head" className="px-gutter" /> : null}
          <div id="gc-thread-messages" className="py-2 space-y-0.5" />
        </div>
        <StatusLine scope="thread" className="px-3 text-xs text-zinc-500 dark:text-zinc-300 h-5 shrink-0" />
        <Composer {...props} />
      </div>
    );
  }
  return (
    <div className="dev-thread border border-zinc-200 dark:border-zinc-800 rounded-xl flex flex-col bg-zinc-50/50 dark:bg-zinc-900/40">
      {/*
          In THIS layout `#gc-thread-messages` is itself the scroller — there is
          no `#gc-thread-scroll` above it — and it is the boxed inner surface,
          so it would be the one element here entitled to its own padding. It
          gives that up anyway: its only children are the same full-bleed rows,
          and the `px-2` it carried was a third inset stacked under the row's,
          putting a message 24px inside the border while the status line and
          composer below sat at 12. Zero here, 12 on the row.
      */}
      <div
        id="gc-thread-messages"
        className="overflow-y-auto py-1 space-y-0.5"
        style={{ maxHeight: '40vh', minHeight: '60px' }}
      />
      <StatusLine scope="thread" className="px-3 text-xs text-zinc-500 dark:text-zinc-300 h-4 shrink-0" />
      <Composer {...props} />
    </div>
  );
}
