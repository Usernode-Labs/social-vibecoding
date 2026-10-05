import { getLanguage } from "../../../lib/i18n/runtime";
import { useMessages as useUiLanguage } from "../../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { XIcon } from '@/components/ui/icons';
import { Html } from '../../../lib/html';
import { pushDismissible } from '../../../lib/back-stack';

type Description = {
  description: string; version: number; stale: boolean; maxLength: number;
  prBody?: string | null; prBodyStatus?: string;
};

function Preview({ text }: { text: string }) {
  const render = (window as any).DevChat?.renderMarkdown;
  return typeof render === 'function'
    ? <Html className="dev-issue-body" html={render(text)} />
    : <p className="whitespace-pre-wrap">{text}</p>;
}

/** Local React state owns the draft, so live check/metadata refreshes cannot
 * replace what the author is typing. Only the matching change opens it. */
export function DescriptionEditor({ id, onSaved }: { id: number; onSaved: (data: Description) => void }) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Description | null>(null);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Description | null>(null);
  const [notice, setNotice] = useState('');
  const fieldId = `change-description-${id}`;

  useEffect(() => {
    const show = (event: Event) => { if (Number((event as CustomEvent).detail) === id) setOpen(true); };
    window.addEventListener('change-description-edit', show);
    return () => window.removeEventListener('change-description-edit', show);
  }, [id]);

  async function read(signal: AbortSignal): Promise<Description> {
    const response = await fetch(`/api/sessions/${id}/description`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || tr("workshop:could_not_load_the_description_6a6dd1d7"));
    return data;
  }

  useEffect(() => {
    if (!open) return;
    const focused = document.activeElement as HTMLElement | null;
    const controller = new AbortController();
    request.current = controller;
    setCurrent(null); setDraft(''); setPreview(false); setError('');
    setLatest(null); setConflict(false); setNotice(''); setBusy(true);
    dialog.current?.showModal();
    const release = pushDismissible(() => {
      if (saving.current) return false;
      setOpen(false);
    });
    read(controller.signal).then((data) => {
      if (!controller.signal.aborted) { setCurrent(data); setDraft(data.description); }
    }).catch((err) => {
      if (!controller.signal.aborted) setError(err.message || tr("workshop:could_not_load_the_description_6a6dd1d7"));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => {
      controller.abort(); request.current?.abort();
      release();
      if (focused?.isConnected) focused.focus();
    };
  }, [open, id]);

  useEffect(() => { if (open && current) input.current?.focus(); }, [open, !!current]);

  async function reviewLatest() {
    const controller = new AbortController(); request.current = controller;
    setBusy(true);
    try {
      const data = await read(controller.signal);
      if (!controller.signal.aborted) setLatest(data);
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!current || busy || conflict || !draft.trim() || draft.length > current.maxLength) return;
    const controller = new AbortController(); request.current = controller;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/sessions/${id}/description`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ description: draft, expectedVersion: current.version }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        throw new Error(data.message || data.error || tr("workshop:could_not_save_the_description_59667168"));
      }
      if (controller.signal.aborted) return;
      setCurrent(data); setDraft(data.description); onSaved(data);
      if (String(data.prBodyStatus || '').startsWith('github_')) {
        setNotice(tr("workshop:saved_in_homeroom_pull_request_synchronization_i_c45f5398"));
      } else {
        setOpen(false);
        (window as any).PlatformUI?.toast?.(tr("workshop:description_saved_e2e50cfe"));
      }
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).name === 'TypeError'
        ? tr("workshop:could_not_connect_your_draft_is_kept_try_saving__703d75dc") : (err as Error).message);
    } finally {
      saving.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <dialog ref={dialog} className="dev-details-card dev-description-dialog" aria-labelledby={`${fieldId}-heading`}
      onCancel={(event) => { event.preventDefault(); if (!saving.current) setOpen(false); }}>
      <form onSubmit={save}>
        <div className="dev-details-head">
          <h2 id={`${fieldId}-heading`} className="dev-topic-h"><Message id="workshop:edit_description_3495f1b0" /></h2>
          <Localized element={<button type="button" className="dev-details-close" aria-label={catalogText("workshop:close_description_editor_80830b73")} disabled={saving.current} onClick={() => setOpen(false)}>
            <XIcon className="w-4 h-4" aria-hidden="true" />
          </button>} messages={{"aria-label":"workshop:close_description_editor_80830b73"}} />
        </div>
        <p id={`${fieldId}-help`} className="text-sm text-zinc-500 dark:text-zinc-400 mb-3"><Message id="workshop:explain_the_problem_and_what_this_change_does_ma_060f080a" /></p>
        {!current && busy ? <p role="status"><Message id="workshop:loading_description_f1189766" /></p> : null}
        {current ? <>
          <label className="block text-sm font-medium mb-2" htmlFor={fieldId}><Message id="workshop:description_526e0087" /></label>
          <Textarea ref={input} id={fieldId} rows={11} className={preview ? 'hidden' : 'w-full'}
            aria-describedby={tr("workshop:value1_help_value2_count_caca401f", { value1: fieldId, value2: fieldId })} value={draft} disabled={saving.current}
            onChange={(event) => setDraft(event.target.value)} />
          {preview ? <Localized element={<div className="max-h-[45vh] overflow-auto" aria-label={catalogText("workshop:description_preview_bff36549")}><Preview text={draft} /></div>} messages={{"aria-label":"workshop:description_preview_bff36549"}} /> : null}
          <div className="flex items-center justify-between gap-3 my-3">
            <Button type="button" variant="neutral" ink="neutral" onClick={() => setPreview(!preview)} aria-pressed={preview}><LocalizedValue render={() => (preview ? tr("workshop:edit_text_7967d944") : tr("workshop:preview_324b134f"))} /></Button>
            <span id={`${fieldId}-count`} className="text-sm text-zinc-500 dark:text-zinc-400">{draft.length.toLocaleString(getLanguage())} / {current.maxLength.toLocaleString(getLanguage())}</span>
          </div>
          {draft.length > current.maxLength ? <p role="alert"><Message id="workshop:shorten_the_description_before_saving_none_of_yo_d4c9ed4f" /></p> : null}
        </> : null}
        {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400 my-3">{error}</p> : null}
        {!current && !busy ? <Button type="button" variant="neutral" ink="neutral" onClick={() => { setOpen(false); }}><Message id="workshop:close_7d9eb7ac" /></Button> : null}
        {conflict && !latest ? <Button type="button" variant="neutral" ink="neutral" disabled={busy} onClick={reviewLatest}><Message id="workshop:review_latest_description_b42916f8" /></Button> : null}
        {latest ? <div className="my-3 rounded-xl border border-zinc-500/30 p-3">
          <h3 className="text-sm font-medium mb-2"><Message id="workshop:latest_saved_description_2e7f7f16" /></h3>
          <div className="max-h-40 overflow-auto"><Preview text={latest.description} /></div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button type="button" variant="neutral" ink="neutral" onClick={() => { setDraft(latest.description); setCurrent(latest); setLatest(null); setConflict(false); setError(''); }}><Message id="workshop:use_latest_text_9a0f0550" /></Button>
            <Button type="button" variant="neutral" ink="neutral" onClick={() => { setCurrent(latest); setLatest(null); setConflict(false); setError(''); }}><Message id="workshop:keep_my_draft_cdb80bb9" /></Button>
          </div>
        </div> : null}
        {notice ? <p role="status" className="text-sm my-3">{notice}</p> : null}
        {current ? <div className="flex flex-wrap justify-end gap-2 mt-4">
          <Button type="button" variant="neutral" ink="neutral" disabled={saving.current} onClick={() => setOpen(false)}><Message id="workshop:cancel_19766ed6" /></Button>
          <Button type="submit" disabled={busy || conflict || !draft.trim() || draft.length > current.maxLength}><LocalizedValue render={() => (saving.current ? tr("workshop:saving_23e39291") : notice ? tr("workshop:retry_github_sync_80bee5b7") : tr("workshop:save_description_0a42115c"))} /></Button>
        </div> : null}
      </form>
    </dialog>, document.body,
  );
}
