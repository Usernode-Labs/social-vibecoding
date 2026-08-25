'use strict';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchAllEvents, fetchJson, send } from './api.ts';
import {
  CH_EDIT_FIELDS, CH_TEMPLATE_FIELDS, buildChallengeBody, templateById, valuesFromTemplate,
} from './challenge-fields.ts';
import { BTN, PANEL_CLS } from './tokens.ts';
import {
  BackButton, EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, FormSection, Input,
  List, Options, Panel, ScreenHeader, Select, Skeleton, Textarea, fmt,
} from './ui.tsx';
import type { Column } from './ui.tsx';

// The Season-event DETAIL view: one event's hero, its ordered challenges, and
// the two-mode challenge form. Reached from the list's Manage button, and
// addressable as #admin/season-events/<eventId>[/new-challenge[/<templateId>]].
//
// ── React-owned (#1120 slice 34) ──────────────────────────────────────
//
// THE ADDRESS STAYS THE ROUTER'S. admin-topochain.js owns
// `_readSeasonEventsDeepLink` and `_syncHash`, which read `_se.detailId`,
// `_ch.open` and `_ch.templateId`. Those three are the module's routing
// state, not this screen's presentation state, so they stay where they are:
// this screen reads them on mount and writes them back through
// `publishRoute()` whenever the operator navigates. Re-implementing the
// address here would have meant two owners for one URL.
//
// Everything about which fields a template fills, what its values look like
// and which of them a save may send is in ./challenge-fields.ts — pure
// functions the tests call directly, instead of a DOM they have to read back.

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

// Write the module's routing state and let it rewrite the address. `open` and
// `templateId` are what _syncHash puts in the /new-challenge tail.
function publishRoute({ detailId, open, templateId }: {
  detailId?: number | null;
  open?: boolean;
  templateId?: string;
}) {
  const t = topo();
  if (!t) return;
  if (detailId !== undefined) t._se.detailId = detailId;
  if (open !== undefined) t._ch.open = open;
  if (templateId !== undefined) t._ch.templateId = templateId;
  t._syncHash();
}

type Challenge = {
  id: number;
  enabled?: boolean;
  completed?: boolean;
  display_order?: number;
  card_preview?: { goal?: string; label?: string } | null;
  activity_type?: { kind?: string } | null;
  overrides?: Record<string, string | null> | null;
};

type EventRow = {
  id: number;
  name: string;
  type?: string | null;
  is_active?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  users_count?: number | null;
  onchain_accounts_count?: number | null;
};

const CTA_OPTIONS = [{ value: 'url', label: 'url' }, { value: 'app', label: 'app' }];
const fieldId = (key: string) => `admin-topo-ch-f-${key}`;

function Stat({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-medium">{String(value)}</dd>
    </div>
  );
}

function Hero({ eventId }: { eventId: number }) {
  const [ev, setEv] = useState<EventRow | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const { ok, data, status } = await fetchJson(
        `/api/v4/admin/season-events/${encodeURIComponent(eventId)}`);
      if (!alive.current) return;
      if (ok && data?.success) { setEv(data.data); return; }
      setError({ status, message: (data && data.error) || null });
    })();
  }, [eventId]);

  if (error) {
    return <ErrorState title="Event not found" status={error.status} message={error.message} />;
  }
  if (!ev) return <Skeleton rows={4} />;
  return (
    <section className={`${PANEL_CLS} px-4 py-4 sm:px-5`}>
      <h2 className="text-base font-semibold sm:text-lg">{ev.name}</h2>
      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
        {`${fmt(ev.starts_at)} – ${fmt(ev.ends_at)}`}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Users" value={ev.users_count ?? 0} />
        <Stat label="Accounts" value={ev.onchain_accounts_count ?? 0} />
        <Stat label="Type" value={ev.type || '—'} />
        <Stat label="Active" value={ev.is_active ? 'yes' : 'no'} />
      </dl>
    </section>
  );
}

// Move a challenge to another event. This was a window.prompt() asking the
// operator to read an id out of a newline-joined list and type it back —
// unstyled, unreadable on a phone, impossible to cancel cleanly, and a typo
// silently moved the challenge somewhere else. It is an inline panel with a
// real <select>: the ids never have to be transcribed, so there is nothing to
// mistype.
function MovePanel({ eventId, challengeId, onClose, onMoved }: {
  eventId: number;
  challengeId: number;
  onClose: () => void;
  onMoved: () => void;
}) {
  const [others, setOthers] = useState<EventRow[] | null>(null);
  const [target, setTarget] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const events = await fetchAllEvents();
      if (!alive.current) return;
      const rest = events.filter((e: EventRow) => e.id !== eventId);
      setOthers(rest);
      if (rest.length) setTarget(String(rest[0].id));
    })();
  }, [eventId]);

  const go = useCallback(async () => {
    if (!canWrite()) return;
    const targetId = parseInt(target, 10);
    if (!Number.isInteger(targetId)) return;
    const { ok, data } = await send(
      'PATCH',
      `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challengeId)}/move`,
      { target_season_event_id: targetId },
    );
    if (ok && data?.success) { onMoved(); return; }
    topo()._alert((data && data.error) || 'Move failed.');
  }, [eventId, challengeId, target, onMoved]);

  if (others === null) {
    return <div className="mt-3"><Panel title="Move this challenge"><Skeleton rows={2} /></Panel></div>;
  }
  if (!others.length) {
    return (
      <div className="mt-3">
        <Panel title="Move this challenge" onClose={onClose} closeLabel="Close the move panel">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            There is no other event to move this challenge to.
          </p>
        </Panel>
      </div>
    );
  }
  return (
    <div className="mt-3">
      <Panel
        title="Move this challenge"
        subtitle="The challenge keeps its configuration; its recorded user activities move with it."
        onClose={onClose}
        closeLabel="Close the move panel"
        footer={(
          <>
            <button id="admin-topo-ch-move-go" type="button" className={BTN.primary} onClick={go}>
              Move
            </button>
            <button
              id="admin-topo-ch-move-cancel"
              type="button"
              className={BTN.secondary}
              onClick={onClose}
            >
              Cancel
            </button>
          </>
        )}
      >
        <Field label="Destination event" htmlFor="admin-topo-ch-move-target">
          <Select
            id="admin-topo-ch-move-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <Options options={others.map((e) => ({ value: e.id, label: `${e.name} (#${e.id})` }))} />
          </Select>
        </Field>
      </Panel>
    </div>
  );
}

// The two modes have different sources of truth: CREATE fills from the
// template (so it shows everything the template defines), EDIT shows the
// per-event overrides the API reports back.
function ChallengeForm({ eventId, existing, initialTemplateId, onClose, onSaved }: {
  eventId: number;
  existing: Challenge | null;
  initialTemplateId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCreate = existing == null;
  const [templates, setTemplates] = useState<any[] | null>(isCreate ? null : []);
  const [templateId, setTemplateId] = useState(isCreate ? initialTemplateId : '');
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!existing) return { display_order: '0' };
    const ov = existing.overrides || {};
    return {
      goal: ov.goal || '',
      reward: ov.reward || '',
      kind: existing.activity_type?.kind || '',
      task: ov.task || '',
      description: ov.description || '',
      display_order: String(existing.display_order ?? 0),
    };
  });
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // The full template rows are kept, not just the option pair: they ARE the
  // prefill source.
  useEffect(() => {
    if (!isCreate) return;
    (async () => {
      const { ok, data } = await fetchJson(
        `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/available-activity-types`);
      if (!alive.current) return;
      setTemplates(ok && data?.success ? data.data : []);
    })();
  }, [isCreate, eventId]);

  // A deep-linked template is applied exactly as if it had just been picked,
  // so the address and the form always agree — but only once the templates
  // have arrived and only if the address named one this event actually has.
  const applied = useRef(false);
  useEffect(() => {
    if (!isCreate || applied.current || !templates || !initialTemplateId) return;
    if (!templates.some((t) => String(t.id) === initialTemplateId)) return;
    applied.current = true;
    setValues((v) => ({
      ...valuesFromTemplate(templateById(templates, initialTemplateId)),
      display_order: v.display_order ?? '0',
    }));
    publishRoute({ open: true, templateId: initialTemplateId });
  }, [isCreate, templates, initialTemplateId]);

  // Runs on EVERY change of the picker, not just the first. Display order is
  // the operator's and is left alone.
  const pickTemplate = useCallback((next: string) => {
    setTemplateId(next);
    setValues((v) => ({
      ...valuesFromTemplate(templateById(templates || [], next)),
      display_order: v.display_order ?? '0',
    }));
    publishRoute({ open: true, templateId: next });
  }, [templates]);

  const set = useCallback((key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    if (isCreate && !templateId) { setError('Choose a challenge template.'); return; }
    const body = buildChallengeBody({
      isCreate,
      values,
      template: isCreate ? templateById(templates || [], templateId) : null,
    });
    let url = `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges`;
    let method = 'POST';
    if (isCreate) body.challenge_template_id = parseInt(templateId, 10);
    else { url += `/${encodeURIComponent(existing.id)}`; method = 'PUT'; }
    const { ok, data } = await send(method, url, body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    onSaved();
  }, [isCreate, templateId, templates, values, eventId, existing, onSaved]);

  const textField = (key: string, label: string, help?: string) => (
    <Field key={key} label={label} htmlFor={fieldId(key)} help={help}>
      <Input
        id={fieldId(key)}
        type="text"
        value={values[key] || ''}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );
  const areaField = (key: string, label: string) => (
    <Field key={key} label={label} htmlFor={fieldId(key)}>
      <Textarea
        id={fieldId(key)}
        rows={3}
        value={values[key] || ''}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );

  const KIND_HELP = 'No admin listing endpoint exists for Kinds (documented gap) — must match an existing challenge_kinds id.';

  return (
    <Panel
      title={existing ? 'Edit challenge' : 'Add challenge'}
      subtitle={existing
        ? 'Overrides apply to this event only; the template is untouched.'
        : 'Pick a template to fill the form in, then change anything that should differ for this event. Nothing here is written back to the template.'}
      onClose={onClose}
      closeLabel="Close the challenge form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save challenge" />}
    >
      {existing ? (
        <>
          <FormGrid>
            {textField('goal', 'Goal override')}
            {textField('reward', 'Reward override')}
            {textField('kind', 'Kind', KIND_HELP)}
            <Field label="Display order" htmlFor={fieldId('display_order')}>
              <Input
                id={fieldId('display_order')}
                type="number"
                min={0}
                value={values.display_order || '0'}
                onChange={(e) => set('display_order', e.target.value)}
              />
            </Field>
          </FormGrid>
          <div className="grid grid-cols-1 gap-4 mt-4">
            {areaField('task', 'Task override')}
            {areaField('description', 'Description override')}
          </div>
        </>
      ) : (
        <>
          <div className="mb-4">
            <Field
              label="Challenge template *"
              htmlFor="admin-topo-ch-f-template"
              help={(templates && templates.length)
                ? 'Picking a template fills in every field below with its values; switching template fills them in again.'
                : 'No unused Challenge templates are available for this event — create one in the Challenge templates tab first.'}
            >
              <Select
                id="admin-topo-ch-f-template"
                value={templateId}
                onChange={(e) => pickTemplate(e.target.value)}
              >
                <Options
                  options={(templates || []).map((t) => ({
                    value: t.id,
                    label: `${t.category}: ${t.goal}`,
                  }))}
                  blank="Choose a template…"
                />
              </Select>
            </Field>
          </div>
          <FormGrid>
            {textField('goal', 'Goal')}
            {textField('reward', 'Reward')}
            {textField('kind', 'Kind', KIND_HELP)}
            <Field
              label="Display order"
              htmlFor={fieldId('display_order')}
              help="Not part of a template — where this challenge sits in the event."
            >
              <Input
                id={fieldId('display_order')}
                type="number"
                min={0}
                value={values.display_order || '0'}
                onChange={(e) => set('display_order', e.target.value)}
              />
            </Field>
            <Field label="Schedule start" htmlFor={fieldId('schedule_start')}>
              <Input
                id={fieldId('schedule_start')}
                type="datetime-local"
                value={values.schedule_start || ''}
                onChange={(e) => set('schedule_start', e.target.value)}
              />
            </Field>
            <Field label="Schedule end" htmlFor={fieldId('schedule_end')}>
              <Input
                id={fieldId('schedule_end')}
                type="datetime-local"
                value={values.schedule_end || ''}
                onChange={(e) => set('schedule_end', e.target.value)}
              />
            </Field>
          </FormGrid>
          <FormSection label="Call to action" />
          <FormGrid>
            {textField('cta_button', 'CTA button label')}
            {textField('cta_label', 'CTA label')}
            <Field label="CTA type" htmlFor={fieldId('cta_type')}>
              <Select
                id={fieldId('cta_type')}
                value={values.cta_type || ''}
                onChange={(e) => set('cta_type', e.target.value)}
              >
                <Options options={CTA_OPTIONS} blank="(none)" />
              </Select>
            </Field>
            {textField('cta_link', 'CTA link')}
            {textField('mobile_cta_label', 'Mobile CTA label')}
            <Field label="Mobile CTA type" htmlFor={fieldId('mobile_cta_type')}>
              <Select
                id={fieldId('mobile_cta_type')}
                value={values.mobile_cta_type || ''}
                onChange={(e) => set('mobile_cta_type', e.target.value)}
              >
                <Options options={CTA_OPTIONS} blank="(none)" />
              </Select>
            </Field>
            {textField('mobile_cta_link', 'Mobile CTA link')}
          </FormGrid>
          <FormSection label="Metric" />
          <FormGrid cols={3}>
            {textField('metric_type', 'Metric type')}
            {textField('metric_label', 'Metric label')}
            <Field label="Metric target" htmlFor={fieldId('metric_target')}>
              <Input
                id={fieldId('metric_target')}
                type="number"
                step="0.01"
                value={values.metric_target || ''}
                onChange={(e) => set('metric_target', e.target.value)}
              />
            </Field>
          </FormGrid>
          <FormSection label="Copy" />
          <div className="grid grid-cols-1 gap-4">
            {areaField('task', 'Task')}
            {areaField('description', 'Description')}
            {areaField('requirements', 'Requirements')}
            {areaField('reward_logic', 'Reward logic')}
          </div>
        </>
      )}
      <FormError message={error} />
    </Panel>
  );
}

function EventDetail({ eventId, onBack }: { eventId: number; onBack: () => void }) {
  const write = canWrite();
  const [items, setItems] = useState<Challenge[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  // null = closed, 'new' = the create form, otherwise the challenge being
  // edited. Seeded from the module's routing state so a /new-challenge deep
  // link opens the form on the template the address names.
  const [form, setForm] = useState<number | 'new' | null>(
    () => (canWrite() && topo()?._ch?.open ? 'new' : null),
  );
  // Spent once by the form that opens, exactly as `pendingTemplateId` was.
  const [pendingTemplateId] = useState<string>(() => {
    const t = topo();
    const pending = t?._ch?.pendingTemplateId;
    if (t?._ch) t._ch.pendingTemplateId = null;
    return pending == null ? '' : String(pending);
  });
  const [moving, setMoving] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Keeps a view-only admin's address honest: the /new-challenge segment can
  // be typed, but nothing opens, so it must not persist.
  useEffect(() => {
    if (!write && topo()?._ch?.open) publishRoute({ open: false, templateId: '' });
  }, [write]);

  const load = useCallback(async () => {
    const { ok, data, status } = await fetchJson(
      `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges`);
    if (!alive.current) return;
    const good = ok && data?.success && Array.isArray(data.data);
    setItems(good ? data.data : []);
    setError(good ? null : { status, message: (data && data.error) || null });
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  const closeForm = useCallback(() => {
    setForm(null);
    publishRoute({ open: false, templateId: '' });
  }, []);

  const reorder = useCallback(async (idx: number, dir: number) => {
    if (!canWrite() || !items) return;
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j], next[idx]];
    const challenges = next.map((c, i) => ({ id: c.id, display_order: i }));
    const { ok, data } = await send(
      'PATCH',
      `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/update-display-orders`,
      { challenges },
    );
    if (ok && data?.success) { load(); return; }
    topo()._alert((data && data.error) || 'Reorder failed.');
  }, [items, eventId, load]);

  const toggle = useCallback(async (challengeId: number, action: string) => {
    if (!canWrite()) return;
    const { ok, data } = await send(
      'PATCH',
      `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challengeId)}/${action}`,
    );
    if (ok && data?.success) { load(); return; }
    topo()._alert((data && data.error) || 'Update failed.');
  }, [eventId, load]);

  const remove = useCallback(async (challengeId: number) => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: 'Remove this challenge from the event?',
      confirmLabel: 'Remove',
      danger: true,
      message: 'This removes the challenge from the event; its recorded user activities are cascaded away with it.',
    });
    if (!ok) return;
    const res = await send(
      'DELETE',
      `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challengeId)}`,
    );
    if (res.ok && res.data?.success) { load(); return; }
    topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [eventId, load]);

  const columns: Column<Challenge>[] = useMemo(() => [
    { label: 'Goal', primary: true, cell: (c) => c.card_preview?.goal || '' },
    { label: 'Kind', cell: (c) => c.card_preview?.label || '', tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
    {
      label: 'Enabled',
      cell: (c) => (c.enabled
        ? <span className="text-green-800 dark:text-green-400">enabled</span>
        : <span className="text-zinc-500 dark:text-zinc-400">disabled</span>),
    },
    { label: 'Completed', cell: (c) => (c.completed ? 'completed' : '—'), tdClass: 'text-zinc-500 dark:text-zinc-400' },
  ], []);

  const editing = typeof form === 'number'
    ? (items || []).find((c) => c.id === form) || null
    : null;

  return (
    <>
      <BackButton id="admin-topo-se-back" onClick={onBack}>Back to season events</BackButton>
      <div id="admin-topo-se-detail-hero" className="mb-4">
        <Hero eventId={eventId} />
      </div>
      <ScreenHeader
        title="Challenges"
        subtitle="Ordered as users see them. Reorder with the arrows."
        actions={write ? (
          <button
            id="admin-topo-ch-new"
            type="button"
            className={BTN.primarySm}
            onClick={() => { setForm('new'); publishRoute({ open: true, templateId: '' }); }}
          >
            Add challenge
          </button>
        ) : null}
      />
      <div id="admin-topo-ch-form">
        {form != null && write ? (
          <ChallengeForm
            key={String(form)}
            eventId={eventId}
            existing={editing}
            initialTemplateId={form === 'new' ? pendingTemplateId : ''}
            onClose={closeForm}
            onSaved={() => { closeForm(); load(); }}
          />
        ) : null}
      </div>
      <div id="admin-topo-ch-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load challenges"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title="No challenges for this event yet"
            body="Add one, or stamp a set out of the Challenge templates library."
            action={write ? (
              <button
                id="admin-topo-ch-empty-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => { setForm('new'); publishRoute({ open: true, templateId: '' }); }}
              >
                Add challenge
              </button>
            ) : null}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <List
            items={items}
            rowKey={(c) => c.id}
            columns={columns}
            actions={write ? (c) => {
              const i = items.indexOf(c);
              return (
                <>
                  <button
                    data-up={i}
                    type="button"
                    aria-label="Move up"
                    title="Move up"
                    className={BTN.row}
                    disabled={i === 0}
                    onClick={() => reorder(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    data-down={i}
                    type="button"
                    aria-label="Move down"
                    title="Move down"
                    className={BTN.row}
                    disabled={i === items.length - 1}
                    onClick={() => reorder(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    data-toggle-enabled={c.id}
                    type="button"
                    className={BTN.row}
                    onClick={() => toggle(c.id, 'toggle-enabled')}
                  >
                    Toggle
                  </button>
                  <button
                    data-toggle-completed={c.id}
                    type="button"
                    className={BTN.row}
                    onClick={() => toggle(c.id, 'toggle-completed')}
                  >
                    Complete
                  </button>
                  <button
                    data-edit-ch={c.id}
                    type="button"
                    className={BTN.row}
                    onClick={() => setForm(c.id)}
                  >
                    Edit
                  </button>
                  <button
                    data-move-ch={c.id}
                    type="button"
                    className={BTN.row}
                    onClick={() => setMoving(c.id)}
                  >
                    Move…
                  </button>
                  <button
                    data-delete-ch={c.id}
                    type="button"
                    className={BTN.rowDanger}
                    onClick={() => remove(c.id)}
                  >
                    Delete
                  </button>
                </>
              );
            } : undefined}
          />
        ) : null}
        <div id="admin-topo-ch-move">
          {moving != null && write ? (
            <MovePanel
              eventId={eventId}
              challengeId={moving}
              onClose={() => setMoving(null)}
              onMoved={() => { setMoving(null); load(); }}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

export { CH_EDIT_FIELDS, CH_TEMPLATE_FIELDS, EventDetail, publishRoute };
