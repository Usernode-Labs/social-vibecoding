/**
 * The app list could not be loaded (#1899).
 *
 * Home's grid and the directory screen used to say so in one red line —
 * "Failed to load apps" — with nothing to do about it but reload the whole
 * page. This is the one error state both draw: what happened in plain words,
 * the likely cause, and a Retry that re-runs the same load. Offline is NOT
 * this state: Home says "You're offline" in its own muted notice, because
 * that one is not a failure and retrying cannot fix it.
 *
 * Rendered only after a failed fetch, never in the first paint, so it never
 * takes part in the shell's prerender.
 */

import { Button } from '@/components/ui/button';
import { WarningTriangleIcon } from '@/components/ui/icons';

export const APPS_LOAD_ERROR_DETAIL =
  'Something went wrong reaching the app directory. Check your connection and try again.';

export function AppsLoadError({ title, onRetry, className = '' }: {
  title: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-apps-load-error=""
      className={`apps-load-error flex flex-col items-center gap-2 px-6 py-8 text-center ${className}`}
    >
      <WarningTriangleIcon className="h-8 w-8 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <p className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">{title}</p>
      <p className="max-w-xs text-sm text-zinc-500 dark:text-zinc-400">{APPS_LOAD_ERROR_DETAIL}</p>
      <Button type="button" variant="pillAccent" size="pill" className="mt-1" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
