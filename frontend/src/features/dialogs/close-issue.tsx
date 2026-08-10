/**
 * Propose-to-close-issue dialog (#close-issue-modal).
 *
 * Propose-to-close-issue modal (AppView.promptCloseIssue). Files a
 * vote-only close_issue governance proposal with an optional reason.
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

export function CloseIssueDialog() {
  return (
    <div
      id="close-issue-modal"
      className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60"
    >
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-sm shadow-xl">
          <h2 className="text-lg font-bold mb-1">
            Propose closing issue
            <span id="close-issue-number" className="font-mono">
              #
            </span>
            ?
          </h2>
          <p className="text-xs text-zinc-500 mb-4">
            This opens a group vote. If it passes, the issue is closed here and on GitHub.
          </p>
          <form id="close-issue-form" className="space-y-4">
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
                rows={3}
                maxLength={2000}
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                placeholder="e.g. obsolete, duplicate, already fixed…"
              >
              </textarea>
              <p className="text-xs text-zinc-500 mt-1">
                Posted publicly on the GitHub issue when the vote passes.
              </p>
            </div>
            <div id="close-issue-error" className="text-red-400 text-sm hidden">
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                id="close-issue-cancel"
                className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                id="close-issue-submit"
                className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
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
