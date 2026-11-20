/**
 * The foot of a thread's card: where it stands, in one headline and one line
 * under it. Pure, so tests read it without a DOM; drawn by ./thread-card.tsx
 * `ThreadFoot`.
 *
 * A change has three things that could be said (its votes, its tests, its
 * merge) and the page used to say all three as cards one above the other.
 * The foot says the one that decides what happens next, and the others are a
 * press away, in the layer a step of the timeline opens.
 */

import { lineWords, stageWords, type Phrase, type Standing, type WorkState } from '../../../lib/work-state';
import { FAILING_LINES, lookOf, type KnownWhy, type Stage } from '../../../lib/work-stages';

export type FootTone = 'bad' | 'ok' | 'muted' | null;

/** Which of a change's cards the foot is speaking for. */
export type FootGate = 'votes' | 'testing' | 'merge';

export interface GateLike {
  name: string;
  figure: string;
  tone: string;
  done: boolean;
  note: string[];
  facts?: { key: string; text: string; ask?: boolean }[];
  segments?: { weight: number; pct: number; state: string }[];
  /** Testing only, on a change Homeroom bot built whose tests failed: where its own fix stands. */
  botFix?: string | null;
}

export interface ChangeFootInput {
  status: { key: string; label: string; yes?: number; majority?: number } | null;
  votes: GateLike;
  testing: GateLike;
  merge?: GateLike | null;
  /**
   * #6821: the change's stored work state (the server's `work`), the same row
   * the Homeroom bot tab and Needs you read, with the viewer's own vote. When
   * it is there and the change is not up for a vote, its words are the foot's
   * headline and line, so the page and the lists can never disagree. The
   * buttons stay on the live gates: what a press does never depends on a row
   * a few seconds old.
   *
   * On a request's page with one change it is the REQUEST's row instead
   * (./thread-changes.tsx): the page is the request's, so its foot says
   * where the request stands ("Stopped: its tests still fail", a question
   * asked), which the change's own row does not know.
   */
  work?: Standing | null;
  /** The viewer is the row's requester: its words are theirs (a request's row; a change's row reads the same to everyone). */
  yours?: boolean;
}

/**
 * Where a change stands, as ONE word the foot and the timeline both read
 * (17 Nov 2026). They used to work it out separately, and disagreed: an
 * approved change's foot was still a vote while its timeline step was titled
 * "2 / 2"; a change going live had a foot about its tests; failed tests left
 * the timeline standing on "Up for a vote".
 *
 *   live      merged and with everyone
 *   closed    ended without going live
 *   going     approved and on its way (merging, deploying)
 *   stuck     its release is stalled or failed, or GitHub refuses the merge
 *   failed    its tests failed: nothing goes live until they pass
 *   testing   its tests are still running
 *   approved  it has the yes it needs and its tests passed; the merge is next
 *   vote      it is waiting for votes
 */
export type ChangePhase = 'live' | 'closed' | 'going' | 'stuck' | 'failed' | 'testing' | 'approved' | 'vote';

const LIVE: ReadonlySet<string> = new Set(['merged', 'live', 'deployed', 'merged_reload', 'deployed_reload']);
/** A live pill that already says more than "Live" (a Reload for a tab older than the change). */
const LIVE_PLAIN: ReadonlySet<string> = new Set(['merged', 'live', 'deployed']);
const ENDED: ReadonlySet<string> = new Set(['closed', 'archived']);
const GOING: ReadonlySet<string> = new Set(['merging', 'deploying', 'delivery_pending']);
const STUCK: ReadonlySet<string> = new Set(['deployment_stalled', 'delivery_failed']);
/** Homeroom bot is no longer fixing the failed tests itself. */
const FIX_STOPPED: ReadonlySet<string> = new Set(['stopped', 'handed_off']);
const FIX_UNDERWAY: ReadonlySet<string> = new Set(['fixing', 'queued']);

/** Pure: the one phase a change is in. Its order is the order of what decides what happens next. */
export function changePhase(input: ChangeFootInput): ChangePhase {
  const { status, votes, testing, merge } = input;
  const key = status?.key || '';
  if (LIVE.has(key)) return 'live';
  if (ENDED.has(key)) return 'closed';
  if (GOING.has(key)) return 'going';
  if (STUCK.has(key)) return 'stuck';
  if (testing.tone === 'bad') return 'failed';
  if (!testing.done) return 'testing';
  if (merge && merge.tone === 'bad') return 'stuck';
  if (votes.done || merge) return 'approved';
  return 'vote';
}

/** Pure: what a failed change is waiting on: Homeroom bot's fix, nothing (it stopped), or its author. */
export function fixStanding(testing: GateLike): 'fixing' | 'stopped' | 'waiting' {
  const fix = testing.botFix || '';
  return FIX_UNDERWAY.has(fix) ? 'fixing' : FIX_STOPPED.has(fix) ? 'stopped' : 'waiting';
}

export interface ChangeFoot {
  gate: FootGate;
  /** For `data-thread-foot`: what the foot is saying. */
  key: 'live' | 'closed' | 'failed' | 'testing' | 'merging' | 'approved' | 'vote';
  /** The headline in words the page already has (a card's name or figure, the pill). */
  headline: string;
  /** Fixed words that replace `headline`: "Approved", "Live", "Tests failed". */
  title: Phrase | null;
  /** Short facts that lead the line under the headline ("3 waiting", "about 6 min left"), joined with a dot. */
  facts: (string | Phrase)[];
  /** The rest of that line, as its sentences. */
  sub: string[];
  tone: FootTone;
  /** 0 to 1 while something is running; null otherwise. */
  progress: number | null;
}

/** Pure: how far a card's bar has got, 0 to 1, weighted as the bar draws it. */
export function barProgress(segments: GateLike['segments']): number | null {
  if (!segments || !segments.length) return null;
  let total = 0;
  let done = 0;
  for (const seg of segments) {
    const weight = Number(seg.weight) > 0 ? Number(seg.weight) : 1;
    total += weight;
    done += weight * Math.max(0, Math.min(100, Number(seg.pct) || 0)) / 100;
  }
  return total > 0 ? done / total : null;
}

/**
 * Pure: a change's foot, by its phase (`changePhase`). The headline is one
 * plain word or figure; the line under it is short facts, then at most the
 * card's own sentences. What explains the phase at length is the note under
 * the timeline's current step (./rail-model.ts), not a paragraph here.
 */
export function changeFoot(input: ChangeFootInput): ChangeFoot {
  const { status, votes, testing, merge } = input;
  const key = status?.key || '';
  const label = status?.label || '';
  const foot = liveFoot(input, key, label);
  return storedFoot(foot, input.work || null, changePhase(input), input.yours !== false);
}

/** The phases a change's own status settles: merged, merging, a stalled release, closed. */
export const SETTLED_PHASES: ReadonlySet<ChangePhase> = new Set<ChangePhase>(['live', 'closed', 'going', 'stuck']);

/**
 * #6821: the foot worded from the stored work state instead of the live
 * gates, by the one rule (lib/work-state.ts): the row gives the word, the
 * live gates add detail under it. An approved change catching up with main
 * reads "Syncing with main", never "Up for a vote"; the row's second line
 * and the viewer's own yes lead the line under it. A change still up for a
 * vote keeps its live foot, which carries the tally and the vote's own
 * words under the same stage word.
 *
 * The live foot's sentences stay as the detail (`sub`): who fixes failed
 * tests, that an update is on its way and clears a yes cast now, what a
 * conflict means for the vote. They used to be dropped, and the foot said a
 * stage with nothing under it that the page's own cards knew.
 *
 * Only while the change is open. Once it is live, closed, merging or its
 * release is stuck (`phase`), its own status is newer than any row and its
 * live foot stands whole: the day it went live, why it was closed, what a
 * stuck merge waits on. The timeline's last step has the same guard
 * (./rail-model.ts withStoredNow); without it a row a few seconds behind
 * said "Taking screenshots" over a change that had just gone live.
 */
function storedFoot(foot: ChangeFoot, work: Standing | null, phase: ChangePhase, yours = true): ChangeFoot {
  if (!work || !work.stage || work.stage === 'up_for_vote') return foot;
  if (SETTLED_PHASES.has(phase)) return foot;
  const line = lineWords(work);
  const mine = work.myVote === 'yes'
    ? { id: 'changes:page.votes.note.youSaidYes' }
    : work.myVote === 'no' ? { id: 'changes:page.votes.facts.youSaidNo' } : null;
  return {
    ...foot,
    headline: '',
    title: stageWords(work, { yours }),
    facts: [...(line ? [line] : []), ...(mine ? [mine] : [])],
    // The row tints it too, whatever the gates say: a foot that says
    // "Building: Homeroom bot is fixing its tests" is not red because a test
    // failed, and a stop is red even while the gates are quiet.
    tone: storedTone(work),
  };
}

/**
 * Pure: whether the row says its change's tests fail: its own checks,
 * GitHub's, or a takeover's fix that failed while they still fail
 * (services/work-state.js withUpdate). Which lines say so is the table's
 * (work-stages.json `failing`, lib/work-stages.ts FAILING_LINES), the list
 * AppView._workPill tints by too. A surface tints such a row with the bad
 * tone.
 */
export function testsFailing(state: WorkState | null | undefined): boolean {
  return !!state && !!state.line && FAILING_LINES.has(state.line.code);
}

/**
 * Pure: the foot's tone for a stored row that is not up for a vote, in the
 * foot's own tones (`liveFoot`): a stop or failing tests are bad; an
 * approved change on its way (going live) is the ok of Approved; otherwise
 * the stage's own tint (lib/work-stages.ts STAGE_LOOK): live is ok and
 * closed muted (a row ahead of the page); anything still in hand is plain.
 */
export function storedTone(work: WorkState): FootTone {
  if (work.stage === 'stopped' || testsFailing(work)) return 'bad';
  if (work.stage === 'going_live') return 'ok';
  return lookOf(work.stage).tone;
}

function liveFoot(input: ChangeFootInput, key: string, label: string): ChangeFoot {
  const { status, votes, testing, merge } = input;
  switch (changePhase(input)) {
    case 'live':
      return { gate: 'votes', key: 'live', headline: label, title: LIVE_PLAIN.has(key) ? { id: 'core:work.stage.live' } : null, facts: [], sub: votes.note, tone: 'ok', progress: null };
    case 'closed':
      return { gate: 'votes', key: 'closed', headline: label, title: null, facts: [], sub: votes.note, tone: 'muted', progress: null };
    case 'going':
      // Approved and on its way. What the merge waits on is one short fact;
      // its account is the timeline's note.
      return {
        gate: merge ? 'merge' : 'votes', key: 'merging', headline: label, title: { id: 'core:work.stage.approved' },
        facts: [{ id: 'core:work.stage.goingLive' }, ...(merge && merge.figure ? [merge.figure] : [])], sub: [], tone: 'ok', progress: null,
      };
    case 'stuck':
      return merge && merge.tone === 'bad'
        ? { gate: 'merge', key: 'merging', headline: merge.name, title: null, facts: [merge.figure].filter(Boolean), sub: merge.note, tone: 'bad', progress: null }
        : { gate: 'votes', key: 'merging', headline: label, title: null, facts: [], sub: votes.note, tone: 'bad', progress: null };
    case 'failed':
      return {
        gate: 'testing', key: 'failed', headline: testing.figure || testing.name,
        title: { id: fixStanding(testing) === 'stopped' ? 'project:topic.card.foot.stoppedTests' : 'project:topic.rail.testsFailedPlain' },
        facts: [testing.figure].filter(Boolean), sub: testing.note, tone: 'bad', progress: null,
      };
    case 'testing':
      // Tests still running lead, as failed ones do: a vote can be cast
      // meanwhile, and its button rides beside See progress.
      // How far they are is the one fact; what they are doing is the note
      // under the timeline's Testing step.
      return { gate: 'testing', key: 'testing', headline: testing.name, title: null, facts: [testing.figure].filter(Boolean), sub: [], tone: null, progress: barProgress(testing.segments) };
    case 'approved':
      return {
        gate: merge ? 'merge' : 'votes', key: 'approved', headline: votes.figure || votes.name, title: { id: 'core:work.stage.approved' },
        facts: merge && merge.figure ? [merge.figure] : [], sub: merge ? [] : votes.note, tone: 'ok', progress: null,
      };
    default:
      return voteFoot(votes, status);
  }
}

function voteFoot(votes: GateLike, status: ChangeFootInput['status']): ChangeFoot {
  const said = votes.facts || [];
  const facts: (string | Phrase)[] = said.map((f) => f.text).filter(Boolean);
  // "0 of 2" before the viewer's own line, unless the card already counts.
  const needed = Number(status?.majority) || 0;
  if (needed > 0 && !said.some((f) => f.key === 'tally')) {
    facts.unshift({ id: 'project:topic.card.foot.tally', values: { yes: Math.max(0, Number(status?.yes) || 0), needed } });
  }
  return {
    gate: 'votes',
    key: 'vote',
    headline: votes.figure || votes.name,
    title: null,
    facts,
    sub: votes.note,
    tone: votes.tone === 'bad' ? 'bad' : null,
    progress: null,
  };
}

export interface RequestFoot {
  key: string;
  headline: Phrase;
  sub: Phrase | null;
  tone: FootTone;
  busy: boolean;
}

/**
 * Pure: a request's foot, from the standing the server stored and worded
 * (lib/work-state.ts). The line under it is the server's own second line
 * when it sent one, else the plain sentence for that stage. Its tint and
 * whether it spins are the stage's look (lib/work-stages.ts STAGE_LOOK).
 */
export function requestFoot(standing: WorkState, yours: boolean): RequestFoot {
  const stage = standing.stage;
  const look = lookOf(stage);
  return {
    key: stage,
    headline: stageWords(standing, { yours }),
    sub: lineWords(standing) || stageNote(standing),
    tone: look.tone,
    busy: look.busy,
  };
}

/**
 * The sentence that says what a stage is waiting for or what happens next,
 * for the timeline's last step and the foot, when the server sent no second
 * line of its own: one for every stage of the table (lib/work-stages.ts), so
 * a new stage is not silently left with none. Each id is written whole so
 * the language inventory finds it.
 */
export const STAGE_NOTES: Readonly<Record<Stage, string>> = Object.freeze({
  reading: 'project:topic.rail.note.reading',
  planning: 'project:topic.rail.note.planning',
  waiting_for_you: 'project:topic.rail.note.waiting',
  building: 'project:topic.rail.note.building',
  checking: 'project:topic.rail.note.checking',
  up_for_vote: 'project:topic.rail.note.vote',
  going_live: 'project:topic.rail.note.goingLive',
  live: 'project:topic.rail.note.live',
  stopped: 'project:topic.rail.note.stopped',
  closed: 'project:topic.rail.note.closed',
});

/**
 * What a row waiting for its requester waits on, where that is more than
 * "waiting" (`null`: the stage's own note): one entry for every why of the
 * table.
 */
export const WHY_NOTES: Readonly<Record<KnownWhy, string | null>> = Object.freeze({
  question: 'project:topic.rail.note.question',
  plan: 'project:topic.rail.note.plan',
  decide: null,
  already_works: null,
  needs_detail: null,
});

/**
 * Pure: the sentence that says what a stage is waiting for or what happens
 * next (STAGE_NOTES, WHY_NOTES): a change with only its before & after
 * screenshots left says that.
 */
export function stageNote(standing: WorkState): Phrase | null {
  const stage = standing.stage;
  if (!Object.prototype.hasOwnProperty.call(STAGE_NOTES, stage)) return null;
  if (stage === 'waiting_for_you' && standing.why && Object.prototype.hasOwnProperty.call(WHY_NOTES, standing.why)) {
    const id = WHY_NOTES[standing.why as KnownWhy];
    if (id) return { id };
  }
  if (stage === 'checking' && standing.line?.code === 'shots') return { id: 'project:topic.rail.note.shots' };
  return { id: STAGE_NOTES[stage] };
}

/**
 * Pure: the headline of the foot under a ballot between competing changes:
 * who leads and by how much, that the leaders are level, or, before anyone
 * has voted, that the group is choosing. `options` are the changes only, in
 * the ballot's order, each with its letter and its yes votes; `say` words a
 * message id.
 */
export function ballotHeadline(
  options: readonly { label: string; yes: number }[],
  say: (id: string, values?: Record<string, unknown>) => string,
): string {
  const ranked = [...options].sort((a, b) => b.yes - a.yes);
  const top = ranked[0];
  const next = ranked[1];
  if (!top || top.yes <= 0) return say('project:topic.card.ballot.choosing', { count: options.length });
  if (next && next.yes === top.yes) {
    return ranked.filter((o) => o.yes === top.yes).length === 2
      ? say('project:topic.card.ballot.levelTwo', { a: top.label, b: next.label })
      : say('project:topic.card.ballot.level');
  }
  return say('project:topic.card.ballot.leads', { choice: top.label, yes: top.yes, other: next ? next.yes : 0 });
}
