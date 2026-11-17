/**
 * "How it got here": the big events of a request's or a change's thread, in
 * the order they happened, ending in where it stands now. Pure, so tests read
 * it without a DOM; drawn by ./thread-rail.tsx beside the thread's card (and,
 * on a narrow page, between the card and the replies).
 *
 * Only what the page already knows goes in: who asked and when, the newest
 * plan, each change that was built, what its tests said, and the standing
 * the server stored and worded (lib/work-state.ts), which is the last step.
 * A reply, a vote or a preview is conversation, not an event here: the
 * stream under the card keeps those.
 */

import { lineWords, stageWords, type Phrase, type Stage, type WorkState } from '../../../lib/work-state';
import type { RequestSpecCard } from './request-model';
import type { ThreadItem } from './thread-model';

/** Which glyph a step's marker wears. */
export type RailIcon =
  | 'asked' | 'plan' | 'built' | 'tested' | 'failed' | 'vote' | 'approved'
  | 'live' | 'closed' | 'stopped' | 'working' | 'waiting' | 'shots';

/** A step that is not plainly done: something failed, went live, or ended. */
export type RailTone = 'bad' | 'ok' | 'muted';

/** What a step's link opens. The page that draws the rail decides how. */
export type RailOpen =
  | { kind: 'request' }
  | { kind: 'plan'; key: string }
  | { kind: 'checks'; changeId: number }
  | { kind: 'change'; changeId: number };

export interface RailStep {
  key: string;
  icon: RailIcon;
  /** A phrase to translate, or words already said (a change page's pill). */
  title: Phrase | string;
  /** When it happened, for the stamp beside its title. */
  at: string | null;
  /** The now step's stamp reads "since …". */
  since: boolean;
  desc: Phrase | null;
  link: { label: Phrase; open: RailOpen } | null;
  /** The last step: where the thread stands. */
  now: boolean;
  tone: RailTone | null;
  /** Something is at work on it right now. */
  busy: boolean;
  /** The now step's second line. */
  note: Phrase | string | null;
}

const step = (s: Partial<RailStep> & Pick<RailStep, 'key' | 'icon' | 'title'>): RailStep => ({
  at: null, since: false, desc: null, link: null, now: false, tone: null, busy: false, note: null, ...s,
});

/** The newest plan still standing: the highest version, else the last posted. */
export function newestPlan(specs: RequestSpecCard[]): RequestSpecCard | null {
  const live = specs.filter((s) => !s.ended);
  const pool = live.length ? live : specs;
  if (!pool.length) return null;
  return pool.reduce((best, s) => ((s.version ?? 0) >= (best.version ?? 0) ? s : best), pool[0]);
}

const BUSY: ReadonlySet<Stage> = new Set<Stage>(['reading', 'planning', 'building', 'checking', 'going_live']);

const STAGE_ICON: Record<Stage, RailIcon> = {
  reading: 'working',
  planning: 'plan',
  waiting_for_you: 'waiting',
  building: 'working',
  checking: 'working',
  up_for_vote: 'vote',
  going_live: 'approved',
  live: 'live',
  stopped: 'stopped',
  closed: 'closed',
};

/** The stages a change's tests have been passed by, so "Tested" is an event behind it. */
const PAST_TESTS: ReadonlySet<Stage> = new Set<Stage>(['up_for_vote', 'going_live', 'live']);

function planStep(plan: RequestSpecCard): RailStep {
  return step({
    key: `plan:${plan.key}`,
    icon: 'plan',
    title: plan.version != null && plan.version > 1
      ? { id: 'project:topic.rail.plannedVersion', values: { version: plan.version } }
      : { id: 'project:topic.rail.planned' },
    at: plan.at,
    desc: plan.byUnknown || plan.bySystem || !plan.by ? null : { id: 'project:topic.rail.by', values: { name: plan.by } },
    link: { label: { id: 'project:topic.rail.readPlan' }, open: { kind: 'plan', key: plan.key } },
  });
}

/** Where the thread stands, as its last step. */
function nowStep(standing: WorkState, yours: boolean): RailStep {
  const stage = standing.stage;
  const shots = stage === 'checking' && standing.line?.code === 'shots';
  return step({
    key: `now:${stage}`,
    icon: shots ? 'shots' : STAGE_ICON[stage] || 'working',
    title: stageWords(standing, { yours }),
    at: standing.since || null,
    since: stage !== 'live' && stage !== 'closed',
    now: true,
    tone: stage === 'stopped' ? 'bad' : stage === 'live' ? 'ok' : stage === 'closed' ? 'muted' : null,
    busy: BUSY.has(stage),
    note: lineWords(standing),
  });
}

export interface RequestRailInput {
  asker: string | null;
  askedAt: string | null;
  specs: RequestSpecCard[];
  /** The thread's changes, oldest first (thread-model.ts `threadLayout`). */
  changes: ThreadItem[];
  /** The request's standing; null from an older server. */
  standing: WorkState | null;
  /** The viewer asked for it: the standing's words are theirs. */
  yours?: boolean;
  /** The request has words of its own to read (a title alone has none). */
  words?: boolean;
}

/** A request's page: asked, planned, each change built, its tests, then where it stands. */
export function requestRail(input: RequestRailInput): RailStep[] {
  const { asker, askedAt, specs, changes, standing } = input;
  const steps: RailStep[] = [step({
    key: 'asked',
    icon: 'asked',
    title: { id: 'project:topic.rail.asked' },
    at: askedAt,
    desc: asker ? { id: 'project:topic.rail.by', values: { name: asker } } : null,
    link: input.words === false ? null : { label: { id: 'project:topic.rail.readRequest' }, open: { kind: 'request' } },
  })];
  const plan = newestPlan(specs);
  if (plan) steps.push(planStep(plan));
  const many = changes.length > 1;
  const lead = standing?.change || null;
  const stage = standing?.stage || null;
  for (const item of changes) {
    // A change still being built is the now step's to say, not an event yet.
    if (item.state === 'underway' && !item.ready) continue;
    steps.push(step({
      key: `built:${item.id}`,
      icon: 'built',
      title: many && item.number != null
        ? { id: 'project:topic.rail.builtNumbered', values: { number: item.number } }
        : { id: 'project:topic.rail.built' },
      at: item.at || null,
      desc: item.by ? { id: 'project:topic.rail.by', values: { name: item.by } } : null,
      link: many ? { label: { id: 'project:topic.rail.openChange' }, open: { kind: 'change', changeId: item.id } } : null,
    }));
    if (!lead || lead.id !== item.id) continue;
    if (lead.checks.state === 'failing' && (stage === 'checking' || stage === 'stopped')) {
      const failing = Number(lead.checks.failing) > 0 ? Number(lead.checks.failing) : null;
      steps.push(step({
        key: `failed:${item.id}`,
        icon: 'failed',
        tone: 'bad',
        title: failing ? { id: 'project:topic.rail.testsFailed', values: { count: failing } } : { id: 'project:topic.rail.testsFailedPlain' },
        link: { label: { id: 'project:topic.rail.seeFailed' }, open: { kind: 'checks', changeId: item.id } },
      }));
    } else if (lead.checks.state === 'passing' && stage && (PAST_TESTS.has(stage) || (stage === 'checking' && standing?.line?.code === 'shots'))) {
      steps.push(step({ key: `tested:${item.id}`, icon: 'tested', title: { id: 'project:topic.rail.tested' }, desc: { id: 'project:topic.rail.testedAll' } }));
    }
    if (stage === 'going_live' || stage === 'live') {
      const yes = Number(lead.votes?.yes) || 0;
      steps.push(step({
        key: `voted:${item.id}`,
        icon: 'vote',
        title: { id: 'project:topic.rail.voted' },
        desc: yes > 0 ? { id: 'project:topic.rail.yesVotes', values: { count: yes } } : null,
      }));
    }
  }
  if (standing) steps.push(nowStep(standing, input.yours !== false));
  return steps;
}

export interface ChangeRailInput {
  id: number | null;
  author: string | null;
  at: string | null;
  plan: RequestSpecCard | null;
  /** The Testing card: its tone, and whether it is done. */
  testing: { tone: string; done: boolean; figure: string | null } | null;
  /** The pill beside the change's number: where it stands, already in words. */
  status: { key: string; label: string } | null;
  /** The Votes card: its figure ("Needs 2 more yes"), and whether it is asking for votes now. */
  votes: { figure: string | null; done: boolean; asking: boolean } | null;
}

const PILL_TONE: Record<string, RailTone> = { merged: 'ok', live: 'ok', closed: 'muted', archived: 'muted', failed: 'bad' };

/** A change's own page (a change with no request): planned, built, its tests, then its pill. */
export function changeRail(input: ChangeRailInput): RailStep[] {
  const steps: RailStep[] = [];
  if (input.plan) steps.push(planStep(input.plan));
  steps.push(step({
    key: 'built',
    icon: 'built',
    title: { id: 'project:topic.rail.built' },
    at: input.at,
    desc: input.author ? { id: 'project:topic.rail.by', values: { name: input.author } } : null,
  }));
  const testing = input.testing;
  if (testing && testing.tone === 'bad' && input.id != null) {
    steps.push(step({
      key: 'failed',
      icon: 'failed',
      tone: 'bad',
      title: { id: 'project:topic.rail.testsFailedPlain' },
      link: { label: { id: 'project:topic.rail.seeFailed' }, open: { kind: 'checks', changeId: input.id } },
    }));
  } else if (testing && testing.done) {
    steps.push(step({ key: 'tested', icon: 'tested', title: { id: 'project:topic.rail.tested' }, desc: { id: 'project:topic.rail.testedAll' } }));
  }
  if (input.status && input.status.label) {
    const tone = PILL_TONE[input.status.key] || null;
    const settled = tone === 'ok' || tone === 'muted';
    const testingNow = !settled && !!testing && !testing.done && testing.tone !== 'bad';
    // Open for votes, it says so in the standing's own words; anything else
    // is the pill's, which already says where the change is.
    const voting = !settled && !!input.votes && input.votes.asking && !input.votes.done;
    steps.push(step({
      key: `now:${input.status.key}`,
      icon: tone === 'ok' ? 'live' : tone === 'muted' ? 'closed' : testingNow ? 'working' : 'vote',
      title: voting ? { id: 'core:work.stage.upForVote' } : input.status.label,
      now: true,
      tone,
      busy: testingNow,
      note: voting ? input.votes!.figure : null,
    }));
  }
  return steps;
}

/** The steps before the last one, which a narrow page folds into a pile. */
export function earlierSteps(steps: RailStep[]): RailStep[] {
  return steps.filter((s) => !s.now);
}

/** A narrow page folds the earlier steps once there are two or more of them. */
export function railFolds(steps: RailStep[]): boolean {
  return earlierSteps(steps).length > 1;
}
