'use strict';

import { useEffect } from 'react';

import { AdminUI } from '../admin-console.js';

// What the Email templates section's parts share: the shapes the admin
// routes answer with (src/routes/admin-email-templates.js), one fetch that
// never throws, the reading of a refusal into something the screen can act
// on, and the two small pieces that show it (beside a field, or above the
// form). Admin console text stays English in code.

export interface Placeholder { name: string; description: string; kind?: string; fromCode?: boolean }

export interface ActionInfo {
  action: string;
  label: string;
  englishOnly: boolean;
  required: { html: string[]; text: string[] };
  placeholders: Placeholder[];
}

export interface TemplateRow {
  id: number;
  action: string;
  name: string;
  layout_family_id: number | null;
  version: number;
  status: 'live' | 'archived';
  subject: string;
  preheader: string;
  why: string;
  html: string;
  text: string;
  created_by: number | null;
  created_at: string;
  deleted_at: string | null;
  locales: string[];
}

export interface LayoutRow {
  id: number;
  family_id: number;
  name: string;
  version: number;
  status: 'live' | 'archived';
  html: string;
  text: string;
  created_by: number | null;
  created_at: string;
  deleted_at: string | null;
  locales: string[];
}

export interface Language { code: string; label: string }

export interface TemplatesPayload {
  actions: ActionInfo[];
  layoutPlaceholders: Placeholder[];
  languages: Language[];
  templates: TemplateRow[];
  layouts: LayoutRow[];
}

export interface FieldError { field: string; message: string }

// What went wrong, as the screen shows it: field problems go beside their
// fields, a conflict offers Reload, a busy database offers Try again, and
// anything else is one sentence.
export type Failure =
  | { kind: 'fields'; message: string; errors: FieldError[] }
  | { kind: 'conflict'; message: string }
  | { kind: 'retry'; message: string }
  | { kind: 'message'; message: string };

export interface Answer { status: number; ok: boolean; data: any }

// A request that never throws. `status: 0` means no answer at all. A route
// that fell through to the page on a lost session answers HTML, which is
// read as no data.
export async function request(url: string, method = 'GET', body?: unknown): Promise<Answer> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) return { status: res.status, ok: res.ok, data: null };
    try { return { status: res.status, ok: res.ok, data: await res.json() }; } catch {
      return { status: res.status, ok: res.ok, data: null };
    }
  } catch {
    return { status: 0, ok: false, data: null };
  }
}

const CONFLICT = 'Someone else changed this since you opened it. Reload to see their version, then make your change again.';
const RETRY = 'The database was busy with another change. Try again in a moment.';

export function readFailure(status: number, data: any): Failure {
  const said = data && typeof data.error === 'string' && data.error ? data.error : '';
  if (status === 0) return { kind: 'message', message: 'Could not reach the platform. Nothing was changed; try again.' };
  if (status === 409 && data && data.code === 'retry') return { kind: 'retry', message: said || RETRY };
  if (status === 409) return { kind: 'conflict', message: said || CONFLICT };
  if (status === 400 && data && Array.isArray(data.errors) && data.errors.length) {
    const errors = data.errors
      .filter((e: any) => e && typeof e.message === 'string')
      .map((e: any) => ({ field: typeof e.field === 'string' ? e.field : '', message: e.message }));
    return { kind: 'fields', message: said || 'This cannot be saved yet. Fix the problems shown and try again.', errors };
  }
  if (status === 403) return { kind: 'message', message: said || 'This needs full admin access.' };
  return { kind: 'message', message: said || 'Something went wrong on the server. Nothing was changed.' };
}

// The messages for one field, from a `fields` failure.
export function errorsFor(failure: Failure | null, ...fields: string[]): string[] {
  if (!failure || failure.kind !== 'fields') return [];
  return failure.errors.filter((e) => fields.includes(e.field)).map((e) => e.message);
}

/** Problems shown under a field, with the id its control points at. */
export function FieldErrors({ id, messages }: { id: string; messages: string[] }) {
  if (!messages.length) return null;
  return (
    <p id={id} className="mt-1 text-xs text-red-700 dark:text-red-400" role="alert">
      {messages.join(' ')}
    </p>
  );
}

/**
 * A refusal above the form. `shownFields` are the fields drawn on screen, so
 * an error for any other field is listed here instead of being lost.
 */
export function FailureNotice({ failure, shownFields = [], onReload, onRetry }: {
  failure: Failure | null; shownFields?: string[]; onReload?: () => void; onRetry?: () => void;
}) {
  if (!failure) return null;
  const loose = failure.kind === 'fields' ? failure.errors.filter((e) => !shownFields.includes(e.field)) : [];
  return (
    <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-800 dark:text-red-300" role="alert">
      <p>{failure.message}</p>
      {loose.length ? (
        <ul className="list-disc ms-5 mt-1">
          {/* eslint-disable-next-line react/no-array-index-key */}
          {loose.map((e, i) => <li key={i}>{e.message}</li>)}
        </ul>
      ) : null}
      {failure.kind === 'conflict' && onReload
        ? <button type="button" className={`${AdminUI.btn.outlineSm} mt-2`} onClick={onReload}>Reload</button>
        : null}
      {failure.kind === 'retry' && onRetry
        ? <button type="button" className={`${AdminUI.btn.outlineSm} mt-2`} onClick={onRetry}>Try again</button>
        : null}
    </div>
  );
}

const DAY = 24 * 60 * 60 * 1000;

// When a version was written. A version nobody wrote (created_by is empty)
// is the one Homeroom shipped with.
export function editedLabel(row: { created_by: number | null; created_at: string }, now: number): string {
  if (row.created_by == null) return 'Original';
  const at = Date.parse(row.created_at);
  if (!Number.isFinite(at)) return '';
  const days = Math.floor((now - at) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return String(row.created_at).slice(0, 10);
}

// How many languages the live version is translated into. It does not say
// whether a translation is behind the English: nothing tracks that yet.
export function languagesLabel(locales: string[], englishOnly: boolean): string {
  const n = englishOnly ? 0 : locales.length;
  if (!n) return 'English only';
  return n === 1 ? '1 language' : `${n} languages`;
}

export const isLive = (row: { status: string; deleted_at: string | null }) => row.status === 'live' && !row.deleted_at;

export function liveTemplate(payload: TemplatesPayload, action: string): TemplateRow | null {
  return payload.templates.find((t) => t.action === action && isLive(t)) || null;
}

export function liveLayouts(payload: TemplatesPayload): LayoutRow[] {
  return payload.layouts.filter(isLive).sort((a, b) => a.name.localeCompare(b.name));
}

export function requiredNames(action: ActionInfo): string[] {
  return [...new Set([...(action.required?.html || []), ...(action.required?.text || [])])];
}

/** The placeholders an email may use, with what each one is. */
export function PlaceholderList({ action, placeholders, required }: {
  action?: ActionInfo; placeholders?: Placeholder[]; required?: string[];
}) {
  const list = action ? action.placeholders : placeholders || [];
  const must = new Set(action ? requiredNames(action) : required || []);
  return (
    <div>
      <h3 className="text-sm font-semibold">Placeholders you can use</h3>
      {list.length ? (
        <ul className="mt-2 space-y-2" data-email-placeholders="">
          {list.map((p) => (
            <li key={p.name} className="text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <code className={AdminUI.kbd}>{`{{${p.name}}}`}</code>
                {must.has(p.name) ? <span className={AdminUI.badge.secondary}>Required</span> : null}
                {p.kind === 'url' ? <span className="text-zinc-500 dark:text-zinc-400">a link</span> : null}
                {p.kind === 'flag' ? <span className="text-zinc-500 dark:text-zinc-400">true or false, for {'{{#if}}'}</span> : null}
              </div>
              <p className="text-zinc-600 dark:text-zinc-300 mt-0.5">{p.description}</p>
              {p.fromCode ? (
                <p className="text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Its wording comes from Homeroom&apos;s code, so it cannot be edited here.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className={`${AdminUI.muted} mt-2`}>This email takes no placeholders.</p>}
    </div>
  );
}

// ── Unsaved edits ──────────────────────────────────────────────────────

/** Whether a draft differs from what the editor opened with. */
export function isDirty(draft: object, opened: object): boolean {
  return JSON.stringify(draft) !== JSON.stringify(opened);
}

// Asks before throwing edits away, through the console's own dialog.
export async function confirmDiscard(message: string, confirmLabel = 'Discard changes'): Promise<boolean> {
  const consoleApi = typeof window !== 'undefined' ? (window as any).AdminConsole : null;
  if (!consoleApi || typeof consoleApi._confirm !== 'function') return true;
  return !!(await consoleApi._confirm({ title: 'Discard your changes?', message, confirmLabel, destructive: true }));
}

// While there are unsaved edits, closing or reloading the tab asks first.
export function useUnloadGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return undefined;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);
}

// An editor left with unsaved edits by a way it cannot stop: the console
// switching section, which tears the section down at once and offers no way
// to ask. The draft is kept here, for this tab only, and the section offers
// it back the next time it opens.
export type KeptDraft =
  | { kind: 'template'; action: string; isNew: boolean; label: string; draft: any }
  | { kind: 'layout'; familyId: number | null; label: string; draft: any };

let kept: KeptDraft | null = null;
export const keptDraft = (): KeptDraft | null => kept;
export const keepDraft = (next: KeptDraft | null) => { kept = next; };

/** Says an editor was left with unsaved edits, and offers them back. */
export function KeptDraftNotice({ draft, onOpen, onDiscard }: {
  draft: KeptDraft | null; onOpen: () => void; onDiscard: () => void;
}) {
  if (!draft) return null;
  return (
    <div id="email-templates-kept" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300" role="status">
      <span>{`You left unsaved changes to ${draft.label}. They are kept until you close this tab.`}</span>
      <span className="flex gap-2">
        <button type="button" className={AdminUI.btn.outlineSm} onClick={onOpen}>Continue editing</button>
        <button type="button" className={AdminUI.btn.outlineSm} onClick={onDiscard}>Discard</button>
      </span>
    </div>
  );
}
