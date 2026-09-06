/**
 * The group chat transcript's view model.
 *
 * `public/js/group-chat.js` used to render this list by building an HTML string
 * per message and assigning the lot to `#gc-messages.innerHTML` — then again on
 * every reaction, every edit, every bookmark toggle, each with its own targeted
 * `innerHTML` write into the row it had just built. It pushes THIS instead, and
 * ./transcript.tsx is the only writer of the DOM below that host.
 *
 * ── Why the shape is flat and pre-decided ─────────────────────────────
 *
 * Every branch the template string evaluated inline — is this a system row, a
 * vote row, mine, edited, does it carry a quote — is resolved by group-chat.js,
 * where `App.user`, `AppView.voteState` and the message-kind vocabulary already
 * live. The component renders; it does not decide. That is the same split the
 * launcher grid runs under (features/home/grid-store.ts), and it is what lets
 * the module keep owning its data while React owns its markup.
 *
 * ── What is NOT in here, on purpose ───────────────────────────────────
 *
 * `bodyHtml` is sanitized markup, not text. `renderMessageBody` in
 * group-chat.js runs the content through DevChat.renderMarkdown and then a
 * sanitizer; reproducing that in React would mean a second markdown pipeline
 * and a second sanitizer, which is exactly how the two drift apart. The
 * component renders it through `dangerouslySetInnerHTML` with a memoised
 * wrapper — see the note there about object identity.
 *
 * Three things are NOT modelled and stay module-filled hosts, which is the
 * documented controller-host seam in AGENTS.md — the same one `#dev-body` runs
 * under:
 *
 *   * vote controls, whose markup comes from `AppView.voteState`. That arrives
 *     on its own schedule and is re-filled in place, so modelling it would mean
 *     re-rendering every row whenever any vote changed. What the row DOES
 *     model is `voteRef` — the (sessionId, prNumber) pair
 *     `refreshVoteControls` resolves against that state — because those come
 *     off the message and nothing else can supply them;
 *   * the spec-share card, a whole second renderer.
 *
 * That is a second copy of logic that already exists, for markup that changes
 * only when the message does.
 *
 * The attachment row was on that list and should not have been. Its hrefs are
 * derived from the app slug and its markdown chips go through a delegated
 * handler, both of which stay the module's — but neither is markup, and
 * nothing ever filled the host, so a message with files rendered an empty div
 * where its thumbnails and download chips belonged. It is `attachments`
 * below.
 */

import { createStore } from '../../lib/plain-store.js';

export interface Reaction {
  emoji: string;
  count: number;
  /** Everyone who reacted — the pill's tooltip, and how "mine" is decided. */
  users: string[];
  mine: boolean;
}

/**
 * A vote row's reference to the pull request it is about.
 *
 * `sessionId` is the precise tag newer servers put in the message metadata;
 * `prNumber` is parsed out of the row's own text and covers rows that predate
 * it. Either may be `''`. They travel onto the controls host as
 * `data-session-id` / `data-pr-number`, which is exactly where
 * `GroupChat.refreshVoteControls` reads them back — the host is module-filled,
 * so the attributes it fills FROM are part of that contract.
 */
export interface VoteRef {
  sessionId: string;
  prNumber: string;
}

/**
 * A quoted reply block, shown above the content (#15, Signal-style reply).
 *
 * Everything the block DRAWS and everything the delegated click handler READS,
 * because they are the same four facts: `_handleQuotedClick` dispatches on
 * `data-quote-source`, opens `data-quote-href` for a PR and jumps to
 * `data-quote-ref` for anything else.
 */
export interface Quote {
  /** 🔀 for a PR, 📋 for a spec, ↩ otherwise. The module picks it. */
  icon: string;
  /** The author, or "PR #12" / "system" where there isn't one. */
  username: string;
  excerpt: string;
  source: string;
  /** PR quotes open this in a new tab; null on every other source. */
  href: string | null;
  /** The row this quote points at, for scroll-into-view. */
  targetId: number | null;
}

export type MessageKind = 'message' | 'system' | 'vote' | 'spec_share';

/**
 * One file on a message, as its chip draws it.
 *
 * Resolved by the module, which owns the app slug the URL is built from and
 * the 32-hex id check that drops anything else before it can reach an `href`.
 * `kind` decides the shape: `image` is an inline thumbnail, `markdown` and
 * `html` are chips with their own action, and everything else is a plain
 * download. `badge` is the little MD / HTML / BIN tag, or null where the kind
 * carries no tag.
 */
export interface Attachment {
  id: string;
  kind: string;
  /** The filename, as a text child — never interpolated into an attribute. */
  name: string;
  url: string;
  /** Pre-formatted by the module: "2 KB", "3.0 MB". */
  size: string;
  badge: string | null;
}

export interface TranscriptMessage {
  id: number | null;
  kind: MessageKind;
  username: string;
  /** Rendered clock time — formatted by the module, whose locale rules these are. */
  time: string;
  /** Sanitized markdown for an ordinary message; plain text for a system row. */
  bodyHtml: string;
  systemText: string;
  /** Set by transcript.tsx's foldRepeats: how many identical lines this one stands for. */
  repeat?: number;
  mine: boolean;
  /** Full timestamp for the "edited" marker's tooltip, or null if never edited. */
  editedTitle: string | null;
  unread: boolean;
  bookmarked: boolean;
  /**
   * The 1.5s highlight a jump-to-original lands on. On the MODEL because the
   * row is React's: `_handleQuotedClick` used to `classList.add` it, which the
   * next repaint would have swept away mid-animation.
   */
  flash: boolean;
  canEdit: boolean;
  /**
   * Whether each of the row's three header controls renders. The module
   * decides — `_readOnly()` and `App.user` are its state, not the
   * component's — which is the same split every other field here runs under.
   *
   * They were MISSING from this type and from the component until the
   * conversion was checked against a seeded chat: the legacy row emitted an
   * edit button, a save button and an add-reaction button, and the first
   * React transcript silently rendered none of the three.
   */
  showEdit: boolean;
  showBookmark: boolean;
  showReact: boolean;
  quote: Quote | null;
  reactions: Reaction[];
  /** The files on this message, already resolved to URLs. Empty for most rows. */
  attachments: Attachment[];
  /** Vote rows only: the tint class the module derives from the viewer's vote. */
  voteRowClass: string;
  /** Vote rows only: what the controls host is about. Null on every other kind. */
  voteRef: VoteRef | null;
  /** Spec-share rows only — see SpecShareView. Null on every other kind. */
  specShare: SpecShareView | null;
}

/**
 * A shared spec, as its card draws it.
 *
 * `snippetHtml` is markdown the module rendered through `DevChat.renderMarkdown`
 * so the preview matches the dev-chat spec viewer exactly; `snippetText` is the
 * fallback for a page where dev-chat.js did not load, and arrives as a text
 * child. At most one of the two is ever set.
 */
export interface SpecShareView {
  title: string;
  /** The header the panel shows while the fetch is in flight. */
  previewTitle: string;
  sharedBy: string;
  version: number;
  /** Formatted build time, or null when the share carried none. */
  built: string | null;
  prNumber: number | null;
  sessionId: number | null;
  snippetHtml: string | null;
  snippetText: string | null;
}

/**
 * The rows above the messages: "Load earlier", and the empty/loading line.
 * Only the thread transcript has them — the general chat paginates from its own
 * header — but modelling them here keeps ONE component for both hosts.
 */
export interface TranscriptLead {
  /** Show the "Load earlier" control. */
  earlier: boolean;
  /** The placeholder line, or null when there are messages to show. */
  placeholder: string | null;
}

export interface TranscriptView {
  messages: TranscriptMessage[];
  lead: TranscriptLead;
}

export interface TranscriptState {
  /** False until group-chat.js has pushed once — see the initial-render note. */
  ready: boolean;
  /**
   * Transcripts by host key — `main` for the general chat, `thread` for the
   * topic sub-view. Keyed rather than two stores because the two are the same
   * shape rendered by the same component into different hosts; a second store
   * would be a second copy of every update path.
   */
  byKey: Record<string, TranscriptView>;
}

export const EMPTY_VIEW: TranscriptView = {
  messages: [],
  lead: { earlier: false, placeholder: null },
};

/**
 * Renders nothing, which is exactly the empty `<div id="gc-messages">` that
 * `AppView.renderDevChatTab` creates. The host is built by a legacy template,
 * so there is no prerender to match here — but an empty first render still
 * matters: the module mounts this portal and THEN loads, and a transcript that
 * flashed placeholder rows would be visible on every tab switch.
 */
export const INITIAL_TRANSCRIPT: TranscriptState = { ready: false, byKey: {} };

export const transcriptStore = createStore<TranscriptState>(INITIAL_TRANSCRIPT);

if (typeof window !== 'undefined') {
  (window as unknown as { GroupChatTranscriptStore?: unknown })
    .GroupChatTranscriptStore = transcriptStore;
}
