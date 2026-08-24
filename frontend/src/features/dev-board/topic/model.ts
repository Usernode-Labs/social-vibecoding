/**
 * The topic head's BODY — everything under the card — as a view model.
 *
 * `_renderTopicHead` used to innerHTML `#gc-thread-head` with the card's
 * markup plus a body built from eight string renderers. The card converted
 * with the rest of the card family (../card/); this is the other half, and
 * it decomposes where the card family could not: each block is a separate
 * region with its own data, so they share one shape rather than one
 * builder.
 *
 * ── One note box, four callers ────────────────────────────────────────
 *
 * `_mergeConflictDetailHtml`, `_platformEnvDetailHtml`,
 * `_consoleCheckDetailHtml` and three of `_checksDetailHtml`'s five states
 * all drew THE SAME THING: a bordered, tinted box with a heading, some
 * rows and sometimes a button. They are `NoteBox` now, and the tone is a
 * name rather than four hand-written class strings — which is what makes
 * them stay one box as the palette moves.
 *
 * The checks VERDICT box keeps its own shape: its rows nest (a failure
 * carries its reason and its console errors) and its passing rows fold away
 * behind a `<details>`, neither of which the shared box has any business
 * knowing about.
 */

import type { ActionSpec } from '../card/model';


/** The four tints a note box comes in. Resolved to classes by the component. */
export type NoteTone = 'neutral' | 'ok' | 'warn' | 'error';

/**
 * A run of prose, with the emphasised spans called out.
 *
 * Several of these sentences name a person or a tool mid-sentence in
 * `font-medium` — "…imported by **maya**…", "Built with **Claude Code** by
 * **maya**…" — and a plain string could not carry that. `{ b }` is the
 * emphasised run; a bare string is ordinary text.
 */
export type TextRun = string | { b: string };

export interface NoteItem {
  /** A `<code>` run — a variable name, a file path. */
  code?: string;
  text?: string;
  /** Sets the whole row in mono at 0.7rem, for a path or a log line. */
  mono?: boolean;
  /** The console-error rows' `[kind] message (source)` shape. */
  kind?: string;
  source?: string;
}

/**
 * One row under a note box's heading — a line of prose, or a bulleted list.
 *
 * ORDERED, and tagged rather than split into a `lines` field and a `list`
 * field, because the two boxes that have a list put it in different places:
 * the conflict box introduces its files ("Conflicting files:") and then
 * lists them, with two more lines after; the platform-variables box lists
 * the missing keys directly under the heading and explains itself below.
 * A lines-then-list shape renders both, in the wrong order, silently.
 */
export type NoteRow =
  | {
    t: 'line';
    parts: TextRun[];
    /** `mt-0.5 opacity-90` (the lede) vs `mt-1 opacity-80` (the footnote). */
    weight?: 'lede' | 'foot';
  }
  | { t: 'list'; items: NoteItem[]; cls?: string };

export interface NoteBox {
  key: string;
  tone: NoteTone;
  heading: string;
  /** An in-flight arc before the heading. */
  spinner?: boolean;
  rows: NoteRow[];
  action?: ActionSpec | null;
}

/** One row of the checks verdict: a check, and why it failed. */
export interface CheckRow {
  key: string;
  pass: boolean;
  advisory: boolean;
  name: string;
  path?: string | null;
  reason?: string | null;
  errors?: { kind: string; message: string; source?: string | null }[];
}

export interface ChecksVerdict {
  failing: boolean;
  heading: string;
  summary: string;
  failures: CheckRow[];
  passes: CheckRow[];
  /** Passes fold behind a `<details>` above this many. */
  foldPasses: boolean;
  advisoryNote: string | null;
  checkedNote: string | null;
  fixNote: string | null;
  action: ActionSpec | null;
}

/** One entry in the detail block's ordered list of boxes. */
export type DetailBlock =
  | { t: 'note'; box: NoteBox }
  | { t: 'checks'; v: ChecksVerdict };

/** The proposal's detail block: the meta line, its notes, and the boxes. */
export interface ProposalDetails {
  /** "View PR on GitHub · proposed by maya · 2h ago", already split. */
  meta: { href?: string | null; parts: TextRun[] }[];
  /** The circular "?" beside the meta line. */
  help: boolean;
  /** A prose note under the meta line. */
  notes: { key: string; parts: TextRun[]; tone: 'muted' | 'warn' }[];
  linked: { n: number; href: string }[];
  /**
   * The note boxes and the checks verdict, IN ORDER — conflict, checks,
   * platform variables. A tagged list rather than three fields because the
   * order is the whole contract: a reader scanning a blocked proposal reads
   * them top to bottom, and the verdict sits between the other two.
   */
  blocks: DetailBlock[];
  /** The vote roster, filled by `_loadVoteRoster` once it answers. */
  roster: RosterView | null;
  helpHint: boolean;
  explicitNote: string | null;
  lockedNote: string | null;
}

export interface RosterView {
  /** 'loading' until the fetch answers; 'hidden' when it fails. */
  phase: 'loading' | 'ready' | 'hidden';
  yes?: { label: string; names: string };
  no?: { label: string; names: string };
  needs?: string;
}

/** The shared-chat section: a disclosure whose BODY is another module's. */
export interface TranscriptSection {
  id: number;
  label: string;
  expanded: boolean;
}

/** Everything under the card, by topic kind. */
export interface TopicBody {
  /** The full action list, the blocked reasons and the before/after block. */
  actions: {
    pills: ActionSpec[];
    reasons: { heading: string; items: { key: string; label: string; detail: string; soft: boolean }[] } | null;
    visuals: { sessionId: number; open: boolean; tilesHtml: string } | null;
  } | null;
  /** An issue's markdown body, already rendered and sanitised. */
  issueBodyHtml?: string | null;
  /** Render the `#dev-issue-comments` host (features/dev-board/issue-comments.tsx). */
  comments?: boolean;
  /** A proposal's plain-language summary, already rendered. */
  summaryHtml?: string | null;
  /**
   * #1370's "Full proposal details" disclosure — the complete GitHub PR
   * description, deliberately quieter than the generated summary above it.
   *
   * The open flag lives in app-view.js (`_proposalBodyOpen`), not in
   * component state: the head repaints on every checks poll and WS event,
   * and the same rule the before/after visuals and the transcript section
   * follow keeps the disclosure from collapsing under the reader.
   */
  proposalBody?: { id: number | null; open: boolean; html: string } | null;
  details?: ProposalDetails | null;
  /** The one-line explainer under a session or governance card. */
  note?: string | null;
  transcript?: TranscriptSection | null;
}
