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
 *     re-rendering every row whenever any vote changed;
 *   * the spec-share card, a whole second renderer;
 *   * the attachment row, whose hrefs are derived from the app slug and whose
 *     clicks go through a delegated handler the module installs.
 *
 * Each is a second copy of logic that already exists, for markup that changes
 * only when the message does.
 */

import { createStore } from '../../lib/plain-store.js';

export interface Reaction {
  emoji: string;
  count: number;
  /** Everyone who reacted — the pill's tooltip, and how "mine" is decided. */
  users: string[];
  mine: boolean;
}

/** A quoted reply block, shown above the content. */
export interface Quote {
  username: string;
  excerpt: string;
  /** The row this quote points at, for scroll-into-view. */
  targetId: number | null;
}

export type MessageKind = 'message' | 'system' | 'vote' | 'spec_share';

export interface TranscriptMessage {
  id: number | null;
  kind: MessageKind;
  username: string;
  /** Rendered clock time — formatted by the module, whose locale rules these are. */
  time: string;
  /** Sanitized markdown for an ordinary message; plain text for a system row. */
  bodyHtml: string;
  systemText: string;
  mine: boolean;
  /** Full timestamp for the "edited" marker's tooltip, or null if never edited. */
  editedTitle: string | null;
  unread: boolean;
  bookmarked: boolean;
  canEdit: boolean;
  quote: Quote | null;
  reactions: Reaction[];
  /** Whether to emit the module-filled attachments host for this row. */
  hasAttachments: boolean;
  /** Vote rows only: the tint class the module derives from the viewer's vote. */
  voteRowClass: string;
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
