import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { ChecksVerdictView, NoteBoxView } from '../topic/topic-head';
import type { ChecksVerdict, NoteBox } from '../topic/model';

export interface SessionChecksProps {
  sessionId: number;
  onClose: () => void;
}

/** Same presentation as the proposal page; results are only loaded while open. */
export function SessionCheckResults({ session }: { session: any }): ReactNode {
  const av = (window as any).AppView;
  const verdict: ChecksVerdict | null = av._checksVerdictView(session);
  const notes: NoteBox[] = verdict ? [] : av._checksStatusNotes(session);
  return <>
    {verdict ? <ChecksVerdictView v={{ ...verdict, action: null }} /> : null}
    {notes.map((box) => <NoteBoxView key={box.key} box={{ ...box, action: null }} />)}
    {!verdict && !notes.length ? <p>No check results have been recorded yet.</p> : null}
    {session.check_state === 'error' && session.check_error_detail
      ? <p className="mt-2 whitespace-pre-wrap break-words">{session.check_error_detail}</p> : null}
  </>;
}

export function SessionChecks({ sessionId, onClose }: SessionChecksProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState<any>(null);
  const [error, setError] = useState('');
  const [rerunning, setRerunning] = useState(false);
  const [revision, setRevision] = useState(0);
  const av = (window as any).AppView;

  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/checks`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load check results');
        if (!controller.signal.aborted) {
          setSession(data.session);
          setError('');
        }
      } catch (err) {
        if (!controller.signal.aborted) setError((err as Error).message);
      } finally {
        // Serialized polling: slow responses cannot overlap or overwrite a
        // newer rerun response. Closing aborts both the fetch and the timer.
        if (!controller.signal.aborted) timer = setTimeout(load, 10000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, revision]);

  const recheck = session && av._recheckAction(session);
  async function rerun() {
    setRerunning(true);
    try {
      if (await av.castRecheck(sessionId)) setRevision((n) => n + 1);
    } finally {
      setRerunning(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label="Proposal checks"
      className="m-auto w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border-0 bg-transparent p-0 text-sm text-zinc-900 dark:text-zinc-100 backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <DialogCard size="md" className="max-w-none">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Proposal checks</h2>
          <Button variant="neutral" ink="neutral" onClick={onClose}>Close</Button>
        </div>
        {session ? <p className="mt-1 text-zinc-500 dark:text-zinc-400">{session.pr_title || session.session_title}</p> : null}
        {error ? <p role="alert" className="mt-3 text-red-700 dark:text-red-400">{error}</p> : null}
        {!session && !error ? <p role="status" className="mt-3">Loading checks…</p> : null}
        {session ? <SessionCheckResults session={session} /> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="neutral" ink="neutral" onClick={() => setRevision((n) => n + 1)}>Refresh results</Button>
          {recheck ? <Button disabled={rerunning || recheck.disabled} onClick={rerun}>
            {rerunning ? 'Re-running…' : recheck.label}
          </Button> : null}
        </div>
      </DialogCard>
    </dialog>
  );
}
