/**
 * Close-issue dialog (#close-issue-modal).
 *
 * "Propose closing issue #N" — opens a group vote; if it passes, the issue is
 * closed here and on GitHub.
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
 * `AppView.promptCloseIssue` / `.closeCloseIssueModal` / `.submitCloseIssue`
 * and the `_closeIssueTarget` field were public/js/app-view.js:9136-9203; the
 * cancel/backdrop/form/⌘↵ listeners were public/js/app.js's `bindEvents`.
 * They are all here now. `AppView.promptCloseIssue(n)` still exists as the
 * public entry point — the issue rows call it — but it is a one-line forward
 * to this island's controller.
 *
 * The fields stay UNCONTROLLED (a ref, not `value`). That is deliberate: a
 * controlled `<textarea>` renders a `value` attribute during the prerender
 * pass, and this document is compared against the hand-written shell's markup
 * attribute for attribute. React owns what the shell left empty — the error
 * line's text, the submit button's `disabled` — and nothing else.
 */

import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

export function CloseIssueDialog() {
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<number | string | null>(null);
  const [issueNumber, setIssueNumber] = useState<number | string>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dialog = useDialog<number | string>('closeIssue', {
    onOpen: (payload) => {
      targetRef.current = payload ?? null;
      setIssueNumber(payload ?? '');
      setError('');
      if (reasonRef.current) reasonRef.current.value = '';
      // Was `setTimeout(() => reason.focus(), 0)`: the card is inside the
      // kit shell by now, and focusing before the shell's own opening
      // animation settles scrolls the page on iOS.
      setTimeout(() => reasonRef.current?.focus(), 0);
    },
    onClose: () => {
      targetRef.current = null;
      setError('');
      if (reasonRef.current) reasonRef.current.value = '';
    },
  });

  useHiddenClass(errorRef, !error);

  // Verbatim from AppView.submitCloseIssue. The two globals it reaches for —
  // AppView (appData, _loadDevFeed, _renderTopicHead) and App (currentSubTab)
  // — are the same ones the method read as file-scope names; app-view.js is a
  // classic script and cannot be imported from.
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const target = targetRef.current;
    const appView = window.AppView;
    const appData = appView?.appData;
    if (!target || !appData) return;
    const reason = (reasonRef.current?.value || '').trim();

    setBusy(true);
    try {
      const resp = await fetch(`/api/apps/${appData.slug}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'close_issue',
          payload: { issueNumber: target, ...(reason ? { reason } : {}) },
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setError(data.error || `Proposal failed (HTTP ${resp.status}).`);
        return;
      }
    } catch (fetchErr) {
      setError(`Proposal failed: ${(fetchErr as Error).message}`);
      return;
    } finally {
      setBusy(false);
    }

    dialog.close();
    await (appView?._loadDevFeed as (() => Promise<void>) | undefined)?.();
    // Refresh the opened-topic card too (the issue row's button flips to
    // "Close proposed") — _loadDevFeed's repaint no-ops without #dev-feed.
    if (window.App?.currentSubTab === 'topic' && document.getElementById('gc-thread-head')) {
      (appView?._renderTopicHead as (() => void) | undefined)?.();
    }
  }

  // ⌘/Ctrl+Enter submits from the textarea — was a keydown listener app.js
  // attached to #close-issue-reason.
  function onReasonKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (!busy) void submit();
  }

  return (
    <div
      id="close-issue-modal"
      ref={dialog.rootRef}
      className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60"
      {...dialog.backdropProps}
    >
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-sm shadow-xl">
          <h2 className="text-lg font-bold mb-1">
            Propose closing issue
            <span id="close-issue-number" className="font-mono">
              {`#${issueNumber}`}
            </span>
            ?
          </h2>
          <p className="text-xs text-zinc-500 mb-4">
            This opens a group vote. If it passes, the issue is closed here and on GitHub.
          </p>
          <form id="close-issue-form" className="space-y-4" onSubmit={submit}>
            <div>
              <label
                htmlFor="close-issue-reason"
                className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
              >
                Why should this issue be closed?
                <span className="font-normal">
                  (optional)
                </span>
              </label>
              <textarea
                id="close-issue-reason"
                ref={reasonRef}
                rows={3}
                maxLength={2000}
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                placeholder="e.g. obsolete, duplicate, already fixed…"
                onKeyDown={onReasonKeyDown}
              >
              </textarea>
              <p className="text-xs text-zinc-500 mt-1">
                Posted publicly on the GitHub issue when the vote passes.
              </p>
            </div>
            <div id="close-issue-error" ref={errorRef} className="text-red-400 text-sm hidden">
              {error}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                id="close-issue-cancel"
                className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                onClick={() => dialog.close()}
              >
                Cancel
              </button>
              <button
                type="submit"
                id="close-issue-submit"
                className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
                disabled={busy}
              >
                Propose close
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
