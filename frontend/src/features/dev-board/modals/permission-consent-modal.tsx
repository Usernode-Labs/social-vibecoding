/**
 * `#permission-consent-modal` — "Allow <app> to record audio from your
 * microphone?" and its eight siblings (#2219).
 *
 * Reached from the bridge relay, not from the board: an app in the iframe
 * asks for a gated browser capability and this is the shell's answer. Same
 * seam as its neighbours (see ./model.ts) — app-view.js owns the scrim, its
 * `hidden` class and its dismissal; React owns the card.
 *
 * ── Why the platform draws this at all ─────────────────────────────────
 *
 * The browser has its own prompt, and it is not good enough here. Under
 * Permissions Policy delegation a cross-origin child's request is
 * attributed to the TOP-LEVEL origin, so the browser's prompt names the
 * platform rather than the app, and the answer is remembered per origin —
 * one "allow" would be inherited by every app the person ever opens. This
 * dialog is the one that can name the app that is actually asking, and the
 * grant behind it is stored per app.
 *
 * ── Resolved copy in, markup out ───────────────────────────────────────
 *
 * Every decision stays in app-view.js, like the LLM dialog beside it: the
 * title sentence, which note applies (a reopen is coming, or this surface
 * cannot turn it on at all) and what the confirm button says are all
 * settled before the view model is built. The catalogue those strings come
 * from is src/services/app-permissions.js, which reaches here through the
 * bootstrap response rather than being retyped.
 *
 * There is NO validation host in this card, where the LLM dialog has
 * `#llm-consent-error`: this dialog has nothing to validate. The decision
 * is the whole answer.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';

import { useStoreState } from '../../../lib/use-store-state';
import { permissionConsentModalStore } from './modals-store';
import type { PermissionConsentModalView } from './model';

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

export function PermissionConsentCard({ view }: { view: PermissionConsentModalView }): ReactNode {
  return (
    <DialogCard size="md" relative>
      <p className="inline-flex items-center rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-medium text-violet-700 mb-3 dark:text-violet-300">
        {view.label}
      </p>
      <h2 className="text-lg font-bold mb-2 text-zinc-900 dark:text-zinc-100">
        {view.title}
      </h2>
      {view.reason ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3 italic">{`“${view.reason}”`}</p>
      ) : null}
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{view.note}</p>
      <div className="flex justify-end gap-2 mt-5">
        <Button
          type="button"
          id="permission-consent-decline"
          variant="neutral"
          ink="neutral"
          onClick={() => call('_permissionConsentDecline')}
        >
          Not now
        </Button>
        <Button
          type="button"
          id="permission-consent-allow"
          onClick={() => call('_permissionConsentAllow')}
        >
          {view.confirmLabel}
        </Button>
      </div>
    </DialogCard>
  );
}

export function PermissionConsentModal(): ReactNode {
  const { view } = useStoreState<{ view: PermissionConsentModalView | null }>(
    permissionConsentModalStore
  );
  if (!view) return null;
  return (
    <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
      <PermissionConsentCard view={view} />
    </div>
  );
}
