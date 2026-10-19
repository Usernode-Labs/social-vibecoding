import { useState, type ReactNode } from 'react';

import {
  ArrowPathIcon, ChatIcon, CheckIcon, ChevronDownIcon, ClockIcon, EllipsisHorizontalIcon, EyeIcon, InfoCircleIcon,
  KeyIcon, ListLinesIcon, NoSymbolIcon, PencilSquareIcon, PlayIcon, SpinnerArcIcon, UserIcon, WarningTriangleIcon, XIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useResolvedCommunityColor } from '../../lib/community-color';
import * as api from './api';
import { noteApprovedHere, useApprovedHere } from './bot-activity-store';
import { tryChange } from './bot-ready';
import { requestHue, requestKey, storyRootIn } from './bot-request';
import { ENDED_STATES, trackEnding, trackLine, trackShort, trackStateWord } from './bot-track';
import { loadBotWork, useBotWork } from './bot-work';
import { loadedMessages, openThreadAt } from './store';
import type { BotTrack, HomeroomBotCurrentJob, HomeroomBotJob, HomeroomBotPastJob, HomeroomBotWork } from './types';

/*
 * The activity drawer in the chat with Homeroom bot (one request, one story).
 *
 * The chat itself draws each request as one row (./bot-news-line.tsx), and
 * each request's story is its thread. What is true NOW, across every request,
 * is here: what needs the person, what is ready to try, what is in progress,
 * and what went live today, read from the same endpoint and store the
 * activity tray used (./bot-work.tsx: GET /api/conversations/homeroom-bot/
 * work, read again on the bot's news and on `homeroom_bot_work_changed`). It
 * changes in place; nothing about it is posted to the chat.
 *
 *   - An ACTIVITY BAR under the header: "1 needs you #18 · 2 ready to try ·
 *     2 in progress · 1 done today", zero parts left out, with the numbers of
 *     what needs them in their own colours (./bot-request.ts). Pressing it
 *     opens the drawer OVER the chat, which keeps its place underneath,
 *     dimmed; the bar or the dimmed chat closes it. It starts closed; the
 *     person's choice is remembered on the device.
 *   - NEEDS YOU, a row each with ONE button that says what to do there (a
 *     change whose yes is theirs keeps the ready row's Try it and Approve).
 *   - READY TO TRY, with Try it and, when their yes would count, Approve: the
 *     ready card's own two acts (./bot-ready.tsx).
 *   - IN PROGRESS, a row each, saying what it is doing, a limit's hold among
 *     it.
 *   - DONE TODAY, folded to its heading and count until pressed: a line
 *     each, with a small tile and how it ended, like the chat's settled rows.
 *
 * Every row opens its request's story, as the chat's row does: the pane
 * beside the chat, at the message waiting on them (the entry's `ask`,
 * flashed: store.openThreadAt). A request from before threads opens on its
 * oldest piece (./bot-request.ts storyRootIn). Opening one closes the drawer.
 *
 * Each request appears once, in the first group that fits, with its number
 * in its own colour. No step numbers and no timings: the thread says those.
 *
 * OWNERSHIP. Every node here is React's, inside the thread pane React owns.
 * Nothing is drawn until the first read lands, so a first render matches.
 */

export type StripGroup = 'needs' | 'ready' | 'progress' | 'done';

/** One request's row in the strip, from its tray entry. */
export interface StripRow {
  key: string;
  group: StripGroup;
  job: HomeroomBotJob;
  /** What the row says under the title. */
  state: string;
  /**
   * What its one button says (Needs you), as a message id, or null for a row
   * that is itself the button.
   */
  action: string | null;
  /** The thread and the message the row opens. */
  rootId: number | null;
  focusId: number | null;
  /** 16 Oct 2026: its request's track, when the server sent tracks (./bot-track.tsx). */
  track?: BotTrack;
}

export interface StripModel {
  needs: StripRow[];
  ready: StripRow[];
  progress: StripRow[];
  done: StripRow[];
}

/** The most numbers of what needs them the bar names. */
export const NEEDS_LIMIT = 3;

/**
 * Pure: midnight of `now`'s local day, where "today" starts. #5392: what
 * "Finished today" counts is what ended since then, on the viewer's own
 * device, which is also where the chat starts its "Today" divider.
 */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** The endings of History that wait on the person while a message of theirs still asks. */
const NEEDS_OUTCOMES = new Set(['question', 'person', 'blocked', 'empty', 'build_failed', 'needs_look', 'failed', 'stopped']);
const READY_OUTCOMES = new Set(['proposed', 'checking']);
const DONE_OUTCOMES = new Set(['live', 'going_live', 'closed']);

/** What a Needs you row says, by what waits on them. */
const NEEDS_STATES: Record<string, string> = {
  question: 'messages:bot.strip.state.needsAnswer',
  followup_ask: 'messages:bot.strip.state.needsAnswer',
  plan: 'messages:bot.strip.state.planReady',
  person: 'messages:bot.strip.state.needsDecision',
  build_failed: 'messages:bot.strip.state.stopped',
  first_version_failed: 'messages:bot.strip.state.stopped',
  blocked: 'messages:bot.strip.state.blocked',
  empty: 'messages:bot.strip.state.empty',
  checks: 'messages:bot.strip.state.needsLook',
  needs_look: 'messages:bot.strip.state.needsLook',
  failed: 'messages:bot.strip.state.stopped',
  stopped: 'messages:bot.strip.state.stopped',
  on_hold: 'messages:bot.strip.state.onHold',
  secrets: 'messages:bot.strip.state.secrets',
};

/** Its one button, by the same. */
const NEEDS_ACTIONS: Record<string, string> = {
  question: 'messages:bot.strip.action.answer',
  followup_ask: 'messages:bot.strip.action.answer',
  plan: 'messages:bot.strip.action.buildIt',
  person: 'messages:bot.strip.action.decide',
  build_failed: 'messages:bot.strip.action.tryAgain',
  first_version_failed: 'messages:bot.strip.action.tryAgain',
  blocked: 'messages:bot.strip.action.addDetail',
  empty: 'messages:bot.strip.action.addDetail',
};

/** What In progress says a request is doing, by its progress stage, else its phase. */
const STAGE_WORDS: Record<string, string> = {
  reading: 'messages:bot.strip.doing.reading',
  planning: 'messages:bot.strip.doing.planning',
  starting: 'messages:bot.strip.doing.building',
  building: 'messages:bot.strip.doing.building',
  reviewing: 'messages:bot.strip.doing.building',
  proposing: 'messages:bot.strip.doing.building',
  checks: 'messages:bot.strip.doing.testing',
  testing: 'messages:bot.strip.doing.testing',
  queued: 'messages:bot.strip.doing.queued',
  build_queued: 'messages:bot.strip.doing.queued',
  followup_queued: 'messages:bot.strip.doing.followingUp',
  fix_queued: 'messages:bot.strip.doing.followingUp',
  revising: 'messages:bot.strip.doing.followingUp',
  fixing: 'messages:bot.strip.doing.followingUp',
  merging: 'messages:bot.strip.doing.goingLive',
  setting_up: 'messages:bot.strip.doing.settingUp',
};
const PHASE_WORDS: Record<string, string> = {
  looking: 'messages:bot.strip.doing.reading',
  building: 'messages:bot.strip.doing.building',
  queued: 'messages:bot.strip.doing.queued',
  follow_up_queued: 'messages:bot.strip.doing.followingUp',
  following_up: 'messages:bot.strip.doing.followingUp',
  merging: 'messages:bot.strip.doing.goingLive',
  setting_up: 'messages:bot.strip.doing.settingUp',
};

/** "Dark mode", "Plant Pal, first version", "Request #12": a row's title, with no project prefix. */
export function stripTitle(job: Pick<HomeroomBotJob, 'appName' | 'appUnnamed' | 'issueNumber' | 'title' | 'firstVersion'>): string {
  // A project nobody can name is not named by its stand-in: its own wording.
  if (job.firstVersion) return job.appUnnamed ? translate('messages:bot.job.firstVersionUnnamed') : translate('messages:bot.strip.firstVersion', { project: job.appName });
  if (job.title) return job.title;
  return job.issueNumber ? translate('messages:bot.strip.requestNumber', { number: String(job.issueNumber) }) : job.appName;
}

/** What an In progress request is doing, in a word or two ("building"). */
export function doingWord(job: HomeroomBotCurrentJob): string {
  const key = (job.stage && STAGE_WORDS[job.stage]) || PHASE_WORDS[job.phase] || 'messages:bot.strip.doing.building';
  return translate(key);
}

/** Which Needs you case an entry is: what waits on them, from its ask, its stage or its ending. */
function needsCase(job: HomeroomBotJob & { outcome?: string | null; stage?: string | null }): string {
  if (job.stage === 'on_hold') return 'on_hold';
  if (job.ask?.kind) return job.ask.kind;
  if (job.outcome) return job.outcome;
  return 'secrets';
}

/** Pure: a Needs you row's words, and its one button. */
export function needsRow(job: HomeroomBotJob & { outcome?: string | null; stage?: string | null }): { state: string; action: string } {
  const which = needsCase(job);
  let state: string;
  if ((which === 'question' || which === 'followup_ask') && job.ask?.question) state = job.ask.question;
  else if ((which === 'build_failed' || which === 'first_version_failed') && job.stopCause === 'time') state = translate('messages:bot.strip.state.stoppedTime');
  else state = translate(NEEDS_STATES[which] || 'messages:bot.strip.state.needsYou');
  return { state, action: NEEDS_ACTIONS[which] || 'messages:bot.strip.action.open' };
}

/** Pure: a Ready to try row's words. */
export function readyState(job: HomeroomBotJob & { outcome?: string | null }): string {
  if (job.outcome === 'checking') return translate('messages:bot.strip.state.testing');
  if (job.ready?.approve) return translate('messages:bot.strip.state.readyForYes');
  if (job.ready?.waiting) return translate('messages:bot.strip.state.waitingFor', { who: job.ready.waiting });
  return translate('messages:bot.strip.state.waitingApproval');
}

function stripRow(job: HomeroomBotJob, group: StripGroup, state: string, action: string | null, focusId: number | null): StripRow {
  return { key: job.key, group, job, state, action, rootId: job.cardId || null, focusId };
}

/**
 * Pure: the strip's four groups from one read of the tray, in order, each
 * request once (the first group that fits). Needs you: what waits on them
 * (the tray's Needs you, an ending of History whose message still asks, and
 * work on hold until Monday); Ready to try: a change up for their yes or
 * being checked; In progress: the rest of Now; Done: what ended today,
 * since midnight (#5392), each row saying how.
 */
export function stripGroups(work: HomeroomBotWork | null, now: Date = new Date()): StripModel {
  const model: StripModel = { needs: [], ready: [], progress: [], done: [] };
  if (!work) return model;
  if (Array.isArray(work.tracks)) return trackGroups(work, work.tracks, now);
  const placed = new Set<string>();
  const place = (row: StripRow) => {
    if (placed.has(row.key)) return;
    placed.add(row.key);
    model[row.group].push(row);
  };
  const askOf = (job: HomeroomBotJob) => job.ask?.messageId || null;
  const needs = (job: HomeroomBotJob & { outcome?: string | null; stage?: string | null }) => {
    const { state, action } = needsRow(job);
    place(stripRow(job, 'needs', state, action, askOf(job)));
  };
  const past = [...work.needsYou, ...work.history];
  for (const job of work.needsYou) {
    if (job.outcome && READY_OUTCOMES.has(job.outcome)) continue;
    needs(job);
  }
  for (const job of work.history) {
    if (job.outcome && NEEDS_OUTCOMES.has(job.outcome) && job.ask) needs(job);
  }
  for (const job of work.now) if (job.stage === 'on_hold') needs(job);
  for (const job of past) {
    if (job.outcome && READY_OUTCOMES.has(job.outcome)) {
      place(stripRow(job, 'ready', readyState(job), null, job.ready?.messageId || null));
    }
  }
  for (const job of work.now) place(stripRow(job, 'progress', doingWord(job), null, null));
  for (const job of work.history) {
    const at = job.at ? Date.parse(job.at) : NaN;
    if (!job.outcome || !DONE_OUTCOMES.has(job.outcome) || !Number.isFinite(at) || at < startOfDay(now).getTime()) continue;
    // No tracks here: the ending words are the state line's own two (Closed, else Live), as before #5392.
    const said = job.outcome === 'closed' ? 'messages:bot.strip.state.closed' : 'messages:bot.strip.state.live';
    place(stripRow(job, 'done', translate(said), null, null));
  }
  return model;
}

// 16 Oct 2026: a waiting track's one button, and the glyph of what to do,
// by why it waits (services/homeroom-bot-track.js).
const TRACK_ACTIONS: Record<string, string> = {
  question: 'messages:bot.strip.action.answer',
  plan: 'messages:bot.strip.action.buildIt',
  detail: 'messages:bot.strip.action.addDetail',
};
const TRACK_NEED_CASES: Record<string, string> = { question: 'question', plan: 'plan', detail: 'blocked', look: 'needs_look' };

/** The tray's entry for a track's request, or one made of the track itself. */
function jobOfTrack(track: BotTrack, jobs: Map<string, HomeroomBotJob>): HomeroomBotJob {
  const job = jobs.get(track.key);
  if (job) return job;
  return {
    key: track.key, appSlug: track.appSlug, appName: track.appName, ...(track.appUnnamed ? { appUnnamed: true } : {}),
    iconUrl: track.iconUrl, iconEmoji: track.iconEmoji, issueNumber: track.issueNumber, title: track.title,
    firstVersion: track.firstVersion, href: track.links.proposal || track.links.request || track.links.project,
    links: track.links, earlier: [],
  };
}

/**
 * Pure (17 Oct 2026): the strip's groups from the requests' tracks, one
 * place each (services/homeroom-bot-track.js decides the state, once), and
 * this is the ONE place it is decided: the row, the bar, the drawer and the
 * chat's news rows all read it. Needs you is what waits on the person: a
 * question, a plan for Build it, more detail, a look, and a change whose
 * yes is theirs (drawn with its Try it and Approve). Ready to try is a
 * change up for a vote where it is the group's turn, not theirs. Work under
 * way, In progress, a limit's hold among it ("On hold · …") and a change
 * going live: none of it has ended. What ended today, since midnight, is
 * Finished today, each row saying how it ended in words.
 */
function trackGroups(work: HomeroomBotWork, tracks: BotTrack[], now: Date): StripModel {
  const model: StripModel = { needs: [], ready: [], progress: [], done: [] };
  const jobs = new Map<string, HomeroomBotJob>([...work.now, ...work.needsYou, ...work.history].map((job) => [job.key, job]));
  const seen = new Set<string>();
  for (const track of tracks) {
    if (seen.has(track.key)) continue;
    seen.add(track.key);
    const job = jobOfTrack(track, jobs);
    const row = (group: StripGroup, state: string, action: string | null, focusId: number | null): StripRow => ({
      key: track.key, group, job, state, action, rootId: track.rootId || job.cardId || null, focusId, track,
    });
    if (track.state === 'waiting') {
      const words = track.why === 'question' && job.ask?.question ? job.ask.question : trackLine(track);
      model.needs.push(row('needs', words, TRACK_ACTIONS[track.why || ''] || 'messages:bot.strip.action.open', track.askId || job.ask?.messageId || null));
    } else if (track.state === 'vote') {
      const words = readyState({ ...job, outcome: 'proposed' });
      if (job.ready?.approve) model.needs.push(row('needs', words, null, job.ready?.messageId || null));
      else model.ready.push(row('ready', words, null, job.ready?.messageId || null));
    } else if (track.state === 'held') {
      // A hold is still work under way, never finished: what it waits for
      // says it. Allowance's line already opens with "On hold"; elsewhere
      // the state's word leads.
      const words = track.held?.limit === 'allowance' ? trackLine(track) : [trackStateWord(track), trackShort(track)].join(' · ');
      model.progress.push(row('progress', words, null, null));
    } else if (track.state === 'going_live') {
      model.progress.push(row('progress', trackLine(track), null, null));
    } else if (ENDED_STATES.has(track.state)) {
      const at = Date.parse(track.since || '');
      if (!Number.isFinite(at) || at < startOfDay(now).getTime()) continue;
      model.done.push(row('done', endedWords(trackEnding(track), track, trackLine(track)), null, null));
    } else {
      model.progress.push(row('progress', trackLine(track), null, null));
    }
  }
  return model;
}

/**
 * Each request in the tray by its key (./bot-request.ts), with the group it
 * is in and what its row says: where it stands NOW, for the chat's news rows.
 * Read once per tray read.
 */
const NOW_CACHE = new WeakMap<HomeroomBotWork, Map<string, StripRow>>();
export function trayNow(work: HomeroomBotWork | null): Map<string, StripRow> | null {
  if (!work) return null;
  const cached = NOW_CACHE.get(work);
  if (cached) return cached;
  const model = stripGroups(work);
  const map = new Map<string, StripRow>();
  for (const row of [...model.needs, ...model.ready, ...model.progress, ...model.done]) {
    const key = requestKey(row.job);
    if (key && !map.has(key)) map.set(key, row);
  }
  NOW_CACHE.set(work, map);
  return map;
}

/**
 * Each request in the tray's History by its key, with how it ended (its
 * ending in the activity cards' words: homeroom-bot-activity.js OUTCOMES),
 * at any age: what the chat's settled rows say. Read once per tray read.
 */
const ENDED_CACHE = new WeakMap<HomeroomBotWork, Map<string, string>>();
export function trayEnded(work: HomeroomBotWork | null): Map<string, string> | null {
  if (!work) return null;
  const cached = ENDED_CACHE.get(work);
  if (cached) return cached;
  const map = new Map<string, string>();
  // 16 Oct 2026: how each request ended, from its track, when there are tracks.
  for (const track of work.tracks || []) {
    const key = requestKey(track);
    const ending = trackEnding(track);
    if (key && ending && !map.has(key)) map.set(key, ending);
  }
  for (const job of work.tracks ? [] : work.history) {
    const key = requestKey(job);
    if (key && job.outcome && !map.has(key)) map.set(key, job.outcome);
  }
  ENDED_CACHE.set(work, map);
  return map;
}

/** Pure: the summary bar's parts, zero ones left out ("1 needs you", "2 ready to try"…). */
export function summaryParts(model: StripModel): Array<{ group: StripGroup; text: string }> {
  const parts: Array<{ group: StripGroup; text: string }> = [];
  if (model.needs.length) parts.push({ group: 'needs', text: translate('messages:bot.strip.summary.needs', { count: model.needs.length }) });
  if (model.ready.length) parts.push({ group: 'ready', text: translate('messages:bot.strip.summary.ready', { count: model.ready.length }) });
  if (model.progress.length) parts.push({ group: 'progress', text: translate('messages:bot.strip.summary.progress', { count: model.progress.length }) });
  if (model.done.length) parts.push({ group: 'done', text: translate('messages:bot.strip.summary.done', { count: model.done.length }) });
  return parts;
}

// ── The drawer, open or closed, remembered per device ──

const HIDDEN_KEY = 'homeroom:botDrawer:open';

export function rememberedOpen(): boolean | null {
  try {
    const value = window.localStorage.getItem(HIDDEN_KEY);
    return value === '1' ? true : value === '0' ? false : null;
  } catch {
    return null;
  }
}

function rememberOpen(open: boolean): void {
  try { window.localStorage.setItem(HIDDEN_KEY, open ? '1' : '0'); } catch { /* a private window: this visit only */ }
}

// ── The view ──

/**
 * A project's tile: its icon image, else its emoji, else its initial on the
 * project's colour (../../lib/community-color.ts). `size` is the strip's
 * row (36px) or a news line's (22px). Decorative: the words beside it name
 * the project.
 */
export function ProjectTile({ name, slug = null, iconUrl = null, emoji = null, size = 'row' }: {
  name: string; slug?: string | null; iconUrl?: string | null; emoji?: string | null; size?: 'row' | 'line';
}) {
  const color = useResolvedCommunityColor({ iconUrl, iconEmoji: emoji, key: slug || name || 'project' });
  const box = size === 'row'
    ? 'h-9 w-9 rounded-[10px] text-[15px]'
    : 'h-[22px] w-[22px] rounded-[6px] text-[11px]';
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden font-bold text-white ${box} bg-zinc-400 dark:bg-zinc-600`}
      style={color ? { backgroundColor: color } : undefined}
      aria-hidden="true"
      data-bot-tile=""
    >
      {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-cover" loading="lazy" draggable="false" />
        : emoji ? <span className={size === 'row' ? 'text-[18px] leading-none' : 'text-[12px] leading-none'}>{emoji}</span>
          : (name.trim().slice(0, 1).toUpperCase() || '?')}
    </span>
  );
}

const TAG = 'inline-flex shrink-0 items-center rounded-[6px] px-1.5 font-semibold tabular-nums bg-[hsl(var(--req-h)_80%_92%)] text-[hsl(var(--req-h)_70%_26%)] dark:bg-[hsl(var(--req-h)_35%_25%)] dark:text-[hsl(var(--req-h)_80%_82%)]';

/** A request's number, "#18", in its own colour: the same in the drawer, the chat and its thread. */
export function RequestTag({ number, size = 'row' }: { number: number | null | undefined; size?: 'row' | 'line' | 'head' }) {
  if (!number || number <= 0) return null;
  const text = size === 'head' ? 'text-[13px] leading-5' : 'text-[12px] leading-[18px]';
  return (
    <span className={`${TAG} ${text}`} style={{ ['--req-h' as string]: String(requestHue(number)) }} data-request-tag={number}>
      {`#${number}`}
    </span>
  );
}

// Complete literals: Tailwind's extractor reads source text.
const EYEBROW = 'px-4 pb-1 pt-2.5 text-[12px] font-bold uppercase tracking-[0.06em]';
const PILL_PRIMARY = 'inline-flex shrink-0 items-center rounded-full bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60 dark:bg-violet-500 dark:hover:bg-violet-400';
const PILL_SECONDARY = 'inline-flex shrink-0 items-center rounded-full bg-white px-3 py-1.5 text-[13px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700';
const NEED_INK = 'text-amber-700 dark:text-amber-400';

/** Open a row's request: its story at the message it names, else its own page. */
function openRow(row: StripRow): void {
  const rootId = row.rootId || storyRootIn(loadedMessages(), requestKey(row.job));
  if (rootId || row.focusId) { openThreadAt(rootId, row.focusId); return; }
  if (row.job.href && typeof window !== 'undefined') window.location.hash = row.job.href;
}

function RowText({ row }: { row: StripRow }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-1.5">
        <OpenState row={row} />
        {row.job.firstVersion ? null : <RequestTag number={row.job.issueNumber} />}
        <span className="truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{stripTitle(row.job)}</span>
      </span>
      <span className="truncate text-[13px] leading-[18px] text-zinc-500 first-letter:uppercase dark:text-zinc-400" data-bot-strip-state="">{row.state}</span>
    </span>
  );
}

function Tile({ job }: { job: HomeroomBotJob }) {
  return <ProjectTile name={job.appName} slug={job.appSlug} iconUrl={job.iconUrl} emoji={job.iconEmoji} />;
}

// ── How a request ended ──

type EndingTone = 'good' | 'ended' | 'trouble';
type BadgeTone = EndingTone | 'need' | 'ready' | 'working' | 'held';
type Glyph = (props: { className?: string; strokeWidth?: string; 'aria-hidden'?: 'true' }) => ReactNode;
interface Ending { key: string; tone: EndingTone; icon: Glyph; stroke?: string }

/**
 * A settled request's ending, by what its last run came to (the activity
 * cards' tones, ./bot-activity.tsx): made it in (a green check), ended
 * without a change (grey), or went wrong (red). `person` is the bot stepping
 * back (homeroom-bot.js handOff): a call for a person to make, a change it
 * may revise no further, failures it cannot fix safely; a person.
 * Endings that still wait on somebody are never settled, so they are not here.
 */
const ENDINGS: Record<string, Ending> = {
  live: { key: 'messages:bot.final.live', tone: 'good', icon: CheckIcon },
  going_live: { key: 'messages:bot.final.goingLive', tone: 'good', icon: CheckIcon },
  done_elsewhere: { key: 'messages:bot.final.doneElsewhere', tone: 'good', icon: CheckIcon },
  closed: { key: 'messages:bot.final.closed', tone: 'ended', icon: XIcon },
  person: { key: 'messages:bot.final.person', tone: 'ended', icon: UserIcon, stroke: '1.75' },
  held: { key: 'messages:bot.final.held', tone: 'ended', icon: ClockIcon },
  stopped: { key: 'messages:bot.final.stopped', tone: 'ended', icon: NoSymbolIcon },
  build_failed: { key: 'messages:bot.final.failed', tone: 'trouble', icon: WarningTriangleIcon },
  failed: { key: 'messages:bot.final.failed', tone: 'trouble', icon: WarningTriangleIcon },
};

/**
 * Pure: how a request ended, in words, beside its small mark on a Finished
 * today row: the ending's own word ("Live", "Closed"), and for a build that
 * went wrong the reason with it ("Couldn’t build · Its build didn't
 * finish"), the dot joining two whole sentences so each can be translated
 * on its own. No record of how it ended: `fallback`, the words the row last
 * said.
 */
export function endedWords(outcome: string | null | undefined, track: BotTrack | null, fallback: string): string {
  const ending = outcome ? ENDINGS[outcome] : undefined;
  if (!ending) return fallback;
  const word = translate(ending.key);
  return ending.tone === 'trouble' && track ? `${word} · ${trackLine(track)}` : word;
}
// A tile like the project's: the same small square family. What is still
// open is tinted (amber while it waits on the person, blue while it is ready
// to try); what is settled is grey, with only its glyph in colour, so it is
// never louder than what is open and never reads as a request's number,
// whose eight hues include a green and a red (./bot-request.ts).
const BADGE_TINT: Record<BadgeTone, string> = {
  good: 'bg-zinc-200/80 text-emerald-600 dark:bg-zinc-700/70 dark:text-emerald-400',
  ended: 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-300',
  trouble: 'bg-zinc-200/80 text-red-600 dark:bg-zinc-700/70 dark:text-red-400',
  need: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  ready: 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300',
  working: 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-300',
  held: 'bg-zinc-200/80 text-amber-600 dark:bg-zinc-700/70 dark:text-amber-400',
};

/** Where a request stands, as a small square: its glyph on its tone's tint. */
function StatusBadge({ tone, icon: Icon, stroke = '2.5', words = null, spin = false, data }: {
  tone: BadgeTone; icon: Glyph; stroke?: string; words?: string | null; spin?: boolean; data: string;
}) {
  return (
    <span
      className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] ${BADGE_TINT[tone]}`}
      title={words || undefined}
      aria-hidden={words ? undefined : 'true'}
      data-bot-badge={data}
    >
      <Icon aria-hidden="true" className={`h-3.5 w-3.5${spin ? ' animate-spin [animation-duration:2.4s]' : ''}`} strokeWidth={stroke} />
      {words ? <span className="sr-only">{words}</span> : null}
    </span>
  );
}

/**
 * How a request ended, as a small square after its project's tile, named
 * for a screen reader and on hover. An ending the tray has no record of is a
 * plain grey square named by the words it last said.
 */
export function FinalState({ outcome, fallback }: { outcome: string | null | undefined; fallback: string }) {
  const t = useMessages('messages');
  const ending = outcome ? ENDINGS[outcome] : undefined;
  return (
    <span className="contents" data-bot-final={outcome || ''}>
      <StatusBadge
        tone={ending?.tone || 'ended'} icon={ending?.icon || EllipsisHorizontalIcon} stroke={ending?.stroke}
        words={ending ? t(ending.key) : fallback} data={outcome || 'unknown'}
      />
    </span>
  );
}

/** What an open request waits on, by its Needs you case: the glyph of what to do. */
const NEED_GLYPHS: Record<string, { icon: Glyph; stroke?: string }> = {
  question: { icon: ChatIcon, stroke: '2' }, followup_ask: { icon: ChatIcon, stroke: '2' },
  plan: { icon: ListLinesIcon },
  person: { icon: UserIcon, stroke: '1.75' },
  blocked: { icon: PencilSquareIcon, stroke: '2' }, empty: { icon: PencilSquareIcon, stroke: '2' },
  build_failed: { icon: ArrowPathIcon, stroke: '2' }, first_version_failed: { icon: ArrowPathIcon, stroke: '2' },
  failed: { icon: ArrowPathIcon, stroke: '2' }, stopped: { icon: ArrowPathIcon, stroke: '2' },
  checks: { icon: EyeIcon, stroke: '2' }, needs_look: { icon: EyeIcon, stroke: '2' },
  on_hold: { icon: ClockIcon }, secrets: { icon: KeyIcon, stroke: '2' },
};

/**
 * Where an open request stands, as the same small square its ending will be:
 * amber with what to do while it waits on the person (a bubble to answer, a
 * pencil to add detail, a person to decide, a loop to try again), blue
 * with a play mark while it is ready to try, grey and turning while the bot
 * works on it. Decorative: the row's second line says it in words.
 */
export function OpenState({ row }: { row: StripRow }) {
  if (row.group === 'needs') {
    // A change whose yes is theirs: what to do is to try it and say yes.
    if (row.track?.state === 'vote') return <StatusBadge tone="need" icon={PlayIcon} stroke="2" data="needs" />;
    const which = row.track ? TRACK_NEED_CASES[row.track.why || ''] || 'question' : needsCase(row.job);
    const glyph = NEED_GLYPHS[which] || { icon: InfoCircleIcon, stroke: '2' };
    return <StatusBadge tone="need" icon={glyph.icon} stroke={glyph.stroke} data="needs" />;
  }
  if (row.group === 'ready') return <StatusBadge tone="ready" icon={PlayIcon} stroke="2" data="ready" />;
  // Work a limit holds back is still under way, never finished: a clock,
  // waiting, never turning.
  if (row.track?.state === 'held') return <StatusBadge tone="held" icon={ClockIcon} data="progress" />;
  // Turning only while the bot works on it this minute.
  const spin = !row.track || row.track.busy || row.track.state === 'building';
  return <StatusBadge tone="working" icon={SpinnerArcIcon} spin={spin} data="progress" />;
}

/**
 * A settled request on one line, in the chat and in Done today: the
 * project's small tile at the end of the big tile's column, so it sits as
 * close to its badge as a big tile does, then how it ended, its number and
 * its title. Only what is still open gets two lines and a full tile.
 */
export function SettledLine({ name, slug, iconUrl, emoji, number, title, outcome, fallback, words = null, nested = false }: {
  name: string; slug: string | null; iconUrl: string | null; emoji: string | null;
  number: number | null | undefined; title: string; outcome: string | null | undefined; fallback: string;
  /** #5392: how it ended, in words after the title, where the mark alone does not say it. */
  words?: string | null;
  /** Inside an opened run (./bot-news-line.tsx SettledRun): no big tile's column to keep. */
  nested?: boolean;
}) {
  return (
    <>
      <span className={nested ? 'flex shrink-0' : 'flex w-9 shrink-0 justify-end'}>
        <ProjectTile name={name} slug={slug} iconUrl={iconUrl} emoji={emoji} size="line" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <FinalState outcome={outcome} fallback={fallback} />
        <RequestTag number={number} size="line" />
        {/* Polish N15: the title is the flexible part, so it has the room
            ("Fix scr…" had 58px beside a 149px status) and a short one
            still puts its status at the row's end, as the others are; the
            status takes at most 40% and gives way first. */}
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-zinc-700 dark:text-zinc-300">{title}</span>
        {words ? <span className="min-w-0 max-w-[40%] truncate text-right text-[13px] leading-5 text-zinc-500 dark:text-zinc-400" data-bot-settled-words="">{words}</span> : null}
      </span>
    </>
  );
}

/** A Needs you row: the row opens the story at what waits, and its one button says what to do there. */
function NeedsRow({ row, onOpen }: { row: StripRow; onOpen: (row: StripRow) => void }) {
  const t = useMessages('messages');
  return (
    <li className="flex items-center gap-3 px-4 py-2" data-bot-strip-row="needs" data-bot-strip-key={row.key}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" data-bot-strip-open="" onClick={() => onOpen(row)}>
        <Tile job={row.job} />
        <RowText row={row} />
      </button>
      <button type="button" className={PILL_PRIMARY} data-bot-strip-act="open" onClick={() => onOpen(row)}>{t(row.action || 'messages:bot.strip.action.open')}</button>
    </li>
  );
}

/** A Ready to try row: Try it, and Approve when their yes counts. */
function ReadyRow({ row, onOpen }: { row: StripRow; onOpen: (row: StripRow) => void }) {
  const t = useMessages('messages');
  const ready = row.job.ready || null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = ready?.sessionId || null;
  // #5483: a Yes cast here stops the row offering Approve, before the tray's
  // next read repeats what the server already knows. The hook redraws the row
  // the moment the Yes lands, wherever on the page it was cast (the card's
  // included; a bare read would wait for the tray's next read to re-render).
  const approved = useApprovedHere(sessionId, ready?.epoch ?? null);
  const canApprove = !!ready?.approve && !!sessionId && !approved;

  function tryIt() {
    if (sessionId && row.job.appSlug) { tryChange({ appSlug: row.job.appSlug }, sessionId); return; }
    openRow(row);
  }

  async function approve() {
    if (!sessionId) return;
    setBusy(true); setError(null);
    const out = await api.approveChange(sessionId, ready?.epoch ?? null);
    setBusy(false);
    if (out.ok) { noteApprovedHere(sessionId, ready?.epoch ?? null, out.goesLive || null); loadBotWork(); return; }
    setError(out.stale ? t('messages:bot.strip.approveStale') : out.error || t('messages:bot.strip.approveFailed'));
  }

  return (
    <li className="px-4 py-2" data-bot-strip-row={row.group} data-bot-strip-key={row.key}>
      <div className="flex items-center gap-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" data-bot-strip-open="" onClick={() => onOpen(row)}>
          <Tile job={row.job} />
          <RowText row={row} />
        </button>
        <button type="button" className={PILL_SECONDARY} data-bot-strip-act="try" onClick={tryIt}>{t('messages:bot.strip.action.tryIt')}</button>
        {canApprove ? <button type="button" className={PILL_PRIMARY} data-bot-strip-act="approve" disabled={busy} onClick={() => { void approve(); }}>{t('messages:bot.strip.action.approve')}</button> : null}
      </div>
      {error ? <p role="alert" className="mt-1 pl-12 text-[13px] text-red-700 dark:text-red-400">{error}</p> : null}
    </li>
  );
}

/** A Done today row: one line, with how it ended in words after its mark. */
function DoneRow({ row, onOpen }: { row: StripRow; onOpen: (row: StripRow) => void }) {
  const job = row.job;
  const outcome = row.track ? trackEnding(row.track) : (job as HomeroomBotPastJob).outcome;
  return (
    <li data-bot-strip-row="done" data-bot-strip-key={row.key}>
      <button type="button" className="flex w-full items-center gap-2 px-4 py-1.5 text-left" data-bot-strip-open="" onClick={() => onOpen(row)}>
        <SettledLine
          name={job.appName} slug={job.appSlug} iconUrl={job.iconUrl} emoji={job.iconEmoji}
          number={job.firstVersion ? null : job.issueNumber} title={stripTitle(job)}
          outcome={outcome} fallback={row.state}
          words={row.state}
        />
      </button>
    </li>
  );
}

/** A row that is itself the button: In progress's. */
function PlainRow({ row, onOpen }: { row: StripRow; onOpen: (row: StripRow) => void }) {
  return (
    <li data-bot-strip-row={row.group} data-bot-strip-key={row.key}>
      <button type="button" className="flex w-full items-center gap-2 px-4 py-2 text-left" data-bot-strip-open="" onClick={() => onOpen(row)}>
        <Tile job={row.job} />
        <RowText row={row} />
      </button>
    </li>
  );
}

function Eyebrow({ children, className }: { children: ReactNode; className: string }) {
  return <div className={`${EYEBROW} ${className}`}>{children}</div>;
}

export interface BotStripViewProps {
  work: HomeroomBotWork | null;
  /** The remembered Hide / Show; null for none. */
  remembered?: boolean | null;
  onRemember?: (open: boolean) => void;
  /** For a test: the moment "today" is counted back from. */
  now?: Date;
}

/** The drawer's chevron: down while closed, turned up while open. */
function Chevron({ open }: { open: boolean }) {
  return <ChevronDownIcon aria-hidden="true" className={`h-[18px] w-[18px] shrink-0 text-zinc-500 transition-transform dark:text-zinc-400 ${open ? 'rotate-180' : ''}`} />;
}

/**
 * The activity drawer, from one read: a pure render, so a test can draw every
 * state. A bar under the chat's header says what is waiting ("1 needs you #18
 * · 2 ready to try"); pressing it opens the drawer OVER the chat, which keeps
 * its place underneath. Opening a request closes it. Closed until the person
 * opens it; their choice is remembered on the device.
 */
export function BotStripView({ work, remembered = null, onRemember, now }: BotStripViewProps) {
  const t = useMessages('messages');
  const model = stripGroups(work, now || new Date());
  const [open, setOpen] = useState<boolean>(remembered ?? false);
  // Done today is folded each time the drawer opens: what is settled waits behind its count.
  const [doneOpen, setDoneOpen] = useState(false);
  const parts = summaryParts(model);
  if (!parts.length) return null;
  const choose = (next: boolean) => { setOpen(next); setDoneOpen(false); onRemember?.(next); };
  const onOpen = (row: StripRow) => { choose(false); openRow(row); };
  const needTags = model.needs.slice(0, NEEDS_LIMIT).map((row) => row.job.issueNumber).filter((n): n is number => !!n && n > 0);
  return (
    <section className="relative z-20 shrink-0" aria-label={t('messages:bot.strip.name')} data-bot-strip={open ? 'open' : 'closed'}>
      <button
        type="button"
        className="flex w-full items-center gap-2.5 bg-[color:var(--dc-sheet-solid)] px-4 py-2.5 text-left shadow-[inset_0_-1px_0_var(--app-sheet-line)] hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
        aria-expanded={open}
        data-bot-strip-toggle=""
        onClick={() => choose(!open)}
      >
        <span className="shrink-0 text-[14px] font-[650] text-zinc-900 dark:text-zinc-100">{t('messages:bot.strip.activity')}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-600 dark:text-zinc-300" data-bot-strip-summary="">
          {parts.map((part, index) => (
            <span key={part.group}>
              {index ? <span aria-hidden="true">{' · '}</span> : null}
              <span className={part.group === 'needs' ? NEED_INK : undefined} data-bot-strip-count={part.group}>{part.text}</span>
              {part.group === 'needs' && needTags.length ? (
                <span className="ml-1 inline-flex gap-1 align-[1px]">{needTags.map((n) => <RequestTag key={n} number={n} />)}</span>
              ) : null}
            </span>
          ))}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <>
          <div className="absolute inset-x-0 top-full h-[100vh] bg-zinc-900/10 dark:bg-black/40" aria-hidden="true" data-bot-strip-scrim="" onClick={() => choose(false)} />
          <div
            className="absolute inset-x-0 top-full max-h-[45vh] overflow-y-auto md:max-h-[min(70vh,560px)] overscroll-contain rounded-b-[20px] bg-[color:var(--dc-sheet-solid)] pb-2 shadow-[0_18px_36px_rgba(0,0,0,0.18)]"
            data-bot-strip-drawer=""
          >
            {model.needs.length ? (
              <>
                <Eyebrow className={NEED_INK}>{t('messages:bot.strip.group.needs')}</Eyebrow>
                <ul data-bot-strip-group="needs">
                  {/* A change whose yes is theirs keeps the ready row's own two acts. */}
                  {model.needs.map((row) => (row.track?.state === 'vote'
                    ? <ReadyRow key={row.key} row={row} onOpen={onOpen} />
                    : <NeedsRow key={row.key} row={row} onOpen={onOpen} />))}
                </ul>
              </>
            ) : null}
            {model.ready.length ? (
              <>
                <Eyebrow className="text-violet-700 dark:text-violet-300">{t('messages:bot.strip.group.ready')}</Eyebrow>
                <ul data-bot-strip-group="ready">{model.ready.map((row) => <ReadyRow key={row.key} row={row} onOpen={onOpen} />)}</ul>
              </>
            ) : null}
            {model.progress.length ? (
              <>
                <Eyebrow className="text-zinc-500 dark:text-zinc-400">{t('messages:bot.strip.group.progress')}</Eyebrow>
                <ul data-bot-strip-group="progress">{model.progress.map((row) => <PlainRow key={row.key} row={row} onOpen={onOpen} />)}</ul>
              </>
            ) : null}
            {model.done.length ? (
              <>
                <button
                  type="button"
                  className={`${EYEBROW} flex w-full items-center gap-1.5 text-left text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200`}
                  aria-expanded={doneOpen}
                  data-bot-strip-done-toggle=""
                  onClick={() => setDoneOpen(!doneOpen)}
                >
                  <span>{t('messages:bot.strip.group.done')}</span>
                  <span className="font-semibold tabular-nums" data-bot-strip-done-count="">{`· ${model.done.length}`}</span>
                  <ChevronDownIcon aria-hidden="true" className={`h-4 w-4 shrink-0 transition-transform ${doneOpen ? 'rotate-180' : ''}`} />
                </button>
                {doneOpen ? <ul data-bot-strip-group="done">{model.done.map((row) => <DoneRow key={row.key} row={row} onOpen={onOpen} />)}</ul> : null}
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The strip in the chat with Homeroom bot, kept current by BotWorkSync (./bot-work.tsx). */
export function BotStrip() {
  // Subscribed: the rows' words are read from the catalog as this renders.
  useMessages('messages');
  const { work } = useBotWork();
  const [remembered] = useState(rememberedOpen);
  return <BotStripView work={work} remembered={remembered} onRemember={rememberOpen} />;
}
