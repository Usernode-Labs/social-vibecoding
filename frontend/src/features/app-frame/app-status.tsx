/**
 * `#app-content`'s placeholder states — what the App tab shows when there is
 * no running app to frame.
 *
 * Five of them: spinning up, awaiting secrets, failed to start, not
 * available, and offline-with-no-app-worker. `renderAppTab` built each as an
 * `innerHTML` string and then bound two buttons by id afterwards, because
 * the branch re-renders on every status change and a delegated listener
 * would have re-attached.
 *
 * ── Why this can own `#app-content` ────────────────────────────────────
 *
 * That host is SHARED: the four Dev sub-views mount their own frames into
 * it, and `showLaunchCoverShot` still writes it by hand. It is single-owner
 * anyway, at the boundary rather than at a node inside it — every path into
 * `#app-content` runs `_teardownDevRoots()` first, exactly the way
 * `AdminConsole._renderSection` tears the previous section down before
 * mounting the next. The ownership audit's entry is scoped with `when` for
 * the same reason.
 *
 * ── What is NOT here ───────────────────────────────────────────────────
 *
 * The launch cover (`showLaunchCoverShot`) stays a string builder: it is the
 * one launch surface with no app behind it, `_launchCoverHtml` has four
 * other callers, and `insertAdjacentHTML`-ing a cover BESIDE a live iframe
 * is the whole point of that path — the frame must survive.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { appStatusStore } from './app-status-store.js';

/** The resolved placeholder. `null` means some other owner has the host. */
export interface AppStatusView {
  /** `creating` and `awaiting` share the amber dot; `error` gets the red one. */
  dot: 'creating' | 'error' | null;
  message: string;
  /** The missing secret names, or the failure reason — one mono red line. */
  detail: string | null;
  /** At most one, and only for a viewer who can act on it. */
  action: { key: 'secrets' | 'buildLog'; label: string; slug: string } | null;
}

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

export function AppStatusView_({ view }: { view: AppStatusView }): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 gap-2 p-4 text-center">
      {view.dot ? <div className={`status-dot ${view.dot}`}></div> : null}
      <p className="text-sm">{view.message}</p>
      {view.detail ? (
        <p className="text-xs font-mono text-red-500 max-w-md break-words">{view.detail}</p>
      ) : null}
      {view.action ? (
        <Button
          id={view.action.key === 'secrets' ? 'awaiting-open-secrets' : 'app-error-build-log'}
          className="mt-3"
          onClick={() => call(
            view.action!.key === 'secrets' ? 'openAwaitingSecrets' : 'openAppBuildLog',
            view.action!.slug,
          )}
        >
          {view.action.label}
        </Button>
      ) : null}
    </div>
  );
}

export function AppStatus(): ReactNode {
  const { view } = useStoreState<{ view: AppStatusView | null }>(appStatusStore);
  return view ? <AppStatusView_ view={view} /> : null;
}
