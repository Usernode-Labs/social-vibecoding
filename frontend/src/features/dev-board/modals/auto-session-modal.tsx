/**
 * `#auto-session-modal` — the Generate-proposal confirmation.
 *
 * The scrim, the Escape key and the backdrop click stay
 * `public/js/app-view.js`'s (see ./model.ts's header on the seam). What is
 * React's is everything inside: the card, the copy, the model picker and the
 * caption that follows the selection.
 *
 * ── The picker's caption is component state ────────────────────────────
 *
 * `_showAutoSessionModal` bound a `change` listener to the `<select>` and
 * rewrote `#auto-session-model-note`'s `textContent` and `title` from it. The
 * caption is a `useState` over the option list now — each option carries its
 * own resolved `note` and `noteTitle`, built by `DevChat.modelOptionText` /
 * `modelNoteText` where they already lived.
 *
 * The `<select>` stays UNCONTROLLED, with `defaultValue`. Confirming reads
 * the chosen id from this component's state and hands it to
 * `AppView._autoSessionConfirm`, so nothing outside reads the element — but
 * an uncontrolled select is still what keeps a re-render from fighting the
 * native picker mid-interaction on iOS.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

import { useStoreState } from '../../../lib/use-store-state';
import { autoSessionModalStore } from './modals-store';
import type { AutoSessionModalView } from './model';

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

export function AutoSessionCard({ view }: { view: AutoSessionModalView }): ReactNode {
  const [chosen, setChosen] = useState(view.preselect);
  const option = view.options.find((o) => o.id === chosen) || null;
  return (
    <DialogCard size="md" relative>
      <h2 className="text-lg font-bold mb-2 text-zinc-900 dark:text-zinc-100">
        {`Generate proposal for issue #${view.issueNumber}?`}
      </h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">{view.intro}</p>
      <p className="text-xs text-amber-800 mb-2 dark:text-amber-300">
        {'Experimental: not recommended for normal users at the moment. Costs are billed '
          + "to you even if the result isn't useful."}
      </p>
      {/* WHERE it builds, named before you confirm — the pot the costs above
          land in depends on it. Absent when build-venues.js has not loaded,
          which leaves the dialog as it was. */}
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
        {view.venue ? (
          <>
            {'Building in '}
            <b>{view.venue.label}</b>
            {`, your saved default. ${view.venue.blurb}`}
          </>
        ) : null}
      </p>
      <Label htmlFor="auto-session-model" className="mb-1">{view.pickerLabel}</Label>
      <Select
        id="auto-session-model"
        defaultValue={view.preselect}
        onChange={(e) => setChosen(e.currentTarget.value)}
      >
        {view.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </Select>
      {/* #800: the caption for whichever model is selected. */}
      <p
        id="auto-session-model-note"
        className="mt-1 mb-5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400"
        title={(option && option.noteTitle) || undefined}
      >
        {option ? option.note : ''}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          data-role="cancel"
          variant="neutral"
          ink="neutral"
          onClick={() => call('_autoSessionCancel')}
        >
          Cancel
        </Button>
        <Button type="button" data-role="confirm" onClick={() => call('_autoSessionConfirm', chosen)}>
          Generate proposal
        </Button>
      </div>
    </DialogCard>
  );
}

export function AutoSessionModal(): ReactNode {
  const { view } = useStoreState<{ view: AutoSessionModalView | null }>(autoSessionModalStore);
  if (!view) return null;
  // The centring wrapper carries `data-modal-backdrop`, which is what
  // app-view.js's dismiss rule looks for — the same attribute DialogRoot
  // renders for the nine static dialogs.
  return (
    <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
      <AutoSessionCard view={view} />
    </div>
  );
}
