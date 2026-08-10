/**
 * Import-a-PR dialog (#import-pr-modal).
 *
 * Import-a-PR modal (AppView.openImportPrModal). Lists open PRs on the
 * app's repo not already imported; importing one creates a promoted
 * proposal via POST /api/apps/:slug/pr-import and navigates to it. Only
 * reachable via the "+" menu when pr_import_enabled (#687).
 *
 * Extracted verbatim from Shell.tsx by #1078 chunk A. The render output is
 * byte-identical to what the shell shipped before — same ids, same class
 * strings, same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html
 * in this commit are the proof.
 *
 * ── Why this component is STATIC ──────────────────────────────────────
 *
 * #1078 mechanism 1: a region may become stateful only when its ENTIRE
 * subtree is React-owned. This root is not, and cannot be yet, for two
 * independent reasons:
 *
 *   1. PlatformUI.adoptStaticModal (public/js/platform-ui.js) has this id in
 *      STATIC_MODAL_IDS. It observes the root's class list and, when
 *      `hidden` comes off, LIFTS THE CARD OUT OF THE ROOT — replacing it
 *      with a comment placeholder — into the native kit's presentModal
 *      shell, adding `platform-modal-adopted` to the root and
 *      `platform-modal-card` to the card. A React re-render of this subtree
 *      would then reconcile against a parent that no longer holds its child
 *      (removeChild on the wrong node) and would overwrite the class the kit
 *      just wrote.
 *   2. The legacy open/close/submit paths in public/js/** still write into
 *      these nodes directly (innerHTML, value, dataset, .hidden toggles).
 *
 * So the dialog markup is a React component, but its BEHAVIOUR stays where
 * it is. Making it stateful is a later chunk's job and has a hard
 * prerequisite: the adoption seam has to move inside React first, so that one
 * owner writes to these nodes instead of two.
 */

export function ImportPrDialog() {
  return (
    <div id="import-pr-modal" className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60">
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl">
          <h2 className="text-lg font-bold mb-1">
            Import a PR as a proposal
          </h2>
          <p className="text-xs text-zinc-500 mb-2">
            Pick an open pull request to turn into a proposal people can vote on. It goes straight into voting, just like a native proposal.
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
            A staging preview is built from the pull request's head commit, so it takes a few minutes to appear — and automated checks stay pending until it does. Rows marked
            <span className="text-amber-600 dark:text-amber-400">
              from a fork
            </span>
            are branches in someone else's repository: review the changes on GitHub before importing.
          </p>
          <div id="import-pr-list" className="max-h-80 overflow-y-auto overscroll-contain -mx-1 px-1 space-y-2">
          </div>
          {/*
              #846: in-flight progress row. The import POST talks to GitHub, so
              the dialog stays put (list dimmed, buttons disabled) until the
              server confirms — only then does the user get routed to the new
              proposal's page. The slow line appears after ~8s so a slow GitHub
              reads as "still working", not as a hung dialog.
          */}
          <div id="import-pr-progress" className="hidden mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            <div className="flex items-center gap-2">
              <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true">
              </span>
              <span id="import-pr-progress-text">
              </span>
            </div>
            <div id="import-pr-progress-slow" className="hidden mt-1 text-xs opacity-80">
              Still working — GitHub is being slow. Don’t close this window.
            </div>
          </div>
          <div id="import-pr-error" className="text-red-400 text-sm hidden mt-3">
          </div>
          <div className="flex gap-3 mt-5">
            <button
              type="button"
              id="import-pr-cancel"
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              id="import-pr-submit"
              className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={true}
            >
              Import
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
