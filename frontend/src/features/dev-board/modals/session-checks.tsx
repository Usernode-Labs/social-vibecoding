import { useMessages as useUiLanguage } from "../../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { ChecksVerdictView, NoteBoxView } from '../topic/topic-head';
import type { ChecksVerdict, NoteBox } from '../topic/model';

export interface SessionChecksProps {
  sessionId: number;
  onClose: () => void;
}

/** Shared verdict presentation for the dev panel and standalone dialog. */
export function SessionCheckResults({ session }: { session: any }): ReactNode {
  const av = typeof window === 'undefined' ? null : (window as any).AppView;
  const verdict: ChecksVerdict | null = av._checksVerdictView(session);
  const notes: NoteBox[] = verdict ? [] : av._checksStatusNotes(session);
  return <>
    {verdict ? <ChecksVerdictView v={{ ...verdict, action: null }} /> : null}
    {notes.map((box) => <NoteBoxView key={box.key} box={{ ...box, action: null }} />)}
    {!verdict && !notes.length ? <p><Message id="workshop:no_check_results_have_been_recorded_yet_f7afe28f" /></p> : null}
    {session.check_state === 'error' && session.check_error_detail
      ? <p className="mt-2 whitespace-pre-wrap break-words">{session.check_error_detail}</p> : null}
  </>;
}

export function SessionChecksPanel({ sessionId }: { sessionId: number }): ReactNode {
  useUiLanguage();
  const [session, setSession] = useState<any>(null);
  const [error, setError] = useState('');
  const [rerunning, setRerunning] = useState(false);
  const [revision, setRevision] = useState(0);
  const av = typeof window === 'undefined' ? null : (window as any).AppView;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/checks`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || tr("workshop:could_not_load_check_results_20c2947a"));
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
    <div className="space-y-4 text-sm leading-relaxed text-zinc-900 dark:text-zinc-100">
      {session ? <p className="text-zinc-500 dark:text-zinc-400 break-words">{session.pr_title || session.session_title}</p> : null}
      {error ? <p role="alert" className="text-red-700 dark:text-red-400">{error}</p> : null}
      {!session && !error ? <p role="status"><Message id="workshop:loading_checks_634e0304" /></p> : null}
      {session ? <div className="min-w-0 [overflow-wrap:anywhere]"><SessionCheckResults session={session} /></div> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="neutral" ink="neutral" onClick={() => setRevision((n) => n + 1)}><Message id="workshop:refresh_results_04cc9c1a" /></Button>
        {recheck ? <Button disabled={rerunning || recheck.disabled} onClick={rerun}>
          <LocalizedValue render={() => (rerunning ? tr("workshop:re_running_6049843f") : recheck.label)} />
        </Button> : null}
      </div>
    </div>
  );
}

export function SessionChecks({ sessionId, onClose }: SessionChecksProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <Localized element={<dialog
      ref={dialog} aria-label={catalogText("workshop:proposal_checks_9c021e96")}
      className="m-auto w-[calc(100%-2rem)] max-w-4xl max-h-[85dvh] overflow-y-auto rounded-xl border-0 bg-transparent p-0 text-sm text-zinc-900 dark:text-zinc-100 backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <DialogCard size="md" className="max-w-none space-y-5 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold"><Message id="workshop:proposal_checks_9c021e96" /></h2>
          <Button variant="neutral" ink="neutral" onClick={onClose}><Message id="workshop:close_7d9eb7ac" /></Button>
        </div>
        <SessionChecksPanel key={sessionId} sessionId={sessionId} />
      </DialogCard>
    </dialog>} messages={{"aria-label":"workshop:proposal_checks_9c021e96"}} />
  );
}
