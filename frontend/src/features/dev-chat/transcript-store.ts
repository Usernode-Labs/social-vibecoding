/**
 * `#dc-messages` — the dev chat's transcript, as a view model.
 *
 * This is the biggest renderer on the screen and the one with the most other
 * authors, so the two stores below are the whole design and are worth reading
 * before the component.
 *
 * ── Why the live bubble gets its OWN store ────────────────────────────
 *
 * A turn streams in token by token. `_renderStreamingMarkdown` throttles to
 * one paint per animation frame and then assigned `el.innerHTML` on the last
 * assistant bubble's content node — up to 60 times a second. Publishing that
 * through the transcript store would re-render every row in the list on every
 * frame, which is exactly the thing this conversion must not do.
 *
 * So there are two stores. `transcriptStore` carries the ROWS and is published
 * when `renderMessages` runs. `streamStore` carries ONE string — the live
 * bubble's html — and is published per frame. Exactly one row subscribes to
 * it: the model marks the last assistant row `live` for the duration of a
 * turn, and only that row renders the component that reads `streamStore`.
 * Every other row renders plain html from its own model and is untouched by
 * the stream.
 *
 * That is what let the second writer go rather than be preserved. The
 * alternative — keeping `.dc-msg-content` a controller host — looked simpler
 * and is not: React would have to render no children for a streaming row and
 * `dangerouslySetInnerHTML` for a sealed one, and the transition INTO
 * streaming (which happens whenever a status row arrives mid-turn) blanks the
 * node until the next token lands.
 *
 * `streamStore` flushes synchronously, because `scrollToBottom()` runs on the
 * line after every stream publish and measures the container it just grew.
 *
 * ── What is RESOLVED here, and what is not ────────────────────────────
 *
 * Every row below carries answers, not inputs: the icon it draws, the html of
 * its markdown, its already-composed labels. Two reasons, both the ones the
 * card family established. `dev-chat.js` is loaded as a classic SCRIPT by a
 * dozen test files, so this bundle cannot import from it; and Tailwind's
 * extractor is a regex over source text, so a class name that only exists in
 * a model is a class name that never gets compiled.
 *
 * Three things stay other modules' markup, carried as html strings the
 * component renders through `dangerouslySetInnerHTML`, because each has
 * callers outside this transcript:
 *
 *   - `DevChat.renderMarkdown` — sanitized where it is built.
 *   - `AppView.visualsTilesHtml` — four other surfaces call it.
 *   - `CreditOptions.cardHtml` — the banner and the modal render it too.
 *
 * ── The ticking spans are DERIVED, not patched ────────────────────────
 *
 * A status row's elapsed time, an AI estimate's count-down and the long-run
 * cohort hint were three `textContent` passes on a 1s timer, walking
 * `#dc-messages` for `[data-elapsed-since]`, `[data-countdown-to]` and
 * `[data-cohort-since]`. The rows carry the anchors now and re-derive their
 * own text from `nowStore`, which is the same shape the Dev card's 30s
 * countdown uses (`cardNowStore`). Three writers gone, and the `data-*`
 * attributes stay in the markup because `_syncElapsedTicker` still reads them
 * to decide whether the heartbeat needs to run at all.
 */

import { createStore } from '../../lib/plain-store.js';

/** A `<details>` disclosure whose open state survives a repaint. */
export interface DetailsSpec {
  /** `<id>:<kind>` — the key `_readDetailsState` persists under. */
  persistId: string;
  defaultOpen: boolean;
}

/** The elapsed suffix on a status row, in its three shapes. */
export type ElapsedSpec =
  /** A settled step: "(took 1m 4s)", already formatted. */
  | { kind: 'fixed'; label: string }
  /** A live step: the row re-derives from `nowStore` and this epoch ms. */
  | { kind: 'since'; since: number }
  | null;

/** One row of the transcript. `t` is the tag; nothing else is shared. */
export type TranscriptRow =
  /** A plain status line: an icon, the text, and maybe an elapsed suffix. */
  | {
    t: 'status';
    key: string;
    icon: 'spinner' | 'check' | 'key' | 'flag';
    /** Raw text; the component escapes it. */
    text: string;
    /** `msg.content` reaches some rows as trusted html — see the builder. */
    html?: string;
    elapsed: ElapsedSpec;
    stamp: string;
    dim?: boolean;
    /** #937's escalation: the row grows a Force stop button. */
    forceStop?: boolean;
  }
  /** The scout's spec-draft card, under its status line. */
  | {
    t: 'spec';
    key: string;
    status: TranscriptRow & { t: 'status' };
    version: string;
    header: string;
    snippetHtml: string;
  }
  /** The human gate on an agent-drafted issue report. */
  | {
    t: 'issueDraft';
    key: string;
    status: TranscriptRow & { t: 'status' };
    msgId: number | null;
    destLabel: string;
    title: string;
    /** The body, either whole or split across a disclosure. */
    body: { kind: 'none' } | { kind: 'plain'; text: string }
    | { kind: 'details'; details: DetailsSpec; summary: string; rest: string };
    action: { kind: 'none' }
    | { kind: 'link'; href: string; label: string }
    | { kind: 'note'; text: string }
    | { kind: 'buttons'; confirmLabel: string };
  }
  /** A coding agent's raw log, behind a disclosure. */
  | { t: 'ccLog'; key: string; details: DetailsSpec; label: string; log: string }
  /**
   * A status line that IS the summary of a disclosure, with a log or a
   * markdown body inside it. Covers the live progress run, the orphaned
   * progress row and the post-turn `ccOutput` summary.
   */
  | {
    t: 'attached';
    key: string;
    details: DetailsSpec;
    icon: 'spinner' | 'check';
    text: string;
    html?: string;
    elapsed: ElapsedSpec;
    stamp: string;
    /** The live run's four summary spans; absent on the other two shapes. */
    progress?: {
      current: string;
      steps: number;
      phase: string;
      /** The AI guess's phrase, and the epoch ms its count-down runs to. */
      estimate: string;
      countdownTo: number | null;
      /** Epoch ms the run started, for the cohort hint. Null when settled. */
      cohortSince: number | null;
    };
    body: { kind: 'log'; persistId: string; text: string } | { kind: 'md'; html: string };
  }
  /** #361's "Changes ready" card, under its status line. */
  | {
    t: 'changes';
    key: string;
    status: TranscriptRow & { t: 'status' };
    prUrl: string | null;
    prNumber: number | null;
    title: string;
    closesHtml: string;
    stamp: string;
    visualsHtml: string;
    preview: { enabled: boolean; url: string; title: string };
    /** #127's "Test this change", when the session carries testing guidance. */
    test: { enabled: boolean; url: string } | null;
    canPropose: boolean;
    /** #558: the propose request is in flight — the button spins and locks. */
    proposePending: boolean;
    /** MergeStatus's badge for the card, or the merged sentence. */
    status2: { kind: 'none' } | { kind: 'merged' } | { kind: 'badge'; html: string };
  }
  /** The out-of-credits card — `CreditOptions.cardHtml`'s markup, whole. */
  | { t: 'credits'; key: string; html: string }
  /** A user or assistant bubble. */
  | {
    t: 'msg';
    key: string;
    who: 'user' | 'ai' | 'cc';
    /** The model chip's label, cost suffix included. Empty when absent. */
    model: string;
    stamp: string;
    contentHtml: string;
    /** True on the one row a live turn is writing into — see the header. */
    live?: boolean;
    /** A user row's attachment strip. */
    attachments?: {
      kind: 'image' | 'file'; href: string; name: string;
      download?: boolean; badgeHtml?: string; size?: string;
    }[];
    /** The `[CHAT_ONLY]` raw-output disclosure. */
    reasoning?: { details: DetailsSpec; raw: string };
    /** A Claude-Code row's "Full output" disclosure. */
    more?: { details: DetailsSpec; html: string };
    /** #32's suggested-answer chips, on the last conversational row. */
    qa?: {
      multi: boolean;
      groups: { label: string; answers: { text: string; suggested: boolean; selected: boolean }[] }[];
    };
  };

export interface TranscriptState {
  rows: TranscriptRow[];
  /** #1049's walkthrough, at the END of the transcript. '' in a launchpad. */
  devFlowHtml: string;
  /** #990's trailing dots. Null when a live coding run already shows progress. */
  activity: { label: string } | null;
}

export const EMPTY_TRANSCRIPT: TranscriptState = { rows: [], devFlowHtml: '', activity: null };

export const transcriptStore = createStore<TranscriptState>(EMPTY_TRANSCRIPT);

/**
 * The live bubble's html, published per animation frame. `id` names the row
 * it belongs to so a publish left over from the previous turn cannot paint
 * into the next one's bubble.
 */
export interface StreamState {
  key: string;
  html: string;
}

export const streamStore = createStore<StreamState>({ key: '', html: '' });

/**
 * `Date.now()`, republished on the 1s heartbeat. Every ticking span re-derives
 * from it — see the header. Zero means "no tick yet", and the rows fall back
 * to the label baked into their model.
 */
export const nowStore = createStore<{ now: number }>({ now: 0 });
