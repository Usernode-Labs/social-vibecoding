/**
 * Home's search found nothing anywhere: offer to make it (#5928, item 10).
 *
 * Discover's search made this offer (#6035): words that matched no app were
 * an idea for a project, and Make opened "What do you want to make?" with
 * them typed in. One Home (#6361) folded Discover into Home and the offer was
 * left behind, though the make screen still credits an idea to a search
 * (../first-session/make.tsx, SEARCH_IDEA_LINE).
 *
 * Home's one search covers three lists, each drawn by its own owner: the
 * apps grid (./home.js), Pinned communities and Communities to join. This
 * reads the same three and speaks only when all of them have answered and
 * none has a match, under the grid's own "None of your apps match" line. A
 * directory still loading, or one that could not be read, is not "nothing
 * matches": nothing is offered then.
 *
 * Nothing in the prerender: the search starts empty, so this is null until
 * somebody types.
 */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import type { GuestApp } from '../guest/guest-data';
import { readDirectory } from './communities-to-join';
import { gridStore } from './grid-store';
import { homePinsStore } from './home-pins-store';
import { matchesQuery, useHomeQuery } from './use-home-query';

/** A web address is somewhere to go, not something to make. */
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?)$/i;

interface Named { slug: string; name?: string | null }

/**
 * The idea a search is, or null while anything matches it or a list has not
 * answered yet. `noApps` is the grid's own verdict for these exact words
 * (gridStore.emptyQuery), so the two can never disagree about the apps.
 */
export function searchIdea(query: string, lists: {
  noApps: boolean;
  communities: readonly Named[] | null;
  directory: readonly Pick<GuestApp, 'slug' | 'name' | 'description'>[] | null;
}): string | null {
  const q = String(query == null ? '' : query).trim();
  if (q.length < 2 || ADDRESS.test(q)) return null;
  if (!lists.noApps || !lists.communities || !lists.directory) return null;
  if (lists.communities.some((c) => matchesQuery(q, c.name, c.slug))) return null;
  if (lists.directory.some((a) => matchesQuery(q, a.name, a.slug, a.description))) return null;
  return q;
}

/** Open the make screen with the search as its idea. */
export function makeFromSearch(idea: string): void {
  (window as unknown as { App?: { showCreateModal?: (o: { idea: string; ideaSource: 'search' }) => boolean } })
    .App?.showCreateModal?.({ idea, ideaSource: 'search' });
}

/** The line and its button. The idea goes whole; only its label is cut to one line. */
export function SearchMakeOffer({ idea }: { idea: string }) {
  const t = useMessages('home');
  const label = t('home:search.make', { idea });
  return (
    <div data-home-search-make="" className="flex flex-col items-center gap-3 px-5 pb-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
      <p>{t('home:search.none', { query: idea })}</p>
      <Button
        type="button"
        layout="iconRow"
        variant="pillAccent"
        size="sm"
        ink="solid"
        className="min-h-[44px] md:min-h-0 max-w-full"
        title={label}
        onClick={() => makeFromSearch(idea)}
      ><span className="min-w-0 truncate">{label}</span></Button>
    </div>
  );
}

export function HomeSearchMake() {
  const query = useHomeQuery();
  const grid = useStoreState(gridStore);
  const pins = useStoreState(homePinsStore);
  const [directory, setDirectory] = useState<GuestApp[] | null>(null);
  // The directory is asked for only once a search has come up empty on the
  // apps, and `readDirectory` answers from the read Communities to join
  // already made.
  const noApps = !!query && grid.view === 'search' && grid.emptyQuery !== null && grid.emptyQuery.trim() === query;
  useEffect(() => {
    if (!noApps) return undefined;
    let live = true;
    void readDirectory().then((list) => { if (live) setDirectory(list); });
    return () => { live = false; };
  }, [noApps]);
  // A private member makes nothing here (their Home has no New community
  // tile either, ./pinned-communities.tsx).
  const win = typeof window !== 'undefined' ? (window as any) : null;
  if (!noApps || !pins.ready || !win?.App?.user || win.App.user.privateMember) return null;
  const idea = searchIdea(query, {
    noApps,
    communities: [...pins.pins, ...pins.joined],
    directory,
  });
  return idea ? <SearchMakeOffer idea={idea} /> : null;
}
