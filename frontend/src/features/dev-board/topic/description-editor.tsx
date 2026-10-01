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
    if (!response.ok) throw new Error(data.message || data.error || 'Could not load the description.');
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
      if (!controller.signal.aborted) setError(err.message || 'Could not load the description.');
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
        throw new Error(data.message || data.error || 'Could not save the description.');
      }
      if (controller.signal.aborted) return;
      setCurrent(data); setDraft(data.description); onSaved(data);
      if (String(data.prBodyStatus || '').startsWith('github_')) {
        setNotice('Saved in Homeroom. Pull-request synchronization is incomplete. Save again to retry.');
      } else {
        setOpen(false);
        (window as any).PlatformUI?.toast?.('Description saved.');
      }
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).name === 'TypeError'
        ? 'Could not connect. Your draft is kept; try saving again.' : (err as Error).message);
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
          <h2 id={`${fieldId}-heading`} className="dev-topic-h">Edit description</h2>
          <button type="button" className="dev-details-close" aria-label="Close description editor" disabled={saving.current} onClick={() => setOpen(false)}>
            <XIcon className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <p id={`${fieldId}-help`} className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">Explain the problem and what this change does. Markdown is supported.</p>
        {!current && busy ? <p role="status">Loading description…</p> : null}
        {current ? <>
          <label className="block text-sm font-medium mb-2" htmlFor={fieldId}>Description</label>
          <Textarea ref={input} id={fieldId} rows={11} className={preview ? 'hidden' : 'w-full'}
            aria-describedby={`${fieldId}-help ${fieldId}-count`} value={draft} disabled={saving.current}
            onChange={(event) => setDraft(event.target.value)} />
          {preview ? <div className="max-h-[45vh] overflow-auto" aria-label="Description preview"><Preview text={draft} /></div> : null}
          <div className="flex items-center justify-between gap-3 my-3">
            <Button type="button" variant="neutral" ink="neutral" onClick={() => setPreview(!preview)} aria-pressed={preview}>{preview ? 'Edit text' : 'Preview'}</Button>
            <span id={`${fieldId}-count`} className="text-sm text-zinc-500 dark:text-zinc-400">{draft.length.toLocaleString()} / {current.maxLength.toLocaleString()}</span>
          </div>
          {draft.length > current.maxLength ? <p role="alert">Shorten the description before saving; none of your text has been removed.</p> : null}
        </> : null}
        {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400 my-3">{error}</p> : null}
        {!current && !busy ? <Button type="button" variant="neutral" ink="neutral" onClick={() => { setOpen(false); }}>Close</Button> : null}
        {conflict && !latest ? <Button type="button" variant="neutral" ink="neutral" disabled={busy} onClick={reviewLatest}>Review latest description</Button> : null}
        {latest ? <div className="my-3 rounded-xl border border-zinc-500/30 p-3">
          <h3 className="text-sm font-medium mb-2">Latest saved description</h3>
          <div className="max-h-40 overflow-auto"><Preview text={latest.description} /></div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button type="button" variant="neutral" ink="neutral" onClick={() => { setDraft(latest.description); setCurrent(latest); setLatest(null); setConflict(false); setError(''); }}>Use latest text</Button>
            <Button type="button" variant="neutral" ink="neutral" onClick={() => { setCurrent(latest); setLatest(null); setConflict(false); setError(''); }}>Keep my draft</Button>
          </div>
        </div> : null}
        {notice ? <p role="status" className="text-sm my-3">{notice}</p> : null}
        {current ? <div className="flex flex-wrap justify-end gap-2 mt-4">
          <Button type="button" variant="neutral" ink="neutral" disabled={saving.current} onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" disabled={busy || conflict || !draft.trim() || draft.length > current.maxLength}>{saving.current ? 'Saving…' : notice ? 'Retry GitHub sync' : 'Save description'}</Button>
        </div> : null}
      </form>
    </dialog>, document.body,
  );
}
