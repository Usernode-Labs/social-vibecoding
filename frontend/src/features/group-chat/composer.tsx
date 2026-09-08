/**
 * The group chat composer — the staged-reply chip, the attachment error, the
 * pending-upload strip, the form, and the status line above it — as the only
 * React writer below all four, for BOTH composers.
 *
 * ── One renderer, because there was always one renderer ───────────────
 *
 * `_renderQuotePreview`, `_setAttachError`, `_renderAttachStrip` and the two
 * typing writers each began with `thread ? 'gc-thread-…' : 'gc-…'` and then
 * built one piece of markup. Splitting that into a thread component and a
 * general component would have been the first time these two controls could
 * disagree. They take a `scope` instead, which is the same ternary in the same
 * one place — see ./composer-store.ts for why the store has two slots.
 *
 * ── What each side still owns ─────────────────────────────────────────
 *
 * The BAR around this is the caller's: ./thread-shell.tsx pins its own to the
 * bottom of the thread panel, ./general-chat.tsx to the bottom of the chat
 * pane, and the two read-only notices are worded and placed differently
 * enough that sharing them would be a change rather than a de-duplication.
 * What is shared is everything between the bar's edges.
 *
 * The LISTENERS are still attached by the module, on the line after the mount:
 * submit, input, keydown, the paperclip, the paste and drag-and-drop wiring,
 * and both autocompletes. They are listeners on nodes — they write no markup —
 * which keeps one owner for the draft, the typing ping, the multi-line submit
 * semantics and the Escape-clears-reply rule.
 *
 * One of them writes an ATTRIBUTE and is fine: `_autoGrowTextarea` sets
 * `style.height` on the field after every keystroke, to grow it to its content
 * and cap it. Nothing here renders a `style` prop, so React never diffs that
 * attribute — the same tolerated overlap the inline message editor's
 * `display:none` runs under, and for the same reason.
 */

import { Button } from '@/components/ui/button';
import { ArrowUpIcon, PaperClipIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';

import {
  PendingStrip,
  type PendingAttachmentView,
} from '../attachments/pending-strip';
import { useStoreState } from '../../lib/use-store-state';
import {
  composerStore,
  type ComposerScope,
  type ComposerSlot,
  type QuoteChipView,
} from './composer-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).GroupChat : null) || null;
}

/**
 * The ids each scope's controls answer to.
 *
 * Every one of them is read back by public/js/group-chat.js or
 * public/js/app-view.js — `setupAttachments` finds the paperclip and the file
 * input, `mountThread` and `renderGroupChatTab` bind the form and the
 * textarea, and `dapp.json` selects on several. They are the contract, so they
 * are written out per scope rather than built by interpolation, which also
 * keeps them greppable.
 */
const IDS = {
  general: {
    preview: 'gc-reply-preview',
    error: 'gc-attach-error',
    strip: 'gc-attachments',
    form: 'gc-form',
    attach: 'gc-attach-btn',
    file: 'gc-file-input',
    input: 'gc-input',
    typing: 'gc-typing',
  },
  thread: {
    preview: 'gc-thread-reply-preview',
    error: 'gc-thread-attach-error',
    strip: 'gc-thread-attachments',
    form: 'gc-thread-form',
    attach: 'gc-thread-attach-btn',
    file: 'gc-thread-file-input',
    input: 'gc-thread-input',
    typing: 'gc-thread-typing',
  },
} as const;

export function useComposerSlot(scope: ComposerScope): ComposerSlot {
  return useStoreState(composerStore)[scope];
}

/**
 * "↩ Replying to @alice" over the quoted line (#15).
 *
 * `.gc-reply-preview-inner` shares its rules in app.css with `.gc-quoted`, the
 * block a sent reply carries — deliberately, so staging a reply looks like
 * what it is about to produce. That is why neither moved into the widget
 * language on its own.
 */
function ReplyPreview({ scope, quote }: { scope: ComposerScope; quote: QuoteChipView | null }) {
  return (
    <div id={IDS[scope].preview} className={quote ? '' : 'hidden'}>
      {quote ? (
        <div className="gc-reply-preview-inner">
          <div className="gc-reply-preview-body">
            <span className="gc-reply-preview-label">{`↩ Replying to ${quote.label}`}</span>
            <span className="gc-reply-preview-snippet">{quote.snippet}</span>
          </div>
          <button
            type="button"
            id={scope === 'general' ? 'gc-reply-cancel' : undefined}
            className="gc-reply-preview-x"
            aria-label="Cancel reply"
            onClick={() => controller()?.clearQuote?.()}
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AttachError({ scope, text }: { scope: ComposerScope; text: string | null }) {
  return (
    <div id={IDS[scope].error} className={text ? 'dc-attach-error' : 'dc-attach-error hidden'}>
      {text}
    </div>
  );
}

/**
 * The pending-upload strip is ../attachments/pending-strip.tsx's — the dev
 * chat draws the same one, and always did (the comment on `#gc-attachments`
 * has said "reuses the dev-chat dc-attach-* styles" since #694). What stays
 * here is which host it goes in and how a row is removed: the live entry holds
 * a File and an object URL, so it never leaves group-chat.js and the row
 * reports its position instead.
 */
function AttachStrip({ scope, items }: { scope: ComposerScope; items: PendingAttachmentView[] }) {
  return (
    <PendingStrip
      id={IDS[scope].strip}
      items={items}
      onRemove={(index) => controller()?._removeAttachmentAt?.(index, scope)}
    />
  );
}

/**
 * The one-line slot under the messages — who is typing, or the reconnect
 * notice. `*View` is the pure half, which is what the tests render.
 */
export function StatusLineView(
  { scope, className, status }: { scope: ComposerScope; className: string; status: string },
) {
  return <div id={IDS[scope].typing} className={className}>{status}</div>;
}

export function StatusLine({ scope, className }: { scope: ComposerScope; className: string }) {
  return <StatusLineView scope={scope} className={className} status={useComposerSlot(scope).status} />;
}

/** The three module-fed rows above the form, in their shipped order. */
export function ComposerSlotsView({ scope, slot }: { scope: ComposerScope; slot: ComposerSlot }) {
  return (
    <>
      <ReplyPreview scope={scope} quote={slot.quote} />
      <AttachError scope={scope} text={slot.attachError} />
      <AttachStrip scope={scope} items={slot.attachments} />
    </>
  );
}

export function ComposerSlots({ scope }: { scope: ComposerScope }) {
  return <ComposerSlotsView scope={scope} slot={useComposerSlot(scope)} />;
}

export interface ComposerFormProps {
  scope: ComposerScope;
  /** The taller sizing: the general composer and the topic thread's. */
  fill: boolean;
  placeholder: string;
  /** GC_MAX_MESSAGE_LEN, passed through so the module owns the number. */
  maxLength: number;
}

export function ComposerForm({ scope, fill, placeholder, maxLength }: ComposerFormProps) {
  const ids = IDS[scope];
  // THE CARD. The two full-height composers — the Discussion's and a topic
  // thread's — are the same card Messages draws at the foot of its sheet: a
  // white surface with bare glyphs, a borderless field at reading size and
  // the round accent send disc. The boxed thread (`fill` false, inside a
  // board card) keeps its compact bordered row: it sits inside a card
  // already, and a card in a card is the thing the language avoids.
  if (fill) {
    return (
      <form id={ids.form} className="gc-composer-card flex items-end gap-1.5">
        <button
          type="button"
          id={ids.attach}
          title="Attach files"
          aria-label="Attach files"
          className="gc-composer-glyph shrink-0"
        >
          <PaperClipIcon aria-hidden="true" />
        </button>
        <input type="file" id={ids.file} className="hidden" multiple />
        <Textarea
          id={ids.input}
          maxLength={maxLength}
          rows={1}
          autoComplete="off"
          placeholder={placeholder}
          lead="composer"
          width="flex"
          box="composerCard"
          hint="muted"
          ring="bare"
        />
        <button type="submit" className="gc-send shrink-0" aria-label="Send" title="Send">
          <ArrowUpIcon aria-hidden="true" />
        </button>
      </form>
    );
  }
  return (
    <form id={ids.form} className="flex gap-2 items-end">
      <button
        type="button"
        id={ids.attach}
        title="Attach files"
        aria-label="Attach files"
        className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-500 hover:border-violet-500 transition-colors"
      >
        📎
      </button>
      <input type="file" id={ids.file} className="hidden" multiple />
      <Textarea
        id={ids.input}
        maxLength={maxLength}
        rows={1}
        autoComplete="off"
        placeholder={placeholder}
        lead="composer"
        width="flex"
        box="composerTight"
        hint="muted"
        ring="seamless"
      />
      <Button type="submit" size="sm" className="shrink-0">
        Send
      </Button>
    </form>
  );
}
