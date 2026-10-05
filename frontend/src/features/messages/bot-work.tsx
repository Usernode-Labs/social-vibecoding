import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { ChevronDownIcon, ClockIcon } from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { agoStamp } from '../../lib/timestamp';
import * as api from './api';
import {
  ACTIVITY_OUTCOME_LABELS, ACTIVITY_OUTCOME_TONES, ActivityLead, ActivityLink, TONE_WORDS, spanText, type ActivityTone,
} from './bot-activity';
import { POLL_MS } from './bot-activity-store';
import { WORK_CHANGED_EVENT, jobName, jobTitle } from './bot-shared';
import type {
  ConversationMessage, HomeroomBotActivityOutcome, HomeroomBotCurrentJob, HomeroomBotJob, HomeroomBotPastJob,
  HomeroomBotPhase, HomeroomBotWork,
} from './types';

export { WORK_CHANGED_EVENT, jobName, jobTitle };

/*
 * #3692: the activity tray in the Homeroom bot's DM.
 *
 * The DM carries the bot's news one message at a time. This is the state in
 * between, read from the platform's records of its work for the viewer and
 * nobody else (services/homeroom-bot-tray.js):
 *
 *   - a STATUS LINE in the chat header, under the bot's name where a DM says
 *     "Direct message": what it is working on for them ("Working on Ear
 *     Trainer #5 · following up"), else what waits on them, else the last
 *     thing it did. A phone gets a short form of the same line. It is words
 *     only (#3770): the name block it sits in used to be the toggle, and
 *     nobody read a name as a control.
 *   - an ACTIVITY DISC among the header's discs, on every width, which opens
 *     the panel at any time, working or not. Its badge is the live dot while
 *     the bot works, or the number of requests that wait on the viewer.
 *   - the PANEL it opens: a sheet that drops over the transcript at the
 *     pane's full width (the conversation under it does not move), closed
 *     again by the disc, Escape, or a press anywhere else but the full-width
 *     toggle beside it, which only widens the pane under it. Its tiles are
 *     the activity cards' language (./bot-activity.tsx): the ring with the
 *     step while the bot works, then Done / Needs you / Ended / Didn't
 *     finish, the request, what came of it, and where to open it. Each
 *     request is one tile, in the first group that fits: Now, Needs you,
 *     History. History starts folded away. A request's other runs fold into
 *     its tile.
 *
 * WHEN IT READS AGAIN. The same realtime Messages already runs on: the
 * bot's news landing in this DM (a new message from it, which the store
 * reloads the thread for; the thread hands its newest id down as `newsKey`),
 * and the live loop starting or finishing work for this person, which
 * reaches every one of their tabs as `homeroom_bot_work_changed` and which
 * public/js/app.js turns into the window event below (as it does after a
 * socket reconnects). Like every conversation event, it carries no data: the
 * tray re-reads its endpoint under the viewer's own session. Opening the
 * panel reads it too.
 *
 * #8 (WP3): every one of those re-reads asks the server (`fresh`), never the
 * service worker's offline copy, which on a slow answer was the state from
 * before the news; the worker's own late correction (store.ts resync) reads
 * it again too; and while the bot has work in hand and the page is in view,
 * it reads again every POLL_MS, as the activity cards do, for the steps the
 * loop announces nothing for. Only opening the DM keeps the ordinary read.
 *
 * ONE STATE, THREE PLACES. The header's status line, its disc and the
 * panel are drawn by different parts of the thread pane, so what was read,
 * whether the panel is open and whether History is unfolded live in one
 * small store here, which BotWorkSync keeps current.
 *
 * OWNERSHIP. Every node here is React's, inside the thread pane React already
 * owns; nothing outside writes into it. Nothing is read until the sync's
 * effect runs, so a first render matches whatever was drawn before.
 */

export const BOT_WORK_PANEL_ID = 'messages-bot-work-panel';
const HISTORY_ID = 'messages-bot-work-history';

// ── The store: what was read, and what is open ───────────────────────────

export interface BotWorkState {
  /** Null until the first read lands. */
  work: HomeroomBotWork | null;
  /** The last read failed (what was read before is kept). */
  failed: boolean;
  open: boolean;
  historyOpen: boolean;
}

const INITIAL: BotWorkState = { work: null, failed: false, open: false, historyOpen: false };
let state: BotWorkState = INITIAL;
const listeners = new Set<() => void>();

function publish(next: Partial<BotWorkState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBotWork(): BotWorkState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

/** Open or shut the panel. It opens with History folded away. */
export function setBotWorkOpen(open: boolean): void {
  if (state.open === open) return;
  publish(open ? { open, historyOpen: false } : { open });
}

export function toggleBotWork(): void {
  setBotWorkOpen(!state.open);
}

// Only the newest read may land: an older one finishing late is dropped.
let seq = 0;

/** Read the tray again. `fresh` (every read but the DM opening): past the worker's offline copy. */
export function loadBotWork({ fresh = true }: { fresh?: boolean } = {}): void {
  const mine = ++seq;
  api.getHomeroomBotWork({ fresh }).then((work) => {
    if (mine === seq) publish({ work, failed: false });
  }).catch(() => {
    if (mine === seq) publish({ failed: true });
  });
}

function resetBotWork(): void {
  seq += 1;
  publish(INITIAL);
}

// ── Words ────────────────────────────────────────────────────────────────

/** What a tile of Now says the bot is doing when the server sends no words of its own. */
export const PHASE_LABELS: Record<HomeroomBotPhase, string> = {
  get looking() { return tr("community:looking_at_it_1984f4e5"); },
  building: 'building',
  get following_up() { return tr("community:following_up_on_its_proposal_2b822bf7"); },
  get setting_up() { return tr("community:getting_the_project_ready_3d4685fa"); },
  // #3734: one per step services/homeroom-bot-tray.js draws an in-flight
  // stage of the bot's progress as.
  get queued() { return tr("community:waiting_its_turn_in_my_queue_671f20c9"); },
  get follow_up_queued() { return tr("community:waiting_its_turn_to_follow_up_on_its_proposal_1327004b"); },
  get merging() { return tr("community:merging_its_approved_proposal_1b5f9e4b"); },
};

/** The same, as the header's status line says it after the request's name. */
export const SHORT_PHASES: Record<HomeroomBotPhase, string> = {
  get looking() { return tr("community:reading_it_e459ec75"); },
  building: 'building',
  get following_up() { return tr("community:following_up_452d3822"); },
  get setting_up() { return tr("community:setting_up_6ae46cb7"); },
  get queued() { return tr("community:in_my_queue_56c9701b"); },
  get follow_up_queued() { return tr("community:queued_to_follow_up_bdc609ef"); },
  merging: 'merging',
};

/** The last thing the bot did, as the status line says it when nothing else is going on. */
export const LAST_WORDS: Record<HomeroomBotActivityOutcome, (name: string) => string> = {
  question: (name) => tr("community:asked_you_about_value1_ece021e7", { value1: name }),
  proposed: (name) => tr("community:proposed_value1_6cf1f124", { value1: name }),
  live: (name) => tr("community:value1_went_live_bae1c229", { value1: name }),
  closed: (name) => tr("community:value1_s_proposal_was_closed_f49bf544", { value1: name }),
  blocked: (name) => tr("community:couldn_t_build_value1_as_written_c3b76ce7", { value1: name }),
  build_failed: (name) => tr("community:couldn_t_finish_building_value1_cd5d7f6c", { value1: name }),
  person: (name) => tr("community:left_value1_to_the_group_c43a5dde", { value1: name }),
  empty: (name) => tr("community:found_nothing_to_build_in_value1_22547337", { value1: name }),
  failed: (name) => tr("community:couldn_t_finish_looking_at_value1_264cc956", { value1: name }),
  held: (name) => tr("community:held_value1_back_for_now_18e4631c", { value1: name }),
  stopped: (name) => tr("community:stopped_on_value1_e50a5446", { value1: name }),
  answer: (name) => tr("community:answered_on_value1_e0b40710", { value1: name }),
  revise: (name) => tr("community:changed_value1_s_proposal_03f92f9f", { value1: name }),
};

function capitalized(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "#12", or the project's name for a first version: what the phone's status line names. */
function shortName(job: Pick<HomeroomBotJob, 'appName' | 'issueNumber' | 'firstVersion'>): string {
  return !job.firstVersion && job.issueNumber ? `#${job.issueNumber}` : job.appName;
}

/** #8 (WP3): the steps of Now that wait their turn in the bot's queue rather than run. */
const QUEUED_PHASES: ReadonlySet<HomeroomBotPhase> = new Set<HomeroomBotPhase>(['queued', 'follow_up_queued']);

export interface TrayStatus {
  /** working: the bot has something in hand; you: something waits on the viewer; last: what it did last. */
  kind: 'working' | 'you' | 'last' | 'idle';
  long: string;
  short: string;
}

/**
 * The header's status line, from what was read: "Working on Ear Trainer #5 ·
 * following up", "Ear Trainer #12 needs you", "Last: answered on Ear Trainer
 * #9 · 16h ago", and a short form of each for a phone. Before the first
 * read, and with nothing to say, it names what opens: "Activity".
 *
 * #8 (WP3, D6): when everything in hand only waits its turn in the queue,
 * the phone's short form says so ("#3 queued") rather than "Working on #3".
 * The long form keeps counting it ("Working on 3 requests", which a declared
 * check reads).
 */
export function trayStatus(work: HomeroomBotWork | null, now: Date = new Date()): TrayStatus {
  const plain: TrayStatus = { kind: 'idle', get long() { return tr("community:activity_38da1505"); }, get short() { return tr("community:activity_38da1505"); } };
  if (!work) return plain;
  const waiting = work.needsYou.length;
  const needs = waiting ? tr("community:count_need_you_3260b3bd", { count: waiting }) : '';
  const queued = work.now.length > 0 && work.now.every((job) => QUEUED_PHASES.has(job.phase));
  // A phone's line has room for one of the two: what waits on them wins.
  if (work.now.length === 1) {
    const job = work.now[0];
    let short = tr("community:working_on_value1_e874ddad", { value1: shortName(job) });
    if (queued) short = needs ? `Queued${needs}` : tr("community:value1_queued_a4991001", { value1: shortName(job) });
    else if (needs) short = `Working${needs}`;
    return { kind: 'working', long: tr("community:working_on_value1_value2_value3_5573966a", { value1: jobName(job), value2: SHORT_PHASES[job.phase], value3: needs }), short };
  }
  if (work.now.length) {
    let short = tr("community:working_on_value1_e874ddad", { value1: work.now.length });
    if (queued) short = needs ? `Queued${needs}` : tr("community:value1_queued_a4991001", { value1: work.now.length });
    else if (needs) short = `Working${needs}`;
    return { kind: 'working', long: tr("community:working_on_value1_requests_value2_1172d03f", { value1: work.now.length, value2: needs }), short };
  }
  if (waiting === 1) {
    const job = work.needsYou[0];
    return { kind: 'you', long: tr("community:value1_needs_you_a1e7084a", { value1: jobName(job) }), short: tr("community:value1_needs_you_a1e7084a", { value1: shortName(job) }) };
  }
  if (waiting) return { kind: 'you', long: tr("community:value1_requests_need_you_e1d1c808", { value1: waiting }), short: tr("community:value1_need_you_efe77087", { value1: waiting }) };
  const last = work.history[0];
  if (!last?.outcome) return plain;
  const ago = agoStamp(last.at, { now }).text;
  const when = ago ? ` · ${ago}` : '';
  return {
    kind: 'last',
    long: tr("community:last_value1_value2_0ac69961", { value1: LAST_WORDS[last.outcome](jobName(last)), value2: when }),
    short: tr("community:last_value1_value2_0ac69961", { value1: LAST_WORDS[last.outcome](shortName(last)), value2: when }),
  };
}

/** The id of the newest message the bot sent here: its news moves its work on. */
export function newestBotMessageId(messages: ConversationMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender.bot && message.id > 0) return message.id;
  }
  return null;
}

// ── The status line ──────────────────────────────────────────────────────

function PingDot() {
  return (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full rounded-full bg-[color:var(--accent)] opacity-60 motion-safe:animate-ping" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--accent)]" />
    </span>
  );
}

/**
 * The line under the bot's name, a pure render. Words only: the Activity
 * disc beside it is the toggle (#3770).
 */
export function BotWorkStatusView({ status }: { status: TrayStatus }) {
  const loud = status.kind === 'working' || status.kind === 'you';
  return (
    <div
      className={`messages-thread-sub flex items-center gap-1.5${loud ? ' font-semibold text-[color:var(--brand-ink)]' : ''}`}
      data-bot-work-status={status.kind}
    >
      {status.kind === 'working' ? <PingDot /> : null}
      <span className="min-w-0 truncate">
        <span className="hidden sm:inline">{status.long}</span>
        <span className="sm:hidden">{status.short}</span>
      </span>
    </div>
  );
}

export function BotWorkStatusLine() {
  const { work } = useBotWork();
  return <BotWorkStatusView status={trayStatus(work)} />;
}

// ── The disc ─────────────────────────────────────────────────────────────

/**
 * #3770: the toggle, a disc among the header's discs (index.tsx
 * ThreadHeader), drawn on a phone too. A press on it is not "outside" the
 * panel, and Escape hands focus back to it: both find it by
 * `data-bot-work-toggle`. Its badge carries the tray's state as
 * `data-bot-work-status`, as the line does: the number of requests that
 * wait on the viewer, the accent's job (AGENTS.md), else the live dot while
 * the bot works, else nothing. A pure render.
 */
export function BotWorkButtonView({ work, open, onToggle }: { work: HomeroomBotWork | null; open: boolean; onToggle?: () => void }) {
  const { kind } = trayStatus(work);
  const waiting = work ? work.needsYou.length : 0;
  let badge: ReactNode = null;
  if (waiting) {
    badge = (
      <span className="messages-bot-work-badge messages-bot-work-count" data-bot-work-status={kind} aria-hidden="true">
        {waiting > 9 ? '9+' : waiting}
      </span>
    );
  } else if (kind === 'working') {
    badge = <span className="messages-bot-work-badge messages-bot-work-dot" data-bot-work-status={kind}><PingDot /></span>;
  }
  return (
    <Localized element={<button
      type="button"
      className="messages-thread-action messages-bot-work-button" aria-label={catalogText("community:activity_38da1505")} title={catalogText("community:activity_38da1505")}
      aria-expanded={open}
      aria-controls={BOT_WORK_PANEL_ID}
      data-bot-work-toggle=""
      onClick={onToggle}
    >
      <ClockIcon aria-hidden="true" />
      {badge}
    </button>} messages={{"aria-label":"community:activity_38da1505","title":"community:activity_38da1505"}} />
  );
}

export function BotWorkButton() {
  const { work, open } = useBotWork();
  return <BotWorkButtonView work={work} open={open} onToggle={toggleBotWork} />;
}

// ── The panel ────────────────────────────────────────────────────────────

const TILE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] items-start gap-2.5 px-3';

function PanelNote({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`px-4 pb-1 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400 ${className}`}>{children}</p>;
}

/** Where a tile can be opened: its proposal once people can open it, its request, or its project. */
function tileLinks(job: HomeroomBotJob): ReactNode[] {
  const links: ReactNode[] = [];
  if (job.links.proposal) links.push(<ActivityLink key="proposal" data="bot-work" href={job.links.proposal}><Message id="community:open_change_6ab4b6b1" /></ActivityLink>);
  if (job.links.request) {
    links.push(
      <ActivityLink key="request" data="bot-work" href={job.links.request}>
        <LocalizedValue render={() => (job.firstVersion || !job.issueNumber ? tr("community:open_request_3cfb5504") : tr("community:request_value1_8051e8ec", { value1: job.issueNumber }))} />
      </ActivityLink>,
    );
  } else if (job.links.project) {
    links.push(<ActivityLink key="project" data="bot-work" href={job.links.project}><Message id="community:open_project_5e5eba7f" /></ActivityLink>);
  }
  return links;
}

interface TileProps {
  job: HomeroomBotJob;
  group: 'now' | 'you' | 'history';
  tone: ActivityTone | null;
  lead: ReactNode;
  eyebrow: string;
  status: string;
  ago: (value: string | null) => string;
}

/** One request, in the activity cards' language. Its earlier runs fold away under it. */
function Tile({ job, group, tone, lead, eyebrow, status, ago }: TileProps) {
  useUiLanguage();
  const [showEarlier, setShowEarlier] = useState(false);
  const links = tileLinks(job);
  const earlier = job.earlier;
  return (
    <div
      className="flex min-w-0 flex-col gap-2.5 rounded-2xl bg-zinc-50 px-3 py-2.5 dark:bg-zinc-950/60"
      role="group"
      aria-label={jobTitle(job)}
      data-bot-work-tile={group}
      data-bot-work-tone={tone || 'working'}
    >
      <div className="flex items-start gap-3">
        {lead}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {group === 'now' ? <PingDot /> : null}
            <span className="truncate">{eyebrow}</span>
          </div>
          <div className="line-clamp-2 text-[0.9375rem] font-semibold leading-5 text-zinc-900 dark:text-zinc-100">{jobTitle(job)}</div>
          <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-work-tile-status="">{status}</p>
        </div>
      </div>
      {links.length || earlier.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {links}
          {earlier.length ? (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-[0.8125rem] text-zinc-500 dark:text-zinc-400"
              aria-expanded={showEarlier}
              data-bot-work-earlier={earlier.length}
              onClick={() => setShowEarlier((shown) => !shown)}
            >
              <LocalizedValue render={() => (tr("community:message_409f67f96459", { value1: earlier.length, count: earlier.length }))} />
              <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${showEarlier ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {showEarlier ? (
        <ul className="flex flex-col gap-1.5 border-t border-zinc-200 pt-2 dark:border-zinc-800">
          {earlier.map((run) => (
            <li key={run.id} className="flex gap-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
              <span className="min-w-0 flex-1">{ACTIVITY_OUTCOME_LABELS[run.outcome]}</span>
              <span className="shrink-0">{ago(run.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function withTime(text: string, time: string): string {
  return time ? `${text} · ${time}` : text;
}

function NowTile({ job, at, ago }: { job: HomeroomBotCurrentJob; at: Date; ago: (value: string | null) => string }) {
  const stepped = !!job.step && !!job.of;
  const eyebrow = stepped ? tr("community:step_value1_of_value2_value3_8acfce48", { value1: job.step, value2: job.of, value3: job.stepName ? ` · ${job.stepName}` : '' }) : tr("community:working_on_it_d55b6d1b");
  const elapsed = spanText(job.since, at);
  return (
    <Tile
      job={job}
      group="now"
      tone={null}
      lead={<ActivityLead step={job.step} of={job.of} stepName={job.stepName} />}
      eyebrow={eyebrow}
      status={withTime(capitalized(job.doing || PHASE_LABELS[job.phase]), elapsed ? `${elapsed} so far` : '')}
      ago={ago}
    />
  );
}

function PastTile({ job, group, ago }: { job: HomeroomBotPastJob; group: 'you' | 'history'; ago: (value: string | null) => string }) {
  const tone: ActivityTone = group === 'you' ? 'you' : (job.outcome ? ACTIVITY_OUTCOME_TONES[job.outcome] : 'ended');
  const said = job.outcome ? ACTIVITY_OUTCOME_LABELS[job.outcome] : capitalized(job.doing || tr("community:waiting_on_you_40fd9e27"));
  return (
    <Tile
      job={job}
      group={group}
      tone={tone}
      lead={<ActivityLead tone={tone} />}
      eyebrow={TONE_WORDS[tone]}
      status={withTime(said, ago(job.at))}
      ago={ago}
    />
  );
}

export interface BotWorkPanelViewProps {
  /** Null until the first read lands. */
  work: HomeroomBotWork | null;
  /** The last read failed (what was read before stays drawn). */
  failed?: boolean;
  historyOpen?: boolean;
  onToggleHistory?: () => void;
  onRetry?: () => void;
  /** For a test: the moment "4m ago" is counted from. */
  now?: Date;
}

/** The panel itself, from what was read: a pure render, so a test can draw every state. */
export function BotWorkPanelView({ work, failed = false, historyOpen = false, onToggleHistory, onRetry, now }: BotWorkPanelViewProps) {
  const at = now || new Date();
  const ago = (value: string | null) => agoStamp(value, { now: at }).text;
  const idle = !!work && !work.now.length && !work.needsYou.length;
  return (
    <Localized element={<section
      id={BOT_WORK_PANEL_ID}
      className="absolute inset-x-3 top-1 max-h-[min(70vh,40rem)] overflow-y-auto overscroll-contain rounded-[20px] bg-white pb-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_18px_40px_-16px_rgba(0,0,0,0.35)] dark:bg-zinc-900" aria-label={catalogText("community:homeroom_bot_activity_5bfda20d")}
      data-bot-work-panel=""
    >
      {!work ? (
        failed ? (
          <div className="flex items-center gap-3 px-4 py-3" role="alert">
            <span className="min-w-0 flex-1 text-[0.8125rem] text-zinc-500 dark:text-zinc-400"><Message id="community:couldn_t_load_what_i_m_working_on_e8390dd5" /></span>
            <Button type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={onRetry}><Message id="community:try_again_d8b8392e" /></Button>
          </div>
        ) : (
          <Localized element={<SkeletonGroup label={catalogText("community:loading_activity_0acd8adf")} className="space-y-4 px-4 py-4">
            {[0, 1, 2].map((key) => (
              <div key={key} className="space-y-2">
                <Skeleton className="w-2/3" />
                <Skeleton shape="muted" className="w-1/3" />
              </div>
            ))}
          </SkeletonGroup>} messages={{"label":"community:loading_activity_0acd8adf"}} />
        )
      ) : (
        <>
          {work.now.length ? (
            <>
              <SectionHeader className="pt-3"><Message id="community:now_fe18013d" /></SectionHeader>
              <div className={TILE_GRID}>
                {work.now.map((job) => <NowTile key={job.key} job={job} at={at} ago={ago} />)}
              </div>
            </>
          ) : null}
          {work.needsYou.length ? (
            <>
              <SectionHeader className={work.now.length ? 'pt-4' : 'pt-3'}><Message id="community:needs_you_74b6abdf" /></SectionHeader>
              <div className={TILE_GRID}>
                {work.needsYou.map((job) => <PastTile key={job.key} job={job} group="you" ago={ago} />)}
              </div>
            </>
          ) : null}
          {idle ? <PanelNote className="pt-3"><Message id="community:i_m_not_working_on_anything_for_you_right_now_9d3a3f8e" /></PanelNote> : null}
          {work.history.length ? (
            <>
              <button
                type="button"
                className="mx-3 mt-3 flex w-[calc(100%-1.5rem)] items-center justify-center gap-1.5 rounded-[14px] bg-zinc-50 px-3 py-2.5 text-[0.875rem] font-semibold text-zinc-900 dark:bg-zinc-950/60 dark:text-zinc-100"
                aria-expanded={historyOpen}
                aria-controls={HISTORY_ID}
                data-bot-work-history-toggle=""
                onClick={onToggleHistory}
              >
                <LocalizedValue render={() => (historyOpen ? tr("community:hide_history_db1ddf34") : tr("community:show_history_value1_579f517d", { value1: work.history.length }))} />
                <ChevronDownIcon className={`h-4 w-4 transition-transform ${historyOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
              {historyOpen ? (
                <div id={HISTORY_ID} className={`${TILE_GRID} pt-2.5`}>
                  {work.history.map((job) => <PastTile key={job.key} job={job} group="history" ago={ago} />)}
                </div>
              ) : null}
            </>
          ) : idle ? <PanelNote><Message id="community:nothing_yet_when_i_work_on_a_request_of_yours_it_bf90bb46" /></PanelNote> : null}
          {failed ? <PanelNote className="pt-3"><Message id="community:couldn_t_refresh_this_just_now_it_may_be_out_of__279155b5" /></PanelNote> : null}
        </>
      )}
    </section>} messages={{"aria-label":"community:homeroom_bot_activity_5bfda20d"}} />
  );
}

/**
 * The panel in the bot's DM, under the chat header: drawn over the
 * transcript from a zero-height anchor, so opening it moves nothing. A
 * press anywhere but the panel and the header's toggle shuts it, as does
 * Escape, which hands focus back to the toggle. The full-width toggle
 * beside it (`data-bot-work-keep`) leaves it open (#3770): that one widens
 * the pane the panel is drawn in, and closing the panel too made it read as
 * the panel's own collapse control.
 */
export function BotWorkPanel() {
  const { work, failed, open, historyOpen } = useBotWork();
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: Event) => {
      const target = event.target as Element | null;
      if (!target || anchor.current?.contains(target) || target.closest?.('[data-bot-work-toggle], [data-bot-work-keep]')) return;
      setBotWorkOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setBotWorkOpen(false);
      document.querySelector<HTMLElement>('[data-bot-work-toggle]')?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div ref={anchor} className="relative z-30 h-0 shrink-0" data-bot-work-tray="">
      <BotWorkPanelView
        work={work}
        failed={failed}
        historyOpen={historyOpen}
        onToggleHistory={() => publish({ historyOpen: !historyOpen })}
        onRetry={() => loadBotWork()}
      />
    </div>
  );
}

/**
 * Keeps the tray in a conversation with the bot current (see the note at
 * the top). `newsKey` is the newest message the bot sent in this DM.
 * Renders nothing.
 */
export function BotWorkSync({ conversationId, newsKey }: { conversationId: number; newsKey: number | null }) {
  const { open, work } = useBotWork();
  const working = !!work && work.now.length > 0;
  // The newest bot message already accounted for. Null until this
  // conversation's transcript has drawn one: the first value it shows is
  // what was there when the read below was made, not news.
  const seenNews = useRef<number | null>(null);

  // Another conversation is another tray: its panel starts shut and it reads
  // afresh. The one ordinary read: what the worker kept is a fine first
  // paint, and its late correction reads it again (store.ts resync).
  useEffect(() => {
    resetBotWork();
    seenNews.current = null;
    loadBotWork({ fresh: false });
  }, [conversationId]);

  // The bot's news here moves its work on.
  useEffect(() => {
    if (newsKey === null || seenNews.current === newsKey) return;
    const first = seenNews.current === null;
    seenNews.current = newsKey;
    if (!first) loadBotWork();
  }, [newsKey]);

  useEffect(() => {
    const changed = () => loadBotWork();
    window.addEventListener(WORK_CHANGED_EVENT, changed);
    return () => window.removeEventListener(WORK_CHANGED_EVENT, changed);
  }, []);

  // #8 (WP3): while the bot has work in hand, and only while the page is in
  // view, again every POLL_MS: the plan starting after the read, a check
  // finishing, are steps nothing announces.
  useEffect(() => {
    if (!working) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') loadBotWork();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [working]);

  // Opening the panel reads it fresh; leaving the DM shuts it.
  useEffect(() => { if (open) loadBotWork(); }, [open]);
  useEffect(() => () => setBotWorkOpen(false), []);

  return null;
}
