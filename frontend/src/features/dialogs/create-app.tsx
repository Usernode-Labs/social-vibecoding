/**
 * Create-app dialog (#create-modal).
 *
 * Create app modal.
 * data-mode controls "new" vs "import"; data-import-state controls
 * the import sub-states (idle / checking / ok / error). CSS in
 * app.css keys off both attributes to show/hide inputs and the
 * submit button. JS only needs to flip attributes, never juggle
 * classes per element.
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

export function CreateAppDialog() {
  return (
    <div
      id="create-modal"
      className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60"
      data-mode="new"
      data-import-state="idle"
    >
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        {/*
            The mode/import-state attributes are mirrored onto this card
            (see App.setCreateMode / App._setImportState) because the
            native-kit modal adoption lifts the card out of #create-modal
            while presented — CSS keyed off the card keeps matching.
        */}
        <div
          id="create-card"
          className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-sm shadow-xl"
          data-mode="new"
          data-import-state="idle"
        >
          <h2 id="create-title" className="text-lg font-bold mb-4">
            Create a new app
          </h2>
          <div className="flex p-1 mb-4 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
            <button
              type="button"
              data-mode-pill="new"
              className="create-mode-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
            >
              Create new
            </button>
            <button
              type="button"
              data-mode-pill="import"
              className="create-mode-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
            >
              Import existing
            </button>
          </div>
          <form id="create-form" className="space-y-4">
            {/*
                Import-only: GitHub repo URL + Check button. The Check
                button runs the bot-access pre-flight; on success the
                #app-name field below appears, prefilled with the repo
                name. CSS hides this whole block in "new" mode.
            */}
            <div id="create-import-block" className="create-import-block">
              <label
                htmlFor="import-url"
                className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
              >
                GitHub repo URL
              </label>
              <div className="flex gap-2">
                <input
                  id="import-url"
                  name="repoUrl"
                  type="url"
                  autoComplete="off"
                  spellCheck="false"
                  className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent font-mono text-sm"
                  placeholder="https://github.com/owner/repo"
                />
                <button
                  type="button"
                  id="import-check"
                  className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap"
                >
                  Check
                </button>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Invite
                <code className="font-mono text-xs">
                  usernode-bot
                </code>
                as a collaborator with Write access.
              </p>
              {/*
                  Inline status row: spinner while checking, green check on
                  ok, red error text on failure. Hidden in idle.
              */}
              <div id="import-status" className="text-sm mt-2">
              </div>
            </div>
            {/*
                Name field. Always visible in "new" mode; gated behind a
                successful access check in "import" mode (CSS hides it
                until #create-card[data-import-state="ok"]).
            */}
            <div id="create-name-block">
              <label htmlFor="app-name" className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                App name
              </label>
              <input
                id="app-name"
                name="name"
                type="text"
                autoComplete="off"
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                placeholder="my cool app"
              />
            </div>
            {/*
                Visibility: two segmented controls. Collab=Everyone forces
                View=Everyone (a publicly-buildable app can't be privately
                viewed) — App.setCreateVisibility enforces it.
            */}
            <div id="create-visibility-block" className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Who can build it
                </label>
                <div className="flex p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
                  <button
                    type="button"
                    data-collab-vis="public"
                    className="create-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  >
                    Everyone
                  </button>
                  <button
                    type="button"
                    data-collab-vis="private"
                    className="create-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  >
                    Invite-only
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Who can see &amp; use it
                </label>
                <div className="flex p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
                  <button
                    type="button"
                    data-view-vis="public"
                    className="create-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  >
                    Everyone
                  </button>
                  <button
                    type="button"
                    data-view-vis="private"
                    className="create-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  >
                    Collaborators only
                  </button>
                </div>
                <p id="create-vis-hint" className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 hidden">
                  Apps everyone can build are always public to view.
                </p>
              </div>
            </div>
            <div id="create-error" className="text-red-400 text-sm hidden">
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                id="create-cancel"
                className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                id="create-submit"
                className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
