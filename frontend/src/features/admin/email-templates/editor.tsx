'use strict';

import { useEffect, useMemo, useRef, useState } from 'react';

import { AdminUI } from '../admin-console.js';
import { PreviewPane } from './preview';
import {
  confirmDiscard, draftTemplate, errorsFor, FailureNotice, FieldErrors, isDirty, keepDraft, liveLayouts, liveTemplate,
  PlaceholderList, readFailure, request, unusableOf, useUnloadGuard,
  type ActionInfo, type Failure, type KeptDraft, type TemplateRow, type TemplatesPayload,
} from './shared';
import { insertAt, UploadImageButton } from './image-panel';
import { VisualTab } from './visual-tab';
import {
  confirmHandCorrected, keptLanguage, LanguageForm, TEMPLATE_PARTS, useEditorLanguages, type LanguageDraft, type UnusableItem,
} from './translations';

// The template editor: what the email is for, its name, the layout it wears,
// subject, preheader and the "why you got this" line, then the body in tabs,
// with the placeholders it may use and a live preview beside it.
//
// Save draft keeps the edit as the email's draft (POST .../draft), which is
// previewed and test-sent like any version but never sent to anyone, and
// "Put draft live" makes it the version that goes out (POST .../:id/publish).
// An email opens on its draft when it has one, unless the list asked for its
// live version (`version`): that one is then edited and saved as ever, and
// only Save draft is left out, since the draft that waits is not the one on
// screen. A new template cannot be saved over an email's waiting draft either:
// that draft is opened from the list. The drip's emails have nothing that
// sends them yet, so they can only be drafts, and the editor says what will
// send each one.
//
// Saving makes a new version and puts it live (POST /api/admin/email-templates)
// with `expectedLiveId`, the live version this editor was opened from, so two
// admins editing the same email cannot overwrite each other unseen: the second
// gets a conflict and a Reload. Every refusal with fields is drawn beside the
// field the server named.

export interface TemplateDraft {
  action: string;
  name: string;
  layoutFamilyId: number | null;
  subject: string;
  preheader: string;
  why: string;
  html: string;
  text: string;
}

export function draftFrom(row: TemplateRow): TemplateDraft {
  return {
    action: row.action,
    name: row.name,
    layoutFamilyId: row.layout_family_id,
    subject: row.subject,
    preheader: row.preheader || '',
    why: row.why || '',
    html: row.html,
    text: row.text,
  };
}

// The body tabs. Visual is where an editor opens: the email as it looks, its
// text retyped in place. HTML is always the full truth, and where structure
// and conditions change.
export type BodyTab = 'visual' | 'html' | 'text';
const TABS: Array<{ key: BodyTab; label: string }> = [
  { key: 'visual', label: 'Visual' },
  { key: 'html', label: 'HTML' },
  { key: 'text', label: 'Text' },
];

// Every field the form draws, by the name the server uses for it, so an
// error for any other field is listed above the form instead.
const SHOWN = ['action', 'name', 'layoutFamilyId', 'subject', 'preheader', 'why', 'html', 'text'];

function Field({ id, label, hint, errors, children }: {
  id: string; label: string; hint?: string; errors: string[]; children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={AdminUI.label}>{label}</label>
      {hint ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
      <div className="mt-1">{children}</div>
      <FieldErrors id={`${id}-error`} messages={errors} />
    </div>
  );
}

// The props a control needs to point at its errors.
const described = (id: string, errors: string[]) => (errors.length
  ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` }
  : {});

// Said in the editor once the draft differs from what it opened on, and in the
// banner after a save: a new version starts with no translations, so readers
// in other languages get its English until it is translated.
export const ENGLISH_UNTIL_TRANSLATED = 'Readers in other languages get the English of this email until it is translated.';
// After a save that kept the English words (a new name or layout).
export const TRANSLATIONS_KEPT = 'The English words did not change, so its translations came along.';

// Whether the edit changes the English words the translations are of. A new
// name or layout keeps them, and the server carries them to the new version.
const WORDS = ['subject', 'preheader', 'why', 'html', 'text'] as const;
export function wordsChanged(draft: TemplateDraft, opened?: TemplateDraft): boolean {
  return !opened || WORDS.some((field) => (draft[field] ?? '') !== (opened[field] ?? ''));
}

/** What sends a drip email, when, and what stops it, beside its editor. */
export function DripPanel({ action }: { action: ActionInfo }) {
  if (!action.drip) return null;
  const rows: Array<[string, string]> = [
    ['Status', 'Off. Nothing sends this email yet, so it stays a draft.'],
    ['From', action.drip.from],
    ['Sent when', action.drip.trigger],
    ['Timing', action.drip.timing],
    ['Skipped if', action.drip.skip],
    ['Sending limits', action.drip.nudge
      ? 'A nudge: at most one a day and three a week per person.'
      : 'Not counted as a nudge.'],
  ];
  return (
    <div id="email-template-drip" className={`${AdminUI.card} p-4`}>
      <h3 className="text-sm font-semibold mb-2">When it is sent</h3>
      <dl className="space-y-1.5 text-sm">
        {rows.map(([term, detail]) => (
          <div key={term}>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">{term}</dt>
            <dd className="text-zinc-800 dark:text-zinc-200">{detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function TemplateForm({
  payload, draft, opened, isNew, canWrite, tab, failure, saving, onChange, onTab, onSave, onCancel, onReload, onRetry, preview,
  dirty = false,
  languagesCard = null,
  openedOn = 'live',
  onSaveDraft,
  onPublish,
  draftWaiting = null,
}: {
  payload: TemplatesPayload;
  draft: TemplateDraft;
  // What the editor opened with, which the Visual tab's Revert goes back to.
  opened?: TemplateDraft;
  isNew: boolean;
  canWrite: boolean;
  tab: BodyTab;
  failure: Failure | null;
  saving: boolean;
  onChange: (field: keyof TemplateDraft, value: string | number | null) => void;
  onTab: (tab: BodyTab) => void;
  onSave: () => void;
  onCancel: () => void;
  onReload: () => void;
  onRetry: () => void;
  preview: React.ReactNode;
  // The draft differs from what the editor opened on.
  dirty?: boolean;
  // The language switch and Translate, above the form.
  languagesCard?: React.ReactNode;
  // Which saved version the editor opened on: the live one, the draft, or
  // none (a new template).
  openedOn?: 'live' | 'draft' | 'new';
  onSaveDraft?: () => void;
  onPublish?: () => void;
  // Why Save draft is not offered: this email has a draft that is not the
  // version on screen.
  draftWaiting?: string | null;
}) {
  const action = payload.actions.find((a) => a.action === draft.action) || null;
  const drip = !!(action && action.drip);
  const layouts = liveLayouts(payload);
  const err = (...fields: string[]) => errorsFor(failure, ...fields);
  const readOnly = !canWrite;
  // The HTML box and its latest text, for an image tag put at the cursor once
  // an upload finishes, by which time the admin may have typed on.
  const htmlArea = useRef<HTMLTextAreaElement | null>(null);
  const latestHtml = useRef(draft.html);
  latestHtml.current = draft.html;
  const putAtCursor = (tag: string) => {
    const el = htmlArea.current;
    const source = latestHtml.current;
    const start = el ? el.selectionStart : source.length;
    const end = el ? el.selectionEnd : source.length;
    onChange('html', insertAt(source, start, end, tag));
  };
  const e = {
    action: err('action'),
    name: err('name'),
    layout: err('layoutFamilyId'),
    subject: err('subject'),
    preheader: err('preheader'),
    why: err('why'),
    html: err('html'),
    text: err('text'),
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={AdminUI.btn.ghost} onClick={onCancel}>‹ All templates</button>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={AdminUI.btn.outline} disabled={saving} onClick={onCancel}>Cancel</button>
            {onSaveDraft ? (
              <button type="button" id="email-template-save-draft" className={drip ? AdminUI.btn.primary : AdminUI.btn.outline}
                disabled={saving || (openedOn === 'draft' && !dirty)} onClick={onSaveDraft}>
                {saving ? 'Saving…' : 'Save draft'}
              </button>
            ) : null}
            {drip ? null : openedOn === 'draft' ? (
              <button type="button" id="email-template-publish" className={AdminUI.btn.primary} disabled={saving || dirty} onClick={onPublish}
                title={dirty ? 'Save the draft first' : undefined}>
                Put draft live
              </button>
            ) : (
              /* Nothing to save until something changed: a save makes a new version, and a copy of the live one would only lose its translations. */
              <button type="button" id="email-template-save" className={AdminUI.btn.primary} disabled={saving || (!isNew && !dirty)} onClick={onSave}>
                {saving ? 'Saving…' : 'Save and put live'}
              </button>
            )}
          </div>
        ) : null}
      </div>
      {openedOn === 'draft' ? (
        <p id="email-template-draft-note" className="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {drip
            ? 'This is a draft. Nothing sends this email yet, and nobody gets it until the sending is built and it is put live.'
            : `This is a draft. Nobody gets it until you put it live; the live version keeps going out until then.${dirty ? ' Save the draft before putting it live.' : ''}`}
        </p>
      ) : null}
      {draftWaiting ? (
        <p id="email-template-draft-waiting" className="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {draftWaiting}
        </p>
      ) : null}
      {canWrite ? null : (
        <p className="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          Editing needs full admin access. You can read this template and preview it.
        </p>
      )}
      {languagesCard}
      {canWrite && dirty && wordsChanged(draft, opened) && action && !action.englishOnly ? (
        <p id="email-template-english-note" className="text-sm text-zinc-600 dark:text-zinc-300">{ENGLISH_UNTIL_TRANSLATED}</p>
      ) : null}
      <FailureNotice failure={failure} shownFields={SHOWN} onReload={onReload} onRetry={onRetry} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={`${AdminUI.card} p-4 space-y-3 min-w-0`}>
          <Field id="email-template-action" label="What this email is for" errors={e.action}
            hint={isNew ? 'Save and put live replaces that email\'s current version. Save draft keeps it as that email\'s draft, sent to nobody.' : undefined}>
            <select id="email-template-action" className={AdminUI.select} value={draft.action}
              disabled={!isNew || readOnly} onChange={(ev) => onChange('action', ev.target.value)} {...described('email-template-action', e.action)}>
              {payload.actions.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
            </select>
          </Field>
          <Field id="email-template-name" label="Name" hint="Only admins see this." errors={e.name}>
            <input id="email-template-name" className={AdminUI.input} value={draft.name} readOnly={readOnly}
              onChange={(ev) => onChange('name', ev.target.value)} {...described('email-template-name', e.name)} />
          </Field>
          <Field id="email-template-layout" label="Layout" errors={e.layout}
            hint="The header and footer it is wrapped in. Without one, the HTML below is the complete email.">
            <select id="email-template-layout" className={AdminUI.select}
              value={draft.layoutFamilyId == null ? '' : String(draft.layoutFamilyId)} disabled={readOnly}
              onChange={(ev) => onChange('layoutFamilyId', ev.target.value ? Number(ev.target.value) : null)}
              {...described('email-template-layout', e.layout)}>
              {layouts.map((l) => <option key={l.family_id} value={String(l.family_id)}>{l.name}</option>)}
              <option value="">None (complete HTML)</option>
            </select>
          </Field>
          <Field id="email-template-subject" label="Subject" errors={e.subject}>
            <input id="email-template-subject" className={AdminUI.input} value={draft.subject} readOnly={readOnly}
              onChange={(ev) => onChange('subject', ev.target.value)} {...described('email-template-subject', e.subject)} />
          </Field>
          <Field id="email-template-preheader" label="Preheader" errors={e.preheader}
            hint="The line inboxes show after the subject. The layout places it.">
            <input id="email-template-preheader" className={AdminUI.input} value={draft.preheader} readOnly={readOnly}
              onChange={(ev) => onChange('preheader', ev.target.value)} {...described('email-template-preheader', e.preheader)} />
          </Field>
          <Field id="email-template-why" label="Why they got it" errors={e.why}
            hint="One line, usually in the footer, saying why this person was sent this email.">
            <input id="email-template-why" className={AdminUI.input} value={draft.why} readOnly={readOnly}
              onChange={(ev) => onChange('why', ev.target.value)} {...described('email-template-why', e.why)} />
          </Field>

          <div>
            <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" role="tablist" aria-label="Email body">
              {TABS.map((t) => (
                <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                  id={`email-template-tab-${t.key}`}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px ${tab === t.key
                    ? 'border-violet-600 text-zinc-900 dark:text-zinc-100'
                    : 'border-transparent text-zinc-500 dark:text-zinc-400'}`}
                  onClick={() => onTab(t.key)}>
                  {t.label}
                  {(t.key === 'text' ? e.text : e.html).length ? <span className="ms-1 text-red-600 dark:text-red-400" aria-label="has problems">•</span> : null}
                </button>
              ))}
            </div>
            <div className="mt-2" role="tabpanel" aria-labelledby={`email-template-tab-${tab}`}>
              {tab === 'visual' ? (
                <div>
                  <VisualTab source={draft.html} opened={(opened || draft).html} onChange={(html) => onChange('html', html)}
                    placeholders={action ? action.placeholders : []} readOnly={readOnly} />
                  <FieldErrors id="email-template-visual-error" messages={e.html} />
                </div>
              ) : tab === 'html' ? (
                <Field id="email-template-html" label="HTML" errors={e.html}
                  hint={draft.layoutFamilyId == null ? 'The whole email, from <html> to </html>.' : 'The middle of the email; the layout adds the rest.'}>
                  <textarea id="email-template-html" ref={htmlArea} className={`${AdminUI.textarea} font-mono text-xs`} rows={18}
                    spellCheck={false} value={draft.html} readOnly={readOnly}
                    onChange={(ev) => onChange('html', ev.target.value)} {...described('email-template-html', e.html)} />
                  {readOnly ? null : <UploadImageButton onTag={putAtCursor} />}
                </Field>
              ) : (
                <Field id="email-template-text" label="Text version"
                  hint="For mail apps that do not show HTML. It needs the same required placeholders." errors={e.text}>
                  <textarea id="email-template-text" className={`${AdminUI.textarea} font-mono text-xs`} rows={18}
                    spellCheck={false} value={draft.text} readOnly={readOnly}
                    onChange={(ev) => onChange('text', ev.target.value)} {...described('email-template-text', e.text)} />
                </Field>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4 min-w-0">
          <div className={`${AdminUI.card} p-4`}>
            <h3 className="text-sm font-semibold mb-2">Preview</h3>
            {preview}
          </div>
          {action ? <DripPanel action={action} /> : null}
          <div className={`${AdminUI.card} p-4`}>
            {action ? <PlaceholderList action={action} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The live version a save expects: the one the editor opened on (kept with a
 * restored draft), or, for a new template moved to another email, that
 * email's live version in the snapshot.
 */
export function expectedLiveFor(openedLive: { action: string; id: number | null }, action: string, payload: TemplatesPayload): number | null {
  if (action === openedLive.action) return openedLive.id;
  const live = liveTemplate(payload, action);
  return live ? live.id : null;
}

const BLANK = (action: string, layoutFamilyId: number | null): TemplateDraft => ({
  action, name: '', layoutFamilyId, subject: '', preheader: '', why: '', html: '', text: '',
});

/**
 * Opens on the live version of `action`, or, for a new template, on a blank
 * draft wearing the first layout; or, given `restore`, on a draft kept when
 * the console left mid-edit. Calls `onSaved` with the saved row, and
 * `onReload` when the admin asks to see someone else's newer version.
 */
export function TemplateEditor({ payload, action, isNew, canWrite, onDone, onSaved, onDraftSaved, onReload, restore = null, version = 'draft' }: {
  payload: TemplatesPayload;
  action: string;
  isNew: boolean;
  // 'live' opens the live version of an email that also has a draft.
  version?: 'draft' | 'live';
  canWrite: boolean;
  onDone: () => void;
  // The saved row, and any translations the save left unusable.
  // `kept`: the English words did not change, so the translations came along.
  onSaved: (row: TemplateRow, unusable: UnusableItem[], kept: boolean) => void;
  // The saved draft: nothing went live and nothing was sent.
  onDraftSaved: (row: TemplateRow) => void;
  onReload: () => void;
  restore?: (KeptDraft & { kind: 'template' }) | null;
}) {
  // What the editor opened with, and the live version that was: unsaved
  // edits are measured against the first, and Save expects the second.
  // The draft the editor opened on, when the email has one: an email opens on
  // its draft, which is where unfinished work is.
  const [openedDraft] = useState<TemplateRow | null>(() => (isNew || version === 'live' ? null : draftTemplate(payload, action)));
  const [opened] = useState<TemplateDraft>(() => {
    if (restore) return restore.opened;
    if (openedDraft) return draftFrom(openedDraft);
    const live = liveTemplate(payload, action);
    if (live && !isNew) return draftFrom(live);
    const first = liveLayouts(payload)[0];
    return BLANK(action, first ? first.family_id : null);
  });
  const [openedLive] = useState<{ action: string; id: number | null }>(() => {
    if (restore) return { action: restore.action, id: restore.openedLiveId };
    const live = liveTemplate(payload, action);
    return { action, id: live ? live.id : null };
  });
  const [draft, setDraft] = useState<TemplateDraft>(() => (restore ? restore.draft : opened));
  const dirty = isDirty(draft, opened);
  const info = payload.actions.find((a) => a.action === draft.action);
  // Languages belong to the saved version this editor opened on (its draft,
  // else the live one); a new template has none until it is saved.
  const versionId = isNew ? null : (openedDraft ? openedDraft.id : openedLive.id);
  const english: LanguageDraft = useMemo(() => ({
    subject: opened.subject, preheader: opened.preheader, why: opened.why, html: opened.html, text: opened.text,
  }), [opened]);
  const languages = useEditorLanguages({
    base: '/api/admin/email-templates', versionId, englishOnly: !!(info && info.englishOnly), englishDirty: dirty,
    canWrite, english, parts: TEMPLATE_PARTS, languages: payload.languages, initial: restore?.language || null,
    idPrefix: 'email-template',
  });
  const { lang } = languages;
  const anyDirty = dirty || lang.dirty;
  useUnloadGuard(anyDirty);
  // Set once the editor is left on purpose (saved, or edits discarded), so
  // unmounting then keeps nothing.
  const settled = useRef(false);
  const latest = useRef({ draft, dirty, lang });
  latest.current = { draft, dirty, lang };
  useEffect(() => () => {
    // The console tore the section down while edits were unsaved: it gives
    // no way to ask first, so keep them for the section to offer back, a
    // language's words included.
    const now = latest.current;
    if (settled.current || !(now.dirty || now.lang.dirty)) return;
    const name = now.draft.name || payload.actions.find((a) => a.action === action)?.label || 'this email';
    const language = keptLanguage(now.lang);
    const label = language ? `${name} (${payload.languages.find((l) => l.code === language.locale)?.label || language.locale})` : name;
    keepDraft({ kind: 'template', action, isNew, version, label, draft: now.draft, opened, openedLiveId: openedLive.id, language });
  }, [action, isNew, version, payload, opened, openedLive]);
  const [tab, setTab] = useState<BodyTab>('visual');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);
  // The live version this editor started from, fixed when it opened (or kept
  // with a restored draft), so a save over someone else's newer version is a
  // conflict. A new template switched to another email expects that email's
  // live version as this snapshot shows it.
  const expectedLiveId = useMemo(() => expectedLiveFor(openedLive, draft.action, payload), [payload, draft.action, openedLive]);

  const change = (field: keyof TemplateDraft, value: string | number | null) => {
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const save = async () => {
    if (saving || !canWrite) return;
    // New English words start the new version with no translations: say
    // first what an admin's hand corrections of this one will need. A new
    // name or layout keeps them, so there is nothing to warn about.
    if (wordsChanged(draft, opened) && !(await confirmHandCorrected(lang.rows, 'email'))) return;
    setSaving(true);
    setFailure(null);
    const res = await request('/api/admin/email-templates', 'POST', { ...draft, expectedLiveId });
    setSaving(false);
    if (res.ok && res.data && res.data.template) {
      settled.current = true;
      onSaved(res.data.template, unusableOf(res.data), res.data.translationsKept === true);
      return;
    }
    const refused = readFailure(res.status, res.data);
    setFailure(refused);
    if (refused.kind === 'fields') {
      // Show the first problem's tab, so it is not hidden behind the other one.
      const first = refused.errors.find((x) => x.field === 'html' || x.field === 'text');
      if (first) setTab(first.field as BodyTab);
    }
  };

  // The email being saved has a draft this editor did not open: its live
  // version was asked for, or a new template was pointed at it.
  const otherDraft = openedDraft ? null : draftTemplate(payload, draft.action);
  const draftWaiting = !otherDraft ? null
    : isNew
      ? 'This email already has a draft. Open that draft from the list to change it, or discard it there first.'
      : `This is the live version. Draft v${otherDraft.version} of this email is waiting too; open it from the list to change it.`;

  // Keeps the edit as the email's draft, which nobody is sent. The draft this
  // editor opened on is the one it expects, so another admin's newer draft
  // is a conflict, not overwritten.
  const saveDraft = async () => {
    if (saving || !canWrite) return;
    setSaving(true);
    setFailure(null);
    // Only the draft this editor opened on is continued. Any other email's
    // draft is left alone: `draftWaiting` keeps Save draft away from it, and
    // the server refuses one that appeared since.
    if (draftWaiting) return;
    const expectedDraftId = openedDraft ? openedDraft.id : null;
    const res = await request('/api/admin/email-templates/draft', 'POST', { ...draft, expectedDraftId });
    setSaving(false);
    if (res.ok && res.data && res.data.template) {
      settled.current = true;
      onDraftSaved(res.data.template);
      return;
    }
    const refused = readFailure(res.status, res.data);
    setFailure(refused);
    if (refused.kind === 'fields') {
      const first = refused.errors.find((x) => x.field === 'html' || x.field === 'text');
      if (first) setTab(first.field as BodyTab);
    }
  };

  // Puts the saved draft live in place of the live version.
  const publish = async () => {
    if (saving || !canWrite || !openedDraft || dirty) return;
    setSaving(true);
    setFailure(null);
    const res = await request(`/api/admin/email-templates/${openedDraft.id}/publish`, 'POST', { expectedLiveId });
    setSaving(false);
    if (res.ok && res.data && res.data.template) {
      settled.current = true;
      onSaved(res.data.template, unusableOf(res.data), (res.data.template.locales || []).length > 0);
      return;
    }
    setFailure(readFailure(res.status, res.data));
  };

  const leave = async () => {
    if (anyDirty && !(await confirmDiscard('Your changes to this email are not saved. Leave and lose them?'))) return;
    settled.current = true;
    onDone();
  };
  const reload = async () => {
    if (anyDirty && !(await confirmDiscard('Reload discards your changes and shows the version saved now.', 'Reload'))) return;
    settled.current = true;
    onReload();
  };

  const fields = {
    name: draft.name, subject: draft.subject, preheader: draft.preheader, why: draft.why,
    html: draft.html, text: draft.text, layoutFamilyId: draft.layoutFamilyId,
  };

  if (lang.locale !== 'en' && lang.draft && lang.opened) {
    const words = lang.draft;
    // The language's words framed as the English would be, so the preview
    // and the test send show that language as its readers get it.
    const languageFields = {
      name: draft.name, layoutFamilyId: draft.layoutFamilyId,
      subject: words.subject || '', preheader: words.preheader || '', why: words.why || '', html: words.html || '', text: words.text || '',
    };
    return (
      <LanguageForm language={languages.name} draft={words} opened={lang.opened} english={english} parts={TEMPLATE_PARTS}
        tab={tab} onTab={setTab} failure={lang.failure} saving={lang.saving} saved={lang.saved} unusable={languages.unusable}
        canWrite={canWrite} retranslating={languages.retranslating} placeholders={info ? info.placeholders : []}
        idPrefix="email-translation" backLabel="‹ All templates" onBack={leave} onChange={lang.setField} onSave={lang.save}
        onRevert={lang.revert} onRetranslate={languages.retranslate} languagesCard={languages.card} languages={payload.languages}
        hasRow={languages.hasRow} onTranslateOne={languages.translateOne} onReload={reload}
        preview={(
          <PreviewPane base="/api/admin/email-templates" body={{ action: draft.action, fields: languageFields }}
            mode={tab === 'text' ? 'text' : 'html'} languages={payload.languages} englishOnly={false} canWrite={canWrite}
            onFieldFailure={() => {}} fixedLocale={lang.locale} />
        )}
        side={<div className={`${AdminUI.card} p-4`}>{info ? <PlaceholderList action={info} /> : null}</div>} />
    );
  }

  return (
    <TemplateForm payload={payload} draft={draft} opened={opened} isNew={isNew} canWrite={canWrite} tab={tab} failure={failure}
      languagesCard={isNew ? null : languages.card}
      saving={saving} onChange={change} onTab={setTab} onSave={save} onCancel={leave} onReload={reload} onRetry={save}
      dirty={dirty} openedOn={isNew ? 'new' : openedDraft ? 'draft' : 'live'} onSaveDraft={draftWaiting ? undefined : saveDraft} onPublish={publish}
      draftWaiting={draftWaiting}
      preview={(
        <PreviewPane base="/api/admin/email-templates" body={{ action: draft.action, fields }} mode={tab === 'text' ? 'text' : 'html'}
          languages={payload.languages} englishOnly={!!(info && info.englishOnly)} canWrite={canWrite}
          onFieldFailure={setFailure} />
      )} />
  );
}
