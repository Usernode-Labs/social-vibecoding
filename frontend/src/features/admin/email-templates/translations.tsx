'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from '../admin-console.js';
import { UploadImageButton } from './image-panel';
import {
  confirmDiscard, errorsFor, FailureNotice, FieldErrors, isDirty, readFailure, request, type Failure, type Language, type Placeholder,
} from './shared';
import { VisualTab } from './visual-tab';
import { createPoller } from './translate-poller';

// Translate in the editors (routes in src/routes/admin-email-templates.js,
// the job in src/services/mail/template-translate.js).
//
// A saved version of an email or a layout is translated into every other
// language Homeroom offers by one job on the server. These parts start it,
// follow it per language until it is done (a reload picks a running job up
// again, because the read reports it), let an admin open one language and
// correct its words in the same tabs as the English, and say plainly which
// languages are not sent because their translation no longer fits.
//
// Everything here is the admin console: English in code, AdminUI recipes,
// and state said in words, never by colour alone.

export interface TranslationRow {
  locale: string;
  subject?: string;
  preheader?: string;
  why?: string;
  html: string;
  text: string;
  origin: 'machine' | 'admin';
  unusable: string | null;
}

export interface JobStatus {
  state: 'none' | 'running' | 'done' | 'stopped';
  perLanguage: Record<string, string>;
  unusable: Record<string, string>;
  overwrite?: boolean;
}

export interface UnusableItem { locale: string; reason: string; action?: string; templateId?: number; layoutId?: number }

/** The languages besides English. */
export const otherLanguages = (languages: Language[]) => languages.filter((l) => l.code !== 'en');

export const languageName = (languages: Language[], code: string) => (languages.find((l) => l.code === code) || { label: code }).label;

// ── The Languages column ───────────────────────────────────────────────

/**
 * How many languages a version is sent in besides English: "12 of 12", "9 of
 * 12, 3 need translating", or "English only". A translation marked unusable
 * is not counted: its readers get the English.
 */
export function translationSummary(row: { locales?: string[]; unusableLocales?: string[] } | null, codes: string[], englishOnly: boolean): string {
  const total = codes.length;
  if (englishOnly || total <= 0) return 'English only';
  const unusable = new Set(row?.unusableLocales || []);
  // Only languages Homeroom offers now count: a translation left over for a
  // language since dropped from the list is not one a reader can get.
  const offered = new Set(codes);
  const n = (row?.locales || []).filter((code) => offered.has(code) && !unusable.has(code)).length;
  if (n >= total) return `${total} of ${total}`;
  const missing = total - n;
  return `${n} of ${total}, ${missing} ${missing === 1 ? 'needs' : 'need'} translating`;
}

/**
 * The list's Languages cell for one email: its own count, and its layout's
 * when that says something different (the layout's words are a separate
 * translation, and a reader gets English for whichever part is missing).
 */
export function languagesColumn(
  payload: { languages: Language[]; layouts: Array<{ family_id: number; status: string; deleted_at: string | null; locales?: string[]; unusableLocales?: string[] }> },
  englishOnly: boolean,
  live: { locales?: string[]; unusableLocales?: string[]; layout_family_id: number | null },
): string {
  const codes = otherLanguages(payload.languages).map((l) => l.code);
  const own = translationSummary(live, codes, englishOnly);
  if (englishOnly || live.layout_family_id == null) return own;
  const layout = payload.layouts.find((l) => l.family_id === live.layout_family_id && l.status === 'live' && !l.deleted_at);
  if (!layout) return own;
  const framed = translationSummary(layout, codes, false);
  return framed === own ? own : `${own}; layout: ${framed}`;
}

// ── Job progress ───────────────────────────────────────────────────────

/** One language's outcome in a job, in words. */
export function stateWords(state: string | undefined): string {
  if (!state || state === 'pending') return 'Waiting to be translated';
  if (state === 'saved') return 'Translated and saved';
  if (state === 'skipped: admin') return 'Skipped: an admin edited this language';
  if (state.startsWith('failed:')) return `Failed: ${state.slice('failed:'.length).trim()}`;
  if (state.startsWith('skipped:')) return `Skipped: ${state.slice('skipped:'.length).trim()}`;
  return state;
}

/** The line above the per-language list. */
export function jobSummary(status: JobStatus): string {
  const states = Object.values(status.perLanguage);
  const count = (pick: (s: string) => boolean) => states.filter(pick).length;
  const saved = count((s) => s === 'saved');
  const failed = count((s) => s.startsWith('failed'));
  const skipped = count((s) => s.startsWith('skipped'));
  if (status.state === 'running') return `Translating: ${states.length - count((s) => s === 'pending')} of ${states.length} languages done.`;
  if (status.state === 'stopped') return 'Translating stopped before it finished. Translate again to finish the rest.';
  if (status.state === 'done') {
    const parts = [`${saved} translated`];
    if (failed) parts.push(`${failed} failed`);
    if (skipped) parts.push(`${skipped} skipped`);
    return `Finished: ${parts.join(', ')}.`;
  }
  return 'Not translated yet.';
}

export function TranslateProgressView({ status, languages }: { status: JobStatus | null; languages: Language[] }) {
  if (!status || (status.state === 'none' && !Object.keys(status.unusable || {}).length)) return null;
  const codes = Object.keys(status.perLanguage);
  return (
    <div className="mt-3" id="email-translate-progress" aria-live="polite">
      <p className="text-sm font-medium">{jobSummary(status)}</p>
      {codes.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {codes.map((code) => (
            <li key={code} data-translate-language={code} className="flex flex-wrap gap-x-2">
              <span className="font-medium min-w-[6rem]">{languageName(languages, code)}</span>
              <span className={status.perLanguage[code].startsWith('failed') ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-300'}>
                {stateWords(status.perLanguage[code])}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {Object.keys(status.unusable || {}).length ? (
        <ul className="mt-2 space-y-1 text-xs text-amber-800 dark:text-amber-300">
          {Object.entries(status.unusable).map(([code, reason]) => (
            <li key={code}>{`${languageName(languages, code)} is not sent: ${reason}. It sends the English until it is fixed.`}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Reads a version's Translate job and keeps reading while it runs (through
 * translate-poller.ts, which backs off after a failed read and keeps the last
 * status on screen). `start` presses Translate; the server answers with the
 * job (a running one when it was already going), and the poller follows it.
 */
export function useTranslateJob(base: string, versionId: number | null) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);
  const poller = useRef<ReturnType<typeof createPoller<JobStatus, Failure>> | null>(null);

  useEffect(() => {
    alive.current = true;
    if (versionId == null) return undefined;
    const p = createPoller<JobStatus, Failure>({
      read: async () => {
        const res = await request(`${base}/${versionId}/translate`);
        return res.ok && res.data ? { ok: true as const, status: res.data } : { ok: false as const, failure: readFailure(res.status, res.data) };
      },
      onStatus: (next) => { setFailure(null); setStatus(next); },
      onFailure: setFailure,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    poller.current = p;
    p.poll();
    return () => { alive.current = false; p.stop(); poller.current = null; };
  }, [base, versionId]);

  const refresh = useCallback(() => { poller.current?.poll(); }, []);

  const start = useCallback(async (body: { overwrite?: boolean; languages?: string[] } = {}) => {
    if (versionId == null || starting) return false;
    setStarting(true);
    setFailure(null);
    const res = await request(`${base}/${versionId}/translate`, 'POST', body);
    if (!alive.current) return false;
    setStarting(false);
    if (!res.ok || !res.data) { setFailure(readFailure(res.status, res.data)); return false; }
    const next: JobStatus = { unusable: status?.unusable || {}, ...res.data };
    setStatus(next);
    poller.current?.seen(next);
    return true;
  }, [base, versionId, starting, status]);

  return { status, failure, starting, start, refresh };
}

// Why Translate cannot be pressed now, or null when it can.
export function translateBlocked({ englishOnly, dirty, versionId }: { englishOnly: boolean; dirty: boolean; versionId: number | null }): string | null {
  if (englishOnly) return 'This email is sent in English only, so there is nothing to translate.';
  if (dirty || versionId == null) return 'Save first, then translate';
  return null;
}

export function TranslateControlsView({
  status, failure, starting, blocked, canWrite, languages, onTranslate, onReplace,
}: {
  status: JobStatus | null;
  failure: Failure | null;
  starting: boolean;
  blocked: string | null;
  canWrite: boolean;
  languages: Language[];
  onTranslate: () => void;
  onReplace: () => void;
}) {
  const running = !!status && status.state === 'running';
  const disabled = !!blocked || running || starting;
  return (
    <div>
      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" id="email-translate" className={AdminUI.btn.outlineSm} disabled={disabled}
            aria-describedby={blocked ? 'email-translate-blocked' : undefined} onClick={onTranslate}>
            {running || starting ? 'Translating…' : 'Translate'}
          </button>
          <button type="button" id="email-translate-replace" className={AdminUI.btn.outlineSm} disabled={disabled}
            aria-describedby={blocked ? 'email-translate-blocked' : undefined} onClick={onReplace}>
            Translate again, replacing admin edits
          </button>
        </div>
      ) : null}
      {blocked && canWrite ? <p id="email-translate-blocked" className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{blocked}</p> : null}
      {canWrite && !blocked ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          {`Translates this saved version into the other ${otherLanguages(languages).length} languages. A language an admin corrected is left alone unless you replace admin edits.`}
        </p>
      ) : null}
      {failure ? <div className="mt-2"><FailureNotice failure={failure} /></div> : null}
      <TranslateProgressView status={status} languages={languages} />
    </div>
  );
}

async function confirmReplace(): Promise<boolean> {
  const consoleApi = typeof window !== 'undefined' ? (window as any).AdminConsole : null;
  if (!consoleApi || typeof consoleApi._confirm !== 'function') return false;
  return !!(await consoleApi._confirm({
    title: 'Replace admin edits?',
    message: 'Every language is translated again from the English, including the ones an admin corrected by hand. Their corrections are lost.',
    confirmLabel: 'Translate and replace',
    destructive: true,
  }));
}

/** Translate for one saved version: the buttons and the progress. */
export function TranslateControls({ versionId, englishOnly, dirty, canWrite, languages, job }: {
  versionId: number | null; englishOnly: boolean; dirty: boolean; canWrite: boolean; languages: Language[];
  job: ReturnType<typeof useTranslateJob>;
}) {
  const blocked = translateBlocked({ englishOnly, dirty, versionId });
  return (
    <TranslateControlsView status={job.status} failure={job.failure} starting={job.starting} blocked={blocked}
      canWrite={canWrite} languages={languages}
      onTranslate={() => { job.start({}); }}
      onReplace={async () => { if (await confirmReplace()) job.start({ overwrite: true }); }} />
  );
}

/**
 * The offer on the banner after a save: "Translate the other languages now".
 * Pressed, it starts the job for the version just saved and shows its progress
 * in place.
 */
export function TranslateOffer({ base, versionId, languages, onFinished }: {
  base: string; versionId: number; languages: Language[];
  // Called once the job it started is over, so the list can count again.
  onFinished?: () => void;
}) {
  const [asked, setAsked] = useState(false);
  if (!asked) {
    return (
      <button type="button" id="email-translate-offer" className={`${AdminUI.btn.outlineSm} mt-2`} onClick={() => setAsked(true)}>
        Translate the other languages now
      </button>
    );
  }
  return <StartedTranslate base={base} versionId={versionId} languages={languages} onFinished={onFinished} />;
}

function StartedTranslate({ base, versionId, languages, onFinished }: {
  base: string; versionId: number; languages: Language[]; onFinished?: () => void;
}) {
  const job = useTranslateJob(base, versionId);
  const once = useRef(false);
  const state = job.status ? job.status.state : null;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (state === 'running') { wasRunning.current = true; return; }
    if (wasRunning.current && (state === 'done' || state === 'stopped')) {
      wasRunning.current = false;
      if (onFinished) onFinished();
    }
  }, [state, onFinished]);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    job.start({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div>
      {job.failure ? <div className="mt-2"><FailureNotice failure={job.failure} /></div> : null}
      <TranslateProgressView status={job.status} languages={languages} />
    </div>
  );
}

// ── Translations a save broke ──────────────────────────────────────────

/** "French (Sign-in code), German": the languages a save left unusable. */
export function unusableNames(items: UnusableItem[], languages: Language[], labelFor?: (item: UnusableItem) => string | null): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of items) {
    const where = labelFor ? labelFor(item) : null;
    const name = where ? `${languageName(languages, item.locale)} (${where})` : languageName(languages, item.locale);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.join(', ');
}

export function UnusableSavedNotice({ items, languages, labelFor }: {
  items: UnusableItem[] | undefined; languages: Language[]; labelFor?: (item: UnusableItem) => string | null;
}) {
  if (!items || !items.length) return null;
  return (
    <div id="email-unusable-notice" className="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300" role="status">
      {`These translations no longer fit and send the English until they are fixed: ${unusableNames(items, languages, labelFor)}.`}
    </div>
  );
}

// ── One language's words ───────────────────────────────────────────────

export type TranslatedField = 'subject' | 'preheader' | 'why' | 'html' | 'text';
export type LanguageDraft = Partial<Record<TranslatedField, string>>;

export const TEMPLATE_PARTS: TranslatedField[] = ['subject', 'preheader', 'why', 'html', 'text'];
export const LAYOUT_PARTS: TranslatedField[] = ['html', 'text'];

/**
 * A language's words to edit: its translation, or, with none yet, the English
 * to start from.
 */
/**
 * The sentence for the languages of a version an admin corrected by hand, or
 * null when there are none. A new English version starts with no
 * translations, so Translate fills it from the English and those corrections
 * are not carried over.
 */
export function handCorrectedWarning(rows: Record<string, TranslationRow> | null | undefined): string | null {
  const count = Object.values(rows || {}).filter((row) => row && row.origin === 'admin').length;
  if (!count) return null;
  return count === 1
    ? '1 language corrected by hand will need correcting again'
    : `${count} languages corrected by hand will need correcting again`;
}

/** Asks before an English save that leaves hand corrections behind; true to go on. */
export async function confirmHandCorrected(rows: Record<string, TranslationRow> | null | undefined, what: 'email' | 'layout'): Promise<boolean> {
  const warning = handCorrectedWarning(rows);
  if (!warning) return true;
  const consoleApi = typeof window !== 'undefined' ? (window as any).AdminConsole : null;
  if (!consoleApi || typeof consoleApi._confirm !== 'function') return true;
  return !!(await consoleApi._confirm({
    title: `Save a new version of this ${what}?`,
    message: `${warning}: the new version starts with no translations, and Translate fills them from the English.`,
    confirmLabel: 'Save',
  }));
}

export function languageDraftFrom(row: TranslationRow | null | undefined, english: LanguageDraft, parts: TranslatedField[]): LanguageDraft {
  return Object.fromEntries(parts.map((p) => [p, row ? String((row as any)[p] ?? '') : String(english[p] ?? '')]));
}

/**
 * Why a language is not sent, or null. The translation row is the latest
 * word on it (a correction just saved clears it); the job's list stands in
 * only before any row is known for that language.
 */
export function unusableReason(row: TranslationRow | undefined, jobUnusable: Record<string, string> | undefined, locale: string): string | null {
  if (locale === 'en') return null;
  if (row) return row.unusable || null;
  return (jobUnusable && jobUnusable[locale]) || null;
}

/** The PUT that saves one language's words, to the version the editor opened on. */
export function languageSaveRequest(base: string, versionId: number, locale: string, draft: LanguageDraft) {
  return {
    url: `${base}/${versionId}/translations/${encodeURIComponent(locale)}`,
    method: 'PUT' as const,
    body: { ...draft, expectedLiveId: versionId },
  };
}

/** Retranslate: that one language, its words replaced whoever wrote them. */
export const retranslateBody = (locale: string) => ({ languages: [locale], overwrite: true });

/** What a move in the language switch does. */
export function languageMove({ from, to, languageDirty }: { from: string; to: string; languageDirty: boolean }): 'stay' | 'confirm' | 'go' {
  if (from === to) return 'stay';
  return languageDirty ? 'confirm' : 'go';
}

/** A language's unsaved words, for a kept draft; null when there are none. */
export function keptLanguage(lang: { dirty: boolean; locale: string; draft: LanguageDraft | null; opened: LanguageDraft | null }) {
  return lang.dirty && lang.draft && lang.opened ? { locale: lang.locale, draft: lang.draft, opened: lang.opened } : null;
}

/** A language's state as the switch names it. */
export function languageState(row: TranslationRow | undefined, unusable?: string): string {
  if (!row) return 'not translated';
  if (row.unusable || unusable) return 'not sent, needs fixing';
  return row.origin === 'admin' ? 'edited by an admin' : 'translated';
}

export function LanguageSwitch({ locale, languages, rows, unusable, blocked, onChange, idPrefix }: {
  locale: string;
  languages: Language[];
  rows: Record<string, TranslationRow> | null;
  unusable?: Record<string, string>;
  // Why the switch cannot move now (unsaved English), or null.
  blocked: string | null;
  onChange: (locale: string) => void;
  idPrefix: string;
}) {
  const id = `${idPrefix}-language`;
  return (
    <div>
      <label htmlFor={id} className={AdminUI.label}>Language</label>
      <select id={id} className={`${AdminUI.select} mt-1`} value={locale} disabled={!!blocked && locale === 'en'}
        aria-describedby={blocked && locale === 'en' ? `${id}-blocked` : undefined}
        onChange={(ev) => onChange(ev.target.value)}>
        <option value="en">English (the original)</option>
        {otherLanguages(languages).map((l) => (
          <option key={l.code} value={l.code}>
            {`${l.label}: ${rows ? languageState(rows[l.code], unusable?.[l.code]) : 'loading'}`}
          </option>
        ))}
      </select>
      {blocked && locale === 'en' ? <p id={`${id}-blocked`} className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{blocked}</p> : null}
    </div>
  );
}

/** Reads every translation of a version, again after each save. */
export function useTranslations(base: string, versionId: number | null) {
  const [rows, setRows] = useState<Record<string, TranslationRow> | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const load = useCallback(async () => {
    if (versionId == null) { setRows({}); return; }
    const res = await request(`${base}/${versionId}/translations`);
    if (!alive.current) return;
    if (!res.ok || !res.data || typeof res.data.translations !== 'object') { setFailure(readFailure(res.status, res.data)); return; }
    setFailure(null);
    setRows(res.data.translations || {});
  }, [base, versionId]);
  useEffect(() => { load(); }, [load]);
  return { rows, failure, reload: load, setRows };
}

/** The notice on a language that is not sent, with Retranslate. */
export function UnusableLanguageNotice({ language, reason, canWrite, busy, onRetranslate }: {
  language: string; reason: string; canWrite: boolean; busy: boolean; onRetranslate: () => void;
}) {
  return (
    <div id="email-language-unusable" className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300" role="status">
      <p className="font-semibold">{`${language} is not sent right now.`}</p>
      <p className="mt-1">{`Why: ${reason}`}</p>
      <p className="mt-1">This language sends the English until it&apos;s fixed. Correct it below and save, or translate it again.</p>
      {canWrite ? (
        <button type="button" id="email-language-retranslate" className={`${AdminUI.btn.outlineSm} mt-2`} disabled={busy} onClick={onRetranslate}>
          {busy ? 'Translating…' : 'Retranslate'}
        </button>
      ) : null}
    </div>
  );
}

const LABELS: Record<TranslatedField, string> = {
  subject: 'Subject', preheader: 'Preheader', why: 'Why they got it', html: 'HTML', text: 'Text version',
};

/**
 * The English beside a language's fields, so the words being corrected can be
 * read against the original. A disclosure, so a phone can fold it away.
 */
export function EnglishPanel({ english, parts, idPrefix }: { english: LanguageDraft; parts: TranslatedField[]; idPrefix: string }) {
  return (
    <details open className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2" id={`${idPrefix}-english`}>
      <summary className="cursor-pointer text-sm font-medium">English</summary>
      <dl className="mt-2 space-y-2 text-xs">
        {parts.map((p) => (
          <div key={p}>
            <dt className="text-zinc-500 dark:text-zinc-400">{LABELS[p]}</dt>
            <dd className={p === 'html' || p === 'text' ? 'font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto' : 'break-words'}>
              {english[p] || '(empty)'}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * Editing one language: its short fields (a template's subject, preheader and
 * why), then the body in the same tabs as the English, which `body` draws.
 * Errors from the server go beside their fields, by the same field names.
 */
export function LanguageFields({ draft, parts, failure, readOnly, onChange, idPrefix }: {
  draft: LanguageDraft;
  parts: TranslatedField[];
  failure: Failure | null;
  readOnly: boolean;
  onChange: (field: TranslatedField, value: string) => void;
  idPrefix: string;
}) {
  return (
    <>
      {parts.filter((p) => p !== 'html' && p !== 'text').map((p) => {
        const id = `${idPrefix}-${p}`;
        const errors = errorsFor(failure, p);
        return (
          <div key={p}>
            <label htmlFor={id} className={AdminUI.label}>{LABELS[p]}</label>
            <input id={id} className={`${AdminUI.input} mt-1`} value={draft[p] || ''} readOnly={readOnly}
              onChange={(ev) => onChange(p, ev.target.value)}
              {...(errors.length ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {})} />
            <FieldErrors id={`${id}-error`} messages={errors} />
          </div>
        );
      })}
    </>
  );
}

/**
 * One language being edited: the row it opened with, the draft, its save and
 * its Retranslate. The editors draw it with their own tabs.
 */
export function useLanguageEditor({ base, versionId, english, parts, languages, initial, onSaved }: {
  base: string;
  versionId: number | null;
  english: LanguageDraft;
  parts: TranslatedField[];
  languages: Language[];
  // A language draft kept when the console left mid-edit.
  initial?: { locale: string; draft: LanguageDraft; opened: LanguageDraft } | null;
  // After a language is saved: the job's view of which languages are unusable
  // is read again.
  onSaved?: () => void;
}) {
  const translations = useTranslations(base, versionId);
  const [locale, setLocale] = useState<string>(initial ? initial.locale : 'en');
  const [opened, setOpened] = useState<LanguageDraft | null>(initial ? initial.opened : null);
  const [draft, setDraft] = useState<LanguageDraft | null>(initial ? initial.draft : null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ text: string; unusable: UnusableItem[] } | null>(null);
  const dirty = locale !== 'en' && !!draft && !!opened && isDirty(draft, opened);

  // Opens a language once its row is known (or on the English to start from).
  // Before the rows arrive it only remembers the choice; the effect below
  // opens it when they do. `keepNotice` keeps the "saved" line, for a reopen
  // after the rows were read again.
  const open = (code: string, { keepNotice = false }: { keepNotice?: boolean } = {}) => {
    setFailure(null);
    if (!keepNotice) setSaved(null);
    setLocale(code);
    if (code === 'en' || !translations.rows) { setOpened(null); setDraft(null); return; }
    const start = languageDraftFrom(translations.rows[code], english, parts);
    setOpened(start);
    setDraft(start);
  };

  // A language chosen before the rows arrived opens once they do.
  useEffect(() => {
    if (locale !== 'en' && !opened && translations.rows) open(locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translations.rows]);

  const setField = (field: TranslatedField, value: string) => {
    setDraft((d) => ({ ...(d || {}), [field]: value }));
  };

  const save = async () => {
    if (saving || versionId == null || locale === 'en' || !draft) return;
    setSaving(true);
    setFailure(null);
    setSaved(null);
    const put = languageSaveRequest(base, versionId, locale, draft);
    const res = await request(put.url, put.method, put.body);
    setSaving(false);
    if (res.ok && res.data && res.data.translation) {
      const row: TranslationRow = res.data.translation;
      translations.setRows((r) => ({ ...(r || {}), [locale]: row }));
      const next = languageDraftFrom(row, english, parts);
      setOpened(next);
      setDraft(next);
      setSaved({
        text: `${languageName(languages, locale)} saved. Its readers get these words within half a minute.`,
        unusable: Array.isArray(res.data.unusableTranslations) ? res.data.unusableTranslations : [],
      });
      if (onSaved) onSaved();
      return;
    }
    setFailure(readFailure(res.status, res.data));
  };

  const revert = () => { setFailure(null); setDraft(opened); };

  return {
    locale, open, draft, opened, dirty, failure, saving, saved, save, revert, setField,
    rows: translations.rows, rowsFailure: translations.failure, reloadRows: translations.reload,
  };
}

// ── The editors' language parts ────────────────────────────────────────

/** The card above an editor: which language, and Translate. */
export function LanguagesCard({ children }: { children: React.ReactNode }) {
  return (
    <section className={`${AdminUI.card} p-4 space-y-3`} aria-label="Languages" id="email-languages">
      <h3 className="text-sm font-semibold">Languages</h3>
      {children}
    </section>
  );
}

export type BodyTabKey = 'visual' | 'html' | 'text';
const BODY_TABS: Array<{ key: BodyTabKey; label: string }> = [
  { key: 'visual', label: 'Visual' },
  { key: 'html', label: 'HTML' },
  { key: 'text', label: 'Text' },
];

/**
 * One language's words in the editor's place: the same fields and body tabs
 * as the English, the English alongside, and Save for that language alone.
 */
export function LanguageForm({
  language, draft, opened, english, parts, tab, onTab, failure, saving, saved, unusable, canWrite, retranslating,
  placeholders, idPrefix, backLabel, onBack, onChange, onSave, onRevert, onRetranslate, languagesCard, preview, side, languages,
  hasRow = true, onTranslateOne, onReload,
}: {
  language: string;
  draft: LanguageDraft;
  opened: LanguageDraft;
  english: LanguageDraft;
  parts: TranslatedField[];
  tab: BodyTabKey;
  onTab: (tab: BodyTabKey) => void;
  failure: Failure | null;
  saving: boolean;
  saved: { text: string; unusable: UnusableItem[] } | null;
  // The reason this language is not sent, when it is not.
  unusable: string | null;
  canWrite: boolean;
  retranslating: boolean;
  placeholders: Placeholder[];
  idPrefix: string;
  backLabel: string;
  onBack: () => void;
  onChange: (field: TranslatedField, value: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onRetranslate: () => void;
  languagesCard: React.ReactNode;
  preview: React.ReactNode;
  side: React.ReactNode;
  languages: Language[];
  // False when the language has no translation yet: the fields hold the
  // English to start from, and Translate for this language is offered.
  hasRow?: boolean;
  onTranslateOne?: () => void;
  // Offered when the version is no longer live (a conflict).
  onReload?: () => void;
}) {
  const readOnly = !canWrite;
  const changed = isDirty(draft, opened);
  const htmlErrors = errorsFor(failure, 'html');
  const textErrors = errorsFor(failure, 'text');
  const htmlId = `${idPrefix}-html`;
  const textId = `${idPrefix}-text`;
  const htmlArea = useRef<HTMLTextAreaElement | null>(null);
  const latestHtml = useRef(draft.html || '');
  latestHtml.current = draft.html || '';
  const putAtCursor = (tag: string) => {
    const el = htmlArea.current;
    const source = latestHtml.current;
    const start = el ? el.selectionStart : source.length;
    const end = el ? el.selectionEnd : source.length;
    onChange('html', source.slice(0, start) + tag + source.slice(end));
  };
  return (
    <div className="space-y-4" data-email-language={language}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={AdminUI.btn.ghost} onClick={onBack}>{backLabel}</button>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={AdminUI.btn.outline} disabled={saving || !changed} onClick={onRevert}>Undo changes</button>
            <button type="button" id={`${idPrefix}-save`} className={AdminUI.btn.primary} disabled={saving || !changed}
              aria-describedby={changed ? undefined : `${idPrefix}-save-why`} onClick={onSave}>
              {saving ? 'Saving…' : `Save ${language}`}
            </button>
          </div>
        ) : null}
      </div>
      {canWrite && !changed ? (
        <p id={`${idPrefix}-save-why`} className="sr-only">Nothing to save yet: change a word first.</p>
      ) : null}
      {languagesCard}
      <FailureNotice failure={failure} shownFields={parts} onReload={onReload} />
      {hasRow ? null : (
        <div id={`${idPrefix}-none`} className="rounded-lg bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-sm" role="status">
          <p className="font-semibold">{`No ${language} translation yet.`}</p>
          <p className="mt-1">{`The fields below show the English to start from, and ${language} readers get the English until there is one.`}</p>
          {canWrite && onTranslateOne ? (
            <button type="button" id={`${idPrefix}-translate-one`} className={`${AdminUI.btn.outlineSm} mt-2`} disabled={retranslating} onClick={onTranslateOne}>
              {retranslating ? 'Translating…' : `Translate ${language}`}
            </button>
          ) : null}
        </div>
      )}
      {saved ? (
        <p className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300" role="status">{saved.text}</p>
      ) : null}
      {saved ? <UnusableSavedNotice items={saved.unusable} languages={languages} /> : null}
      {unusable ? (
        <UnusableLanguageNotice language={language} reason={unusable} canWrite={canWrite} busy={retranslating} onRetranslate={onRetranslate} />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={`${AdminUI.card} p-4 space-y-3 min-w-0`}>
          <p className={AdminUI.muted}>{`Editing the ${language} words of this saved version. Placeholders, links and tags stay as they are in the English.`}</p>
          <LanguageFields draft={draft} parts={parts} failure={failure} readOnly={readOnly} onChange={onChange} idPrefix={idPrefix} />
          <div>
            <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" role="tablist" aria-label={`${language} body`}>
              {BODY_TABS.map((t) => (
                <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} id={`${idPrefix}-tab-${t.key}`}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px ${tab === t.key
                    ? 'border-violet-600 text-zinc-900 dark:text-zinc-100'
                    : 'border-transparent text-zinc-500 dark:text-zinc-400'}`}
                  onClick={() => onTab(t.key)}>
                  {t.label}
                  {(t.key === 'text' ? textErrors : htmlErrors).length ? <span className="ms-1 text-red-600 dark:text-red-400" aria-label="has problems">•</span> : null}
                </button>
              ))}
            </div>
            <div className="mt-2" role="tabpanel" aria-labelledby={`${idPrefix}-tab-${tab}`}>
              {tab === 'visual' ? (
                <div>
                  <VisualTab key={language} source={draft.html || ''} opened={opened.html || ''} onChange={(html) => onChange('html', html)}
                    placeholders={placeholders} readOnly={readOnly} />
                  <FieldErrors id={`${idPrefix}-visual-error`} messages={htmlErrors} />
                </div>
              ) : tab === 'html' ? (
                <div>
                  <label htmlFor={htmlId} className={AdminUI.label}>HTML</label>
                  <textarea id={htmlId} ref={htmlArea} className={`${AdminUI.textarea} font-mono text-xs mt-1`} rows={18}
                    spellCheck={false} value={draft.html || ''} readOnly={readOnly}
                    onChange={(ev) => onChange('html', ev.target.value)}
                    {...(htmlErrors.length ? { 'aria-invalid': true as const, 'aria-describedby': `${htmlId}-error` } : {})} />
                  <FieldErrors id={`${htmlId}-error`} messages={htmlErrors} />
                  {readOnly ? null : <UploadImageButton onTag={putAtCursor} />}
                </div>
              ) : (
                <div>
                  <label htmlFor={textId} className={AdminUI.label}>Text version</label>
                  <textarea id={textId} className={`${AdminUI.textarea} font-mono text-xs mt-1`} rows={18}
                    spellCheck={false} value={draft.text || ''} readOnly={readOnly}
                    onChange={(ev) => onChange('text', ev.target.value)}
                    {...(textErrors.length ? { 'aria-invalid': true as const, 'aria-describedby': `${textId}-error` } : {})} />
                  <FieldErrors id={`${textId}-error`} messages={textErrors} />
                </div>
              )}
            </div>
          </div>
          <EnglishPanel english={english} parts={parts} idPrefix={idPrefix} />
        </div>
        <div className="space-y-4 min-w-0">
          <div className={`${AdminUI.card} p-4`}>
            <h3 className="text-sm font-semibold mb-2">{`Preview in ${language}`}</h3>
            {preview}
          </div>
          {side}
        </div>
      </div>
    </div>
  );
}

/**
 * Everything an editor needs for its languages: the Translate job, the
 * language being edited, the card above the editor, and the moves between
 * languages, each asking before unsaved words are lost.
 */
export function useEditorLanguages({ base, versionId, englishOnly, englishDirty, canWrite, english, parts, languages, initial, idPrefix }: {
  base: string;
  versionId: number | null;
  englishOnly: boolean;
  englishDirty: boolean;
  canWrite: boolean;
  english: LanguageDraft;
  parts: TranslatedField[];
  languages: Language[];
  initial?: { locale: string; draft: LanguageDraft; opened: LanguageDraft } | null;
  idPrefix: string;
}) {
  const job = useTranslateJob(base, versionId);
  const lang = useLanguageEditor({ base, versionId, english, parts, languages, initial, onSaved: job.refresh });
  const name = languageName(languages, lang.locale);

  // When a job finishes, read the translations again; the effect below then
  // shows the new words of the language on screen, unless the admin has
  // changed them meanwhile.
  const lastState = useRef<string | null>(null);
  useEffect(() => {
    const state = job.status ? job.status.state : null;
    if (lastState.current === 'running' && state && state !== 'running') {
      lang.reloadRows();
    }
    lastState.current = state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.status && job.status.state]);
  // Rows read again after a job reopen the language on screen.
  const rowsSeen = useRef(lang.rows);
  useEffect(() => {
    if (rowsSeen.current && lang.rows !== rowsSeen.current && !lang.dirty && lang.locale !== 'en') lang.open(lang.locale, { keepNotice: true });
    rowsSeen.current = lang.rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang.rows]);

  // The switch sits in a different form on each side of a move, so it is
  // drawn anew; focus goes back to it, where the keyboard user left it.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    if (typeof document !== 'undefined') document.getElementById(`${idPrefix}-language`)?.focus();
  });

  const switchTo = async (code: string) => {
    const move = languageMove({ from: lang.locale, to: code, languageDirty: lang.dirty });
    if (move === 'stay') return;
    if (move === 'confirm' && !(await confirmDiscard(`Your changes to ${name} are not saved. Switch and lose them?`))) return;
    refocus.current = true;
    lang.open(code);
  };

  const row = lang.rows && lang.locale !== 'en' ? lang.rows[lang.locale] : undefined;
  const unusable = unusableReason(row, job.status?.unusable, lang.locale);

  const retranslate = async () => {
    if (lang.locale === 'en') return;
    // Retranslating replaces this language's words, an admin's included.
    if (row && row.origin === 'admin') {
      const consoleApi = typeof window !== 'undefined' ? (window as any).AdminConsole : null;
      const sure = consoleApi && typeof consoleApi._confirm === 'function' ? await consoleApi._confirm({
        title: `Replace the ${name} an admin wrote?`,
        message: `${name} is translated again from the English, replacing the words an admin corrected by hand.`,
        confirmLabel: 'Retranslate', destructive: true,
      }) : false;
      if (!sure) return;
    }
    if (lang.dirty && !(await confirmDiscard(`Retranslating replaces your unsaved changes to ${name}.`, 'Retranslate'))) return;
    lang.revert();
    await job.start(retranslateBody(lang.locale));
  };
  // A language with no translation yet: translate just that one. Nothing an
  // admin wrote is there to replace.
  const translateOne = async () => {
    if (lang.locale === 'en') return;
    await job.start({ languages: [lang.locale] });
  };

  const blockedSwitch = englishDirty ? 'Save the English first, then edit another language.' : versionId == null ? 'Save first, then translate' : null;
  const card = (
    <LanguagesCard>
      {englishOnly ? null : (
        <LanguageSwitch locale={lang.locale} languages={languages} rows={lang.rows} unusable={job.status?.unusable}
          blocked={blockedSwitch} onChange={switchTo} idPrefix={idPrefix} />
      )}
      {lang.rowsFailure ? <FailureNotice failure={lang.rowsFailure} /> : null}
      <TranslateControls versionId={versionId} englishOnly={englishOnly} dirty={englishDirty || lang.dirty}
        canWrite={canWrite} languages={languages} job={job} />
    </LanguagesCard>
  );

  return {
    job, lang, card, switchTo, retranslate, translateOne, unusable, name, hasRow: !!row,
    retranslating: !!job.status && job.status.state === 'running',
  };
}

/**
 * What a save, restore or delete did, on the list: its sentence, the
 * translations it left unusable, and, after a save, the offer to translate
 * the version just saved.
 */
export function SavedBanner({ text, unusable, translate, languages, labelFor, onFinished }: {
  text: string;
  unusable?: UnusableItem[];
  translate?: { base: string; versionId: number } | null;
  languages: Language[];
  labelFor?: (item: UnusableItem) => string | null;
  // When a Translate started here finishes: the list counts again.
  onFinished?: () => void;
}) {
  return (
    <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300" role="status">
      <p>{text}</p>
      {unusable && unusable.length ? (
        <p className="mt-1 text-amber-800 dark:text-amber-300" id="email-unusable-notice">
          {`These translations no longer fit and send the English until they are fixed: ${unusableNames(unusable, languages, labelFor)}.`}
        </p>
      ) : null}
      {translate && otherLanguages(languages).length
        ? <TranslateOffer base={translate.base} versionId={translate.versionId} languages={languages} onFinished={onFinished} /> : null}
    </div>
  );
}
