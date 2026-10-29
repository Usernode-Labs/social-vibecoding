/**
 * #6019 (threads, stage 6): merging and splitting threads, under the
 * thread's list (./thread-items.tsx).
 *
 *   Proposed: merge into #12. Happens in 23 hours unless someone objects.
 *   [Agree] [Object]
 *   [Move…]  → Merge into #__ | Split one out: (choose)
 *
 * Any member proposes; a requester agrees; anybody objects, which puts it
 * to the project's vote (routes/threads.js, services/thread-moves.js). A
 * project the viewer has not joined answers join_required, which the
 * client's fetch wrapper turns into a Join prompt.
 */

import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { moveLines, splittable, type Phrase, type ThreadPayload } from './thread-model';

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

export function ThreadMoves({ slug, data, onChanged }: {
  slug: string;
  data: ThreadPayload;
  /** Read the thread again: a move changed it. */
  onChanged: () => void;
}): ReactNode {
  const t = useMessages('project');
  const say = (p: Phrase) => t(p.id, p.values);
  const [open, setOpen] = useState<'merge' | 'split' | null>(null);
  const [into, setInto] = useState('');
  const [item, setItem] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const number = data.thread.number;
  if (!number || data.thread.kind === 'decision' || data.thread.state !== 'open') return null;
  const moves = data.moves || [];
  const candidates = splittable(data);
  const app = encodeURIComponent(slug);

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
    else if (open === 'split' && item) {
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
      {moves.length ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="pillNeutral" size="sm" ink="neutral" aria-pressed={open === 'merge'} data-thread-move-open="merge"
            onClick={() => { setOpen(open === 'merge' ? null : 'merge'); setError(null); }}>
            {t('project:topic.thread.move.mergeInto')}
          </Button>
          {candidates.length > 0 && candidates.length < data.items.length ? (
            <Button type="button" variant="pillNeutral" size="sm" ink="neutral" aria-pressed={open === 'split'} data-thread-move-open="split"
              onClick={() => { setOpen(open === 'split' ? null : 'split'); setError(null); }}>
              {t('project:topic.thread.move.splitOut')}
            </Button>
          ) : null}
        </div>
      )}
      {open ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={propose} data-thread-move-form={open}>
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
        </form>
      ) : null}
      {error ? <p role="alert" className="text-[0.8125rem] text-zinc-600 dark:text-zinc-300">{error}</p> : null}
    </div>
  );
}
