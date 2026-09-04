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
  ArrowUpIcon,
  ChevronDownIcon,
  DraftEditIcon,
  DraftSendIcon,
  DraftTrashIcon,
  PlusIcon,
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
  = 'Attach files: images (≤4 MB), text/code files (≤200 KB), zip archives (≤20 MB),'
  + ' or any other file (≤10 MB); up to 4 per message';

// #920's hint line is gone; its two spellings are these titles. The button
// and Ctrl/Cmd+Enter perform the same action in every state, so naming it on
// the control names it for both.
const SEND_TITLE = 'Send (Ctrl+Enter)';
const SAVE_TITLE
  = 'Save this text as a draft (Ctrl+Enter). It stays here until you send it';

// The control row's two bare glyph buttons. No box, no border: the CARD is
// the box now, and a bordered control inside it would draw a second one.
const ROW_BTN
  = 'dc-row-btn shrink-0 text-zinc-700 dark:text-zinc-200 hover:text-violet-600'
  + ' dark:hover:text-violet-400 transition-colors';

// The chat-model picker, bare. `.dc-model-select` strips the native
// appearance so the row reads as text with a caret; the caret beside it is
// this component's, because a stripped <select> draws none.
const MUTED_XS = 'text-xs text-zinc-500 dark:text-zinc-400';

const MODEL_SELECT
  = 'dc-model-select text-[13px] text-zinc-900 dark:text-zinc-100 focus:outline-none'
  + ' focus:ring-2 focus:ring-violet-500 rounded';

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
  send: 'shrink-0 dc-circle-send',
  save: 'shrink-0 dc-circle-save',
  stop: 'shrink-0 dc-btn-stop',
  stopping: 'shrink-0 dc-btn-stopping',
  busy: 'shrink-0 dc-btn-streaming',
} as const;

function SendButton({ send }: { send: ComposerState['send'] }): ReactNode {
  // A BARE ROUND BUTTON. `roundedFull` carries the radius and nothing else,
  // `icon` no padding, `none` no ink — so the fill and the glyph colour come
  // from the state class alone (.dc-circle-send / .dc-circle-save /
  // .dc-btn-stop / …), which is what lets one control wear five surfaces.
  //
  // The radius has to come from HERE rather than from `.dc-send-btn` in
  // app.css: the compiled utilities are loaded LAST on purpose, so a
  // `rounded-lg` from the cva table beats an app.css `border-radius` at equal
  // specificity. That is exactly what shipped a rounded SQUARE the first time
  // this was built.
  const common = {
    type: 'submit' as const,
    id: 'dc-send-btn',
    lead: 'devSend' as const,
    variant: 'roundedFull' as const,
    size: 'icon' as const,
    ink: 'none' as const,
  };
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
  // A turn is running and the box has text, so the only useful action is to
  // park it — see `_sendButtonView`. It stands where Stop stands, and saving
  // blanks the field, which is what hands Stop back.
  if (send.kind === 'save') {
    return (
      <Button
        {...common} className={SEND_CLASS.save}
        aria-label="Save as draft" title={SAVE_TITLE}
      >
        <SaveDraftIcon width={20} height={20} aria-hidden="true" />
      </Button>
    );
  }
  return (
    <Button {...common} className={SEND_CLASS.send} aria-label="Send" title={SEND_TITLE}>
      <ArrowUpIcon width={20} height={20} aria-hidden="true" />
    </Button>
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
    ? 'Claude is still working. You can send this when the turn finishes'
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
        {/* #907: where the next coding turn runs — three states, two of
            which draw nothing at all. It stays ABOVE the card: it is a
            statement about the session, not a control of the message. */}
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
        <div className="dc-above-card flex flex-wrap items-center gap-2">
          <RunnerControlsBar />
        </div>
        <SavedDrafts rows={s.drafts.rows} busy={s.drafts.busy} />
        <PendingStrip
          id="dc-attachments" items={items}
          onRemove={(index) => controller()?._removeAttachment?.(index)}
        />
        <div id="dc-attach-error" className={s.attachError ? 'dc-attach-error' : 'dc-attach-error hidden'}>
          {s.attachError}
        </div>
        {/* The pills come OUT of the composer and sit on the pane's ground,
            directly above the card (Streamlined Concept). They kept sharing a
            line with the paperclip while the composer was a stack of rows;
            the composer is one card now, and a scrolling strip inside it
            would break that shape every time a turn ends.

            `.dc-composer-actions` travels with them: it is what gives the
            strip its layout, and #dc-attach-btn is no longer its sibling
            because the attach control moved onto the card's own row. */}
        <div className="dc-composer-actions">
          <QuickRepliesBar />
        </div>
        {/* ── The card ──────────────────────────────────────────────────
            One surface: the field, then one row of controls. It is the FORM,
            so the one circle at its end is a submit and the module's single
            submit listener routes all three actions (send / stop / save).

            The field carries no box of its own — no fill, no border, no
            focus ring — because the card is the box. Anything it drew would
            be a second box inside the first. */}
        <form id="dc-form" className="dc-card">
          {/* UNCONTROLLED on purpose. `_restoreDraft` and `_editSavedDraft`
              set `.value` directly and `_setupTextareaResize` grows
              `style.height` on every keystroke; a rendered `value` would make
              React the owner of the first and fight the module for it. */}
          <Textarea
            id="dc-input" rows={1} autoComplete="off" placeholder={s.placeholder}
            lead="devComposer" width="full" box="devCard" hint="muted" ring="bare"
            className="resize-none"
          />
          <div className="dc-card-row">
            <input type="file" id="dc-file-input" className="hidden" multiple />
            <button
              type="button" id="dc-attach-btn" title={ATTACH_TITLE}
              aria-label="Attach files" className={ROW_BTN}
            >
              <PlusIcon width={20} height={20} />
            </button>
            <BudgetPillBar />
            {s.models ? (
              <div id="dc-venue-detail" className="dc-venue-detail dc-venue-detail-inline">
                {/* #1589 stands: the CLOSED control is the model's NAME and
                    nothing else. The guidance ("general coding work") reads
                    in the open list and in the Generate-proposal picker —
                    here it would set the control's width and push the circle
                    off the row. The label is gone with the box: a bare
                    "Opus 5 ⌄" beside the meter needs no "Chat model:" in
                    front of it, and the accessible name survives on the
                    select itself. */}
                <label className="sr-only" htmlFor="dc-model-select">Chat model</label>
                <select
                  id="dc-model-select" className={MODEL_SELECT}
                  value={s.models.selected} onChange={onModel}
                >
                  {s.models.options.map((o) => <option value={o.id} key={o.id}>{o.label}</option>)}
                </select>
                <ChevronDownIcon width={14} height={14} aria-hidden="true" />
              </div>
            ) : null}
            <span className="flex-1"></span>
            <SendButton send={s.send} />
          </div>
        </form>
      </div>
    </>
  );
}

export function DevComposer(): ReactNode {
  return <DevComposerView s={useStoreState(composerStore)} />;
}
