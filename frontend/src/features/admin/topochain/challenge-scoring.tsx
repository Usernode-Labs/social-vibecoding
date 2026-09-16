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
};

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
          {off ? 'Scoring runs only when you press Run now' : `Scoring runs every ${schedule.interval_minutes} minutes`}
        </div>
        <p className="mt-1 text-zinc-500 dark:text-zinc-400">
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
              {`${r.goal || r.rule}: ${r.credits} credit(s)`}
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
      return `credits ${pts(share)} an account, ${pts(points)} for all ${n}.`;
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

function RuleForm({
  existing, measures, templates, onClose, onSaved,
}: {
  existing: Rule | null;
  measures: Measure[];
  templates: Template[];
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
  }, [name, measure, scope, templateId, challengeId, target, points, notes, enabled, isNew, existing, onSaved]);

  const sentence = ruleSentence({
    measure: spec,
    points: effPoints,
    target: effTarget,
    challenge: scope === 'template' ? (template?.goal || null) : (challengeId ? `challenge #${challengeId}` : null),
  });

  return (
    <Panel
      title={isNew ? 'New scoring rule' : `Edit ${existing.name}`}
      subtitle="Pick what to measure and which challenge it pays into."
      onClose={onClose}
      closeLabel="Close the rule form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save rule" />}
    >
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
            title={`Dry run: ${preview.credits} credit(s) would be written`}
            subtitle="Nothing was written and no grading was spent."
            onClose={() => setPreview(null)}
            closeLabel="Close the preview"
          >
            <RunDetail run={preview} />
          </Panel>
        </div>
      ) : null}

      <div id="admin-topo-cs-form">
        {editing != null && write ? (
          <RuleForm
            key={editing}
            existing={editingRule}
            measures={payload?.measures || []}
            templates={templates}
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
            message="A challenge with no rule is never scored automatically. Add one to start."
          />
        ) : null}
        {payload && !error && payload.rules.length ? (
          <List
            items={payload.rules}
            columns={columns}
            rowKey={(r) => r.id}
            extra={extra}
            actions={write ? (r) => (
              <>
                <button type="button" className={BTN.row} onClick={() => setEditing(String(r.id))}>
                  Edit
                </button>
                <button type="button" className={BTN.rowDanger} onClick={() => remove(r)}>
                  Delete
                </button>
              </>
            ) : undefined}
          />
        ) : null}
      </div>

      {lastRun ? (
        <div id="admin-topo-cs-last-run" className={`${PANEL_CLS} mt-4 px-4 py-3 sm:px-5`}>
          <div className="text-sm font-semibold">
            {`Last run ${fmt(lastRun.started_at)}`}
            {lastRun.dry_run ? ' (dry run)' : ''}
            {`: ${lastRun.credits} credit(s)`}
          </div>
          <div className="mt-1">
            <RunDetail run={lastRun} />
          </div>
        </div>
      ) : null}
    </>
  );
}

export { ChallengeScoringScreen };
