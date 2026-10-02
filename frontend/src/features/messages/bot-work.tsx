import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';

import { Button } from '@/components/ui/button';
import { ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { ChevronDownIcon, XIcon } from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { agoStamp } from '../../lib/timestamp';
import * as api from './api';
import { recordObjectOrigin } from './format';
import type {
  ConversationMessage, HomeroomBotCurrentJob, HomeroomBotJob, HomeroomBotOutcome, HomeroomBotPhase, HomeroomBotWork,
} from './types';

/*
 * #3692: the activity tray at the top of the Homeroom bot's DM.
 *
 * The DM carries the bot's news one message at a time. This is the state in
 * between, read from the platform's records of its work for the viewer and
 * nobody else (services/homeroom-bot-tray.js):
 *
 *   - a compact STRIP pinned above the transcript while the bot is working on
 *     something of theirs — "Working on: Ear Trainer first version ·
 *     building" — and nothing at all while it is not;
 *   - tapping it opens the PANEL under it: what it is doing now, and the
 *     history of what it did before (the request, what came of it, when),
 *     each row a link to its proposal or its request. The ⋯ menu's
 *     "Activity" opens the same panel when nothing is in flight.
 *
 * WHEN IT READS AGAIN. The same realtime Messages already runs on: the
 * bot's news landing in this DM (a new message from it, which the store
 * reloads the thread for; the thread hands its newest id down as `newsKey`),
 * and the live loop starting or finishing work for this person, which
 * reaches every one of their tabs as `homeroom_bot_work_changed` and which
 * public/js/app.js turns into the window event below (as it does after a
 * socket reconnects). Like every conversation event, it carries no data: the
 * tray re-reads its endpoint under the viewer's own session.
 *
 * OWNERSHIP. Every node here is React's, inside the thread pane React already
 * owns; nothing outside writes into it. It renders nothing until its first
 * read lands (data loads in an effect), so a first render matches whatever
 * was drawn before.
 */

/** public/js/app.js dispatches this on `homeroom_bot_work_changed` and on a socket reconnect. */
export const WORK_CHANGED_EVENT = 'homeroom-bot-work-changed';
const PANEL_ID = 'messages-bot-work-panel';

// ── Open or closed: the strip and the header's ⋯ menu share it ───────────

let panelOpen = false;
const listeners = new Set<() => void>();

export function setBotWorkOpen(open: boolean): void {
  if (panelOpen === open) return;
  panelOpen = open;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function useBotWorkOpen(): boolean {
  return useSyncExternalStore(subscribe, () => panelOpen, () => false);
}

// ── Words ────────────────────────────────────────────────────────────────

export const PHASE_LABELS: Record<HomeroomBotPhase, string> = {
  looking: 'looking at it',
  building: 'building',
  following_up: 'following up on its proposal',
  setting_up: 'getting the project ready',
};

export const OUTCOME_LABELS: Record<HomeroomBotOutcome, string> = {
  question: 'Asked you a question',
  ready: 'Started building it',
  proposed: 'Built it and opened a proposal',
  live: 'Built it; approved and live',
  closed: 'Built it; the proposal was closed',
  build_failed: 'Couldn’t finish building it',
  person: 'Left it for the group to decide',
  empty: 'Found nothing to build yet',
  failed: 'Couldn’t finish looking at it',
  answer: 'Answered on its proposal',
  revise: 'Changed its proposal',
};

function capitalized(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "Ear Trainer first version", "Ear Trainer #12": what the strip names. */
export function jobName(job: HomeroomBotJob): string {
  if (job.firstVersion) return `${job.appName} first version`;
  return job.issueNumber ? `${job.appName} #${job.issueNumber}` : job.appName;
}

/** A row's title: the name, and the request's own title when it has one. */
export function jobTitle(job: HomeroomBotJob): string {
  const name = jobName(job);
  return !job.firstVersion && job.title ? `${name}: ${job.title}` : name;
}

/** The strip's one line: "Working on: Ear Trainer first version · building". */
export function trayLine(now: HomeroomBotCurrentJob[]): string {
  const job = now[0];
  return job ? `Working on: ${jobName(job)} · ${PHASE_LABELS[job.phase]}` : '';
}

/** The id of the newest message the bot sent here: its news moves its work on. */
export function newestBotMessageId(messages: ConversationMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender.bot && message.id > 0) return message.id;
  }
  return null;
}

// ── The view ─────────────────────────────────────────────────────────────

function JobRow({ job, subtitle, kind }: { job: HomeroomBotJob; subtitle: string; kind: 'now' | 'history' }) {
  if (!job.href) {
    return <ListRow data-bot-work-row={kind} title={jobTitle(job)} subtitle={subtitle} chevron={false} />;
  }
  const href = job.href;
  return (
    <ListRow
      data-bot-work-row={kind}
      as="a"
      href={href}
      title={jobTitle(job)}
      subtitle={subtitle}
      onClick={(event: MouseEvent<HTMLElement>) => recordObjectOrigin(event as MouseEvent<HTMLAnchorElement>, href)}
    />
  );
}

function PanelNote({ children }: { children: string }) {
  return <p className="px-4 pb-3 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{children}</p>;
}

export interface BotWorkTrayViewProps {
  /** Null until the first read lands. */
  work: HomeroomBotWork | null;
  /** The last read failed (what was read before stays drawn). */
  failed?: boolean;
  open: boolean;
  onToggle?: () => void;
  onClose?: () => void;
  onRetry?: () => void;
  /** For a test: the moment "4m ago" is counted from. */
  now?: Date;
}

/**
 * The tray itself, from what was read: a pure render, so a test can draw
 * every state. Nothing at all when nothing is in flight and the panel is
 * shut.
 */
export function BotWorkTrayView({ work, failed = false, open, onToggle, onClose, onRetry, now }: BotWorkTrayViewProps) {
  const current = work?.now || [];
  if (!current.length && !open) return null;
  const more = current.length - 1;
  const ago = (value: string | null) => agoStamp(value, now ? { now } : {}).text;
  return (
    <div className="shrink-0" data-bot-work-tray="">
      {current.length ? (
        <button
          type="button"
          className="mx-4 mb-2 flex items-center gap-3 rounded-2xl bg-[color:var(--brand-tint)] px-4 py-2.5 text-left text-[color:var(--brand-ink)]"
          aria-expanded={open}
          aria-controls={PANEL_ID}
          data-bot-work-strip=""
          onClick={onToggle}
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full rounded-full bg-[color:var(--accent)] opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[color:var(--accent)]" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.875rem] font-[650]">{trayLine(current)}</span>
          {more > 0 ? <span className="shrink-0 text-[0.8125rem] font-semibold opacity-80">{`+${more} more`}</span> : null}
          <ChevronDownIcon className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      ) : null}
      {open ? (
        <section
          id={PANEL_ID}
          className="mx-4 mb-2 max-h-[min(55vh,28rem)] overflow-y-auto overscroll-contain rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900"
          aria-label="Homeroom bot activity"
          data-bot-work-panel=""
        >
          <div className="flex items-center gap-2 px-4 pt-3">
            <h2 className="min-w-0 flex-1 truncate text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100">What I’m doing for you</h2>
            <Button
              type="button"
              variant="pillNeutral"
              size="icon"
              ink="neutral"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center"
              aria-label="Close activity"
              onClick={onClose}
            >
              <XIcon className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          {!work ? (
            failed ? (
              <div className="flex items-center gap-3 px-4 py-3" role="alert">
                <span className="min-w-0 flex-1 text-[0.8125rem] text-zinc-500 dark:text-zinc-400">Couldn’t load what I’m working on.</span>
                <Button type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={onRetry}>Try again</Button>
              </div>
            ) : (
              <SkeletonGroup label="Loading activity" className="space-y-4 px-4 py-4">
                {[0, 1, 2].map((key) => (
                  <div key={key} className="space-y-2">
                    <Skeleton className="w-2/3" />
                    <Skeleton shape="muted" className="w-1/3" />
                  </div>
                ))}
              </SkeletonGroup>
            )
          ) : (
            <>
              <SectionHeader className="pt-3">Now</SectionHeader>
              {current.length ? (
                <div>
                  {current.map((job, index) => (
                    <JobRow
                      key={`${job.appSlug || job.appName}-${job.issueNumber || 'first'}-${index}`}
                      job={job}
                      kind="now"
                      subtitle={[capitalized(PHASE_LABELS[job.phase]), ago(job.since)].filter(Boolean).join(' · ')}
                    />
                  ))}
                </div>
              ) : <PanelNote>I’m not working on anything for you right now.</PanelNote>}
              <SectionHeader className="pt-4">History</SectionHeader>
              {work.history.length ? (
                <div className="pb-2">
                  {work.history.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      kind="history"
                      subtitle={[OUTCOME_LABELS[job.outcome], ago(job.at)].filter(Boolean).join(' · ')}
                    />
                  ))}
                </div>
              ) : <PanelNote>Nothing yet. When I work on a request of yours, it shows up here.</PanelNote>}
              {failed ? <PanelNote>Couldn’t refresh this just now; it may be out of date.</PanelNote> : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * The tray in a conversation with the bot: reads the viewer's work and keeps
 * it current (see the note at the top). `newsKey` is the newest message the
 * bot sent in this DM.
 */
export function BotWorkTray({ conversationId, newsKey }: { conversationId: number; newsKey: number | null }) {
  const open = useBotWorkOpen();
  const [work, setWork] = useState<HomeroomBotWork | null>(null);
  const [failed, setFailed] = useState(false);
  // Only the newest read may land: an older one finishing late is dropped.
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    api.getHomeroomBotWork().then((next) => {
      if (mine !== seq.current) return;
      setWork(next);
      setFailed(false);
    }).catch(() => {
      if (mine === seq.current) setFailed(true);
    });
  }, []);

  // The newest bot message already accounted for. Null until this
  // conversation's transcript has drawn one: the first value it shows is
  // what was there when the read below was made, not news.
  const seenNews = useRef<number | null>(null);

  // Another conversation is another tray: its panel starts shut and it reads afresh.
  useEffect(() => {
    setBotWorkOpen(false);
    setWork(null);
    setFailed(false);
    seenNews.current = null;
    load();
  }, [conversationId, load]);

  // The bot's news here moves its work on.
  useEffect(() => {
    if (newsKey === null || seenNews.current === newsKey) return;
    const first = seenNews.current === null;
    seenNews.current = newsKey;
    if (!first) load();
  }, [newsKey, load]);

  useEffect(() => {
    const changed = () => load();
    window.addEventListener(WORK_CHANGED_EVENT, changed);
    return () => window.removeEventListener(WORK_CHANGED_EVENT, changed);
  }, [load]);

  // Opening the panel reads it fresh; leaving the DM shuts it.
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => () => setBotWorkOpen(false), []);

  return (
    <BotWorkTrayView
      work={work}
      failed={failed}
      open={open}
      onToggle={() => setBotWorkOpen(!open)}
      onClose={() => setBotWorkOpen(false)}
      onRetry={load}
    />
  );
}
