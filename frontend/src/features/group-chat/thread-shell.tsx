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
 * ── Four hosts stay the modules' ──────────────────────────────────────
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
 *   * `#gc-thread-typing` — one line of text from `_renderThreadTyping`.
 *   * `#gc-thread-reply-preview`, `#gc-thread-attach-error` and
 *     `#gc-thread-attachments` — the composer's three module-filled slots.
 *
 * ── The composer's listeners are still attached, not props ────────────
 *
 * `mountThread` binds submit, input, keydown, the attachment wiring and both
 * autocompletes to the elements below, on the line after this renders. They
 * are LISTENERS on nodes — they write no markup — which is the split
 * app-grid.tsx makes for the canvas recognizer, and it keeps one owner for the
 * draft, the typing ping, the multi-line submit semantics and the Escape rule.
 */

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
  if (readOnly) {
    return (
      <div
        className={`px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 border-t border-zinc-200 dark:border-zinc-800 shrink-0 ${SAFE_BAR}`}
      >
        {notice}
      </div>
    );
  }
  return (
    <div className={`shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-2 ${SAFE_BAR}`}>
      <div id="gc-thread-reply-preview" className="hidden" />
      <div id="gc-thread-attach-error" className="dc-attach-error hidden" />
      <div id="gc-thread-attachments" className="dc-attach-strip" />
      <form id="gc-thread-form" className="flex gap-2 items-end">
        <button
          type="button"
          id="gc-thread-attach-btn"
          title="Attach files"
          aria-label="Attach files"
          className={`shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 ${
            fill ? 'py-2' : 'py-1.5'
          } text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-500 hover:border-violet-500 transition-colors`}
        >
          📎
        </button>
        <input type="file" id="gc-thread-file-input" className="hidden" multiple />
        <textarea
          id="gc-thread-input"
          maxLength={maxLength}
          rows={1}
          autoComplete="off"
          placeholder={placeholder}
          className={`gc-composer-input flex-1 min-w-0 resize-none overflow-y-auto rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 ${
            fill ? 'py-2' : 'py-1.5'
          } text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent`}
        />
        <button
          type="submit"
          className={`rounded-lg bg-violet-600 hover:bg-violet-500 ${
            fill ? 'px-4 py-2' : 'px-3 py-1.5'
          } text-sm font-medium text-white transition-colors shrink-0`}
        >
          Send
        </button>
      </form>
    </div>
  );
}

export function ThreadShell(props: ThreadShellProps) {
  const { fill, withHeader } = props;
  if (fill) {
    return (
      <div className="dev-thread flex flex-col h-full min-h-0">
        <div
          id="gc-thread-scroll"
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3"
        >
          {withHeader ? <div id="gc-thread-head" /> : null}
          <div id="gc-thread-messages" className="py-2 space-y-0.5" />
        </div>
        <div id="gc-thread-typing" className="px-3 text-xs text-zinc-500 dark:text-zinc-400 h-5 shrink-0" />
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
      <div id="gc-thread-typing" className="px-3 text-xs text-zinc-500 dark:text-zinc-400 h-4 shrink-0" />
      <Composer {...props} />
    </div>
  );
}
