/**
 * Send-feedback dialog (#feedback-modal).
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

export function FeedbackDialog() {
  return (
    <div id="feedback-modal" className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60">
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-sm shadow-xl">
          <h2 className="text-lg font-bold mb-4">
            Send Feedback
          </h2>
          {/*
              Target toggle: file this feedback against the app being viewed
              or against the Social Vibecoding platform. The "This app" button
              is always visible but rendered disabled/grayed-out when no app
              with a repo is open (see app.js).
          */}
          <div id="feedback-target" className="flex gap-2 mb-3" role="radiogroup" aria-label="Feedback target">
            <div className="flex-1 flex flex-col items-center">
              <button
                type="button"
                role="radio"
                aria-checked="false"
                data-feedback-target="app"
                id="feedback-target-app"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs font-medium transition-colors"
              >
                This app
              </button>
              {/* Caret indicating the selected option; shown/hidden in app.js. */}
              <div
                id="feedback-caret-app"
                className="hidden mt-1 w-0 h-0 border-l-4 border-r-4 border-b-4 border-l-transparent border-r-transparent border-b-violet-600"
              >
              </div>
            </div>
            <div className="flex-1 flex flex-col items-center">
              <button
                type="button"
                role="radio"
                aria-checked="true"
                data-feedback-target="platform"
                id="feedback-target-platform"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs font-medium transition-colors"
              >
                Social Vibecoding Platform
              </button>
              <div
                id="feedback-caret-platform"
                className="hidden mt-1 w-0 h-0 border-l-4 border-r-4 border-b-4 border-l-transparent border-r-transparent border-b-violet-600"
              >
              </div>
            </div>
          </div>
          {/*
              #556: editable title, auto-filled live from the description
              (app.js debounces POST /api/feedback/title as the user types).
              Left blank at submit, the server names the issue as before.
          */}
          <input
            id="feedback-title"
            type="text"
            maxLength={200}
            placeholder="Title — generated as you type; edit as you like"
            className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 mb-2"
          />
          <textarea
            id="feedback-text"
            rows={4}
            maxLength={2000}
            placeholder="Describe the issue or suggestion..."
            className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
          >
          </textarea>
          {/*
              #683: drag-to-select screenshot attachment. The button only
              renders where the Screen Capture API exists (app.js gates it
              via ScreenshotSelect.isSupported()); while a screenshot is
              attached the button is swapped for the thumbnail row.
          */}
          <div className="mt-2">
            <button
              id="feedback-screenshot-btn"
              type="button"
              className="hidden inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z"
                />
              </svg>
              Attach screenshot
            </button>
            <div id="feedback-screenshot-preview" className="hidden items-center gap-2">
              <img
                id="feedback-screenshot-img"
                alt="Screenshot preview"
                className="h-14 max-w-[8rem] rounded-md border border-zinc-300 dark:border-zinc-700 object-cover"
              />
              <span id="feedback-screenshot-state" className="text-xs text-zinc-500 dark:text-zinc-400">
              </span>
              <button
                id="feedback-screenshot-remove"
                type="button"
                aria-label="Remove screenshot"
                className="rounded-full w-6 h-6 flex items-center justify-center text-xs bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
          {/*
              #685: opt-in app state snapshot. Hidden unless the open app has
              registered a state provider via usernode.issueState.register()
              AND the feedback target is "This app" (wired in app.js).
          */}
          <div id="feedback-state-row" className="hidden mt-2">
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                id="feedback-state-checkbox"
                type="checkbox"
                defaultChecked={true}
                className="accent-violet-500 w-4 h-4 mt-0.5"
              />
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  Include app state
                </span>
                &mdash; this app can attach a snapshot of its current state to help debugging
              </span>
            </label>
          </div>
          {/*
              #964: opt-in kudos bounty on the issue this dialog is about to
              file. Starts UNCHECKED on every open (app.js openFeedbackModal) —
              filing feedback must never quietly spend someone's weekly
              allowance. The note under it carries the viewer's live remaining
              figure, and the checkbox is disabled at zero; the server is the
              real gate either way, and a bounty that can't be placed never
              costs the user their filed issue. Same utility classes as
              #feedback-state-row above, so no new Tailwind names appear.
          */}
          <div id="feedback-bounty-row" className="hidden mt-2">
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input id="feedback-bounty-checkbox" type="checkbox" className="accent-violet-500 w-4 h-4 mt-0.5" />
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  Put a kudos bounty on this
                </span>
                &mdash; pledges 1 of your weekly kudos to whoever's merged proposal closes this issue
                <br />
                <span id="feedback-bounty-note" className="text-zinc-500 dark:text-zinc-500">
                </span>
              </span>
            </label>
          </div>
          <div id="feedback-status" className="text-sm mt-2 hidden">
          </div>
          <div className="flex gap-3 mt-4">
            <button
              id="feedback-cancel"
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              id="feedback-submit"
              className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
