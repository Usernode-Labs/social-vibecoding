import { RichMessage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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
import { ReplyStarters } from './reply-starters';

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
  /**
   * What the read-only bar says, when it is not the usual "only
   * collaborators can post": Homeroom's old project discussion, kept as
   * history since #general became the Homeroom community's channel.
   */
  notice?: string | null;
  /** GC_MAX_MESSAGE_LEN, passed through so the module owns the number. */
  maxLength: number;
}

export function GeneralChat({ introAppName, readOnly, notice, maxLength }: GeneralChatProps) {
  return (
    <div className="flex flex-col h-full min-h-0 dc-lift dc-lift-session">
      <div className="gc-tab-body flex-1 flex min-h-0">
        {/* `platform-kb-column` (app.css): same shape as the topic thread —
            #gc-messages scrolls and the composer bar is a shrink-0 sibling
            below it — so the keyboard inset is reserved here, on the column. */}
        <div className="gc-chat-pane platform-kb-column flex-1 flex flex-col min-h-0">
          {/*
              #3: name what group chat is for, once per browser. It is rarely
              empty — system messages land here — so a permanent banner would
              be clutter.
          */}
          {introAppName ? (
            <div className="mx-3 mt-3 px-4 py-3 rounded-2xl bg-violet-500/10 text-[15px] leading-snug text-zinc-700 dark:text-zinc-200"><RichMessage id="workshop:sentence_223c6d41842d" values={{ value1: introAppName }} components={[<span className="font-medium" />]} /></div>
          ) : null}
          <div id="gc-messages" className="flex-1 overflow-y-auto py-2 space-y-0.5" />
          <StatusLine
            scope="general"
            className="px-3 text-xs text-zinc-500 dark:text-zinc-400 h-5 shrink-0"
          />
          {/*
              `platform-safe-bar` (app.css) adds the home-indicator inset to
              this bar's own p-2. It wraps BOTH the composer and the read-only
              notice, so both clear the indicator — which is why #621's notice
              sits inside the bar here rather than replacing it the way the
              thread panel's does.
          */}
          <div className={`shrink-0 px-3 pt-1 pb-2 ${SAFE_BAR}`}>
            {readOnly ? (
              <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 text-center" data-gc-readonly-notice="">
                <LocalizedValue render={() => (notice || tr("workshop:you_re_viewing_this_app_s_dev_space_read_only_on_03a69a60"))} />
              </div>
            ) : (
              <>
                {/* Reply chips for somebody who has not said anything here
                    yet, once someone else has (./reply-starters.tsx). A tap
                    fills the box below; it does not send. */}
                <ReplyStarters />
                <ComposerSlots scope="general" />
                <Localized element={<ComposerForm
                  scope="general"
                  fill placeholder={catalogText("workshop:type_a_message_69518e68")}
                  maxLength={maxLength}
                />} messages={{"placeholder":"workshop:type_a_message_69518e68"}} />
              </>
            )}
          </div>
        </div>
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
