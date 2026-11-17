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

import { lineWords, stageWords, type Phrase, type WorkState } from '../../../lib/work-state';

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
}

export interface ChangeFootInput {
  status: { key: string; label: string } | null;
  votes: GateLike;
  testing: GateLike;
  merge?: GateLike | null;
}

export interface ChangeFoot {
  gate: FootGate;
  /** For `data-thread-foot`: what the foot is saying. */
  key: 'live' | 'closed' | 'failed' | 'testing' | 'merging' | 'vote';
  headline: string;
  /** Short facts that lead the line under the headline ("3 waiting", "about 6 min left"), joined with a dot. */
  facts: string[];
  /** The rest of that line, as its sentences. */
  sub: string[];
  tone: FootTone;
  /** 0 to 1 while something is running; null otherwise. */
  progress: number | null;
}

const LIVE: ReadonlySet<string> = new Set(['merged', 'live']);
const ENDED: ReadonlySet<string> = new Set(['closed', 'archived']);

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
 * Pure: a change's foot. Live or closed says so; then a vote the viewer can
 * cast; then failed tests, since nothing else can happen until they pass;
 * then tests still running; then a merge under way; otherwise the vote.
 */
export function changeFoot(input: ChangeFootInput): ChangeFoot {
  const { status, votes, testing, merge } = input;
  const key = status?.key || '';
  if (LIVE.has(key)) {
    return { gate: 'votes', key: 'live', headline: status!.label, facts: [], sub: votes.note, tone: 'ok', progress: null };
  }
  if (ENDED.has(key)) {
    return { gate: 'votes', key: 'closed', headline: status!.label, facts: [], sub: votes.note, tone: 'muted', progress: null };
  }
  // A vote the viewer can cast leads: it is the one thing they can do here.
  // What its tests say rides under it (`also`).
  if (votes.tone === 'ask') return voteFoot(votes);
  if (testing.tone === 'bad') {
    return { gate: 'testing', key: 'failed', headline: testing.figure || testing.name, facts: [], sub: testing.note, tone: 'bad', progress: null };
  }
  if (!testing.done) {
    return {
      gate: 'testing',
      key: 'testing',
      headline: testing.name,
      facts: [testing.figure].filter(Boolean),
      sub: testing.note,
      tone: null,
      progress: barProgress(testing.segments),
    };
  }
  if (merge) {
    return {
      gate: 'merge',
      key: 'merging',
      headline: merge.name,
      facts: [merge.figure].filter(Boolean),
      sub: merge.note,
      tone: merge.tone === 'bad' ? 'bad' : null,
      progress: null,
    };
  }
  return voteFoot(votes);
}

function voteFoot(votes: GateLike): ChangeFoot {
  const facts = (votes.facts || []).map((f) => f.text).filter(Boolean);
  return {
    gate: 'votes',
    key: 'vote',
    headline: votes.figure || votes.name,
    facts,
    sub: votes.note,
    tone: votes.tone === 'bad' ? 'bad' : votes.done ? 'ok' : null,
    progress: null,
  };
}

/**
 * Pure: under a vote's foot, what its tests say when they are not simply
 * passed: failed, or still running. Null when there is nothing to add.
 */
export function alsoTests(foot: ChangeFoot, testing: GateLike): { bad: boolean; figure: string; lines: string[] } | null {
  if (foot.key !== 'vote') return null;
  if (testing.tone !== 'bad' && testing.done) return null;
  return { bad: testing.tone === 'bad', figure: testing.figure || testing.name, lines: testing.note };
}

export interface RequestFoot {
  key: string;
  headline: Phrase;
  sub: Phrase | null;
  tone: FootTone;
  busy: boolean;
}

const BUSY: ReadonlySet<string> = new Set(['reading', 'planning', 'building', 'checking', 'going_live']);

/**
 * Pure: a request's foot, from the standing the server stored and worded
 * (lib/work-state.ts). The line under it is the server's own second line
 * when it sent one, else the plain sentence for that stage.
 */
export function requestFoot(standing: WorkState, yours: boolean): RequestFoot {
  const stage = standing.stage;
  return {
    key: stage,
    headline: stageWords(standing, { yours }),
    sub: lineWords(standing) || stageNote(standing),
    tone: stage === 'stopped' ? 'bad' : stage === 'live' ? 'ok' : stage === 'closed' ? 'muted' : null,
    busy: BUSY.has(stage),
  };
}

/**
 * Pure: the sentence that says what a stage is waiting for or what happens
 * next, for the timeline's last step and the foot, when the server sent no
 * second line of its own. Each id is written whole so the language inventory
 * finds it.
 */
export function stageNote(standing: WorkState): Phrase | null {
  switch (standing.stage) {
    case 'reading': return { id: 'project:topic.rail.note.reading' };
    case 'planning': return { id: 'project:topic.rail.note.planning' };
    case 'waiting_for_you':
      if (standing.why === 'question') return { id: 'project:topic.rail.note.question' };
      if (standing.why === 'plan') return { id: 'project:topic.rail.note.plan' };
      return { id: 'project:topic.rail.note.waiting' };
    case 'building': return { id: 'project:topic.rail.note.building' };
    case 'checking':
      return standing.line?.code === 'shots' ? { id: 'project:topic.rail.note.shots' } : { id: 'project:topic.rail.note.checking' };
    case 'up_for_vote': return { id: 'project:topic.rail.note.vote' };
    case 'going_live': return { id: 'project:topic.rail.note.goingLive' };
    case 'live': return { id: 'project:topic.rail.note.live' };
    case 'stopped': return { id: 'project:topic.rail.note.stopped' };
    case 'closed': return { id: 'project:topic.rail.note.closed' };
    default: return null;
  }
}
