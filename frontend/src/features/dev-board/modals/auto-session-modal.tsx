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
 * The OpenRouter branch is controlled because filtering, favorites and a
 * forced refresh can replace its option set while the dialog stays open.
 * Confirming still hands only the chosen id to AppView; nothing outside reads
 * the element.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

import { useStoreState } from '../../../lib/use-store-state';
import { autoSessionModalStore } from './modals-store';
import type { AutoSessionModalView } from './model';

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

function filteredOptions(
  options: AutoSessionModalView['options'],
  query: string,
  favoritesOnly: boolean,
): AutoSessionModalView['options'] {
  const needle = query.trim().toLocaleLowerCase();
  return options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => {
      if (favoritesOnly && !option.isFavorite) return false;
      return !needle || String(option.searchText || option.label || option.id)
        .toLocaleLowerCase().includes(needle);
    })
    .sort((a, b) => {
      if (!!a.option.isFavorite !== !!b.option.isFavorite) return a.option.isFavorite ? -1 : 1;
      if (!!a.option.isRecommended !== !!b.option.isRecommended) return a.option.isRecommended ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ option }) => option);
}

function catalogAgeText(refreshedAt: string | null | undefined): string {
  const refreshed = Date.parse(refreshedAt || '');
  if (!Number.isFinite(refreshed)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - refreshed) / 1000));
  if (seconds < 60) return 'Updated just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.round(minutes / 60)}h ago`;
}

export function AutoSessionCard({ view }: { view: AutoSessionModalView }): ReactNode {
  const [options, setOptions] = useState(view.options);
  const [chosen, setChosen] = useState(view.preselect);
  const [query, setQuery] = useState('');
  // Open on the short default-favorite list when it contains the selected
  // model. Preserve an explicitly selected non-favorite by showing All.
  const [favoritesOnly, setFavoritesOnly] = useState(
    view.openRouter === true
      && view.options.find((option) => option.id === view.preselect)?.isFavorite === true,
  );
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState(view.catalogRefreshedAt || null);
  const [totalModels, setTotalModels] = useState(view.catalogTotalModels || view.options.length);
  const visibleOptions = filteredOptions(options, query, favoritesOnly);
  const option = visibleOptions.find((o) => o.id === chosen) || null;

  const chooseFrom = (
    nextOptions: AutoSessionModalView['options'],
    nextQuery: string,
    nextFavoritesOnly: boolean,
  ): void => {
    const visible = filteredOptions(nextOptions, nextQuery, nextFavoritesOnly);
    if (!visible.some((item) => item.id === chosen)) setChosen(visible[0]?.id || '');
  };

  const toggleFavorite = async (): Promise<void> => {
    if (!option || !view.onFavorite || favoriteBusy) return;
    const favorite = !option.isFavorite;
    setFavoriteBusy(true);
    setCatalogError('');
    try {
      await view.onFavorite(option.id, favorite);
      const next = options.map((item) => item.id === option.id
        ? { ...item, isFavorite: favorite }
        : item);
      setOptions(next);
      chooseFrom(next, query, favoritesOnly);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'Could not update that favorite.');
    } finally {
      setFavoriteBusy(false);
    }
  };

  const refreshModels = async (): Promise<void> => {
    if (!view.onRefresh || refreshing) return;
    setRefreshing(true);
    setCatalogError('');
    try {
      const fresh = await view.onRefresh();
      setOptions(fresh.options);
      setRefreshedAt(fresh.refreshedAt);
      setTotalModels(fresh.totalModels);
      chooseFrom(fresh.options, query, favoritesOnly);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'Could not refresh OpenRouter models.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <DialogCard size="md" relative>
      <h2 className="text-lg font-bold mb-2 text-zinc-900 dark:text-zinc-100">
        {`Generate proposal for issue #${view.issueNumber}?`}
      </h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">{view.intro}</p>
      <p className="text-xs text-amber-800 mb-2 dark:text-amber-300">
        {'Experimental, and not recommended for normal users at the moment. Costs are billed '
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
      {view.openRouter ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <Input
            type="search"
            value={query}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setQuery(next);
              chooseFrom(options, next, favoritesOnly);
            }}
            autoComplete="off"
            placeholder="Filter by model or provider…"
            aria-label="Filter OpenRouter models"
            width="flex"
          />
          <button
            type="button"
            aria-pressed={favoritesOnly}
            onClick={() => {
              const next = !favoritesOnly;
              setFavoritesOnly(next);
              chooseFrom(options, query, next);
            }}
            className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            {favoritesOnly ? '★ Favorites' : '☆ Favorites'}
          </button>
          <button
            type="button"
            disabled={refreshing}
            onClick={refreshModels}
            className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      ) : null}
      <div className="flex items-stretch gap-2">
        <Select
          id="auto-session-model"
          value={option?.id || ''}
          disabled={!visibleOptions.length}
          onChange={(e) => setChosen(e.currentTarget.value)}
          className="min-w-0 flex-1"
        >
          {visibleOptions.map((o) => (
            <option key={o.id} value={o.id}>{`${o.isFavorite ? '★ ' : ''}${o.label}`}</option>
          ))}
        </Select>
        {view.openRouter ? (
          <button
            type="button"
            disabled={!option || favoriteBusy}
            aria-pressed={option?.isFavorite === true}
            aria-label={option?.isFavorite ? 'Remove selected model from favorites' : 'Add selected model to favorites'}
            title={option?.isFavorite ? 'Remove selected model from favorites' : 'Add selected model to favorites'}
            onClick={toggleFavorite}
            className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-lg leading-none text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
          >
            {option?.isFavorite ? '★' : '☆'}
          </button>
        ) : null}
      </div>
      {view.openRouter ? (
        <p className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          {visibleOptions.length
            ? `${visibleOptions.length} of ${totalModels} models${catalogAgeText(refreshedAt) ? ` · ${catalogAgeText(refreshedAt)}` : ''}`
            : `No key-visible models match. Refresh, then check this key's OpenRouter account policies${catalogAgeText(refreshedAt) ? ` · ${catalogAgeText(refreshedAt)}` : ''}`}
        </p>
      ) : null}
      {view.openRouter ? (
        <p className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          Platform recommendations start in Favorites. Clear the Favorites filter to browse every model available to this key.
        </p>
      ) : null}
      {catalogError ? (
        <p role="status" className="mt-1 text-xs text-red-700 dark:text-red-400">{catalogError}</p>
      ) : null}
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
        <Button type="button" data-role="confirm" disabled={!option} onClick={() => call('_autoSessionConfirm', option?.id || '')}>
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
