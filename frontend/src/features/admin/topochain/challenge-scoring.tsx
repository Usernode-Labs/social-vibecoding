'use strict';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, send } from './api.ts';
import { BTN, PANEL_CLS } from './tokens.ts';
import {
  Badge, EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, Input, List, Options,
  Panel, ScreenHeader, Select, Skeleton, Textarea, fmt,
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
  target_unit: string | null;
  counted: boolean;
  graded: boolean;
  windowed: boolean;
};

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
function ScheduleCard({ schedule }: { schedule: Schedule | null }) {
  if (!schedule) return null;
  const off = !schedule.interval_minutes;
  return (
    <div id="admin-topo-cs-schedule" className={`${PANEL_CLS} mb-4 px-4 py-3 text-sm sm:px-5`}>
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

function RuleForm({
  existing, measures, templates, onClose, onSaved,
}: {
  existing: Rule | null;
  measures: Measure[];
  templates: { value: number; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = existing == null;
  const [name, setName] = useState(existing?.name || '');
  const [measure, setMeasure] = useState(existing?.measure || (measures[0]?.key || ''));
  const [templateId, setTemplateId] = useState(
    existing?.challenge_template_id != null ? String(existing.challenge_template_id) : ''
  );
  const [challengeId, setChallengeId] = useState(
    existing?.challenge_id != null ? String(existing.challenge_id) : ''
  );
  const [target, setTarget] = useState(existing?.target != null ? String(existing.target) : '');
  const [points, setPoints] = useState(existing?.points != null ? String(existing.points) : '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const [enabled, setEnabled] = useState(existing ? existing.enabled : true);
  const [error, setError] = useState<string | null>(null);

  const spec = measures.find((m) => m.key === measure) || null;

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    if (!name.trim()) { setError('Give the rule a name.'); return; }
    if (!measure) { setError('Pick what to measure.'); return; }
    if (!templateId && !challengeId) {
      setError('Bind the rule to a challenge template, or to one challenge by id.');
      return;
    }
    if (templateId && challengeId) {
      setError('Bind the rule to a template or to one challenge, not both.');
      return;
    }
    const body = {
      name: name.trim(),
      measure,
      challenge_template_id: templateId ? Number(templateId) : null,
      challenge_id: challengeId ? Number(challengeId) : null,
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
  }, [name, measure, templateId, challengeId, target, points, notes, enabled, isNew, existing, onSaved]);

  return (
    <Panel
      title={isNew ? 'New scoring rule' : `Edit ${existing.name}`}
      subtitle="Pick what to measure and which challenge it pays into. Leave Target and Points blank to use the challenge's own numbers."
      onClose={onClose}
      closeLabel="Close the rule form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save rule" />}
    >
      <FormGrid>
        <Field label="Name *" htmlFor="admin-topo-cs-f-name">
          <Input
            id="admin-topo-cs-f-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Measure *" htmlFor="admin-topo-cs-f-measure" help={spec?.summary}>
          <Select
            id="admin-topo-cs-f-measure"
            value={measure}
            onChange={(e) => setMeasure(e.target.value)}
          >
            <Options options={measures.map((m) => ({ value: m.key, label: m.label }))} />
          </Select>
        </Field>
        <Field
          label="Applies to a challenge template"
          htmlFor="admin-topo-cs-f-template"
          help="The useful binding: it covers every challenge stamped from this template, including next week's."
        >
          <Select
            id="admin-topo-cs-f-template"
            value={templateId}
            onChange={(e) => { setTemplateId(e.target.value); if (e.target.value) setChallengeId(''); }}
          >
            <Options options={templates} blank="None" />
          </Select>
        </Field>
        <Field
          label="…or one challenge, by id"
          htmlFor="admin-topo-cs-f-challenge"
          help="Only when a single instance should be scored differently from the rest."
        >
          <Input
            id="admin-topo-cs-f-challenge"
            type="number"
            min={1}
            value={challengeId}
            onChange={(e) => { setChallengeId(e.target.value); if (e.target.value) setTemplateId(''); }}
          />
        </Field>
        <Field
          label={`Target${spec?.target_unit ? ` (${spec.target_unit})` : ''}`}
          htmlFor="admin-topo-cs-f-target"
          help="Blank uses the challenge's own metric target."
        >
          <Input
            id="admin-topo-cs-f-target"
            type="number"
            min={1}
            step="any"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
        <Field
          label="Points"
          htmlFor="admin-topo-cs-f-points"
          help="Blank reads the challenge's reward. Set it when the reward is not a plain number."
        >
          <Input
            id="admin-topo-cs-f-points"
            type="number"
            min={1}
            step="any"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
        </Field>
        <Field label="Notes" htmlFor="admin-topo-cs-f-notes" className="md:col-span-2">
          <Textarea
            id="admin-topo-cs-f-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <Field label="Switched on" htmlFor="admin-topo-cs-f-enabled">
          <Select
            id="admin-topo-cs-f-enabled"
            value={enabled ? '1' : '0'}
            onChange={(e) => setEnabled(e.target.value === '1')}
          >
            <Options options={[{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }]} />
          </Select>
        </Field>
      </FormGrid>
      <FormError message={error} />
    </Panel>
  );
}

function ChallengeScoringScreen() {
  const write = canWrite();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [templates, setTemplates] = useState<{ value: number; label: string }[]>([]);
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
      setTemplates(data.data.map((t: any) => ({ value: t.id, label: `${t.goal} (#${t.id})` })));
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

  const columns: Column<Rule>[] = [
    { label: 'Rule', primary: true, cell: (r) => r.name },
    {
      label: 'Measures',
      cell: (r) => (payload?.measures.find((m) => m.key === r.measure)?.label || r.measure),
      tdClass: 'text-xs',
    },
    {
      label: 'Pays into',
      cell: (r) => `${r.bound_to.label}${r.bound_to.kind === 'template' ? ' (every instance)' : ''}`,
      tdClass: 'text-xs text-zinc-500 dark:text-zinc-400',
    },
    {
      label: 'Status',
      cell: (r) => {
        if (!r.enabled) return <Badge label="Off" tone="zinc" />;
        if (!r.covers.length) return <Badge label="No live challenge" tone="amber" />;
        const live = r.covers.filter((c) => !c.skipped).length;
        return live
          ? <Badge label={`Scoring ${live}`} tone="green" />
          : <Badge label={r.covers[0].skipped || 'Idle'} tone="amber" />;
      },
    },
  ];

  // The per-challenge detail under each row: what this rule pays into right
  // now, with the numbers it resolved and the reason for any it is skipping.
  const extra = (r: Rule) => (r.covers.length ? (
    <div className="text-xs text-zinc-500 dark:text-zinc-400">
      <ul className="list-disc ml-5">
        {r.covers.map((c) => (
          <li key={c.challenge_id}>
            {`${c.goal || `Challenge #${c.challenge_id}`}: `}
            {c.points != null ? `${c.points} pts` : 'no points'}
            {c.target != null ? `, target ${c.target}` : ''}
            {c.skipped ? ` (${c.skipped})` : ' (scoring)'}
          </li>
        ))}
      </ul>
    </div>
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
          <>
            <button
              id="admin-topo-cs-new"
              type="button"
              className={BTN.primarySm}
              onClick={() => setEditing('new')}
            >
              New rule
            </button>
            <button
              id="admin-topo-cs-dry-run"
              type="button"
              className={BTN.secondarySm}
              disabled={busy}
              onClick={() => run(true)}
            >
              Dry run
            </button>
            <button
              id="admin-topo-cs-run"
              type="button"
              className={BTN.warnSm}
              disabled={busy}
              onClick={() => run(false)}
            >
              Run now
            </button>
          </>
        ) : null}
      />

      <ScheduleCard schedule={payload?.schedule || null} />

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
