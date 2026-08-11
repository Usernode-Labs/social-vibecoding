/**
 * App-secrets dialog (#app-secrets-modal).
 *
 * App secrets modal (per-app env vars declared in dapp.json).
 * Opened from the "App secrets" row in the dev-chat tab's Edit
 * section (see AppView.renderDevChatTab). Admins can set/clear
 * values directly; non-admins propose changes via the existing
 * issues vote machinery.
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

export function AppSecretsDialog() {
  return (
    <div id="app-secrets-modal" className="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-lg mx-4 shadow-xl relative max-h-[80vh] flex flex-col">
        <button
          id="app-secrets-close"
          className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-200 transition-colors"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {/*
            Title + subtitle are set by Secrets.render(): the same modal is
            "App secrets" for a child app and "Platform variables" for the
            platform's own row, where a change lands on the next deploy.
        */}
        <h2 id="app-secrets-title" className="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100">
          App secrets
        </h2>
        <p id="app-secrets-subtitle" className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
          Environment variables this app declares in
          <code className="text-xs">
            dapp.json
          </code>
          .
        </p>
        {/*
            One scroll container for the rows AND the "New variable" form:
            as two flex siblings the open form squeezes the row list to
            zero height, so the panel would appear to lose its contents
            the moment you start adding a variable.
        */}
        <div className="flex-1 overflow-y-auto -mx-2 px-2">
          <div id="app-secrets-list">
          </div>
          {/*
              "+ New variable": declares a key that dapp.json doesn't have
              yet. The button and the (collapsed) form are both rendered by
              Secrets.render() into this slot, because every field in the
              form is scope-dependent (staging default is app-only, group
              is platform-only) and the helper copy differs too.
          */}
          <div id="app-secrets-declare" className="mt-3 hidden">
          </div>
        </div>
        <div id="app-secrets-status" className="text-sm mt-3 hidden">
        </div>
        <div
          id="app-secrets-footer"
          className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 hidden"
        >
          Changes apply on the next deploy. Admins can
          <button id="app-secrets-redeploy" className="text-violet-500 hover:text-violet-400 underline">
            redeploy now
          </button>
          .
        </div>
      </div>
    </div>
  );
}
