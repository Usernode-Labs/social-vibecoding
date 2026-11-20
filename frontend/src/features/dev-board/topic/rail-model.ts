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

import { lineWords, stageWords, type Phrase, type Stage, type Standing, type WorkState } from '../../../lib/work-state';
import { lookOf, stagePhrase } from '../../../lib/work-stages';
import type { RequestSpecCard } from './request-model';
import { changePhase, fixStanding, stageNote, SETTLED_PHASES, type ChangePhase, type GateLike } from './card-model';
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
  | { kind: 'votes'; changeId: number }
  | { kind: 'track' }
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
  /**
   * What a press on the step opens over the card, when it has no link of its
   * own to say so: the last step's votes, its tests, the bot's progress.
   */
  open: RailOpen | null;
  /** The last step: where the thread stands. */
  now: boolean;
  tone: RailTone | null;
  /** Something is at work on it right now. */
  busy: boolean;
  /** The now step's second line. */
  note: Phrase | string | null;
  /**
   * How the note is tinted: `act` when somebody has to do something (vote,
   * answer, press Build it), `bad` for a stop, `plain` for a wait that needs
   * nobody. The prototype's three tones; every note used to be the same wash.
   */
  noteTone: 'act' | 'plain' | 'bad';
}

const step = (s: Partial<RailStep> & Pick<RailStep, 'key' | 'icon' | 'title'>): RailStep => ({
  at: null, since: false, desc: null, link: null, open: null, now: false, tone: null, busy: false, note: null, noteTone: 'plain', ...s,
});

/** The newest plan still standing: the highest version, else the last posted. */
export function newestPlan(specs: RequestSpecCard[]): RequestSpecCard | null {
  const live = specs.filter((s) => !s.ended);
  const pool = live.length ? live : specs;
  if (!pool.length) return null;
  return pool.reduce((best, s) => ((s.version ?? 0) >= (best.version ?? 0) ? s : best), pool[0]);
}

/**
 * The icon of the timeline's last step, by its stage: one for every stage of
 * the table (lib/work-stages.ts), so a new stage is drawn on purpose. Whether
 * the step spins, how it is tinted and whether its note asks somebody are
 * the stage's look (STAGE_LOOK), which the foot (./card-model.ts) reads too.
 */
export const STAGE_ICON: Readonly<Record<Stage, RailIcon>> = {
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

/**
 * Where the thread stands, as its last step. Its title is short (the foot
 * carries the server's whole headline; a stop's reason is the note), and a
 * ballot between competing changes names itself as the foot does.
 */
function nowStep(standing: WorkState, yours: boolean, track = false, ballot: RequestRailInput['ballot'] = null): RailStep {
  const stage = standing.stage;
  const lead = standing.change || null;
  const shots = stage === 'checking' && standing.line?.code === 'shots';
  const choosing = !!ballot && stage === 'up_for_vote';
  const look = lookOf(stage);
  return step({
    key: `now:${stage}`,
    icon: shots ? 'shots' : STAGE_ICON[stage] || 'working',
    title: choosing ? { id: 'project:topic.card.ballot.choosing', values: { count: ballot!.count } }
      : stage === 'stopped' ? { id: stagePhrase('stopped') } : stageWords(standing, { yours }),
    at: standing.since || null,
    since: stage !== 'live' && stage !== 'closed',
    now: true,
    tone: look.tone,
    busy: look.busy,
    // The rule of a ballot; else the server's own second line, else the
    // plain sentence for the stage.
    note: choosing ? ballot!.about : lineWords(standing) || stageNote(standing),
    noteTone: stage === 'stopped' ? 'bad' : look.asks ? 'act' : 'plain',
    open: lead && (stage === 'up_for_vote' || stage === 'going_live' || stage === 'live')
      ? { kind: 'votes', changeId: lead.id }
      : lead && stage === 'checking'
        ? { kind: 'checks', changeId: lead.id }
        : track && !lead ? { kind: 'track' } : null,
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
  /** Homeroom bot's progress on it is known, so the last step can open it. */
  track?: boolean;
  /** The letter each competing change has on the ballot (A, B, C), by its id: its step is named by it. */
  letters?: ReadonlyMap<number, string> | null;
  /** An open ballot between competing changes: how many, and its rule in a sentence (the last step's title and note). */
  ballot?: { count: number; about: Phrase | string } | null;
  /**
   * The request's one change, when the card's foot is drawn in that change's
   * section: its events (built, its tests, its votes) and what a press opens
   * come from `changeRail`. The last step is still the REQUEST's: worded
   * from `standing`, the request's own stored row, as the foot is
   * (./thread-changes.tsx hands the same row to the change's foot). The
   * change's row (`lead.work`) words it only when the request's row is not
   * about this change, or there is none (`leadRow`).
   */
  lead?: ChangeRailInput | null;
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
  if (input.lead) {
    // The page is the request's, so where it stands is the request's row.
    // It used to be the change's: a request whose row said "Stopped: its
    // tests still fail" (the bot gave up fixing them) ended its own page on
    // a busy "Checking", the change's row, while the Homeroom bot tab and
    // the bell said Stopped. The two rows differ on purpose: the request's
    // says what is being done about it, the change's where the change is.
    const row = leadRow(standing, input.lead.work || null, input.lead.id);
    steps.push(...changeRail({ ...input.lead, plan: null, work: row, yours: row === standing ? input.yours !== false : true }));
    return steps;
  }
  const lead = standing?.change || null;
  const stage = standing?.stage || null;
  for (const item of changes) {
    // A change still being built is the now step's to say, not an event yet.
    if (item.state === 'underway' && !item.ready) continue;
    const letter = input.letters?.get(item.id) || null;
    steps.push(step({
      key: `built:${item.id}`,
      icon: 'built',
      title: letter
        ? { id: 'project:topic.rail.builtLettered', values: { letter } }
        : many && item.number != null
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
    } else if (lead.checks.state === 'passing' && stage && (lookOf(stage).pastTests || (stage === 'checking' && standing?.line?.code === 'shots'))) {
      steps.push(step({
        key: `tested:${item.id}`,
        icon: 'tested',
        title: { id: 'project:topic.rail.tested' },
        desc: { id: 'project:topic.rail.testedAll' },
        link: { label: { id: 'project:topic.rail.seeChecks' }, open: { kind: 'checks', changeId: item.id } },
      }));
    }
    if (stage === 'going_live' || stage === 'live') {
      const yes = Number(lead.votes?.yes) || 0;
      steps.push(step({
        key: `voted:${item.id}`,
        icon: 'vote',
        title: { id: 'project:topic.rail.voted' },
        desc: yes > 0 ? { id: 'project:topic.rail.yesVotes', values: { count: yes } } : null,
        open: { kind: 'votes', changeId: item.id },
      }));
    }
  }
  if (standing) steps.push(nowStep(standing, input.yours !== false, !!input.track, input.ballot || null));
  return steps;
}

/**
 * Pure: the row that words a request's page with one change (`id`): the
 * request's own stored row while it is about that change (its `change`),
 * else the change's own. A request's row that names another change (one the
 * page no longer draws), or none at all (an older server, a row stored
 * before the change was), says nothing about this one: wording this
 * change's foot from it would put "Not started yet" over a change up for a
 * vote.
 *
 * One case reads the change's row past the request's: the request says only
 * that its change is up for a vote. Whether that vote is open yet is the
 * change's row's to say (its screenshots, a sync with main, an update on its
 * way), and the two rows reach the page by different reads, so for a moment
 * the request's can still say "Up for a vote" after the change's has moved
 * on.
 */
export function leadRow<T extends WorkState>(request: T | null, change: T | null, id: number | null = null): T | null {
  const about = !!request && !!request.change && (id == null || Number(request.change.id) === Number(id));
  if (!request || !about) return change;
  return request.stage === 'up_for_vote' && change ? change : request;
}

export interface ChangeRailInput {
  id: number | null;
  author: string | null;
  at: string | null;
  plan: RequestSpecCard | null;
  /** The pill beside the change's number: where it stands, already in words. */
  status: { key: string; label: string; yes?: number; majority?: number } | null;
  /** The Votes, Testing and merge cards, as the foot reads them (./card-model.ts). */
  votes: GateLike | null;
  testing: GateLike | null;
  merge?: GateLike | null;
  /** Who has to fix failed tests, in the card's own words. */
  fixNote?: string | null;
  /** When it went live. */
  liveAt?: string | null;
  /**
   * The change's stored work state (its own `work_states` row, the proposal
   * read's `work`), the one every list and the card's foot read
   * (./card-model.ts storedFoot). While it is not up for a vote, its words
   * title the last step, so the timeline never says "Up for a vote" while
   * the foot says "Taking screenshots". On a request's page with one change
   * `requestRail` passes the request's row here instead.
   */
  work?: Standing | null;
  /** The viewer is the row's requester: its words are theirs (a request's row only; a change's row reads the same to everyone). */
  yours?: boolean;
}

/** The pills that only count votes: the step says "Up for a vote", and the foot has the count. */
const VOTE_PILL: ReadonlySet<string> = new Set(['needs_vote', 'approvals', 'needs_member']);

const sentence = (parts: (string | null | undefined)[]): string => parts
  .map((p) => String(p || '').trim()).filter(Boolean)
  .map((p) => (/[.!?…]$/.test(p) ? p : `${p}.`))
  .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  .join(' ');

/**
 * A change's own page (a change with no request): planned, built, its tests,
 * then where it stands. The last step is the change's phase, the same one
 * its foot reads (`changePhase`), so the two cannot disagree: failed tests
 * end on what the failure waits for, an approved change on Approved or Going
 * live, and tests still running on Testing.
 */
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
  const { id, testing, votes, status } = input;
  const checks: RailOpen | null = id != null ? { kind: 'checks', changeId: id } : null;
  const ballot: RailOpen | null = id != null ? { kind: 'votes', changeId: id } : null;
  if (!testing || !votes || !status || !status.label) {
    // Still being built, or closed: nothing stands after Built.
    if (testing && testing.tone === 'bad' && checks) {
      steps.push(step({ key: 'failed', icon: 'failed', tone: 'bad', title: { id: 'project:topic.rail.testsFailedPlain' }, link: { label: { id: 'project:topic.rail.seeFailed' }, open: checks } }));
    } else if (testing && testing.done) {
      steps.push(step({ key: 'tested', icon: 'tested', title: { id: 'project:topic.rail.tested' }, desc: { id: 'project:topic.rail.testedAll' }, link: checks ? { label: { id: 'project:topic.rail.seeChecks' }, open: checks } : null }));
    }
    return steps;
  }
  const phase = changePhase({ status, votes, testing, merge: input.merge || null });
  const tested = () => steps.push(step({
    key: 'tested',
    icon: 'tested',
    title: { id: 'project:topic.rail.tested' },
    desc: { id: 'project:topic.rail.testedAll' },
    link: checks ? { label: { id: 'project:topic.rail.seeChecks' }, open: checks } : null,
  }));
  const voted = () => {
    const yes = Number(status.yes) || 0;
    steps.push(step({
      key: 'voted',
      icon: 'vote',
      title: { id: 'project:topic.rail.voted' },
      desc: yes > 0 ? { id: 'project:topic.rail.yesVotes', values: { count: yes } } : null,
      open: ballot,
    }));
  };
  const now = (s: Partial<RailStep> & Pick<RailStep, 'icon' | 'title'>) => steps.push(step({ key: `now:${phase}`, now: true, ...s }));
  switch (phase) {
    case 'live':
      if (testing.done && testing.tone !== 'bad') tested();
      voted();
      // Its date and one plain line: nothing is waited for, so no note box.
      now({ icon: 'live', title: { id: 'core:work.stage.live' }, tone: 'ok', at: input.liveAt || null, desc: { id: 'project:topic.rail.note.live' }, open: ballot });
      break;
    case 'closed':
      now({ icon: 'closed', title: status.label, tone: 'muted', note: { id: 'project:topic.rail.note.closed' }, open: ballot });
      break;
    case 'going':
      if (testing.done && testing.tone !== 'bad') tested();
      voted();
      now({
        icon: 'working', title: { id: 'core:work.stage.goingLive' }, busy: true,
        note: input.merge && input.merge.note.length ? sentence(input.merge.note) : { id: 'project:topic.rail.note.goingLive' },
        open: ballot,
      });
      break;
    case 'stuck':
      if (testing.done && testing.tone !== 'bad') tested();
      now({
        icon: 'stopped', tone: 'bad', title: input.merge && input.merge.tone === 'bad' ? input.merge.name : status.label,
        note: sentence(input.merge && input.merge.tone === 'bad' ? [input.merge.figure, ...input.merge.note] : votes.note) || null,
        noteTone: 'bad', open: ballot,
      });
      break;
    case 'failed': {
      steps.push(step({
        key: 'failed',
        icon: 'failed',
        tone: 'bad',
        title: { id: 'project:topic.rail.testsFailedPlain' },
        link: checks ? { label: { id: 'project:topic.rail.seeFailed' }, open: checks } : null,
      }));
      const fix = fixStanding(testing);
      if (fix === 'fixing') {
        now({ icon: 'working', busy: true, title: { id: 'project:topic.rail.fixing' }, note: input.fixNote || { id: 'project:topic.rail.note.fixing' }, open: checks });
      } else if (fix === 'stopped') {
        now({ icon: 'stopped', tone: 'bad', title: { id: 'core:work.stage.stopped' }, note: input.fixNote || { id: 'project:topic.rail.note.stoppedTests' }, noteTone: 'bad', open: checks });
      } else {
        now({ icon: 'waiting', title: { id: 'project:topic.rail.waitingFix' }, note: input.fixNote || { id: 'project:topic.rail.note.waitingFix' }, noteTone: 'act', open: checks });
      }
      break;
    }
    case 'testing':
      now({
        icon: 'working', busy: true, title: { id: 'project:topic.rail.testing' },
        note: sentence([testing.figure, ...testing.note]) || { id: 'project:topic.rail.note.checking' },
        open: checks,
      });
      break;
    case 'approved':
      tested();
      now({
        icon: 'approved', title: { id: 'core:work.stage.approved' },
        // Who said yes is the foot's line; here, what happens next.
        note: input.merge ? sentence([input.merge.figure, ...input.merge.note]) : { id: 'project:topic.rail.note.approved' },
        open: ballot,
      });
      break;
    default: {
      tested();
      const asking = votes.tone === 'ask';
      now({
        icon: 'vote',
        title: asking || VOTE_PILL.has(status.key) ? { id: 'core:work.stage.upForVote' } : status.label,
        // The figure is the foot's headline: here it leads who can give the
        // yes, when the card says so; else the plain sentence.
        note: votes.note.length ? sentence([votes.figure, votes.note[0]]) : { id: 'project:topic.rail.note.vote' },
        noteTone: 'act',
        open: ballot,
      });
    }
  }
  return withStoredNow(steps, input.work || null, phase, input.merge || null, input.yours !== false);
}

/**
 * T2.3 (19 Nov 2026): the last step worded from the stored work state, as
 * the foot is (./card-model.ts storedFoot), whenever that row is not up for
 * a vote. The live gates still decide which events stand behind it (Tested,
 * Tests failed, Voted) and what a press opens; the row decides what it is
 * waiting on now. Its checks passed and only the screenshots are left reads
 * "Taking screenshots"; a sync with main, an update on its way, GitHub's
 * hold or a check being fixed say so too, never "Up for a vote". Only while
 * the change is open: once it is live, closed or merging, the phase's own
 * step stands (its date, its pill; SETTLED_PHASES, which the foot shares).
 *
 * The row is the change's own on a change's page, and the request's on a
 * request's page with one change (`requestRail`). A change's own row is
 * never Stopped (services/work-state.js deriveChange has no such state), so
 * the stopped wording below is the request's: the bot stopped fixing its
 * change's tests, and the step keeps the card's own words for who fixes them
 * now.
 */
function withStoredNow(steps: RailStep[], work: Standing | null, phase: ChangePhase, merge: GateLike | null = null, yours = true): RailStep[] {
  if (!work || !work.stage || work.stage === 'up_for_vote') return steps;
  // Merged, merging, a stalled release or closed: the change's own status
  // is newer than any row, and its step already says so.
  if (SETTLED_PHASES.has(phase)) return steps;
  const at = steps.findIndex((s) => s.now);
  if (at < 0) return steps;
  const stage = work.stage;
  const shots = stage === 'checking' && work.line?.code === 'shots';
  // Approved, and GitHub holds its merge (the Merging card): the row titles
  // the step, and its note stays the card's own account ("GitHub is now
  // building and scanning the release images, which usually takes about 6
  // minutes"), which says more than the row's line and is the only place
  // the card look shows it while the step layer is shut.
  const held = stage === 'going_live' && phase === 'approved' && !!merge && merge.note.length > 0 && !!steps[at].note;
  const look = lookOf(stage);
  steps[at] = {
    ...steps[at],
    icon: shots ? 'shots' : STAGE_ICON[stage] || 'working',
    title: stage === 'stopped' ? { id: stagePhrase('stopped') } : stageWords(work, { yours }),
    tone: look.tone,
    busy: look.busy,
    // The row's second line; a stop of the bot's fixes keeps the card's own
    // words for who fixes it now, which the row has no line for.
    note: held ? steps[at].note
      : lineWords(work) || (stage === 'stopped' && phase === 'failed' ? steps[at].note : null) || stageNote(work),
    noteTone: stage === 'stopped' ? 'bad' : look.asks ? 'act' : 'plain',
  };
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

/** What a press on a step opens: its link's, else its own. */
export function stepOpens(s: RailStep): RailOpen | null {
  return s.link ? s.link.open : s.open;
}
