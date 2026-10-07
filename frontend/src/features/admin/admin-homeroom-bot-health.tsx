'use strict';

import { AdminUI } from './admin-console.js';

// Rollout health (#admin/homeroom-bot, Overview): before the bot is on for
// everyone, whether it is working, over the last week. The numbers and
// which of them are past their line come from the dashboard's payload
// (services/homeroom-bot-health.js); this file only says them. A figure
// with too little behind it says so instead of passing a verdict, and only
// a figure past its line gets a badge.

type Watch = boolean | null;

export interface RolloutHealthData {
  days: number;
  proposals: {
    up: number; merged: number; closed: number; open: number; settled: number;
    mergeRate: number | null; timed: number;
    medianHoursToProposal: number | null; slowestHoursToProposal: number | null;
  };
  questions: {
    asked: number; answered: number; settledOtherwise: number; waitingOfAsked: number;
    medianMinutesToAnswer: number | null; waiting: number; oldestWaitingAt: string | null;
  };
  turns: { runs: number; failed: number; builds: number; buildsFailed: number };
  chat: { turns: number; failed: number; unanswered: number; recovered: number; claimsCaught: number };
  watch: { mergeRate: Watch; hoursToProposal: Watch; questionsWaiting: Watch; turnFailures: Watch; chatFailures: Watch };
}

// One DM answer that failed on the way, as the payload's dmChat lists the
// last week's (homeroom-bot.js dmChatSummary): codes, never the words.
export interface ChatFailure {
  at: string;
  username: string;
  error: string | null;
  failures: string[];
  fallback: string | null;
  rounds: number;
}

export interface HealthRow {
  key: 'proposals' | 'time' | 'questions' | 'turns' | 'chat';
  label: string;
  value: string;
  detail: string;
  watch: Watch;
  // What to look at when it is past its line, or why there is no verdict.
  note: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A span of hours as a person says it: "40 min", "3 h", "2 d 4 h". Pure. */
export function duration(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return '–';
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const h = Math.round(hours);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const percent = (rate: number | null) => (rate == null ? '–' : `${Math.round(rate * 100)}%`);

/** The panel's rows, from the payload's figures. Pure. */
export function healthRows(h: RolloutHealthData, now: number = Date.now()): HealthRow[] {
  const { proposals: p, questions: q, turns: t, chat: c, watch: w } = h;
  const tooFew = (what: string) => `Too few ${what} to judge yet.`;
  const oldest = q.oldestWaitingAt ? Date.parse(q.oldestWaitingAt) : NaN;
  return [
    {
      key: 'proposals',
      label: 'Its proposals that merged',
      value: percent(p.mergeRate),
      detail: p.up
        ? `${plural(p.up, 'proposal')} put up: ${p.merged} merged, ${p.closed} closed without merging, ${p.open} still open.`
        : 'It put up no proposals.',
      watch: w.mergeRate,
      note: w.mergeRate ? 'Fewer than half of its settled proposals merged. The closed ones say what the groups turned down.'
        : w.mergeRate == null ? tooFew('settled proposals') : '',
    },
    {
      key: 'time',
      label: 'From request to proposal',
      value: duration(p.medianHoursToProposal),
      detail: p.timed
        ? `The median over ${plural(p.timed, 'proposal')}. The slowest took ${duration(p.slowestHoursToProposal)}.`
        : 'No proposal to time yet.',
      watch: w.hoursToProposal,
      note: w.hoursToProposal ? 'Half its proposals took more than a day from the request. The queue and the builds say where the time went.'
        : w.hoursToProposal == null ? tooFew('proposals') : '',
    },
    {
      key: 'questions',
      label: 'Its questions still waiting',
      value: q.asked ? `${q.waitingOfAsked} of ${q.asked}` : '0',
      detail: `${q.answered} answered${q.medianMinutesToAnswer == null ? '' : ` (in ${duration(q.medianMinutesToAnswer / 60)}, the median)`}, ${q.settledOtherwise} settled another way. ${
        q.waiting ? `${plural(q.waiting, 'question')} waiting in all; the oldest was asked ${duration(Number.isNaN(oldest) ? null : (now - oldest) / 3600000)} ago.` : 'None is waiting.'}`,
      watch: w.questionsWaiting,
      note: w.questionsWaiting ? 'More than half of this week\'s questions are still waiting on an answer. Are they hard to answer?'
        : w.questionsWaiting == null ? tooFew('questions') : '',
    },
    {
      key: 'turns',
      label: 'Its turns that failed',
      value: `${t.failed + t.buildsFailed} of ${t.runs + t.builds}`,
      detail: `${t.failed} of ${plural(t.runs, 'triage and follow-up turn')}, ${t.buildsFailed} of ${plural(t.builds, 'build')}. A turn stopped on its budget is not counted.`,
      watch: w.turnFailures,
      note: w.turnFailures ? 'More than 1 in 10 of its turns failed. Verdicts, filtered to Failed, has the errors.'
        : w.turnFailures == null ? tooFew('turns') : '',
    },
    {
      key: 'chat',
      label: 'DM answers it could not write',
      value: `${c.failed} of ${c.turns}`,
      detail: `${c.unanswered} answered by nothing at all, ${c.recovered} answered after a retry, ${c.claimsCaught} said it had done something it had not and were written again.`,
      watch: w.chatFailures,
      note: w.chatFailures ? 'More than 1 in 10 of its DM answers failed. The failures are listed below.'
        : w.chatFailures == null ? tooFew('DM answers') : '',
    },
  ];
}

/** One failed DM answer as a line: when, who, why, what answered. Pure. */
export function failureLine(f: ChatFailure): string {
  const at = new Date(f.at);
  const when = Number.isNaN(at.getTime()) ? '' : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return [
    when,
    `@${f.username}`,
    f.error ? f.error : 'answered after a retry',
    f.failures.length ? f.failures.join(', ') : '',
    f.fallback ? `answered by: ${f.fallback}` : '',
  ].filter(Boolean).join(' · ');
}

export function RolloutHealth({ health, failures }: { health?: RolloutHealthData | null; failures?: ChatFailure[] }) {
  const rows = health ? healthRows(health) : [];
  const flagged = rows.filter((r) => r.watch).length;
  const list = failures || [];
  return (
    <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-rollout">
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>Rollout health</h3>
        <span className={AdminUI.cardDescription} id="admin-homeroom-bot-rollout-summary">
          {!health ? 'Loading…'
            : flagged ? `${plural(flagged, 'figure')} worth a look`
              : `Nothing past its line in the last ${health.days} days`}
        </span>
      </div>
      {health ? (
        <ul className="grid gap-3 md:grid-cols-2" id="admin-homeroom-bot-rollout-rows">
          {rows.map((r) => (
            <li key={r.key} className="rounded-xl bg-zinc-100 dark:bg-zinc-800 p-3" data-rollout={r.key} data-watch={r.watch == null ? 'unknown' : String(r.watch)}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={AdminUI.muted}>{r.label}</span>
                {r.watch ? <span className={AdminUI.badge.warn}>Worth a look</span> : null}
              </div>
              <div className="text-2xl font-semibold mt-0.5 tabular-nums">{r.value}</div>
              <p className={AdminUI.muted}>{r.detail}</p>
              {r.note ? <p className={`${AdminUI.muted} mt-1`}>{r.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <details className="mt-3" id="admin-homeroom-bot-rollout-failures">
        <summary className={`${AdminUI.muted} cursor-pointer`}>
          {list.length ? `DM answers that failed in the last 7 days (${list.length}${list.length >= 20 ? ', the latest' : ''})` : 'No DM answer failed in the last 7 days'}
        </summary>
        {list.length ? (
          <ul className="text-sm space-y-1 mt-2">
            {list.map((f, i) => <li key={`${f.at}-${i}`} className="break-words">{failureLine(f)}</li>)}
          </ul>
        ) : null}
      </details>
    </div>
  );
}
