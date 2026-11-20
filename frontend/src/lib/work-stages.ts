/**
 * The one table of a work state's vocabulary, in the browser: its ten
 * stages, the whys of waiting_for_you, the reasons of stopped, and every
 * line code. The text is src/services/work-stages.json, the SAME file the
 * server derives and words a row with (src/services/work-stages.js says what
 * each property of it means). It is JSON so both sides can read it, as the
 * admin console's country table and the artifact policy are shared.
 *
 * The client used to keep copies of its own: the plain stage words, the
 * lines a pressed plan's build waits on, the lines whose tests fail, the
 * lines nobody has started on. Each was right the day it was written and
 * drifted from the server's one code at a time (review B5: `credit_wait`
 * reached the server's lists and none of these). Now there is nothing to
 * keep in step: a new stage or line code is one entry in the table, and the
 * browser reads it the next build.
 *
 * Two parts below:
 *   - the shared vocabulary, read off the table and never written here;
 *   - the client's own look of each stage (whether a step spins, how it is
 *     tinted, whether its note asks somebody), keyed by the shared stages,
 *     one entry for every stage, so a new stage is drawn on purpose.
 *
 * tests/work-stages-client.test.js holds both, and every client table keyed
 * by a stage, why, reason or line code, to the table: it fails when the
 * server and the client disagree on any of them.
 */

import table from '../../../src/services/work-stages.json';

type Table = typeof table;

/** A stage, as the table names it. */
export type Stage = keyof Table['stages'];
/** A why of waiting_for_you this build knows. */
export type KnownWhy = keyof Table['whys'];
/** A reason of stopped this build knows. */
export type KnownReason = keyof Table['reasons'];
/** A line code this build knows. */
export type LineCode = keyof Table['lines'];

interface StageDef { phrase: string }
interface LineDef {
  stages: readonly string[];
  notStarted?: boolean;
  ready?: boolean;
  waits?: boolean;
  approved?: boolean;
  failing?: boolean;
}

const STAGE_DEF = table.stages as unknown as Readonly<Record<Stage, StageDef>>;
const LINE_DEF = table.lines as unknown as Readonly<Record<string, LineDef>>;

const keysOf = <K extends string>(record: object): readonly K[] => Object.freeze(Object.keys(record)) as readonly K[];

/** The ten stages, in the table's order. */
export const STAGES: readonly Stage[] = keysOf<Stage>(table.stages);
/** The whys a waiting_for_you row may carry. */
export const WHYS: readonly KnownWhy[] = keysOf<KnownWhy>(table.whys);
/** The reasons a stopped row may carry. */
export const REASONS: readonly KnownReason[] = keysOf<KnownReason>(table.reasons);
/** Every line code. */
export const LINE_CODES: readonly LineCode[] = keysOf<LineCode>(table.lines);

const own = (record: object, key: unknown) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(record, key);

/** Pure: whether a value is a stage this build knows. */
export function isStage(value: unknown): value is Stage {
  return own(table.stages, value);
}

/** Pure: whether a value is a line code this build knows. */
export function isLineCode(value: unknown): value is LineCode {
  return own(table.lines, value);
}

/**
 * Pure: a stage's own word (a phrase id of the core catalog), the one a row
 * with no `words` says (an older server, a copy kept from before). A row the
 * server worded says its own words instead (lib/work-state.ts stageWords).
 */
export function stagePhrase(stage: Stage): string {
  return (STAGE_DEF[stage] || STAGE_DEF.reading).phrase;
}

const linesWhere = (test: (line: LineDef) => boolean): ReadonlySet<string> => new Set(LINE_CODES.filter((code) => test(LINE_DEF[code])));

/** The lines of a request nobody has started on yet (`notStarted`). */
export const NOT_STARTED: ReadonlySet<string> = linesWhere((l) => l.notStarted === true);
/** The lines of a build found ready that waits: its turn, a limit, credit (`ready`). */
export const READY: ReadonlySet<string> = linesWhere((l) => l.ready === true);
/** The lines that say the bot waits rather than works (`waits`). */
export const WAITING_LINES: ReadonlySet<string> = linesWhere((l) => l.waits === true);
/** The lines that say a change's votes are in (`approved`). */
export const APPROVED_LINES: ReadonlySet<string> = linesWhere((l) => l.approved === true);
/** The lines that say a change's tests fail: its own checks, GitHub's, or a fix of them that failed (`failing`). */
export const FAILING_LINES: ReadonlySet<string> = linesWhere((l) => l.failing === true);

// ── The client's own look of each stage ─────────────────────────────────

/** How a stage is tinted where a row is drawn: the foot's and the timeline's tones. */
export type StageTone = 'ok' | 'bad' | 'muted' | null;

export interface StageLook {
  /** A step or a foot at this stage spins: the bot, the checks or the merge is at it this minute. */
  busy: boolean;
  /** Its tint: a stop is bad, live is ok, closed is muted, anything still in hand plain (null). */
  tone: StageTone;
  /** Its note asks a person to act (answer, OK a plan, vote): the timeline's act tone. */
  asks: boolean;
  /** Its change's tests have passed it, so "Tested" is an event behind it on the timeline. */
  pastTests: boolean;
  /** A request's header names its work at this stage even with nothing in its thread yet: built, being built, or past it. */
  named: boolean;
  /** Its work is over: what a track's "finished" counts. */
  ended: boolean;
}

/**
 * Each stage's look, one entry for every stage of the table. These used to
 * be six sets in four modules (two copies of the busy stages among them),
 * each a list of the stages it was true for, so a new stage was silently
 * false in all of them. Here a new stage has no entry until somebody writes
 * one, and the agreement test says so.
 */
export const STAGE_LOOK: Readonly<Record<Stage, StageLook>> = Object.freeze({
  reading: { busy: true, tone: null, asks: false, pastTests: false, named: false, ended: false },
  planning: { busy: true, tone: null, asks: false, pastTests: false, named: false, ended: false },
  waiting_for_you: { busy: false, tone: null, asks: true, pastTests: false, named: false, ended: false },
  building: { busy: true, tone: null, asks: false, pastTests: false, named: true, ended: false },
  checking: { busy: true, tone: null, asks: false, pastTests: false, named: true, ended: false },
  up_for_vote: { busy: false, tone: null, asks: true, pastTests: true, named: true, ended: false },
  going_live: { busy: true, tone: null, asks: false, pastTests: true, named: true, ended: false },
  live: { busy: false, tone: 'ok', asks: false, pastTests: true, named: true, ended: true },
  stopped: { busy: false, tone: 'bad', asks: false, pastTests: false, named: true, ended: true },
  closed: { busy: false, tone: 'muted', asks: false, pastTests: false, named: false, ended: true },
});

const PLAIN_LOOK: StageLook = Object.freeze({ busy: false, tone: null, asks: false, pastTests: false, named: false, ended: false });

/** Pure: a stage's look, or the plain one of a stage this build does not know. */
export function lookOf(stage: string | null | undefined): StageLook {
  return isStage(stage) ? STAGE_LOOK[stage] : PLAIN_LOOK;
}
