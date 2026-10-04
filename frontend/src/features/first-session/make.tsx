/**
 * "What do you want to make?": the first thing an account made from the
 * signed-out story is asked (../auth/story.tsx sets the session's
 * `usernode:first-session:make` flag in its sheet; ./index.tsx opens this
 * once the shell has signed them in).
 *
 * Two questions, the New project dialog's own (create-app.tsx), cut down:
 * what it should do, then what to call it — the name is the group's and
 * the project's, since a community and its one project share a name. The
 * three examples (./examples.ts) fill both fields. "Make it" creates a
 * private community through the same POST /api/apps the dialog uses
 * (audience 'invited', no invitees yet: inviting comes next), with
 * `from: 'first-session'`, and Homeroom bot builds the first version from
 * the description. The Create app wizard stays as it is, behind the Create
 * button.
 *
 * "Look around first" is the quiet way out: Home, with nothing asked.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Wordmark } from '@/components/ui/wordmark';

import { EXAMPLES, type Example } from './examples';

/** create-app.tsx's BRIEF_MIN: the server's floor for a description. */
export const BRIEF_MIN = 10;

export type Made = {
  slug: string;
  name: string;
  emoji: string | null;
  description: string | null;
  example: Example | null;
  conversationId: number | null;
};

const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';

export function MakeScreen({ who, onMade, onLookAround }: {
  who: string;
  onMade: (made: Made) => void;
  onLookAround: () => void;
}) {
  const [brief, setBrief] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Example | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { briefRef.current?.focus(); }, []);

  const pick = useCallback((e: Example) => {
    setPicked(e);
    setBrief(e.brief);
    setName(e.name);
    setError(null);
  }, []);

  const valid = brief.trim().length >= BRIEF_MIN && name.trim().length > 0;

  const make = useCallback(async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    // The example's one-line description only while the brief is still the
    // example's own; a brief they rewrote is theirs to describe later.
    const example = picked && brief.trim() === picked.brief ? picked : null;
    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: name.trim(),
          audience: 'invited',
          brief: brief.trim(),
          ...(example ? { description: example.description } : {}),
          from: 'first-session',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.app) {
        setError(data.error || (res.status === 429 ? 'Too many new projects for now. Try again later.' : 'Could not make it. Try again.'));
        return;
      }
      onMade({
        slug: data.app.slug,
        name: data.app.name || name.trim(),
        emoji: example ? example.emoji : null,
        description: example ? example.description : null,
        example,
        conversationId: Number(data.homeroomBot?.conversationId) || null,
      });
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }, [valid, busy, picked, brief, name, onMade]);

  return (
    <div
      role="dialog"
      aria-labelledby="first-session-make-title"
      data-first-session-make=""
      className="fixed inset-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className="flex h-[52px] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
        <Wordmark className="h-6 w-auto text-[color:var(--brand-ink)]" />
      </div>
      <form
        className="mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))]"
        onSubmit={(e) => { e.preventDefault(); void make(); }}
      >
        <div className="text-center">
          <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">
            {who ? `Hi ${who}!` : 'You\'re in!'}
          </p>
          <h1 id="first-session-make-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">What do you want to make?</h1>
          <p className="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">
            Describe it for your group. Homeroom bot builds the first version while you invite your people.
          </p>
        </div>
        <p className="mt-6 pb-2 text-[13px] text-zinc-500 dark:text-zinc-400">Start from an example</p>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Examples">
          {EXAMPLES.map((e) => {
            const on = picked?.key === e.key;
            return (
              <button
                key={e.key}
                type="button"
                aria-pressed={on}
                data-first-session-example={e.key}
                onClick={() => pick(e)}
                className={`relative flex flex-col items-center gap-1.5 rounded-2xl bg-white px-1 pb-2.5 pt-3 text-center dark:bg-zinc-900 ${on ? 'shadow-[inset_0_0_0_2px_var(--accent)]' : 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]'}`}
              >
                <span className="app-icon-tile flex h-11 w-11 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{e.emoji}</span>
                <span className="text-[13px] font-semibold leading-tight">{e.short}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
          <div className={FIELD}>
            <label htmlFor="first-session-brief" className={LABEL}>What should it do?</label>
            <textarea
              ref={briefRef}
              id="first-session-brief"
              rows={3}
              value={brief}
              onChange={(e) => { setBrief(e.target.value); setError(null); }}
              placeholder="A tracker for our weekly miles…"
              className={`${INPUT} resize-none leading-[22px]`}
            />
          </div>
          <div className={FIELD}>
            <label htmlFor="first-session-name" className={LABEL}>What should we call it?</label>
            <input
              id="first-session-name"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder="Sunday Run Club"
              className={INPUT}
            />
            <p className="pb-1 text-xs text-zinc-500 dark:text-zinc-400">It's your group's name too. You can change it later.</p>
          </div>
        </div>
        {error ? <p role="alert" className="mt-3 text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="grow" />
        <Button
          type="submit"
          disabled={!valid || busy}
          layout="full"
          variant="pillAccent"
          size="pillLg"
          ink="solidLate"
          className="mt-6 flex items-center justify-center disabled:opacity-50"
        >
          {busy ? 'Making it…' : 'Make it'}
        </Button>
        <p className="mt-3 text-center text-[15px] text-zinc-500 dark:text-zinc-400">
          {'Not sure yet? '}
          <button type="button" onClick={onLookAround} className="font-medium text-violet-700 hover:underline dark:text-violet-400">Look around first</button>
        </p>
      </form>
    </div>
  );
}
