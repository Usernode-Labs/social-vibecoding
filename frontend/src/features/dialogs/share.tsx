/**
 * Share dialog (#share-modal).
 *
 * Share modal — shows the app's bare subdomain URL so users can pass it
 * around outside the platform. The URL itself never carries auth: child
 * apps that need a JWT will gate visitors at their own login page;
 * public apps (e.g. echo) render directly.
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

export function ShareDialog() {
  return (
    <div id="share-modal" className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60">
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md shadow-xl relative">
          <button
            id="share-close"
            className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-200 transition-colors"
            aria-label="Close share"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <h2 className="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100">
            Share this app
          </h2>
          <p className="text-xs text-zinc-500 mb-4">
            Anyone with this link can open the app outside the Usernode platform. Whether they need to log in is up to the app — most public apps work for anonymous viewers.
          </p>
          <div className="flex gap-2">
            <input
              id="share-url-input"
              type="text"
              readOnly={true}
              className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
              aria-label="Share URL"
            />
            <button
              id="share-copy-btn"
              className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap"
            >
              Copy
            </button>
          </div>
          <div className="mt-4 flex justify-end">
            <a
              id="share-open-link"
              href="#"
              target="_blank"
              rel="noopener"
              className="text-sm text-violet-500 hover:text-violet-400 transition-colors inline-flex items-center gap-1"
            >
              Open in new tab
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
