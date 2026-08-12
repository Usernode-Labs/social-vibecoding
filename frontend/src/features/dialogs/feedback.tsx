/**
 * Send-feedback dialog (#feedback-modal).
 *
 * Extracted verbatim from Shell.tsx by #1078 chunk A. The render output is
 * byte-identical to what the shell shipped before — same ids, same class
 * strings, same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html
 * in this commit are the proof.
 *
 * ── What this island owns, and what it does not ───────────────────────
 *
 * OWNS: the open/close lifecycle. `useDialog` holds the `open` state,
 * `useStaticModal` performs the kit lift that `PlatformUI.adoptStaticModal`
 * used to do from outside React, and Cancel and the backdrop click are
 * rendered handlers rather than listeners `App.bindEvents` attached.
 *
 * DOES NOT OWN: anything inside the card. The target pills, the title and
 * description fields, the screenshot row, the two opt-in rows and the status
 * line are written by `./feedback-controller` — the retired ~810-line block
 * from `App.bindEvents`, whose header explains why it is still imperative.
 * React renders this tree once and never reconciles inside it, which is what
 * keeps the two owners from colliding.
 *
 * That controller is also why the fields below stay UNCONTROLLED: a rendered
 * `value` would both fight the controller and put a `value` attribute into
 * the prerendered public/index.html that the hand-written shell never had.
 */

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { Feedback, init as initFeedback } from './feedback-controller';
import { useDialog } from './use-dialog';

/** Reserved for callers that still pass `{ fromDev: true }` — see #226/#312. */
interface OpenOptions {
  fromDev?: boolean;
}

export function FeedbackDialog() {
  const dialog = useDialog<OpenOptions>('feedback', {
    onOpen: (opts) => Feedback._open(opts || {}),
    onClose: () => Feedback._reset(),
  });

  // Was the middle of `App.bindEvents`. Layout effect, so the header's
  // speech-bubble button and the ?shot=feedback deep link are both live
  // before the first paint that could act on them.
  useIsomorphicLayoutEffect(() => {
    initFeedback();
  }, []);

  return (
    <div
      id="feedback-modal"
      ref={dialog.rootRef}
      className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60"
      {...dialog.backdropProps}
    >
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-sm shadow-xl">
          <h2 className="text-lg font-bold mb-4">
            Send Feedback
          </h2>
          {/*
              Target toggle: file this feedback against the app being viewed
              or against the Social Vibecoding platform. The "This app" button
              is always visible but rendered disabled/grayed-out when no app
              with a repo is open (see ./feedback-controller).
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
              {/* Caret indicating the selected option; shown/hidden by the controller. */}
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
              (the controller debounces POST /api/feedback/title as you type).
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
              renders where the Screen Capture API exists (the controller gates
              it via ScreenshotSelect.isSupported()); while a screenshot is
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
              AND the feedback target is "This app" (wired in the controller).
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
              file. Starts UNCHECKED on every open (the controller's _open) —
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
            {/*
                The controller's success and save-for-later paths still close
                the dialog by clicking this button after their 1500 ms grace
                window (`setTimeout(() => …('feedback-cancel').click(), 1500)`).
                That keeps working through a rendered handler: a programmatic
                click dispatches a real event, and React 19 delegates its
                listeners at document.body.
            */}
            <button
              id="feedback-cancel"
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              onClick={() => dialog.close()}
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
