/**
 * #6019 (threads, stage 6): merging and splitting threads, under the
 * thread's list (./thread-items.tsx).
 *
 *   Proposed: merge into #12. Happens in 23 hours unless someone objects.
 *   [Agree] [Object]
 *   ⋯ Merge into another thread → #__ | Split one out → (choose) | Break it up → parts
 *
 * 31 Oct 2026: the three moves are rows of the page's ⋯ (./thread-menu.ts),
 * not pills under every thread; the row opens its form here (`open`). Where
 * a page has no ⋯ to put them in, they stay pills (`pills`).
 *
 * Break it up (#6019 follow-up) turns the thread's request into smaller
 * requests in the same thread, each with a title and what it is done when;
 * the request closes with the last of them. It is decided as a merge is.
 *
 * Any member proposes; a requester agrees; anybody objects, which puts it
 * to the project's vote (routes/threads.js, services/thread-moves.js). A
 * project the viewer has not joined answers join_required, which the
 * client's fetch wrapper turns into a Join prompt.
 */

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { moveLines, splittable, type Phrase, type ThreadPayload } from './thread-model';

export type MoveKind = 'merge' | 'split' | 'breakup';

/**
 * The moves this thread can be proposed for, in the ⋯'s order: none on a
 * decision, a closed thread or one with a move already waiting; Split one
 * out where it holds more than its lead; Break it up where an open request
 * leads it. Pure.
 */
export function moveChoices(data: ThreadPayload | null): MoveKind[] {
  if (!data || !data.thread.number || data.thread.kind === 'decision' || data.thread.state !== 'open') return [];
  if ((data.moves || []).length) return [];
  const number = data.thread.number;
  const candidates = splittable(data);
  const out: MoveKind[] = ['merge'];
  if (candidates.length > 0 && candidates.length < data.items.length) out.push('split');
  if (data.thread.lead === 'request' && data.items.some((i) => i.type === 'request' && i.number === number && i.status === 'open')) out.push('breakup');
  return out;
}

/** A move's row and pill, in the words the pills had. */
export const MOVE_LABELS: Record<MoveKind, string> = {
  merge: 'project:topic.thread.move.mergeInto',
  split: 'project:topic.thread.move.splitOut',
  breakup: 'project:topic.thread.move.breakUp',
};

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { ok: res.ok, data: await res.json().catch(() => null) };
  } catch {
    return { ok: false, data: null };
  }
}

export function ThreadMoves({ slug, data, onChanged, open: chosen, onOpen, pills = true }: {
  slug: string;
  data: ThreadPayload;
  /** Read the thread again: a move changed it. */
  onChanged: () => void;
  /** The form open, when the page's ⋯ chose it (./thread-items.tsx); this keeps its own otherwise. */
  open?: MoveKind | null;
  onOpen?: (next: MoveKind | null) => void;
  /** Draw the moves as pills: a page with no ⋯ to list them in. */
  pills?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const say = (p: Phrase) => t(p.id, p.values);
  const [own, setOwn] = useState<MoveKind | null>(null);
  const open = chosen !== undefined ? chosen : own;
  const setOpen = (next: MoveKind | null) => { if (onOpen) onOpen(next); else setOwn(next); };
  const [into, setInto] = useState('');
  const [item, setItem] = useState('');
  const [parts, setParts] = useState<Array<{ title: string; doneWhen: string }>>([{ title: '', doneWhen: '' }, { title: '', doneWhen: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opened from the ⋯, which can be far from where the form is drawn: the
  // form comes into view with its first field ready.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (pills || !open) return;
    const el = form.current;
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    el?.querySelector<HTMLElement>('input, select')?.focus({ preventScroll: true });
  }, [open, pills]);
  const number = data.thread.number;
  if (!number || data.thread.kind === 'decision' || data.thread.state !== 'open') return null;
  const moves = data.moves || [];
  const candidates = splittable(data);
  const app = encodeURIComponent(slug);
  const choices = moveChoices(data);
  const filledParts = parts.filter((p) => p.title.trim());
  // Opened from the ⋯, a form says how to put it away again.
  const cancel = pills ? null : (
    <Button type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={() => { setOpen(null); setError(null); }}>
      {t('core:common.cancel')}
    </Button>
  );

  const act = async (path: string, body: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await post(path, body);
    setBusy(false);
    if (out.ok) { setOpen(null); onChanged(); return; }
    setError(out.data && typeof out.data.error === 'string' && out.data.error !== 'join_required'
      ? out.data.error : t('project:topic.thread.move.failed'));
  };
  const propose = (event: FormEvent) => {
    event.preventDefault();
    if (open === 'merge') void act(`/api/apps/${app}/threads/${number}/moves`, { kind: 'merge', into: Number(into) });
    else if (open === 'breakup') {
      void act(`/api/apps/${app}/threads/${number}/moves`, {
        kind: 'breakup', request: number, parts: filledParts.map((p) => ({ title: p.title.trim(), doneWhen: p.doneWhen.trim() })),
      });
    } else if (open === 'split' && item) {
      const [type, ref] = item.split(':');
      void act(`/api/apps/${app}/threads/${number}/moves`, {
        kind: 'split', items: [type === 'request' ? { type, number: Number(ref) } : { type, id: Number(ref) }],
      });
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2" data-thread-moves={moves.length}>
      {moves.map((move) => {
        const lines = moveLines(move);
        return (
          <div key={move.id} className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-zinc-600 dark:text-zinc-300" data-thread-move={move.state}>
            <span className="min-w-0 flex-1">{`${say(lines.what)}. ${say(lines.when)}`}</span>
            {move.state === 'pending' ? (
              <>
                <Button type="button" variant="pillNeutral" size="sm" ink="neutral" disabled={busy}
                  onClick={() => { void act(`/api/apps/${app}/thread-moves/${move.id}/agree`, {}); }}>
                  {t('project:topic.thread.move.agree')}
                </Button>
                <Button type="button" variant="pillNeutral" size="sm" ink="neutral" disabled={busy}
                  onClick={() => { void act(`/api/apps/${app}/thread-moves/${move.id}/object`, {}); }}>
                  {t('project:topic.thread.move.object')}
                </Button>
              </>
            ) : null}
          </div>
        );
      })}
      {pills && choices.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {choices.map((kind) => (
            <Button key={kind} type="button" variant="pillNeutral" size="sm" ink="neutral" aria-pressed={open === kind} data-thread-move-open={kind}
              onClick={() => { setOpen(open === kind ? null : kind); setError(null); }}>
              {t(MOVE_LABELS[kind])}
            </Button>
          ))}
        </div>
      ) : null}
      {open === 'breakup' ? (
        <form ref={form} className="flex flex-col gap-2" onSubmit={propose} data-thread-move-form="breakup">
          <p className="text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{t('project:topic.thread.move.breakUpAbout', { number: number ?? '' })}</p>
          {parts.map((part, i) => (
            <div key={i} className="flex flex-col gap-1" data-thread-move-part={i}>
              <Input aria-label={t('project:topic.thread.move.partTitle', { count: i + 1 })} placeholder={t('project:topic.thread.move.partTitle', { count: i + 1 })}
                value={part.title} maxLength={120}
                onChange={(e) => { const v = e.currentTarget.value; setParts(parts.map((p, j) => (j === i ? { ...p, title: v } : p))); }} />
              <Input aria-label={t('project:topic.thread.move.partDone')} placeholder={t('project:topic.thread.move.partDone')}
                value={part.doneWhen} maxLength={600}
                onChange={(e) => { const v = e.currentTarget.value; setParts(parts.map((p, j) => (j === i ? { ...p, doneWhen: v } : p))); }} />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            {parts.length < 6 ? (
              <Button type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={() => setParts([...parts, { title: '', doneWhen: '' }])}>
                {t('project:topic.thread.move.addPart')}
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={busy || filledParts.length < 2}>{t('project:topic.thread.move.propose')}</Button>
            {cancel}
          </div>
        </form>
      ) : null}
      {open === 'merge' || open === 'split' ? (
        <form ref={form} className="flex flex-wrap items-center gap-2" onSubmit={propose} data-thread-move-form={open}>
          {open === 'merge' ? (
            <Input aria-label={t('project:topic.thread.move.number')} placeholder={t('project:topic.thread.move.number')} inputMode="numeric"
              value={into} onChange={(e) => setInto(e.currentTarget.value.replace(/[^0-9]/g, ''))} required />
          ) : (
            <Select aria-label={t('project:topic.thread.move.choose')} value={item} onChange={(e) => setItem(e.currentTarget.value)} required>
              <option value="">{t('project:topic.thread.move.choose')}</option>
              {candidates.map((c) => (
                <option key={`${c.type}:${c.id}`} value={c.type === 'request' ? `request:${c.number}` : `${c.type}:${c.id}`}>
                  {`${c.number ? `#${c.number} ` : ''}${c.title || ''}`}
                </option>
              ))}
            </Select>
          )}
          <Button type="submit" size="sm" disabled={busy || (open === 'merge' ? !into : !item)}>{t('project:topic.thread.move.propose')}</Button>
          {cancel}
        </form>
      ) : null}
      {error ? <p role="alert" className="text-[0.8125rem] text-zinc-600 dark:text-zinc-300">{error}</p> : null}
    </div>
  );
}
