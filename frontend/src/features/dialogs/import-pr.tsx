import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Import-a-PR dialog (#import-pr-modal).
 *
 * Lists open PRs on the app's repo that aren't already imported; importing one
 * creates a shared In-progress item via POST /api/apps/:slug/pr-import and
 * navigates to it. Only reachable from the "+" menu when
 * `pr_import_enabled` (#687).
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
 * import routes the user to its full change page (`openTopic('proposal')`),
 * never the dev-chat session view. An imported PR has no dev session by
 * design (see the sessionBtn / importedNote
 * branches in `_renderProposalCard` / `_proposalDetailsHtml`), and that view
 * renders an empty transcript with a live composer until the minutes-long
 * staging build lands. The proposal page is complete on arrival and refreshes
 * itself on checks_ready / staging_ready.
 *
 * `busy` is also the dialog's `canClose` veto: a dismiss mid-request would
 * strand the user with an import they can't see the outcome of. `useDialog`
 * takes that predicate, so the backdrop, the Cancel button and a kit-initiated
 * Escape all respect it from one place — where the legacy code had to repeat
 * the check in `closeImportPrModal` AND in the backdrop listener.
 */

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';

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
const ERROR_CLASS = 'text-sm text-red-700 dark:text-red-400 py-6 text-center';

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
  if (status === 404) return tr("core:pr_value1_wasn_t_found_on_github_it_may_have_bee_6621d7bc", { value1: prNumber });
  if (status === 409) return tr("core:pr_value1_can_t_be_imported_right_now_612df76a", { value1: prNumber });
  if (status === 503) return tr("core:the_platform_is_restarting_try_the_import_again__1e1a8573");
  return tr("core:something_went_wrong_importing_this_pr_please_tr_f38d20b9");
}

export function ImportPrDialog() {
  useUiLanguage();
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
      setList({ kind: 'error', get text() { return tr("core:couldn_t_load_pull_requests_please_try_again_35b7ffb5"); } });
      return;
    }
    if (!ok) {
      // 404 = GitHub not configured for this app. Treat as the GitHub-off
      // state rather than an error the user can't act on.
      setList({
        kind: 'note',
        get text() { return tr("core:github_isn_t_configured_for_this_app_so_there_s__f96b81f6"); },
      });
      return;
    }
    const rows = Array.isArray(data.candidates) ? data.candidates : [];
    if (rows.length === 0) {
      setList({
        kind: 'note',
        get text() { return tr("core:no_open_pull_requests_are_available_to_import_ri_21bf4beb"); },
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
      tr("core:importing_pr_value1_checking_it_on_github_and_ad_c3b760d9", { value1: prNumber }),
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
    if (pr == null) return setError(tr("core:pick_a_pull_request_to_import_79d2c8ea"));
    setError('');
    setImportBusy(true, pr);

    let sessionId: string | null = null;
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
    } catch {
      setImportBusy(false);
      setError(tr("core:network_error_please_try_again_9ff8cfaf"));
      return;
    }

    // Import confirmed. Land on the imported item's full change page, THEN close the
    // dialog — so it covers the transition instead of flashing the screen the
    // user came from.
    setImportBusy(false);
    try {
      await (appView?.openTopic as ((kind: string, id: string | null) => Promise<void>))(
        'proposal',
        sessionId,
      );
    } catch {
      // The imported item exists regardless; say so rather than swallowing it.
      // #866: set the expectation that the Preview button isn't there yet —
      // the staging build takes minutes, and until it lands the proposal shows
      // "Preview building…" with checks pending.
      window.PlatformUI?.toast?.(
        tr("core:pr_value1_was_imported_its_preview_is_being_buil_c17a4bff", { value1: pr }),
      );
    }
    dialog.close();
  }

  return (
    <DialogRoot
      id="import-pr-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="md">
        <h2 className="text-lg font-bold mb-1"><Message id="core:import_a_pull_request_eaf57bed" /></h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2"><Message id="core:pick_an_open_pull_request_to_add_to_in_progress__98b812e6" /></p>
        {/*
            #866: two expectations worth setting before the import, both of
            which used to surprise people. (1) The staging preview is built
            from the PR's head commit and takes a few minutes, so there's no
            Preview button at first. (2) A pull request can be headed by a
            fork — rows marked "from a fork" run an outside contributor's
            code in the preview, so read the diff on GitHub first.
        */}
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4"><RichMessage id="core:sentence_138f319d4224" components={[<span className="text-amber-800 dark:text-amber-400" />]} /></p>
        <div
          id="import-pr-list"
          className={
            busy
              ? 'max-h-80 overflow-y-auto overscroll-contain -mx-1 px-1 space-y-2 pointer-events-none opacity-50'
              : 'max-h-80 overflow-y-auto overscroll-contain -mx-1 px-1 space-y-2'
          }
        >
          {!dialog.isOpen ? null : list.kind === 'loading' ? (
            <div className={NOTE_CLASS}><Message id="core:loading_open_pull_requests_c93af41e" /></div>
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
                      {`${String(c.author || 'unknown')} · `}
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
                      <Localized element={<span
                        className="block text-xs text-amber-800 dark:text-amber-400 mt-0.5" title={catalogText("core:this_branch_lives_in_a_fork_not_in_this_app_s_ow_ae49ecc7")}
                      >
                        <Message id="core:from_a_fork_d1c26901" />
                        <span className="font-mono">{String(c.headRepo || 'unknown fork')}</span>
                      </span>} messages={{"title":"core:this_branch_lives_in_a_fork_not_in_this_app_s_ow_ae49ecc7"}} />
                    ) : null}
                    {c.htmlUrl ? (
                      <a
                        href={String(c.htmlUrl)}
                        target="_blank"
                        rel="noopener"
                        className="inline-block text-xs text-violet-700 hover:underline mt-1 dark:text-violet-400"
                        onClick={(event) => event.stopPropagation()}
                      ><Message id="core:view_on_github_f5acbc5b" /></a>
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
            imported item's page. The slow line appears after ~8s so a slow GitHub
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
          <div id="import-pr-progress-slow" ref={slowRef} className="hidden mt-1 text-xs opacity-80"><Message id="core:still_working_github_is_being_slow_so_don_t_clos_f372ef03" /></div>
        </div>
        <div id="import-pr-error" ref={errorRef} className="text-red-700 dark:text-red-400 text-sm hidden mt-3">
          {error}
        </div>
        <div className="flex gap-3 mt-5">
          <button
            type="button"
            id="import-pr-cancel"
            className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
            disabled={busy}
            onClick={() => dialog.close()}
          ><Message id="core:cancel_19766ed6" /></button>
          <Button
            type="button"
            id="import-pr-submit"
            layout="flex"
            className="disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy || selected == null}
            onClick={submit}
          >
            <LocalizedValue render={() => (busy ? tr("core:importing_c01c4324") : tr("core:import_2cff9baa"))} />
          </Button>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
