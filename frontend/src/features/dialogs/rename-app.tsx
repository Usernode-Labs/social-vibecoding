/**
 * Rename-app dialog (#rename-modal).
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
 * `AppView.promptRename` / `.closeRenameModal` / `.submitRename` were
 * public/js/app-view.js:12775-12806 and 13220-13265; the cancel, backdrop and
 * submit listeners were public/js/app.js's `bindEvents`. `AppView.promptRename`
 * survives as a one-line forward to this island's controller because the
 * drawer's "Rename app" row calls it by name.
 *
 * `AppView.applyRename` deliberately did NOT move: it is the WS handler's
 * post-merge state update (app.js calls it when the rename vote lands), not
 * dialog behaviour, and it runs when this dialog is long closed.
 *
 * The input stays UNCONTROLLED (a ref, not `value`), because a controlled
 * input renders a `value` attribute during the prerender pass and this
 * document is compared against the hand-written shell attribute for
 * attribute. React owns what the shell left empty — the current-name span,
 * the error line, the submit button's label and `disabled` — and no more.
 */

import { useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

export function RenameAppDialog() {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const [currentName, setCurrentName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dialog = useDialog('rename', {
    onOpen: () => {
      const name = (window.AppView?.appData?.name as string) || '';
      setCurrentName(name);
      setError('');
      if (inputRef.current) inputRef.current.value = name;
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

  // Verbatim from AppView.submitRename.
  async function submit(event: FormEvent) {
    event.preventDefault();
    const appView = window.AppView;
    const appData = appView?.appData;
    if (!appData) return;
    const next = (inputRef.current?.value || '').trim();
    const current = (appData.name as string) || '';

    if (!next || next.length < 3) return setError('Name must be at least 3 characters');
    if (next.length > 64) return setError('Name must be 64 characters or fewer');
    if (next === current) return setError('New app name must differ from the current one');

    setBusy(true);
    try {
      // Renames now open a PR that edits dapp.json's `name` field; it lands
      // through the normal merge-vote pipeline (the new name applies when the
      // PR merges and the app redeploys). See POST /api/apps/:slug/rename in
      // src/routes/apps.js.
      const res = await fetch(`/api/apps/${appData.slug}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to open rename PR');
        return;
      }
      dialog.close();
      (appView?.refreshDevData as ((reason: string) => void) | undefined)?.('vote');
    } catch {
      setError('Network error while opening rename PR');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot
      id="rename-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        <h2 className="text-lg font-bold mb-1">
          Rename app
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          Current app name:
          <span id="rename-current" className="font-mono text-zinc-500 dark:text-zinc-400">
            {currentName}
          </span>
        </p>
        <form id="rename-form" className="space-y-4" onSubmit={submit}>
          <div>
            <label
              htmlFor="rename-input"
              className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
            >
              New app name
            </label>
            <Input
              id="rename-input"
              ref={inputRef}
              type="text"
              required={true}
              minLength={3}
              maxLength={64}
              autoComplete="off"
              box="dialog"
              hint="muted"
              ring="seamless"
              placeholder="a better name"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              3–64 characters. This is the app's display name — the URL won't change. Opens a PR that edits
              <span className="font-mono">
                dapp.json
              </span>
              ; the rename applies once the PR is voted in and merged.
            </p>
          </div>
          <div id="rename-error" ref={errorRef} className="text-red-400 text-sm hidden">
            {error}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              id="rename-cancel"
              className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
              onClick={() => dialog.close()}
            >
              Cancel
            </button>
            <Button
              type="submit"
              id="rename-submit"
              layout="flex"
              disabled={busy}
            >
              {busy ? 'Opening PR...' : 'Open PR'}
            </Button>
          </div>
        </form>
      </DialogCard>
    </DialogRoot>
  );
}
