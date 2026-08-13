/**
 * App-secrets dialog (#app-secrets-modal).
 *
 * App secrets modal (per-app env vars declared in dapp.json).
 * Opened from the "App secrets" row in the dev-chat tab's Edit
 * section (see AppView.renderDevChatTab). Admins can set/clear
 * values directly; non-admins propose changes via the existing
 * issues vote machinery.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * made it stateful. The render output is still byte-identical to what the
 * shell shipped — same ids, same class strings, same `hidden` semantics, same
 * data-* attributes — and tests/baselines/shell-markup.json plus the
 * image-prerendered public/index.html are the proof.
 *
 * ── What this island owns, and what it does not ───────────────────────
 *
 * OWNS: the open/close lifecycle. `useDialog` holds the `open` state,
 * `useStaticModal` performs the kit lift that `PlatformUI.adoptStaticModal`
 * used to do from outside React, and the close button and backdrop click are
 * rendered handlers rather than listeners `Secrets.init()` attached.
 *
 * DOES NOT OWN: the rows. `#app-secrets-list`, `#app-secrets-declare`,
 * `#app-secrets-footer`, `#app-secrets-title`/`-subtitle` and
 * `#app-secrets-status` are innerHTML hosts that `./app-secrets-controller`
 * writes — the same arrangement `#admin-section-content` has. React renders
 * them empty and never reconciles inside them, which is what keeps the two
 * owners from colliding.
 *
 * The controller is the retired public/js/app-secrets.js, moved into the
 * bundle by this chunk (see its header). This island is what replaced its
 * `DOMContentLoaded` bootstrap.
 */

import { DialogCard, DialogRoot } from '@/components/ui/dialog';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { Secrets, init as initSecrets } from './app-secrets-controller';
import { useDialog } from './use-dialog';

interface OpenPayload {
  slug: string;
  opts?: { declare?: boolean };
}

export function AppSecretsDialog() {
  const dialog = useDialog<OpenPayload>('appSecrets', {
    onOpen: (payload) => {
      if (payload?.slug) void Secrets._load(payload.slug, payload.opts || {});
    },
    onClose: () => Secrets._reset(),
  });

  // Was `document.addEventListener('DOMContentLoaded', () => Secrets.init())`
  // at the bottom of public/js/app-secrets.js. Layout effect, so the redeploy
  // button is live before the first paint that could show it.
  useIsomorphicLayoutEffect(() => {
    initSecrets();
  }, []);

  return (
    <DialogRoot
      layout="centered"
      id="app-secrets-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="lg" relative scroll>
        <button
          id="app-secrets-close"
          className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-200 transition-colors"
          aria-label="Close"
          onClick={() => Secrets.close()}
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
      </DialogCard>
    </DialogRoot>
  );
}
