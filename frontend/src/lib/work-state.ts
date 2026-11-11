/**
 * Where a request or a change stands: its standing, one per item, drawn the
 * same on every screen (docs/plans/bot-one-model.md, step 3; step 1 of the
 * one-model finish, 11 Nov 2026).
 *
 * The server decides it once (src/services/work-state.js), stores it and
 * words it: `words` holds the phrase ids its stage and second line are said
 * with, as the requester reads them and as anyone else does. The Homeroom bot
 * tab, the chat's drawer, a request's page and a project's chat draw what it
 * sent, and a `work_state` push carries the whole standing when it moves.
 * Nothing here decides a stage or picks words: the mapping from a stage, a
 * why, a reason and a line to its phrase exists once, on the server
 * (work-state.js phrasesOf).
 *
 * Ten stages: reading, planning, waiting_for_you (always with a why),
 * building, checking, up_for_vote, going_live, live, stopped (with a
 * reason), closed. Beside them the standing carries the facts a screen draws
 * around its words: its change (checks, votes, whether its vote is open), what
 * it asks of people (a question, a plan, a vote to close, ...) and what the
 * bot last said about it.
 */

export type Stage =
  | 'reading' | 'planning' | 'waiting_for_you' | 'building' | 'checking'
  | 'up_for_vote' | 'going_live' | 'live' | 'stopped' | 'closed';

export type Why = 'question' | 'plan' | 'decide' | 'already_works' | 'needs_detail';

export type Reason = 'build_failed' | 'fix_stopped' | 'look_failed' | 'change_closed' | 'stalled';

export interface WorkLine {
  code: string;
  /** `queued`: its place in Homeroom bot's line (1 is next). */
  place?: number;
  /** `reviewing`: the round, of how many. */
  round?: number;
  of?: number;
  /** `checks_failing`: how many tests failed. */
  failing?: number;
  /** `checks_running`: about how many minutes are left. */
  minutes?: number;
  /** `claimed`: who pressed Claim. */
  by?: string;
  /** `reason`: Homeroom bot's own sentence. */
  text?: string;
  /** #6399: a hand-back reason a later release made out of date, by its code. */
  outdated?: string;
}

export interface Phrase {
  id: string;
  values?: Record<string, string | number>;
}

/** The standing's words: phrase ids into the core catalog, chosen by the server. */
export interface WorkWords {
  /** The stage as its requester reads it. */
  stage: Phrase;
  /** The stage as anyone else reads it. */
  stageOthers: Phrase;
  /** The second line, or null when it has none. */
  line: Phrase | null;
}

/** The change a standing draws (a request's lead change, or a change's own row). */
export interface StandingChange {
  id: number;
  number: number | null;
  status: string | null;
  checks: { state: string | null; phase: string | null; failing: number | null };
  votes: { yes: number; no: number };
  /** Open for votes now: the only time anything may say Vote on it. */
  voteOpen: boolean;
  firstVersion: boolean;
  githubHold: boolean;
  shotsHeld: boolean;
  conflict: boolean;
  /** An update on its way. */
  update: 'queued' | 'running' | null;
}

/** What the standing asks of people. */
export interface StandingAsks {
  question: { messageId: number | null; at: string | null } | null;
  plan: { version: number | null; sessionId: number | null; at: string | null; waitingGo: boolean } | null;
  closeVote: { issueId: number; yes: number; no: number } | null;
  draft: { threadId: number | null } | null;
  offers: { id: number; kind: string; expiresAt: string | null }[];
  reports: number;
}

/** Homeroom bot's newest post about it. */
export interface StandingSaid {
  messageId: number | null;
  kind: string | null;
  at: string | null;
  text: string;
}

export interface WorkState {
  stage: Stage;
  why?: Why | null;
  reason?: Reason | null;
  line?: WorkLine | null;
  whoseMove?: 'bot' | 'requester' | 'group' | 'builder' | null;
  since?: string | null;
  /** Absent from an older server or a cached payload: then only the plain stage word is said. */
  words?: WorkWords | null;
  change?: StandingChange | null;
  asks?: StandingAsks | null;
  said?: StandingSaid | null;
}

/**
 * The standing as a reader gets it: which item it is, and the facts that
 * are the viewer's own (added at read time, never stored): `mine` (they
 * asked for it, or decide on its project) and `voteOwed`.
 */
export interface Standing extends WorkState {
  kind?: 'request' | 'change';
  appId?: number | null;
  issueNumber?: number | null;
  sessionId?: number | null;
  mine?: boolean;
  voteOwed?: boolean;
}

export const STAGES: readonly Stage[] = Object.freeze([
  'reading', 'planning', 'waiting_for_you', 'building', 'checking',
  'up_for_vote', 'going_live', 'live', 'stopped', 'closed',
]);

// A payload with no words (an older server, a copy kept from before) says
// only its plain stage word. Each id is written whole, so the language
// inventory can find it; this is no mapping of whys, reasons or lines.
const PLAIN_STAGE: Record<Stage, string> = {
  reading: 'core:work.stage.reading',
  planning: 'core:work.stage.planning',
  waiting_for_you: 'core:work.stage.waitingForYou',
  building: 'core:work.stage.building',
  checking: 'core:work.stage.checking',
  up_for_vote: 'core:work.stage.upForVote',
  going_live: 'core:work.stage.goingLive',
  live: 'core:work.stage.live',
  stopped: 'core:work.stage.stopped',
  closed: 'core:work.stage.closed',
};

/** Pure: whether a value is a stage this build knows. */
export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/**
 * Pure: the stage's words, as the server chose them: the requester's
 * (`yours`) or anyone else's. With no words, the plain stage word.
 */
export function stageWords(state: WorkState, { yours = true }: { yours?: boolean } = {}): Phrase {
  const words = state.words;
  const said = words ? (yours ? words.stage : words.stageOthers) : null;
  return said || { id: PLAIN_STAGE[state.stage] || PLAIN_STAGE.reading };
}

/** Pure: the second line's words, as the server chose them, or null. */
export function lineWords(state: WorkState): Phrase | null {
  return (state.words && state.words.line) || null;
}

/** Pure: whether the stage asks something of its requester. */
export function asksRequester(state: WorkState | null | undefined): boolean {
  return !!state && (state.stage === 'waiting_for_you' || state.stage === 'stopped');
}

/** Pure: whether its change is merged, or merging: nothing may say Vote on it again. */
export function isSettled(state: WorkState | null | undefined): boolean {
  return !!state && (state.stage === 'live' || state.stage === 'going_live');
}

/**
 * Pure: whether its change is open for votes now, as the server stored it
 * (work_states.vote_open). A settled one never is, whatever an older read
 * of it said.
 */
export function voteOpen(state: WorkState | null | undefined): boolean {
  return !!state && !isSettled(state) && !!(state.change && state.change.voteOpen);
}

/**
 * Pure: whether it waits for its plan to be OK'd ("Review plan"): only a
 * standing waiting for its requester because of the plan, never one being
 * built.
 */
export function waitsForPlan(state: WorkState | null | undefined): boolean {
  return !!state && state.stage === 'waiting_for_you' && state.why === 'plan';
}

const WHYS: ReadonlySet<string> = new Set(['question', 'plan', 'decide', 'already_works', 'needs_detail']);
const REASONS: ReadonlySet<string> = new Set(['build_failed', 'fix_stopped', 'look_failed', 'change_closed', 'stalled']);
const MOVES: ReadonlySet<string> = new Set(['bot', 'requester', 'group', 'builder']);
const CODE = /^[a-z_]{1,40}$/;
const PHRASE_ID = /^[a-z][A-Za-z-]*:[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/;

const recordOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const count = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const idOf = (v: unknown) => (v == null ? null : (Number.isSafeInteger(Number(v)) && Number(v) !== 0 ? Number(v) : null));
const flag = (v: unknown) => v === true;

/** Pure: one phrase as the server sent it, or null. */
function phraseOf(input: unknown): Phrase | null {
  const row = recordOf(input);
  if (!row || !PHRASE_ID.test(text(row.id))) return null;
  const valuesIn = recordOf(row.values);
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(valuesIn || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) values[key] = value;
    else if (typeof value === 'string') values[key] = value.slice(0, 200);
  }
  return Object.keys(values).length ? { id: text(row.id), values } : { id: text(row.id) };
}

function wordsOf(input: unknown): WorkWords | null {
  const row = recordOf(input);
  const stage = row ? phraseOf(row.stage) : null;
  if (!row || !stage) return null;
  return { stage, stageOthers: phraseOf(row.stageOthers) || stage, line: phraseOf(row.line) };
}

function changeOf(input: unknown): StandingChange | null {
  const row = recordOf(input);
  const id = row ? idOf(row.id) : null;
  if (!row || !id) return null;
  const checks = recordOf(row.checks) || {};
  const votes = recordOf(row.votes) || {};
  const update = text(row.update);
  return {
    id,
    number: idOf(row.number),
    status: text(row.status) || null,
    checks: {
      state: text(checks.state) || null,
      phase: text(checks.phase) || null,
      failing: checks.failing == null ? null : count(checks.failing),
    },
    votes: { yes: count(votes.yes), no: count(votes.no) },
    voteOpen: flag(row.voteOpen),
    firstVersion: flag(row.firstVersion),
    githubHold: flag(row.githubHold),
    shotsHeld: flag(row.shotsHeld),
    conflict: flag(row.conflict),
    update: update === 'queued' || update === 'running' ? update : null,
  };
}

function asksOf(input: unknown): StandingAsks | null {
  const row = recordOf(input);
  if (!row) return null;
  const question = recordOf(row.question);
  const plan = recordOf(row.plan);
  const closeVote = recordOf(row.closeVote);
  const draft = recordOf(row.draft);
  const offers = Array.isArray(row.offers) ? row.offers : [];
  return {
    question: question ? { messageId: idOf(question.messageId), at: text(question.at) || null } : null,
    plan: plan ? {
      version: idOf(plan.version), sessionId: idOf(plan.sessionId), at: text(plan.at) || null, waitingGo: flag(plan.waitingGo),
    } : null,
    closeVote: closeVote && idOf(closeVote.issueId)
      ? { issueId: idOf(closeVote.issueId) as number, yes: count(closeVote.yes), no: count(closeVote.no) }
      : null,
    draft: draft ? { threadId: idOf(draft.threadId) } : null,
    offers: offers.map(recordOf).filter((o): o is Record<string, unknown> => !!o && !!idOf(o.id)).slice(0, 20)
      .map((o) => ({ id: idOf(o.id) as number, kind: text(o.kind).slice(0, 40), expiresAt: text(o.expiresAt) || null })),
    reports: count(row.reports),
  };
}

function saidOf(input: unknown): StandingSaid | null {
  const row = recordOf(input);
  if (!row) return null;
  return {
    messageId: idOf(row.messageId),
    kind: text(row.kind).slice(0, 40) || null,
    at: text(row.at) || null,
    text: text(row.text).slice(0, 200),
  };
}

/**
 * Pure: a standing as the server sent it, field by field, or null for a
 * stage this client does not know (drawn nowhere rather than guessed at).
 */
export function normalizeWorkState(input: unknown): WorkState | null {
  const row = recordOf(input);
  if (!row || !isStage(row.stage)) return null;
  const num = (v: unknown) => count(v) || undefined;
  const lineIn = recordOf(row.line);
  const code = text(lineIn?.code);
  const line: WorkLine | null = lineIn && CODE.test(code) ? {
    code,
    ...(num(lineIn.place) ? { place: num(lineIn.place) } : {}),
    ...(num(lineIn.round) ? { round: num(lineIn.round) } : {}),
    ...(num(lineIn.of) ? { of: num(lineIn.of) } : {}),
    ...(num(lineIn.failing) ? { failing: num(lineIn.failing) } : {}),
    ...(num(lineIn.minutes) ? { minutes: num(lineIn.minutes) } : {}),
    ...(text(lineIn.by) ? { by: text(lineIn.by).slice(0, 64) } : {}),
    ...(text(lineIn.text) ? { text: text(lineIn.text).slice(0, 200) } : {}),
    ...(CODE.test(text(lineIn.outdated)) ? { outdated: text(lineIn.outdated) } : {}),
  } : null;
  const words = wordsOf(row.words);
  const change = changeOf(row.change);
  const asks = asksOf(row.asks);
  const said = saidOf(row.said);
  return {
    stage: row.stage,
    why: WHYS.has(text(row.why)) ? text(row.why) as Why : null,
    reason: REASONS.has(text(row.reason)) ? text(row.reason) as Reason : null,
    line,
    whoseMove: MOVES.has(text(row.whoseMove)) ? text(row.whoseMove) as WorkState['whoseMove'] : null,
    since: text(row.since) || null,
    ...(words ? { words } : {}),
    ...(change ? { change } : {}),
    ...(asks ? { asks } : {}),
    ...(said ? { said } : {}),
  };
}

/** A `work_state` push (services/work-state.js pushOf), as the socket delivers it. */
export interface WorkStatePush {
  type: 'work_state';
  appId: number;
  appSlug: string | null;
  item: { kind: 'request' | 'change'; ref: number; issueNumber: number | null; sessionId: number | null };
  /** The whole standing, as every reader gets it. */
  state: WorkState;
}

/** Pure: whether an events-socket message is a work_state push. */
export function isWorkStatePush(event: unknown): event is WorkStatePush {
  const e = event as WorkStatePush | null;
  return !!e && e.type === 'work_state' && !!e.item && !!e.state && isStage(e.state.stage);
}

/** Pure: the standing a push carries, with which item it is, or null. */
export function standingOfPush(push: WorkStatePush): Standing | null {
  const state = normalizeWorkState(push.state);
  if (!state) return null;
  return {
    ...state,
    kind: push.item.kind === 'change' ? 'change' : 'request',
    appId: idOf(push.appId),
    issueNumber: idOf(push.item.issueNumber),
    sessionId: idOf(push.item.sessionId),
  };
}

/**
 * Pure: what a push says about a change's vote: its change (by its session
 * id) and whether its vote is open now, or null when it names no change.
 * Read off the stored `voteOpen`; a payload without one (an older server)
 * reads a change row that is not up for a vote as closed to votes.
 */
export function voteNews(push: WorkStatePush): { sessionId: number; open: boolean } | null {
  const standing = standingOfPush(push);
  if (!standing) return null;
  const sessionId = standing.change?.id
    || (standing.kind === 'change' ? idOf(push.item.sessionId) || idOf(push.item.ref) : null);
  if (!sessionId) return null;
  if (standing.change) return { sessionId, open: voteOpen(standing) };
  return standing.kind === 'change' ? { sessionId, open: standing.stage === 'up_for_vote' && !isSettled(standing) } : null;
}

/**
 * Pure: the Needs you feed's cards (GET /api/workshop/needs-feed, the
 * server's vote rows) less the Vote card of a change a push says is no
 * longer open for votes (merged, merging, held by GitHub or its shots,
 * closed, an update on its way), or the same list when it holds none.
 * Nothing is remembered: the read that follows brings the card back if its
 * vote opens again.
 */
export function withoutClosedVote<T extends { kind?: string; id?: number | null }>(feed: T[] | null, push: unknown): T[] | null {
  if (!feed || !isWorkStatePush(push)) return feed;
  const news = voteNews(push);
  if (!news || news.open) return feed;
  const kept = feed.filter((item) => !(item.kind === 'proposal' && Number(item.id) === news.sessionId));
  return kept.length === feed.length ? feed : kept;
}
