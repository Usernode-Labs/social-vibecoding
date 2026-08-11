/**
 * Fork-app dialog (#fork-modal).
 *
 * Fork modal (AppView.promptFork). Stands up an independent copy of
 * the current app owned by the forker.
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

export function ForkAppDialog() {
  return (
    <div id="fork-modal" className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60">
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-sm shadow-xl">
          <h2 className="text-lg font-bold mb-1">
            Fork this app
          </h2>
          <p className="text-xs text-zinc-500 mb-4">
            Forking
            <span id="fork-source-name" className="font-mono text-zinc-300">
            </span>
            stands up your own independent copy — its own repo, database, and web address.
          </p>
          <form id="fork-form" className="space-y-4">
            <div>
              <label
                htmlFor="fork-input"
                className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
              >
                Name for your fork
              </label>
              <input
                id="fork-input"
                type="text"
                required={true}
                minLength={3}
                maxLength={64}
                autoComplete="off"
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
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
            <div id="fork-error" className="text-red-400 text-sm hidden">
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                id="fork-cancel"
                className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                id="fork-submit"
                className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                Fork
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
