/**
 * `#llm-grants-list` — the App AI permissions rows, as the only React writer
 * below that host.
 *
 * The host is STATIC in the React tree (sections/app-ai.tsx), so this is a
 * plain child component rather than a portal: there is nothing to mount, and
 * nothing outside React writes here any more. settings.js keeps every fetch,
 * every PATCH/DELETE and the confirm dialog; this file keeps the markup.
 *
 * The handlers are called BY NAME on `window.Settings` rather than passed in,
 * for the same reason the transcript calls `window.GroupChat`: settings.js is
 * loaded as a classic script before this bundle and cannot be imported. Each
 * one already does its own optimistic-revert and status reporting, so the
 * component hands it the value and forgets.
 *
 * Markup is like-for-like with the string it replaces — same classes, same
 * `data-role` attributes — except for the two the reskin changed on purpose,
 * noted at their call sites.
 */

import { useStoreState } from '../../lib/use-store-state';
import { grantsStore } from './grants-store.js';

type GrantView = {
  appId: number;
  appName: string;
  revoked: boolean;
  spent: string;
  cap: string;
  capValue: string;
  showByok: boolean;
  allowByok: boolean;
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

/*
 * A floating white card, where the string this replaces was
 * `bg-zinc-100 … border border-zinc-300`. Both halves of that changed for one
 * reason: this section renders straight onto the settings PAGE GROUND, and in
 * this palette zinc-100 IS that ground (#eaeaea) — the fill was doing nothing
 * and the border was the only thing drawing the row. The language separates by
 * figure/ground, so the row is the surface and needs no border, which is also
 * what every other card on this screen does.
 */
const ROW_CLASS = 'rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 text-xs';

function RevokedRow({ grant }: { grant: GrantView }) {
  return (
    <div className={ROW_CLASS}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-500 dark:text-zinc-500 truncate">{grant.appName}</span>
        <span className="shrink-0 rounded px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400">
          Revoked
        </span>
      </div>
    </div>
  );
}

function GrantRow({ grant }: { grant: GrantView }) {
  return (
    <div className={ROW_CLASS}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-700 dark:text-zinc-300 truncate">{grant.appName}</span>
        <span className="font-mono text-zinc-600 dark:text-zinc-400 shrink-0">
          {`$${grant.spent} / $${grant.cap} today`}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
        <label className="flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
          Cap $
          <input
            data-role="cap"
            type="number"
            min="0.01"
            step="0.01"
            defaultValue={grant.capValue}
            className="w-20 rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 font-mono text-zinc-900 dark:text-zinc-100"
            onChange={(e) => controller()?._onGrantCapChange?.(grant.appId, e.currentTarget.value)}
          />
        </label>
        {grant.showByok ? (
          <label className="flex items-center gap-1 cursor-pointer select-none text-zinc-600 dark:text-zinc-400">
            <input
              data-role="byok"
              type="checkbox"
              className="accent-violet-500 w-3.5 h-3.5"
              checked={grant.allowByok}
              onChange={(e) => controller()?._onGrantByokChange?.(grant.appId, e.currentTarget.checked)}
            />
            Use my own key past the daily budget
          </label>
        ) : null}
        {/*
            Filled, not a red outline — the language draws no outlined control
            (see the `neutral` variant in @/components/ui/button.tsx and the
            profile screen's six buttons). Revoke keeps its red because it IS
            destructive; only the box changed.
        */}
        <button
          type="button"
          data-role="revoke"
          className="rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 py-0.5 font-medium text-red-700 dark:text-red-400 transition-colors"
          onClick={() => { void controller()?._onGrantRevoke?.(grant.appId, grant.appName); }}
        >
          Revoke
        </button>
      </div>
    </div>
  );
}

export function GrantsList() {
  const state = useStoreState(grantsStore);
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') return <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading…</p>;
  if (state.phase === 'error') return <p className="text-xs text-red-500">Failed to load app permissions.</p>;
  if (!state.grants.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-500">No apps have asked to use AI yet.</p>;
  }
  return (
    <>
      {state.grants.map((g) => (
        g.revoked ? <RevokedRow key={g.appId} grant={g} /> : <GrantRow key={g.appId} grant={g} />
      ))}
    </>
  );
}
