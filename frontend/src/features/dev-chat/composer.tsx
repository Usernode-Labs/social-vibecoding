/**
 * `#dc-composer-bar`'s children — the dev chat's composer.
 * See ./composer-store.ts for the split and for what stays the module's.
 *
 * ── What this component does NOT bind ─────────────────────────────────
 *
 * The form's submit, the textarea's input and keydown, the paperclip, the
 * file input, the drafts' delegated click and the quick-reply bar's are all
 * bound by dev-chat.js on the line after the mount, on elements this renders.
 * A listener is not a DOM write, and keeping them there keeps ONE owner for
 * the draft, the shortcut routing and the attachment lifecycle.
 *
 * What did need handlers are the two controls whose only job is to call a
 * named function: the chat-model picker's `change` and the OpenRouter row's
 * "Change model". Both were `addEventListener` calls at the bottom of
 * `renderChatView`, re-bound on every render because the element was new.
 */

import { type ChangeEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  DraftEditIcon,
  DraftSendIcon,
  DraftTrashIcon,
  PaperclipIcon,
  SaveDraftIcon,
} from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';

import { PendingStrip } from '../attachments/pending-strip';
import { useStoreState } from '../../lib/use-store-state';
import { attachStripStore } from './attach-strip-store';
import { QuickRepliesBar, RunnerControlsBar } from './composer-chrome';
import { BudgetPillBar } from './budget-pill';
import { composerStore, type ComposerState, type SavedDraftView } from './composer-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).DevChat : null) || null;
}

const ATTACH_TITLE
  = 'Attach files — images (≤4 MB), text/code files (≤200 KB), zip archives (≤20 MB),'
  + ' or any other file (≤10 MB); up to 4 per message';

const ATTACH_BTN
  = 'dc-attach-btn rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-100'
  + ' dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 hover:text-violet-400'
  + ' hover:border-violet-500 px-1.5 py-1 shrink-0 transition-colors';

const MODEL_SELECT
  = 'rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700'
  + ' px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 focus:outline-none'
  + ' focus:ring-2 focus:ring-violet-500';

const MUTED_XS = 'text-xs text-zinc-500 dark:text-zinc-400';

/**
 * The send button's four states.
 *
 * `dc-send-btn` LEADS the string and arrives through `lead`, the cva group
 * declared first; the trailing `shrink-0` and the state class arrive through
 * className, which cva emits last. That is exactly where the hand-written
 * template and `classList.add` put them, so the rendered class attribute does
 * not move.
 */
const SEND_CLASS = {
  send: 'shrink-0',
  stop: 'shrink-0 dc-btn-stop',
  stopping: 'shrink-0 dc-btn-stopping',
  busy: 'shrink-0 dc-btn-streaming',
} as const;

function SendButton({ send }: { send: ComposerState['send'] }): ReactNode {
  const common = { type: 'submit' as const, id: 'dc-send-btn', lead: 'devSend' as const };
  if (send.kind === 'stopping') {
    return (
      <Button
        {...common} className={SEND_CLASS.stopping}
        disabled aria-label="Stopping" title="Stopping…"
      >
        <span className="dc-send-spinner"></span>
        <span className="dc-btn-stopping-label">Stopping…</span>
      </Button>
    );
  }
  if (send.kind === 'busy') {
    return (
      <Button
        {...common} className={SEND_CLASS.busy}
        disabled aria-label={send.label} title={send.title}
      >
        <span className="dc-send-spinner"></span>
      </Button>
    );
  }
  if (send.kind === 'stop') {
    return (
      <Button {...common} className={SEND_CLASS.stop} aria-label="Stop" title="Stop">
        <span className="dc-stop-icon" aria-hidden="true"></span>
      </Button>
    );
  }
  return (
    <Button {...common} className={SEND_CLASS.send} aria-label="Send" title="Send">Send</Button>
  );
}

/**
 * #798's saved drafts.
 *
 * No onClick: `_wireSavedDrafts` binds one delegated click on this element
 * and reads `data-draft-action` plus the row's `data-draft-id`, exactly like
 * the quick-reply bar. The element outlives every repaint of its rows.
 */
function SavedDrafts({ rows, busy }: { rows: SavedDraftView[]; busy: boolean }): ReactNode {
  const sendTitle = busy
    ? 'Claude is still working — you can send this when the turn finishes'
    : 'Send this draft now';
  return (
    <div id="dc-drafts" className={rows.length ? 'dc-drafts dc-drafts-active' : 'dc-drafts'}>
      {rows.length ? (
        <>
          <div className="dc-drafts-head">
            <span>
              {`Saved drafts (${rows.length}) `}
              <span className="dc-drafts-hint">· on all your devices</span>
            </span>
            {busy ? <span className="dc-drafts-hint">sending unlocks when Claude finishes</span> : null}
          </div>
          {rows.map((d) => (
            <div className="dc-draft-row" data-draft-id={d.id} key={d.id}>
              <span className="dc-draft-text" title={d.text}>{d.text}</span>
              <span className="dc-draft-actions">
                <button
                  type="button" className="dc-draft-btn dc-draft-send"
                  data-draft-action="send" aria-label="Send this draft"
                  disabled={busy} title={sendTitle}
                >
                  <DraftSendIcon width={14} height={14} aria-hidden="true" />
                </button>
                <button
                  type="button" className="dc-draft-btn dc-draft-edit"
                  data-draft-action="edit" aria-label="Edit this draft"
                  title="Put this draft back in the box to edit"
                >
                  <DraftEditIcon width={14} height={14} aria-hidden="true" />
                </button>
                <button
                  type="button" className="dc-draft-btn dc-draft-trash"
                  data-draft-action="trash" aria-label="Delete this draft"
                  title="Delete this draft"
                >
                  <DraftTrashIcon width={14} height={14} aria-hidden="true" />
                </button>
              </span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

export function DevComposerView({ s }: { s: ComposerState }): ReactNode {
  const { items } = useStoreState(attachStripStore);
  const onModel = (e: ChangeEvent<HTMLSelectElement>) => controller()?._onModelPicked?.(e.target.value);
  return (
    <>
      {/* What is left of the venue statement (#1086) once the control itself
          moved to the header (#1348): the sentence explaining a venue you did
          NOT get. `.dc-venue-slot:empty` collapses it in the ordinary case,
          so the div must render with no children at all — which is what an
          empty `__html` produces. */}
      <div
        id="dc-venue-slot" className="dc-venue-slot"
        dangerouslySetInnerHTML={{ __html: s.venueNoteHtml }}
      />
      {/* #1281: in a hand-off venue the launchpad stands INSTEAD of this, and
          the composer is HIDDEN rather than removed — every module below
          looks its controls up by id, and a getElementById that starts
          returning null would throw on a route the checks load. */}
      <div id="dc-composer-controls" hidden={s.hidden || undefined}>
        {/* #1353: ONE status line — the model picker on the left where the
            strip starts, the meter on the right. */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {s.models ? (
            <div id="dc-venue-detail" className="dc-venue-detail dc-venue-detail-inline">
              <label className={MUTED_XS} htmlFor="dc-model-select">Chat model:</label>
              <select
                id="dc-model-select" className={MODEL_SELECT}
                value={s.models.selected} onChange={onModel}
              >
                {s.models.options.map((o) => <option value={o.id} key={o.id}>{o.label}</option>)}
              </select>
            </div>
          ) : null}
          {/* #907: where the next coding turn runs — three states, two of
              which draw nothing at all. */}
          <RunnerControlsBar />
          <span className="flex-1"></span>
          <BudgetPillBar />
        </div>
        {s.openRouter ? (
          <div id="dc-venue-detail" className="dc-venue-detail">
            <span className={MUTED_XS}>OpenRouter model:</span>
            <span id="dc-openrouter-model" className="dc-openrouter-model" title={s.openRouter.model}>
              {s.openRouter.model}
            </span>
            <button
              type="button" id="dc-openrouter-model-change" className="dc-openrouter-model-change"
              disabled={s.openRouter.changeDisabled}
              onClick={() => controller()?._onOpenRouterModelChange?.()}
            >Change model</button>
            <div
              id="dc-agent-note"
              className="basis-full text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400"
            >{s.openRouter.note}</div>
          </div>
        ) : null}
        <SavedDrafts rows={s.drafts.rows} busy={s.drafts.busy} />
        {/* #1353: the attach button rides with the suggested replies, one
            line above the send row. The pills scroll horizontally inside
            their own element, so the button is a SIBLING rather than a child:
            a child would scroll away with them. */}
        <div className="dc-composer-actions">
          <input type="file" id="dc-file-input" className="hidden" multiple />
          <button
            type="button" id="dc-attach-btn" title={ATTACH_TITLE}
            aria-label="Attach files" className={ATTACH_BTN}
          >
            <PaperclipIcon width={14} height={14} />
          </button>
          <QuickRepliesBar />
        </div>
        <PendingStrip
          id="dc-attachments" items={items}
          onRemove={(index) => controller()?._removeAttachment?.(index)}
        />
        <div id="dc-attach-error" className={s.attachError ? 'dc-attach-error' : 'dc-attach-error hidden'}>
          {s.attachError}
        </div>
        <form id="dc-form" className="flex gap-2 items-end">
          {/* Through the primitives, and the rendered class attribute does not
              move: `devComposer` was added to @/components/ui/input's `lead`
              and `box` groups in the order this string was written, and the
              trailing `resize-none` arrives through className, which cva
              emits last — which is where the hand-written string had it.

              UNCONTROLLED on purpose. `_restoreDraft` and `_editSavedDraft`
              set `.value` directly and `_setupTextareaResize` grows
              `style.height` on every keystroke; a rendered `value` would make
              React the owner of the first and fight the module for it. */}
          <Textarea
            id="dc-input" rows={1} autoComplete="off" placeholder={s.placeholder}
            lead="devComposer" width="flex1" box="devComposer" hint="muted" ring="seamless"
            className="resize-none"
          />
          {/* #810: hidden while the chat is STOPPED — then the user can simply
              send what they typed, and a "keep this for later" control is
              noise. Hidden through the `hidden` PROPERTY, which app.css pairs
              with `.dc-save-draft-btn[hidden]`. */}
          <button
            type="button" id="dc-save-draft-btn" className="dc-save-draft-btn shrink-0"
            hidden={s.saveDraft.hidden || undefined} disabled={s.saveDraft.disabled}
            title={s.saveDraft.title} aria-label="Save as draft"
          >
            <SaveDraftIcon width={14} height={14} aria-hidden="true" />
          </button>
          <SendButton send={s.send} />
        </form>
        {/* #920: names whatever Ctrl/Cmd+Enter does RIGHT NOW. Raw html
            because both spellings carry `<kbd>`, and the constants in
            dev-chat.js are what `_onComposerShortcut` is documented against. */}
        <div
          className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 text-right"
          id="dc-shortcut-hint"
          dangerouslySetInnerHTML={{ __html: s.shortcutHintHtml }}
        />
      </div>
    </>
  );
}

export function DevComposer(): ReactNode {
  return <DevComposerView s={useStoreState(composerStore)} />;
}
