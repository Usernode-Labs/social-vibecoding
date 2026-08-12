/**
 * Import-a-PR dialog (#import-pr-modal).
 *
 * Lists open PRs on the app's repo that aren't already imported; importing one
 * creates a session via POST /api/apps/:slug/pr-import and navigates to it.
 * Only reachable from the "+" menu when `pr_import_enabled` (#687).
 *
 * #1162: an import lands **In progress**, not In review. The POST no longer
 * sends `promote`, so the server's new default applies, and the response's
 * `status` decides where we route (see the openTopic call in `submit`).
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
 * `AppView._importPrSelected`, `._importPrBusy`, `._importPrSlowTimer`,
 * `.openImportPrModal`, `._loadImportPrCandidates`, `.closeImportPrModal`,
 * `._setImportPrBusy`, `._importPrErrorMessage` and `.submitImportPr` were
 * public/js/app-view.js:12797-13020; the cancel, submit and backdrop listeners
 * were public/js/app.js's `bindEvents`. `AppView.openImportPrModal()` survives
 * as a one-line forward — the Dev "+" menu calls it by name.
 *
 * The candidate rows were an `innerHTML` template with `escapeHtml`/`escapeAttr`
 * calls threaded through it and a `querySelectorAll` pass afterwards to bind
 * each radio. They are JSX now, so the escaping is the renderer's job and the
 * selection is a `useState`.
 *
 * ── #846: the import POST is awaited IN PLACE ─────────────────────────
 *
 * Progress row, dimmed list, frozen buttons — and only a server-confirmed
 * import routes the user, to the imported row's DISCUSSION page, never the
 * dev-chat session view. An imported row has no dev session by design (see
 * the sessionBtn / importedNote branches in `_renderProposalCard` /
 * `_proposalDetailsHtml`), and that view renders an empty transcript with a
 * live composer until the minutes-long staging build lands. The page is
 * complete on arrival and refreshes itself on checks_ready / staging_ready.
 *
 * Which topic that is now depends on the returned `status` (#1162): an
 * In-progress import is a `session` topic — `openTopic('proposal')` would
 * 404, because /api/sessions/:id/proposal only serves promoted rows.
 *
 * `busy` is also the dialog's `canClose` veto: a dismiss mid-request would
 * strand the user with an import they can't see the outcome of. `useDialog`
 * takes that predicate, so the backdrop, the Cancel button and a kit-initiated
 * Escape all respect it from one place — where the legacy code had to repeat
 * the check in `closeImportPrModal` AND in the backdrop listener.
 */

import { useEffect, useRef, useState } from 'react';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

interface Candidate {
  number: number;
  title?: string;
  author?: string;
  headBranch?: string;
  baseBranch?: string;
  htmlUrl?: string;
  fromFork?: boolean;
  headRepo?: string;
}

/** What the list area shows: the fetch's outcome, not just its rows. */
type ListState =
  | { kind: 'loading' }
  | { kind: 'rows'; rows: Candidate[] }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

const NOTE_CLASS = 'text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center';
const ERROR_CLASS = 'text-sm text-red-400 py-6 text-center';

/**
 * Turn an import failure into copy the user can act on.
 *
 * The server's own 404/409 strings are already user-grade (PR not found / not
 * open / already imported / GitHub not configured), so they win; the
 * status-code branches cover the ones that aren't (503 = drainGuard
 * mid-deploy). Exported for tests/dialog-import-pr.test.js.
 */
export function importPrErrorMessage(
  status: number,
  serverError: string | undefined,
  prNumber: number,
): string {
  if (serverError) return serverError;
  if (status === 404) return `PR #${prNumber} wasn’t found on GitHub — it may have been deleted.`;
  if (status === 409) return `PR #${prNumber} can’t be imported right now.`;
  if (status === 503) return 'The platform is restarting — try the import again in a few seconds.';
  return 'Something went wrong importing this PR. Please try again.';
}

export function ImportPrDialog() {
  const errorRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const slowRef = useRef<HTMLDivElement>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [slow, setSlow] = useState(false);

  const busyRef = useRef(false);
  busyRef.current = busy;

  const dialog = useDialog('importPr', {
    // Never dismiss out from under an in-flight import — the user would be
    // left with no idea whether the proposal was created.
    canClose: () => !busyRef.current,
    onOpen: () => {
      setSelected(null);
      setError('');
      setList({ kind: 'loading' });
      void loadCandidates();
    },
    onClose: () => {
      setSelected(null);
      setError('');
    },
  });

  useHiddenClass(errorRef, !error);
  useHiddenClass(progressRef, !busy);
  useHiddenClass(slowRef, !slow);

  useEffect(
    () => () => {
      if (slowTimer.current) clearTimeout(slowTimer.current);
    },
    [],
  );

  /**
   * Fetch + render the candidate rows into the (already open) picker.
   *
   * Split out of the open path — verbatim from `_loadImportPrCandidates` — so
   * a 409 "already imported" can refresh the list in place, dropping the stale
   * row the user just tried.
   */
  async function loadCandidates() {
    const slug = window.AppView?.appData?.slug as string | undefined;
    if (!slug) return;
    setSelected(null);
    let data: { candidates?: Candidate[] } = {};
    let ok = false;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/pr-import/candidates`);
      ok = res.ok;
      data = await res.json().catch(() => ({}));
    } catch {
      setList({ kind: 'error', text: 'Couldn’t load pull requests — please try again.' });
      return;
    }
    if (!ok) {
      // 404 = GitHub not configured for this app. Treat as the GitHub-off
      // state rather than an error the user can't act on.
      setList({
        kind: 'note',
        text: 'GitHub isn’t configured for this app, so there’s nothing to import.',
      });
      return;
    }
    const rows = Array.isArray(data.candidates) ? data.candidates : [];
    if (rows.length === 0) {
      setList({
        kind: 'note',
        text: 'No open pull requests are available to import right now.',
      });
      return;
    }
    setList({ kind: 'rows', rows });
  }

  /**
   * Freeze / unfreeze the picker around the import POST (#846).
   *
   * `on` shows the progress row (naming the PR), dims the list so a second
   * choice can't be made mid-request, disables BOTH buttons (Cancel is
   * disabled rather than hidden so the footer doesn't reflow), and arms the
   * ~8s "still working" line. Every exit path calls it with `false` so the
   * slow timer can't outlive the request.
   */
  function setImportBusy(on: boolean, prNumber?: number) {
    setBusy(on);
    busyRef.current = on;
    if (slowTimer.current) {
      clearTimeout(slowTimer.current);
      slowTimer.current = null;
    }
    setSlow(false);
    if (!on) return;
    setProgressText(
      `Importing PR #${prNumber} — checking it on GitHub and creating the proposal…`,
    );
    slowTimer.current = setTimeout(() => {
      if (busyRef.current) setSlow(true);
    }, 8000);
  }

  // Verbatim from AppView.submitImportPr.
  async function submit() {
    const appView = window.AppView;
    const slug = appView?.appData?.slug as string | undefined;
    if (!slug) return;
    if (busy) return;
    const pr = selected;
    if (pr == null) return setError('Pick a pull request to import.');
    setError('');
    setImportBusy(true, pr);

    let sessionId: string | null = null;
    let status = '';
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/pr-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = importPrErrorMessage(res.status, data.error, pr);
        // Keep the dialog open so the user can pick another PR. An
        // already-imported 409 means the list is stale — reload it so the row
        // they just tried disappears.
        const alreadyImported =
          res.status === 409 && /already been imported/i.test(String(data.error || ''));
        setImportBusy(false);
        if (alreadyImported) await loadCandidates();
        setError(msg);
        return;
      }
      sessionId = data.sessionId;
      status = String(data.status || '');
    } catch {
      setImportBusy(false);
      setError('Network error — please try again.');
      return;
    }

    // Import confirmed. Land on the proposal's discussion page, THEN close the
    // dialog — so it covers the transition instead of flashing the screen the
    // user came from.
    setImportBusy(false);
    // #1162: the default import is In progress, which lives on the `session`
    // topic. Only a caller that asked to promote lands on `proposal` — that
    // page loads from /api/sessions/:id/proposal, which serves promoted rows
    // only and would 404 for an In-progress import.
    const topic = status === 'promoted' ? 'proposal' : 'session';
    try {
      await (appView?.openTopic as ((kind: string, id: string | null) => Promise<void>))(
        topic,
        sessionId,
      );
    } catch {
      // The proposal exists regardless; say so rather than swallowing it.
      // #866: set the expectation that the Preview button isn't there yet —
      // the staging build takes minutes, and until it lands the proposal shows
      // "Preview building…" with checks pending.
      window.PlatformUI?.toast?.(
        `PR #${pr} was imported — its preview is being built now. Find it on the Dev board.`,
      );
    }
    dialog.close();
  }

  return (
    <div
      id="import-pr-modal"
      ref={dialog.rootRef}
      className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60"
      {...dialog.backdropProps}
    >
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl">
          <h2 className="text-lg font-bold mb-1">
            Import a PR as a proposal
          </h2>
          {/*
              #1162: an import lands In progress, like any other piece of work
              in flight — it is NOT up for vote yet. Say so here, because the
              old copy promised the opposite ("it goes straight into voting")
              and that is exactly the expectation this issue reverses.
          */}
          <p className="text-xs text-zinc-500 mb-2">
            Pick an open pull request to bring onto the dev board. It arrives <span className="font-medium">In progress</span> — put it up for vote from its card when it’s ready for people to review.
          </p>
          {/*
              #866: two expectations worth setting before the import, both of
              which used to surprise people. (1) The staging preview is built
              from the PR's head commit and takes a few minutes, so there's no
              Preview button at first. (2) A pull request can be headed by a
              fork — rows marked "from a fork" run an outside contributor's
              code in the preview, so read the diff on GitHub first.
          */}
          <p className="text-xs text-zinc-500 mb-4">
            {"A staging preview is built from the pull request's head commit, so it takes a few minutes to appear — and automated checks stay pending until it does. Rows marked "}
            <span className="text-amber-600 dark:text-amber-400">
              from a fork
            </span>
            {" are branches in someone else's repository: review the changes on GitHub before importing."}
          </p>
          <div
            id="import-pr-list"
            className={
              busy
                ? 'max-h-80 overflow-y-auto overscroll-contain -mx-1 px-1 space-y-2 pointer-events-none opacity-50'
                : 'max-h-80 overflow-y-auto overscroll-contain -mx-1 px-1 space-y-2'
            }
          >
            {!dialog.isOpen ? null : list.kind === 'loading' ? (
              <div className={NOTE_CLASS}>Loading open pull requests…</div>
            ) : list.kind === 'note' ? (
              <div className={NOTE_CLASS}>{list.text}</div>
            ) : list.kind === 'error' ? (
              <div className={ERROR_CLASS}>{list.text}</div>
            ) : (
              list.rows.map((c) => {
                const num = Number(c.number);
                return (
                  <label
                    key={num}
                    className="flex items-start gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 cursor-pointer transition-colors"
                  >
                    <input
                      type="radio"
                      name="import-pr-choice"
                      value={num}
                      className="mt-1 accent-violet-600"
                      checked={selected === num}
                      onChange={() => {
                        setSelected(num);
                        setError('');
                      }}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        #{num} · {String(c.title || '')}
                      </span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                        {`${String(c.author || 'unknown')} — `}
                        <span className="font-mono">
                          {String(c.headBranch || '')} → {String(c.baseBranch || '')}
                        </span>
                      </span>
                      {/*
                          #866: fork provenance. A fork-headed PR's branch lives
                          in someone else's repo — the preview is built from the
                          PR head ref instead, and the code is an outside
                          contributor's. Say so on the row so the choice is
                          informed rather than discovered after importing.
                      */}
                      {c.fromFork ? (
                        <span
                          className="block text-xs text-amber-600 dark:text-amber-400 mt-0.5"
                          title="This branch lives in a fork, not in this app's own repository. The preview is built from the pull request's head commit. Review the changes on GitHub before importing."
                        >
                          {'from a fork — '}
                          <span className="font-mono">{String(c.headRepo || 'unknown fork')}</span>
                        </span>
                      ) : null}
                      {c.htmlUrl ? (
                        <a
                          href={String(c.htmlUrl)}
                          target="_blank"
                          rel="noopener"
                          className="inline-block text-xs text-violet-500 hover:underline mt-1"
                          onClick={(event) => event.stopPropagation()}
                        >
                          View on GitHub ↗
                        </a>
                      ) : null}
                    </span>
                  </label>
                );
              })
            )}
          </div>
          {/*
              #846: in-flight progress row. The import POST talks to GitHub, so
              the dialog stays put (list dimmed, buttons disabled) until the
              server confirms — only then does the user get routed to the new
              proposal's page. The slow line appears after ~8s so a slow GitHub
              reads as "still working", not as a hung dialog.
          */}
          <div
            id="import-pr-progress"
            ref={progressRef}
            className="hidden mt-3 text-sm text-zinc-500 dark:text-zinc-400"
          >
            <div className="flex items-center gap-2">
              <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true">
              </span>
              <span id="import-pr-progress-text">
                {progressText}
              </span>
            </div>
            <div id="import-pr-progress-slow" ref={slowRef} className="hidden mt-1 text-xs opacity-80">
              Still working — GitHub is being slow. Don’t close this window.
            </div>
          </div>
          <div id="import-pr-error" ref={errorRef} className="text-red-400 text-sm hidden mt-3">
            {error}
          </div>
          <div className="flex gap-3 mt-5">
            <button
              type="button"
              id="import-pr-cancel"
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              disabled={busy}
              onClick={() => dialog.close()}
            >
              Cancel
            </button>
            <button
              type="button"
              id="import-pr-submit"
              className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={busy || selected == null}
              onClick={submit}
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
