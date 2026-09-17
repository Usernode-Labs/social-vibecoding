'use strict';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, send } from './api.ts';
import { BTN, PANEL_CLS } from './tokens.ts';
import {
  Badge, CheckField, EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, FormSection,
  Input, List, Options, Panel, ScreenHeader, Select, Skeleton, Textarea, fmt,
} from './ui.tsx';
import type { Column } from './ui.tsx';

// Challenge scoring — the rules that credit season challenges automatically,
// and the controls for the service that applies them.
//
// ── What an admin does here ────────────────────────────────────────────
//
// Adds a rule: a name, one MEASURE from the list the platform implements,
// and the challenge it pays into. Target and Points are left blank unless the
// challenge's own numbers cannot be used, so the figures a participant reads
// on the card are the figures they are paid by.
//
// The reason a rule is or is not scoring right now is a column, not a thing
// to go and work out: "window has not started" and "no target" are the two
// mistakes that actually get made, and without saying so the screen would
// just show silence.
//
// Dry run is the safety net worth having before a live season — it does every
// read and every calculation, spends no grading calls, writes nothing, and
// reports exactly what Run now would pay.
//
// ── How it scores, and how often ───────────────────────────────────────
//
// The list says how often each rule runs. The rule's own panel says what a
// run of it DOES — the tables it reads, the statement it executes, whether a
// model is called and with which rubric — shown in full rather than behind a
// toggle, because it is the thing an operator needs in front of them at the
// moment they choose the interval just below it. Both come from the server,
// taken from the code that runs (services/topochain/challenge-anatomy.js), so
// the panel cannot describe a scorer that no longer exists.

type Measure = {
  key: string;
  label: string;
  summary: string;
  phrase: string;
  payout: string;
  target_unit: string | null;
  needs_target: boolean;
  counted: boolean;
  graded: boolean;
  windowed: boolean;
};

// Only the fields this screen reads. The template list carries the whole
// challenge definition; what the form needs from it is the name to show, the
// numbers it would inherit, and the category to tell two similar goals apart.
type Template = {
  id: number;
  goal: string;
  category: string;
  reward: string | null;
  metric_target: number | null;
};

// The server's reward parser, in the one place the client genuinely needs the
// same answer: showing the operator which number a blank Points field will
// use. Kept deliberately strict and identical in behaviour — anything that is
// not confidently one number reads as "not a plain number" here too, which is
// exactly when the Points field has to be filled in.
function parseReward(reward: string | null): number | null {
  if (reward == null) return null;
  const cleaned = String(reward).trim()
    .replace(/^up\s+to\s+/i, '')
    .replace(/\s*(?:pts?|points?)\s*$/i, '')
    .replace(/,/g, '')
    .trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

type Cover = {
  challenge_id: number;
  goal: string | null;
  target: number | null;
  points: number | null;
  window_start: string | null;
  window_end: string | null;
  skipped: string | null;
};

type Rule = {
  id: number;
  name: string;
  measure: string;
  challenge_template_id: number | null;
  challenge_id: number | null;
  bound_to: { kind: string; label: string };
  target: number | null;
  points: number | null;
  enabled: boolean;
  notes: string | null;
  covers: Cover[];
  // The rule's own interval (null follows the default), the one it really
  // runs on (null when the schedule is off), and when it last ran to its end
  // and is next due.
  interval_minutes: number | null;
  effective_interval_minutes: number | null;
  last_scored_at: string | null;
  next_due_at: string | null;
  last_pass: LastPass | null;
};

// What the rule's last pass cost, measured by the scorer and kept on the rule.
type LastPass = {
  at: string;
  ms: number;
  candidates: number;
  credits: number;
  points?: number;
  graded?: number;
  rejected?: number;
  error?: string;
  cut_short?: boolean;
  idle?: string;
};

type AnatomyStep = {
  kind: string;
  title: string;
  text: string;
  tables?: string[];
  sql?: string;
  note?: string;
  model?: string;
  rubric?: string | null;
};

type Anatomy = { measure: string; lane: 'sql' | 'sql_model'; cost: string; steps: AnatomyStep[] };

type Run = {
  id: number;
  started_at: string | null;
  finished_at: string | null;
  trigger: string;
  dry_run: boolean;
  credits: number;
  summary: any;
  error: string | null;
};

type Schedule = {
  interval_minutes: number;
  interval_choices: number[];
  aggregate_hours: number;
  grading_configured: boolean;
};

type Payload = { measures: Measure[]; rules: Rule[]; runs: Run[]; schedule: Schedule };

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

// How the service is set up right now, in one line each. The grading row is
// the one that matters in practice: with no key the two graded challenges
// quietly wait instead of failing, and an operator needs to be told that
// rather than discover it from an empty week.
function ScheduleCard({ schedule, write, busy, onRun }: {
  schedule: Schedule | null;
  write: boolean;
  busy: boolean;
  onRun: (dryRun: boolean) => void;
}) {
  if (!schedule) return null;
  const off = !schedule.interval_minutes;
  return (
    <div
      id="admin-topo-cs-schedule"
      className={`${PANEL_CLS} mb-4 flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:px-5`}
    >
      <div className="min-w-0">
        <div className="font-semibold">
          {off ? 'Scoring runs only when you press Run now' : 'Each rule runs on its own interval'}
        </div>
        <p className="mt-1 text-zinc-500 dark:text-zinc-400">
          {off ? '' : `One that does not set its own runs ${everyLabel(schedule.interval_minutes).toLowerCase()}. `}
          {schedule.aggregate_hours
            ? `Standings are rebuilt at most every ${schedule.aggregate_hours} hours after a run. `
            : 'Standings are rebuilt only from the Aggregate button. '}
          {schedule.grading_configured
            ? 'Graded challenges are being scored.'
            : 'Graded challenges are waiting: no model key is configured, so accepted proposals and feedback are left uncredited until one is.'}
        </p>
      </div>
      {/* The two controls that act on the SERVICE this card describes, rather
          than on the list below it. They sat in the screen header, which put
          "press Run now" and the button it names at opposite ends of the
          page. New rule stays up there: it makes a rule, not a run. */}
      {write ? (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <button
            id="admin-topo-cs-dry-run"
            type="button"
            className={BTN.secondarySm}
            disabled={busy}
            onClick={() => onRun(true)}
          >
            Dry run
          </button>
          <button
            id="admin-topo-cs-run"
            type="button"
            className={BTN.warnSm}
            disabled={busy}
            onClick={() => onRun(false)}
          >
            {busy ? 'Running…' : 'Run now'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// The runs behind the newest one.
//
// The API has always returned the last ten; the screen showed one and dropped
// the rest. That is the difference between "the scorer ran" and "the scorer is
// running", and it is the question an operator actually has — a service that
// ticks every ten minutes is trusted by its rhythm, not by its latest line. A
// row of quiet zeroes is the healthy state, and seeing nine of them is how you
// know the one credit above is new rather than stuck.
//
// Collapsed by default: it is reassurance, not the headline.
function RunHistory({ runs }: { runs: Run[] }) {
  const rest = runs.slice(1);
  if (!rest.length) return null;
  return (
    <details id="admin-topo-cs-run-history" className="mt-3">
      <summary className="cursor-pointer text-xs text-zinc-600 hover:underline dark:text-zinc-300">
        {`Earlier runs (${rest.length})`}
      </summary>
      <ul className="mt-2 space-y-1">
        {rest.map((r) => (
          <li key={r.id} className="flex flex-wrap gap-x-2 text-xs text-zinc-600 dark:text-zinc-300">
            <span className="tabular-nums">{fmt(r.started_at)}</span>
            <span>
              {r.dry_run ? 'dry run, ' : ''}
              {plural(r.credits, 'credit')}
            </span>
            {r.error ? <span className="text-red-700 dark:text-red-400">{r.error}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

// One run, unpacked. The summary is the same shape a dry run produces, which
// is what lets the preview and the history share this component.
function RunDetail({ run }: { run: Run | null }) {
  if (!run) return null;
  const rows: any[] = Array.isArray(run.summary?.challenges) ? run.summary.challenges : [];
  const scored = rows.filter((r) => r.credits > 0 || r.to_grade > 0);
  const skipped = rows.filter((r) => r.skipped);
  return (
    <div className="text-xs text-zinc-600 dark:text-zinc-300">
      {run.error ? <p className="text-red-700 dark:text-red-400">{run.error}</p> : null}
      {run.summary?.grading ? (
        <p className="text-amber-700 dark:text-amber-400">{`Grading stopped: ${run.summary.grading}`}</p>
      ) : null}
      {scored.length ? (
        <ul className="list-disc ml-5 mt-1">
          {scored.map((r) => (
            <li key={`${r.rule_id}-${r.challenge_id}`}>
              {`${r.goal || r.rule}: ${plural(r.credits, 'credit')}`}
              {r.points ? `, ${r.points} pts` : ''}
              {r.to_grade ? `, ${r.to_grade} waiting to be graded` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {skipped.length ? (
        <ul className="list-disc ml-5 mt-1 text-zinc-500 dark:text-zinc-400">
          {skipped.map((r) => (
            <li key={`${r.rule_id}-${r.challenge_id}-s`}>{`${r.goal || r.rule}: ${r.skipped}`}</li>
          ))}
        </ul>
      ) : null}
      {!scored.length && !skipped.length && !run.error
        ? <p className="text-zinc-500 dark:text-zinc-400">Nothing to credit.</p>
        : null}
    </div>
  );
}

// "Every 2 min", in the one place it is phrased. The two ends of the list
// read better as words than as "every 1 min" and "every 60 min".
function everyLabel(minutes: number): string {
  if (minutes === 1) return 'Every minute';
  if (minutes === 60) return 'Every hour';
  return `Every ${minutes} min`;
}

// A clock for the relative times on this screen. Thirty seconds is as fine as
// "in about 3 min" can be wrong by, and coarse enough to cost nothing.
function useNow(everyMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const aboutMinutes = (ms: number) => {
  const mins = Math.max(1, Math.round(ms / 60000));
  return `${mins} min`;
};

// The list's "Runs" cell: how often, and the one fact that says the schedule
// is alive. Overdue is its own state and an amber one — a rule three beats
// late is the scheduler being stuck, which is exactly what this column is the
// first place to show.
function RunsCell({ rule, now }: { rule: Rule; now: number }) {
  if (!rule.enabled) return <span className="text-zinc-500 dark:text-zinc-400">—</span>;
  if (rule.effective_interval_minutes == null) {
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">Only from Run now</span>;
  }
  const next = rule.next_due_at ? Date.parse(rule.next_due_at) : null;
  let when = 'not run yet';
  let late = false;
  if (next != null) {
    if (next > now) when = `next in about ${aboutMinutes(next - now)}`;
    else if (now - next < 3 * 60000) when = 'due now';
    else { when = `overdue since ${fmt(rule.next_due_at)}`; late = true; }
  }
  return (
    <>
      <span className="whitespace-nowrap">{everyLabel(rule.effective_interval_minutes)}</span>
      <span className={`block mt-0.5 text-xs ${late ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
        {rule.interval_minutes == null ? 'default · ' : ''}
        {when}
      </span>
    </>
  );
}

// The anatomy's prose names tables and columns in backticks; draw those as
// code rather than shipping markup from the server.
function withCode(text: string) {
  return text.split('`').map((part, i) => (i % 2
    ? <code key={i} className="font-mono text-[0.92em] text-zinc-700 dark:text-zinc-200">{part}</code>
    : <span key={i}>{part}</span>));
}

const CODE_BLOCK = 'mt-2 overflow-x-auto rounded-lg bg-zinc-50 dark:bg-zinc-950 p-3 font-mono text-xs '
  + 'leading-relaxed text-zinc-700 dark:text-zinc-300';

function passLine(pass: LastPass): string {
  const took = pass.ms >= 1000 ? `${(pass.ms / 1000).toFixed(1)} s` : `${pass.ms} ms`;
  if (pass.idle) return `Last pass ${fmt(pass.at)}: ${pass.idle}.`;
  const parts = [`read ${pass.candidates.toLocaleString()}`];
  if (pass.rejected) parts.push(`dropped ${pass.rejected} as junk`);
  if (pass.graded) parts.push(`graded ${pass.graded}`);
  parts.push(`wrote ${plural(pass.credits, 'credit')}`);
  return `Last pass ${fmt(pass.at)} took ${took}: ${parts.join(', ')}.`;
}

// How a run of this rule works, in full. Fetched rather than carried on the
// rule because it follows the form as it is being edited: change the measure
// and the steps change, change the points and the rubric's bands change —
// and the rubric is the grader's own function called with those numbers,
// which only the server can do.
function HowItScores({ anatomy, lastPass }: { anatomy: Anatomy | null; lastPass: LastPass | null }) {
  if (!anatomy) return <Skeleton rows={3} />;
  return (
    <div id="admin-topo-cs-f-anatomy" className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          label={anatomy.lane === 'sql_model' ? 'SQL + model' : 'SQL only'}
          tone={anatomy.lane === 'sql_model' ? 'violet' : 'zinc'}
        />
        {lastPass ? (
          <span id="admin-topo-cs-f-last-pass" className="text-xs text-zinc-500 dark:text-zinc-400">
            {passLine(lastPass)}
          </span>
        ) : null}
      </div>
      {lastPass?.error ? (
        <p className="mt-1 text-xs text-red-700 dark:text-red-400">{`The measure query failed: ${lastPass.error}`}</p>
      ) : null}
      {lastPass?.cut_short ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          Cut short by the run's shared budget. It goes first on the next beat.
        </p>
      ) : null}
      <ol className="mt-3 space-y-4">
        {anatomy.steps.map((step, i) => (
          <li key={step.kind} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
            <span className="tabular-nums text-xs leading-5 text-zinc-500 dark:text-zinc-400">{i + 1}</span>
            <div className="min-w-0">
              <div className="font-medium leading-5">
                {step.title}
                {step.tables?.length ? (
                  <span className="ml-2 font-mono text-xs font-normal text-zinc-500 dark:text-zinc-400">
                    {step.tables.join(' · ')}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                {withCode(step.text)}
                {step.note ? ` ${step.note}` : ''}
              </p>
              {step.sql ? <pre className={`${CODE_BLOCK} whitespace-pre`}>{step.sql}</pre> : null}
              {step.rubric ? (
                <>
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {`The rubric ${step.model || 'the model'} is sent with every one:`}
                  </p>
                  <pre className={`${CODE_BLOCK} whitespace-pre-wrap`}>{step.rubric}</pre>
                </>
              ) : null}
              {step.kind === 'grade' && !step.rubric ? (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  The rubric appears once the rule has points and a target: its bands are worked out from them.
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// The rule, read back as a sentence while it is being written.
//
// This is the part that makes the form composable rather than fillable: seven
// inputs with labels tell you what you are typing, but not what the thing you
// are building will DO. The payout shape in particular is invisible in the
// fields — "500 pts, target 3" does not say whether that is 500 each or 500
// for the set, and those differ by 1,000 points a person.
//
// The phrase comes from the server's measure catalogue, so it cannot drift
// from the behaviour it describes. Only the arithmetic below is local, and
// only for display.
// "1 credit(s)" is a form field's plural, not a sentence's. An operator reads
// this line to find out what a tick did; it should read like something a
// person wrote.
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function payoutClause({ measure, points, target }: {
  measure: Measure | null;
  points: number | null;
  target: number | null;
}): string | null {
  if (!measure) return null;
  const n = target && target > 0 ? target : null;
  const phrase = (measure.phrase || '').replace('{target}', n == null ? 'enough' : String(n));
  if (points == null) {
    return 'nothing yet: the reward is not a plain number, so fill in Points.';
  }
  const pts = (v: number) => `${Math.round(v).toLocaleString()} pts`;
  const share = n ? Math.floor(points / n) : points;
  switch (measure.payout) {
    case 'per_unit':
      // `for all ${n}` reads as a placeholder that nobody filled in when n is
      // two, which is every case this measure actually has today.
      return `credits ${pts(share)} an account, ${pts(points)} ${n === 2 ? 'for both' : `for all ${n}`}.`;
    case 'graded':
      return `credits up to ${pts(share)} each time someone ${phrase}, up to ${n} per window. `
        + `${pts(points)} at most, and a model grades each one.`;
    case 'on_target':
      return `credits ${pts(points)} once someone ${phrase}. Nothing before that.`;
    default:
      return `credits ${pts(points)} when someone ${phrase}.`;
  }
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The form's version leads with the challenge, rather than splicing it in
// after the phrase. Several phrases end in a preposition ("sends a report
// worth acting on"), so the other order produces "acting on on Send useful
// feedback".
function ruleSentence({ measure, points, target, challenge }: {
  measure: Measure | null;
  points: number | null;
  target: number | null;
  challenge: string | null;
}): string | null {
  const clause = payoutClause({ measure, points, target });
  if (clause == null) return null;
  return challenge
    ? `${challenge}: ${clause}`
    : `${capitalise(clause)} Pick the challenge it pays into.`;
}

// The rule's panel: what it is, how a run of it works, how often it runs, and
// — for somebody who can write — the fields that change any of that. A
// view-only admin gets the same panel with the fields switched off, because
// "how does this rule score" is a question every reader of this screen has,
// not only the ones allowed to edit it.
function RuleForm({
  existing, measures, templates, schedule, readOnly, onClose, onSaved,
}: {
  existing: Rule | null;
  measures: Measure[];
  templates: Template[];
  schedule: Schedule | null;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = existing == null;
  const [name, setName] = useState(existing?.name || '');
  // Whether the name is the operator's own words. Until it is, picking a
  // challenge fills it in — the name is bookkeeping, and making somebody
  // invent one before they can save is the kind of friction that turns a
  // form into a chore.
  const [nameTouched, setNameTouched] = useState(!!existing?.name);
  const [measure, setMeasure] = useState(existing?.measure || (measures[0]?.key || ''));
  const [templateId, setTemplateId] = useState(
    existing?.challenge_template_id != null ? String(existing.challenge_template_id) : ''
  );
  const [challengeId, setChallengeId] = useState(
    existing?.challenge_id != null ? String(existing.challenge_id) : ''
  );
  // One choice, not two competing fields. The old form put a template picker
  // beside a bare id box joined by "…or", which asks the reader to work out
  // that filling one forbids the other.
  const [scope, setScope] = useState<'template' | 'challenge'>(
    existing?.challenge_id != null ? 'challenge' : 'template'
  );
  const [target, setTarget] = useState(existing?.target != null ? String(existing.target) : '');
  const [points, setPoints] = useState(existing?.points != null ? String(existing.points) : '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const [enabled, setEnabled] = useState(existing ? existing.enabled : true);
  // '' follows the default. A string because it is a <select>'s value.
  const [interval, setIntervalChoice] = useState(
    existing?.interval_minutes != null ? String(existing.interval_minutes) : ''
  );
  const [error, setError] = useState<string | null>(null);

  const spec = measures.find((m) => m.key === measure) || null;
  const template = templates.find((t) => String(t.id) === templateId) || null;

  // What the rule will actually use: the operator's number, or the
  // challenge's own. Shown as the input's PLACEHOLDER, so "blank means
  // inherit" is something you can see rather than a sentence of help text
  // below an empty box.
  const inheritedTarget = template?.metric_target ?? null;
  const inheritedPoints = template ? parseReward(template.reward) : null;
  const effTarget = target.trim() !== '' ? Number(target) : inheritedTarget;
  const effPoints = points.trim() !== '' ? Number(points) : inheritedPoints;

  // A rule bound to one challenge has no template to inherit from here, so
  // its numbers come from the challenge it is covering right now.
  const cover = existing?.covers?.[0] || null;
  const shownTarget = effTarget ?? (scope === 'challenge' ? cover?.target ?? null : null);
  const shownPoints = effPoints ?? (scope === 'challenge' ? cover?.points ?? null : null);

  // How a run of this rule works, for the numbers as they stand. Debounced:
  // Points and Target are typed a digit at a time, and each digit is a
  // different rubric.
  const [anatomy, setAnatomy] = useState<Anatomy | null>(null);
  useEffect(() => {
    if (!measure) { setAnatomy(null); return undefined; }
    let live = true;
    const timer = setTimeout(async () => {
      const query = new URLSearchParams({ measure });
      if (shownPoints != null && shownPoints > 0) query.set('points', String(shownPoints));
      if (shownTarget != null && shownTarget > 0) query.set('target', String(shownTarget));
      const { ok, data } = await fetchJson(`/api/v4/admin/challenge-scoring/anatomy?${query}`);
      if (live) setAnatomy(ok && data?.success ? data.data : null);
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [measure, shownPoints, shownTarget]);

  const pickTemplate = useCallback((value: string) => {
    setTemplateId(value);
    if (value) setChallengeId('');
    if (!nameTouched) {
      const picked = templates.find((t) => String(t.id) === value);
      setName(picked?.goal || '');
    }
  }, [nameTouched, templates]);

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    if (!name.trim()) { setError('Give the rule a name.'); return; }
    if (!measure) { setError('Pick what to measure.'); return; }
    const boundTemplate = scope === 'template' ? templateId : '';
    const boundChallenge = scope === 'challenge' ? challengeId : '';
    if (!boundTemplate && !boundChallenge) {
      setError(scope === 'template'
        ? 'Pick the challenge template this rule pays into.'
        : 'Type the id of the challenge this rule pays into.');
      return;
    }
    const body = {
      name: name.trim(),
      measure,
      challenge_template_id: boundTemplate ? Number(boundTemplate) : null,
      challenge_id: boundChallenge ? Number(boundChallenge) : null,
      target: target.trim() === '' ? null : Number(target),
      points: points.trim() === '' ? null : Number(points),
      notes: notes.trim() === '' ? null : notes.trim(),
      enabled,
      interval_minutes: interval === '' ? null : Number(interval),
    };
    const url = isNew
      ? '/api/v4/admin/challenge-scoring/rules'
      : `/api/v4/admin/challenge-scoring/rules/${existing.id}`;
    const { ok, data } = await send(isNew ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) {
      const detail = data?.details ? Object.values(data.details)[0] : null;
      setError((Array.isArray(detail) ? detail[0] : null) || data?.error || 'Save failed.');
      return;
    }
    onSaved();
  }, [name, measure, scope, templateId, challengeId, target, points, notes, enabled, interval, isNew, existing, onSaved]);

  const sentence = ruleSentence({
    measure: spec,
    points: effPoints,
    target: effTarget,
    challenge: scope === 'template' ? (template?.goal || null) : (challengeId ? `challenge #${challengeId}` : null),
  });

  const defaultMinutes = schedule?.interval_minutes || 0;
  const choices = schedule?.interval_choices || [];
  // The rule's pass is only this rule's while the measure is still the one it
  // ran with; pick another and the numbers describe something else.
  const lastPass = existing && existing.measure === measure ? existing.last_pass : null;

  return (
    <Panel
      title={isNew ? 'New scoring rule' : readOnly ? existing.name : `Edit ${existing.name}`}
      subtitle={readOnly
        ? 'What it measures, how a run of it works, and how often it runs.'
        : 'Pick what to measure and which challenge it pays into.'}
      onClose={onClose}
      closeLabel="Close the rule form"
      footer={readOnly
        ? <button type="button" className={BTN.secondary} onClick={onClose}>Close</button>
        : <FormActions onSave={save} onCancel={onClose} saveLabel="Save rule" />}
    >
      {/* One switch for every field below: a view-only admin reads the same
          panel, and a disabled fieldset is the browser's own way of saying
          these are not theirs to change. `min-w-0` undoes the fieldset's
          min-content width, which would otherwise let the SQL block push the
          panel wider than the screen. */}
      <fieldset disabled={readOnly} className="min-w-0">
      {/* The rule in one sentence, kept live. It is the first thing in the
          panel because it is the only part that says what will happen. */}
      <div
        id="admin-topo-cs-f-sentence"
        className="rounded-xl border border-violet-200 dark:border-violet-900 bg-violet-50/70 dark:bg-violet-950/30 px-4 py-3 text-sm text-violet-900 dark:text-violet-200"
      >
        {sentence || 'Pick what to measure, then the challenge it pays into.'}
      </div>

      <FormSection label="What to measure" />
      <FormGrid>
        <Field label="Measure *" htmlFor="admin-topo-cs-f-measure" help={spec?.summary}>
          <Select
            id="admin-topo-cs-f-measure"
            value={measure}
            onChange={(e) => setMeasure(e.target.value)}
          >
            <Options options={measures.map((m) => ({ value: m.key, label: m.label }))} />
          </Select>
        </Field>
        <Field label="Where the credits go" htmlFor="admin-topo-cs-f-scope">
          <Select
            id="admin-topo-cs-f-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value === 'challenge' ? 'challenge' : 'template')}
          >
            <Options
              options={[
                { value: 'template', label: 'Every challenge from a template' },
                { value: 'challenge', label: 'One challenge only' },
              ]}
            />
          </Select>
        </Field>
        {scope === 'template' ? (
          <Field
            label="Challenge template *"
            htmlFor="admin-topo-cs-f-template"
            help="Covers every challenge stamped from it, including next week's."
            className="md:col-span-2"
          >
            <Select
              id="admin-topo-cs-f-template"
              value={templateId}
              onChange={(e) => pickTemplate(e.target.value)}
            >
              <Options
                options={templates.map((t) => ({ value: t.id, label: `${t.goal} (${t.category})` }))}
                blank="Pick a challenge"
              />
            </Select>
          </Field>
        ) : (
          <Field
            label="Challenge id *"
            htmlFor="admin-topo-cs-f-challenge"
            help="Only when one instance should be scored differently from the rest. It stops working when the challenge is next re-created."
            className="md:col-span-2"
          >
            <Input
              id="admin-topo-cs-f-challenge"
              type="number"
              min={1}
              value={challengeId}
              onChange={(e) => { setChallengeId(e.target.value); if (e.target.value) setTemplateId(''); }}
            />
          </Field>
        )}
      </FormGrid>

      <FormSection label="How it scores" />
      <HowItScores anatomy={anatomy} lastPass={lastPass} />

      <FormSection label="How often" />
      <FormGrid>
        <Field
          label="Run this rule"
          htmlFor="admin-topo-cs-f-interval"
          help={defaultMinutes ? anatomy?.cost : 'The schedule is switched off for this deployment, so rules run only from Run now.'}
        >
          <Select
            id="admin-topo-cs-f-interval"
            value={interval}
            onChange={(e) => setIntervalChoice(e.target.value)}
          >
            <Options
              options={choices.map((m) => ({ value: m, label: everyLabel(m) }))}
              blank={defaultMinutes ? `Default (${everyLabel(defaultMinutes).toLowerCase()})` : 'Default'}
            />
          </Select>
        </Field>
      </FormGrid>

      <FormSection label="Numbers" />
      <p className="-mt-1 mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        {template
          ? 'Leave these blank. Filled in, they override what the card promises, so the two stop agreeing.'
          : 'These come from the challenge once you pick one.'}
      </p>
      <FormGrid>
        <Field
          label={`Target${spec?.target_unit ? ` (${spec.target_unit})` : ''}`}
          htmlFor="admin-topo-cs-f-target"
        >
          <Input
            id="admin-topo-cs-f-target"
            type="number"
            min={1}
            step="any"
            disabled={!spec?.target_unit}
            placeholder={inheritedTarget != null ? `${inheritedTarget} (from the challenge)` : 'Not set on the challenge'}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
        <Field label="Points" htmlFor="admin-topo-cs-f-points">
          <Input
            id="admin-topo-cs-f-points"
            type="number"
            min={1}
            step="any"
            placeholder={inheritedPoints != null ? `${inheritedPoints} (from the reward)` : 'The reward is not a plain number'}
            value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
        </Field>
      </FormGrid>

      <FormSection label="Bookkeeping" />
      <FormGrid>
        <Field label="Name *" htmlFor="admin-topo-cs-f-name" help="For this list only. It is never shown to users.">
          <Input
            id="admin-topo-cs-f-name"
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
          />
        </Field>
        <Field label="Notes" htmlFor="admin-topo-cs-f-notes">
          <Textarea
            id="admin-topo-cs-f-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </FormGrid>
      <CheckField
        id="admin-topo-cs-f-enabled"
        label="Score this challenge"
        help="Off keeps the rule and stops the credits. Credits already written stay."
        checked={enabled}
        onChange={setEnabled}
      />
      </fieldset>
      <FormError message={error} />
    </Panel>
  );
}

function ChallengeScoringScreen() {
  const write = canWrite();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  // null = closed, 'new' = the create form, otherwise the rule id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { ok, data, status } = await fetchJson('/api/v4/admin/challenge-scoring');
    if (!alive.current) return;
    if (ok && data?.success) { setPayload(data.data); setError(null); return; }
    setPayload({ measures: [], rules: [], runs: [], schedule: null as any });
    setError({ status, message: (data && data.error) || null });
  }, []);
  useEffect(() => { load(); }, [load]);

  // The Runs column counts down to a time the scorer then acts on, so what it
  // says goes stale at exactly the moment somebody is watching it. One reload
  // shortly after the soonest rule falls due keeps it honest; nothing is
  // polled while nothing is due, and nothing at all in a hidden tab.
  const now = useNow();
  const soonest = (payload?.rules || []).reduce((min: number | null, r) => {
    const at = r.enabled && r.next_due_at ? Date.parse(r.next_due_at) : null;
    return at != null && (min == null || at < min) ? at : min;
  }, null);
  useEffect(() => {
    if (soonest == null) return undefined;
    const wait = Math.max(soonest - Date.now(), 0) + 8000;
    if (wait > 3600000) return undefined;
    const id = setTimeout(() => { if (!document.hidden) load(); }, wait);
    return () => clearTimeout(id);
  }, [soonest, load]);

  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson('/api/v4/admin/challenge-templates?page=1&per_page=100');
      if (!alive.current || !ok || !data?.success || !Array.isArray(data.data)) return;
      setTemplates(data.data.map((t: any) => ({
        id: t.id,
        goal: t.goal,
        category: t.category,
        reward: t.reward ?? null,
        metric_target: t.metric_target == null ? null : Number(t.metric_target),
      })));
    })();
  }, []);

  const run = useCallback(async (dryRun: boolean) => {
    if (!canWrite()) return;
    setBusy(true);
    setPreview(null);
    const { ok, data } = await send('POST', '/api/v4/admin/challenge-scoring/run', { dry_run: dryRun });
    if (!alive.current) return;
    setBusy(false);
    if (!ok || !data?.success) {
      topo()._alert((data && data.error) || 'The run failed.');
      return;
    }
    if (dryRun) {
      setPreview({
        id: data.data.runId, started_at: null, finished_at: null, trigger: 'admin',
        dry_run: true, credits: data.data.credits, summary: data.data, error: null,
      });
    }
    load();
  }, [load]);

  const remove = useCallback(async (rule: Rule) => {
    if (!canWrite()) return;
    const confirmed = await topo()._confirm({
      title: `Delete "${rule.name}"?`,
      message: 'Scoring stops. Credits this rule already wrote stay where they are.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    const res = await send('DELETE', `/api/v4/admin/challenge-scoring/rules/${rule.id}`);
    if (res.ok && res.data?.success) load();
    else topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [load]);

  // One row per rule, and the row says what the rule DOES.
  //
  // It used to take three columns plus a whole second table row to say less
  // than this: "Measures: Tried different apps", "Pays into: Try 3 apps
  // (every instance)", and then a detail line repeating the same challenge
  // with its numbers. Every one of those is in the sentence, which is the
  // same one the form composes — so the list and the editor describe a rule
  // in exactly the same words.
  const measureOf = (r: Rule) => payload?.measures.find((m) => m.key === r.measure) || null;

  const columns: Column<Rule>[] = [
    { label: 'Rule', primary: true, cell: (r) => r.name },
    {
      label: 'What it does',
      cell: (r) => {
        const cover = r.covers[0] || null;
        const clause = payoutClause({
          measure: measureOf(r),
          points: cover ? cover.points : r.points,
          target: cover ? cover.target : r.target,
        });
        return (
          <>
            <span>{clause ? capitalise(clause) : 'Nothing yet.'}</span>
            <span className="block mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {r.bound_to.kind === 'template'
                ? `Every challenge from ${r.bound_to.label}`
                : r.bound_to.label}
              {r.covers.length > 1 ? `, ${r.covers.length} running now` : ''}
            </span>
          </>
        );
      },
      tdClass: 'text-xs',
    },
    // How often the rule runs. What a run of it DOES is in the rule's own
    // panel, not here: the list is for scanning seven rules at once.
    { label: 'Runs', cell: (r) => <RunsCell rule={r} now={now} />, tdClass: 'text-xs' },
    {
      label: 'Status',
      cell: (r) => {
        if (!r.enabled) return <Badge label="Off" tone="zinc" />;
        if (!r.covers.length) return <Badge label="No live challenge" tone="amber" />;
        const live = r.covers.filter((c) => !c.skipped).length;
        if (!live) return <Badge label={r.covers[0].skipped || 'Idle'} tone="amber" />;
        // The count is noise when a rule pays into exactly one challenge,
        // which is every rule until a season runs two events at once.
        return <Badge label={live > 1 ? `Scoring ${live}` : 'Scoring'} tone="green" />;
      },
    },
  ];

  // Only when a rule pays into SEVERAL live challenges at once is there
  // anything the row above has not already said.
  const extra = (r: Rule) => (r.covers.length > 1 ? (
    <ul className="list-disc ml-5 text-xs text-zinc-500 dark:text-zinc-400">
      {r.covers.map((c) => (
        <li key={c.challenge_id}>
          {`${c.goal || `Challenge #${c.challenge_id}`}: `}
          {c.points != null ? `${c.points} pts` : 'no points'}
          {c.target != null ? `, target ${c.target}` : ''}
          {c.skipped ? ` (${c.skipped})` : ' (scoring)'}
        </li>
      ))}
    </ul>
  ) : null);

  const editingRule = editing === 'new'
    ? null
    : (payload?.rules || []).find((r) => String(r.id) === editing) || null;
  const lastRun = payload?.runs?.[0] || null;

  return (
    <>
      <ScreenHeader
        title="Challenge scoring"
        subtitle="Rules that credit season challenges automatically, and the service that applies them."
        actions={write ? (
          <button
            id="admin-topo-cs-new"
            type="button"
            className={BTN.primarySm}
            onClick={() => setEditing('new')}
          >
            New rule
          </button>
        ) : null}
      />

      <ScheduleCard schedule={payload?.schedule || null} write={write} busy={busy} onRun={run} />

      {preview ? (
        <div id="admin-topo-cs-preview" className="mb-4">
          <Panel
            title={`Dry run: ${plural(preview.credits, 'credit')} would be written`}
            subtitle="Nothing was written and no grading was spent."
            onClose={() => setPreview(null)}
            closeLabel="Close the preview"
          >
            <RunDetail run={preview} />
          </Panel>
        </div>
      ) : null}

      <div id="admin-topo-cs-form">
        {editing != null && (write || editingRule) ? (
          <RuleForm
            key={editing}
            existing={editingRule}
            measures={payload?.measures || []}
            templates={templates}
            schedule={payload?.schedule || null}
            readOnly={!write}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); }}
          />
        ) : null}
      </div>

      <div id="admin-topo-cs-rules">
        {payload == null ? <Skeleton rows={3} /> : null}
        {payload && error ? (
          <ErrorState status={error.status} message={error.message} onRetry={load} />
        ) : null}
        {payload && !error && !payload.rules.length ? (
          <EmptyState
            title="No scoring rules yet"
            body={write
              ? 'Nothing is credited automatically until a rule says so. Add one per challenge you want scored.'
              : 'Nothing is credited automatically until a rule says so.'}
            action={write ? (
              <button
                id="admin-topo-cs-empty-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                Add the first rule
              </button>
            ) : null}
          />
        ) : null}
        {payload && !error && payload.rules.length ? (
          <List
            items={payload.rules}
            columns={columns}
            rowKey={(r) => r.id}
            extra={extra}
            actions={(r) => (write ? (
              <>
                <button type="button" className={BTN.row} onClick={() => setEditing(String(r.id))}>
                  Edit
                </button>
                <button type="button" className={BTN.rowDanger} onClick={() => remove(r)}>
                  Delete
                </button>
              </>
            ) : (
              // The same panel, fields switched off: how a rule scores is
              // worth reading whether or not it is yours to change.
              <button type="button" className={BTN.row} onClick={() => setEditing(String(r.id))}>
                View
              </button>
            ))}
          />
        ) : null}
      </div>

      {lastRun ? (
        <div id="admin-topo-cs-last-run" className={`${PANEL_CLS} mt-4 px-4 py-3 sm:px-5`}>
          <div className="text-sm font-semibold">
            {`Last run ${fmt(lastRun.started_at)}`}
            {lastRun.dry_run ? ' (dry run)' : ''}
            {`: ${plural(lastRun.credits, 'credit')}`}
          </div>
          <div className="mt-1">
            <RunDetail run={lastRun} />
          </div>
          <RunHistory runs={payload?.runs || []} />
        </div>
      ) : null}
    </>
  );
}

export { ChallengeScoringScreen };
