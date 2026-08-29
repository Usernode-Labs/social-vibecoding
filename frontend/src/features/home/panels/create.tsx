/**
 * The Create app block.
 *
 * The only one of the three that is NOT drawn in a `PanelShell`: it has no
 * title bar, no ⋮ and no footer, because the whole block is one button. Its
 * `data-create-enabled` is stamped on the block itself and mirrored onto the
 * section host, so `[data-panel-slot="create"][data-create-enabled="true"]`
 * — the way dapp.json and the screenshot assertions write it — matches one
 * element.
 *
 * ── It is on every home screen, for every account ─────────────────────
 *
 * An account with no app quota gets the same block in the same place —
 * dimmed, and tapping it says why — rather than having it silently absent.
 * Two reasons that is the right shape:
 *
 *   1. `canCreateApps` is DERIVED per request (`isAdmin || live app count <
 *      app_quota`, see /api/auth/me), so it flips without any user action:
 *      creating your one allowed app, an admin editing your quota, an app
 *      erroring out. A conditional block would turn each of those flips into a
 *      layout change under the user.
 *   2. It is the majority rendering — most accounts carry no quota — so
 *      "absent" would read as a missing feature rather than a locked one.
 *
 * The disabled state must NOT be a `disabled` attribute: a disabled element
 * swallows pointer events, which would kill the explanatory toast.
 * `aria-disabled` plus a branch in the handler keeps it tappable.
 *
 * ── What the conversion retired ───────────────────────────────────────
 *
 * `Home.wireCreateButtons()` bound this button, and is GONE. It did a
 * `cloneNode` + `replaceChild` to clear stale listeners — discipline the
 * string renderer needed because every paint rebuilt the node, and a
 * structural DOM write React must not see under a host it owns. React keeps
 * the element and the handler is a prop, so neither half applies any more; the
 * helper had no other caller and no other matching element, so leaving it
 * would have left a loaded gun pointed at this block.
 */

import { PlusIcon } from '@/components/ui/icons';

import type { CreateView } from '../panels-store';

function win(): any {
  return typeof window !== 'undefined' ? (window as any) : {};
}

export function CreatePanel({ view }: { view: CreateView }) {
  const label = view.canCreate ? 'Create a new app' : view.hint;
  return (
    // ONE SHAPE. It used to be two: the widget's grid footprint was 4x1 below
    // 640px and 1x1 at and above it, so the content flipped on the same `sm:`
    // breakpoint the grid did. THE UI OVERHAUL made this a full-width section
    // at every width, so the row shape is the only one left; the stacked
    // variant existed for a 150px cell that is gone, and `h-full` went with it
    // — there is no rectangle to fill, so the block is as tall as its padding.
    <div
      className={`home-create-widget ${view.canCreate ? '' : 'home-create-widget--disabled'}`}
      data-panel={view.key}
      data-create-enabled={String(view.canCreate)}
    >
      <button
        type="button"
        className="home-create-btn home-create-tile w-full rounded-xl p-4 flex flex-row items-center justify-center text-center gap-3 transition-colors"
        {...(view.canCreate ? null : { 'aria-disabled': true })}
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          if (view.canCreate) {
            win().App?.showCreateModal?.();
            return;
          }
          // Deliberately not a no-op: a dead tap on a dimmed tile reads as
          // broken, where a toast reads as locked. Same string as the tooltip
          // and the ⋮ note.
          win().PlatformUI?.toast?.(win().Home?.CREATE_DISABLED_HINT || view.hint);
        }}
      >
        <span
          className="app-icon-tile app-icon-tile--empty w-14 h-14 rounded-xl flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          <PlusIcon className="w-6 h-6" />
        </span>
        <span
          className={`home-create-label text-sm leading-tight max-w-full ${
            view.canCreate
              ? 'text-violet-700 dark:text-violet-400'
              : 'text-zinc-500 dark:text-zinc-500'
          }`}
        >
          Create app
        </span>
      </button>
    </div>
  );
}
