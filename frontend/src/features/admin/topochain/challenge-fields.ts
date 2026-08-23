'use strict';

import { isoToLocalInput, localInputToIso } from './ui.tsx';

// The Add-challenge form's template contract, as data and pure functions.
//
// ── Why this is its own module (#1120 slice 34) ────────────────────────
//
// Every rule about the challenge form that is worth testing is a decision
// about VALUES, not about markup: which fields a template fills, what a
// template's value looks like in the form, and — the subtle one — which of
// those the save is allowed to send. The innerHTML version could only express
// those by writing into a DOM and reading it back, which is why
// tests/challenge-template-prefill.test.js ran the whole module inside a `vm`
// with a hand-written DOM shim.
//
// Pulled out here, each rule is a function that takes a template and returns
// values. The tests call them directly; the component below just renders what
// they return. Nothing about the behaviour changed in the move — the
// comments are the originals.

export type TemplateField = { id: string; type?: 'date' | 'number' };

// Every field the Add-challenge form fills from the picked template.
// `id` is BOTH the `admin-topo-ch-f-<id>` input suffix and the key on the
// template projection (formatTemplate in
// src/routes/topochain/challenge-view.js) — which is also the key the POST
// body writes back, so one list drives the render, the prefill and the save
// and they cannot drift apart. `type` is only about how the value is carried.
export const CH_TEMPLATE_FIELDS: TemplateField[] = [
  { id: 'goal' }, { id: 'reward' }, { id: 'kind' },
  { id: 'schedule_start', type: 'date' }, { id: 'schedule_end', type: 'date' },
  { id: 'cta_button' }, { id: 'cta_label' }, { id: 'cta_type' }, { id: 'cta_link' },
  { id: 'mobile_cta_label' }, { id: 'mobile_cta_type' }, { id: 'mobile_cta_link' },
  { id: 'metric_type' }, { id: 'metric_label' }, { id: 'metric_target', type: 'number' },
  { id: 'task' }, { id: 'description' }, { id: 'requirements' }, { id: 'reward_logic' },
];

// The subset the EDIT form shows and saves. The challenges list is the only
// source an edit has, and it reports back exactly the override keys
// (buildChallengeListItem's `overrides`) — so the edit form stays on them.
// Rendering the rest there would show the TEMPLATE's values in fields that
// save as challenge-level overrides, quietly freezing them into the event on
// the next save.
export const CH_EDIT_FIELDS = ['goal', 'reward', 'kind', 'task', 'description'];

// What one template field looks like IN the form. Shared by the fill and by
// the save below, which compares against it — if these two ever disagreed,
// every untouched field would read as operator-edited.
export function templateFieldText(t: any, f: TemplateField): string {
  const raw = t ? t[f.id] : null;
  if (raw == null) return '';
  return f.type === 'date' ? isoToLocalInput(raw) : String(raw);
}

// The whole form's values for one template. Every field in CH_TEMPLATE_FIELDS
// is written unconditionally: a template that leaves a field null CLEARS the
// input rather than skipping it, so nothing the previously-picked template put
// there can survive the switch. Fields the template has no say in (display
// order) are the operator's and are deliberately not in the list.
export function valuesFromTemplate(t: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of CH_TEMPLATE_FIELDS) out[f.id] = templateFieldText(t, f);
  return out;
}

export function templateById(templates: any[], templateId: unknown) {
  return (templates || []).find((x) => String(x.id) === String(templateId)) || null;
}

/**
 * The POST/PUT body for one challenge.
 *
 * These columns are per-event OVERRIDES of the template, and null means "keep
 * inheriting". So CREATE sends only what the operator actually changed away
 * from the prefilled value: a field left exactly as the template filled it
 * stays null and keeps tracking the template, which is what a challenge
 * created before the prefill existed did. Sending the whole form back would
 * freeze a copy of the template into every new challenge and quietly stop
 * later template edits reaching it.
 *
 * EDIT stays on CH_EDIT_FIELDS — the only values that form was given, hence
 * the only ones it may write.
 */
export function buildChallengeBody(
  { isCreate, values, template }: {
    isCreate: boolean;
    values: Record<string, string>;
    template: any;
  },
): Record<string, unknown> {
  const val = (id: string) => (values[id] ?? '').trim();
  const body: Record<string, unknown> = { display_order: Number(val('display_order') || 0) };
  for (const fld of CH_TEMPLATE_FIELDS) {
    if (!isCreate && !CH_EDIT_FIELDS.includes(fld.id)) continue;
    const raw = val(fld.id);
    if (isCreate && raw === templateFieldText(template, fld).trim()) {
      body[fld.id] = null;
      continue;
    }
    if (fld.type === 'date') body[fld.id] = localInputToIso(raw);
    else if (fld.type === 'number') body[fld.id] = raw === '' ? null : Number(raw);
    else body[fld.id] = raw || null;
  }
  return body;
}
