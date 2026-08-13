/**
 * Fork-app dialog (#fork-modal).
 *
 * Stands up an independent copy of an app — its own repo, database and web
 * address.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * moved the behaviour in and made it stateful. The render output is still
 * byte-identical to what the shell shipped — same ids, same class strings,
 * same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html in
 * this commit are the proof.
 *
 * ── What moved, and from where ────────────────────────────────────────
 *
 * `AppView._forkSource`, `.promptFork`, `.closeForkModal` and `.submitFork`
 * were public/js/app-view.js:12838-12918; the cancel, backdrop and submit
 * listeners were public/js/app.js's `bindEvents`. `AppView.promptFork(source)`
 * survives as a one-line forward because it has TWO callers with different
 * arguments: the app-view header's "+" menu passes nothing (fork the open
 * app) and the home-screen card dropdown passes an arbitrary `{slug, name}`
 * with no app open. That argument is now the island's open payload, which is
 * why `_forkSource` no longer needs to exist as shared state.
 */

import { useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

export interface ForkSource {
  slug: string;
  name?: string;
}

export function ForkAppDialog() {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<ForkSource | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dialog = useDialog<ForkSource>('fork', {
    onOpen: (payload) => {
      const src = payload || null;
      sourceRef.current = src;
      setSourceName(src?.name || '');
      setError('');
      if (inputRef.current) inputRef.current.value = `${src?.name || 'App'} (fork)`;
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    },
    onClose: () => {
      setError('');
      if (inputRef.current) inputRef.current.value = '';
    },
  });

  useHiddenClass(errorRef, !error);

  // Verbatim from AppView.submitFork.
  async function submit(event: FormEvent) {
    event.preventDefault();
    const source = sourceRef.current;
    if (!source?.slug) return;
    const name = (inputRef.current?.value || '').trim();
    if (name.length < 3) return setError('Name must be at least 3 characters.');

    setBusy(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(source.slug)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Fork failed.');
        return;
      }
      dialog.close();
      // Land the user on the home feed where the new fork tile shows its
      // "Spinning up…" state (identical to creating a new app).
      (window.App?.navigateHome as (() => void) | undefined)?.();
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot
      id="fork-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        <h2 className="text-lg font-bold mb-1">
          Fork this app
        </h2>
        <p className="text-xs text-zinc-500 mb-4">
          Forking
          <span id="fork-source-name" className="font-mono text-zinc-300">
            {sourceName}
          </span>
          stands up your own independent copy — its own repo, database, and web address.
        </p>
        <form id="fork-form" className="space-y-4" onSubmit={submit}>
          <div>
            <label
              htmlFor="fork-input"
              className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
            >
              Name for your fork
            </label>
            <Input
              id="fork-input"
              ref={inputRef}
              type="text"
              required={true}
              minLength={3}
              maxLength={64}
              autoComplete="off"
              box="dialog"
              hint="muted"
              ring="seamless"
              placeholder="My fork"
            />
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 p-3">
            <p>
              <span className="text-emerald-500">
                ✅ Carries over:
              </span>
              the app's code, its icon, and its current
              <strong>
                public
              </strong>
              data (e.g. leaderboards, public posts).
            </p>
            <p>
              <span className="text-violet-400">
                🔁 Resets to you:
              </span>
              you become the sole owner — collaborators, group chat, issues, proposals and votes all start empty.
            </p>
            <p>
              <span className="text-amber-500">
                ❌ Not copied:
              </span>
              <strong>
                private
              </strong>
              secrets (API keys, signing keys) and
              <strong>
                private
              </strong>
              data (DMs, per-user rows). You'll be asked to re-enter required secrets before your fork goes live.
            </p>
          </div>
          <div id="fork-error" ref={errorRef} className="text-red-400 text-sm hidden">
            {error}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              id="fork-cancel"
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              onClick={() => dialog.close()}
            >
              Cancel
            </button>
            <Button
              type="submit"
              id="fork-submit"
              layout="flex"
              isDisabled={busy}
            >
              {busy ? 'Forking…' : 'Fork'}
            </Button>
          </div>
        </form>
      </DialogCard>
    </DialogRoot>
  );
}
