/**
 * The general chat pane — the message stream, the status line, the composer
 * and the spec side-panel's slot — as the only React writer below
 * `#dev-chat-body`.
 *
 * ── Props, not a store ────────────────────────────────────────────────
 *
 * Everything here is fixed for the life of one mount: the app's name, whether
 * the viewer is read-only, whether the first-arrival banner is due. It changes
 * only when `AppView.renderGroupChatTab` runs again, and `mountLegacyPortal`
 * re-renders with a new node and commits synchronously — so the props ARE the
 * publish. The parts that move while the pane is open (the staged reply, the
 * uploads, the error line, the typing text) go through ./composer-store.ts.
 *
 * ── The layout mirrors the dev-chat session view ──────────────────────
 *
 * A flex row holding the chat pane on the left and a slot for the spec side
 * panel on the right. The slot lives empty in the DOM so re-rendering this tab
 * does not tear down a panel the reader has open, and CSS switches it between
 * a side panel and a fullscreen modal at 1024px. The divider between them is
 * `display:none` until both the panel is open and the viewport is wide.
 *
 * ── Two hosts stay other owners' ──────────────────────────────────────
 *
 * `#gc-messages` is the transcript's portal target and `#gc-spec-side-panel`
 * is the spec reader's — both rendered here as empty elements with constant
 * `className`, and both mounted into by features/group-chat/mount.ts. That is
 * the same arrangement `#gc-thread-messages` has inside ./thread-shell.tsx,
 * and it carries the same obligation on the caller: drop the transcript's
 * portal BEFORE re-rendering this shell, because a layout change recreates the
 * element and a portal left pointing at a detached node keeps its subtree and
 * its store subscription alive.
 */

import { ComposerForm, ComposerSlots, StatusLine } from './composer';

const SAFE_BAR = 'platform-safe-bar';

export interface GeneralChatProps {
  /**
   * The app's name for the first-arrival banner, or null once it has been
   * seen. The localStorage read AND the write stay in app-view.js: whether
   * this has been shown is a browser fact, not a render-time one, and a
   * component that wrote it would fire again on every re-render.
   */
  introAppName: string | null;
  readOnly: boolean;
  /** GC_MAX_MESSAGE_LEN, passed through so the module owns the number. */
  maxLength: number;
}

export function GeneralChat({ introAppName, readOnly, maxLength }: GeneralChatProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="gc-tab-body flex-1 flex min-h-0">
        <div className="gc-chat-pane flex-1 flex flex-col min-h-0">
          {/*
              #3: name what group chat is for, once per browser. It is rarely
              empty — system messages land here — so a permanent banner would
              be clutter.
          */}
          {introAppName ? (
            <div className="mx-3 mt-2 px-3 py-2 rounded-lg bg-azure-500/10 border border-azure-500/20 text-xs text-zinc-600 dark:text-zinc-300">
              {'This is where everyone using '}
              <span className="font-medium">{introAppName}</span>
              {' talks and votes on proposed changes to it.'}
            </div>
          ) : null}
          {/*
              NO horizontal padding, and that is the decision rather than an
              omission. The transcript's rows are FULL-BLEED — `.gc-msg:hover`
              paints a band that runs edge to edge — so each row holds the
              content keyline in its own `px-3` (@/components/ui/chat.tsx's
              ChatMessageRow, and app.css's `.gc-msg`, `.gc-msg-system` and
              `.gc-spec-card` beside it). This scroller owning a gutter would
              inset that hover ground and land every row at 24px.

              This host was already right; the row was not. It carried `px-4`,
              so the same row sat at 16px here, 28px in `#gc-thread-scroll` and
              24px in the boxed thread list. All three read 12px now, which is
              the composer bar's `px-gutter` below and the intro banner's
              `mx-3` above.
          */}
          <div id="gc-messages" className="flex-1 overflow-y-auto py-2 space-y-0.5" />
          <StatusLine
            scope="general"
            className="px-3 text-xs text-zinc-500 dark:text-zinc-300 h-5 shrink-0"
          />
          {/*
              `platform-safe-bar` (app.css) adds the home-indicator inset to
              this bar's own `py-2` — the 0.5rem the utility's calc() is
              written against, which is why the vertical half stays `py-2`
              when the horizontal half moves. It wraps BOTH the composer and
              the read-only notice, so both clear the indicator — which is why
              #621's notice sits inside the bar here rather than replacing it
              the way the thread panel's does.

              `px-gutter`, not the p-2 this was: the composer's form carries no
              horizontal padding of its own (../group-chat/composer.tsx's
              `<form class="flex gap-2 items-end">`), so the bar's inset IS the
              composer's left edge, and 8px put it 4px inside the transcript
              above it. The token is app.css's --screen-gutter, the shell's
              content keyline — the same declaration `px-3` computes to,
              resolved by reference rather than respelled.
          */}
          <div className={`shrink-0 border-t border-zinc-200 dark:border-zinc-800 py-2 px-gutter ${SAFE_BAR}`}>
            {readOnly ? (
              <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-300 text-center">
                You&#39;re viewing this app&#39;s dev space read-only. Only collaborators can post.
              </div>
            ) : (
              <>
                <ComposerSlots scope="general" />
                <ComposerForm
                  scope="general"
                  fill
                  placeholder="Type a message..."
                  maxLength={maxLength}
                />
              </>
            )}
          </div>
        </div>
        <div
          id="gc-spec-resizer"
          className="gc-spec-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize spec panel"
        />
        <div id="gc-spec-side-panel" className="gc-spec-side-panel" />
      </div>
    </div>
  );
}
