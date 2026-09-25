/**
 * "Find friends" (#3048): a username search at the top of your own Friends
 * section, so adding someone no longer means finding their page first.
 *
 * It reuses the people search Messages' "+" already runs
 * (`GET /api/users/search?scope=messages`, via ../messages/api): prefix match
 * on the username, ten results, the directory limiter, never an email, and
 * with you and anyone blocked either way already left out by the server. A
 * blocked person therefore never appears here to be added.
 *
 * Each result carries the existing FriendButton, so the four states and
 * their menus are the ones a person's page draws. Its starting state comes
 * from the lists the section already holds (who is a friend, who asked you,
 * whom you asked), so a search costs one request, not one per row. A change
 * made here announces itself (FRIENDS_CHANGED_EVENT) and the section above
 * re-reads its lists, which hands the row its new state.
 *
 * Nothing is fetched on the first render: the box starts empty, and the
 * search runs from an effect once something is typed.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { searchUsers } from '../messages/api';
import type { ConversationUser } from '../messages/types';
import { FriendButton } from './friend-button';
import type { FriendState } from './api';
import { PLANE_FILL } from '@/components/ui/grouped-list';

type IdRow = { id: number };

export type FriendSearchLists = {
  friends: readonly IdRow[];
  incoming: readonly IdRow[];
  outgoing?: readonly IdRow[];
};

/** The viewer's relationship with `id`, read from the lists they already hold. Pure, for tests. */
export function friendStateFor(id: number, lists: FriendSearchLists): FriendState {
  if (lists.friends.some((row) => row.id === id)) return 'friends';
  if (lists.incoming.some((row) => row.id === id)) return 'incoming';
  if ((lists.outgoing || []).some((row) => row.id === id)) return 'outgoing';
  return 'none';
}

function useFriendSearch(query: string): { users: ConversationUser[]; loading: boolean; failed: boolean } {
  const [users, setUsers] = useState<ConversationUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setUsers([]); setLoading(false); setFailed(false); return; }
    let alive = true;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await searchUsers(q);
        if (alive) { setUsers(result); setFailed(false); }
      } catch {
        if (alive) { setUsers([]); setFailed(true); }
      } finally {
        if (alive) setLoading(false);
      }
    }, 200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query]);
  return { users, loading, failed };
}

function Initial({ username }: { username: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-sm font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
    >
      {(username[0] || '?').toUpperCase()}
    </span>
  );
}

/** What the search shows under the box. Pure of fetching, so tests render it directly. */
export function FriendSearchResults({
  query,
  users,
  loading,
  failed,
  lists,
}: {
  query: string;
  users: readonly ConversationUser[];
  loading: boolean;
  failed: boolean;
  lists: FriendSearchLists;
}): ReactNode {
  const q = query.trim();
  if (!q) return null;
  let note: string | null = null;
  if (failed) note = 'Search isn’t working right now. Check your connection and try again.';
  else if (loading && !users.length) note = 'Searching…';
  else if (!loading && !users.length) note = `No one matches “${q}”.`;
  return (
    <div
      id="profile-friend-search-results"
      aria-live="polite"
      className={`mt-2 rounded-2xl ${PLANE_FILL} divide-y divide-zinc-100 dark:divide-zinc-800`}
    >
      {users.map((user) => (
        <div
          key={user.id}
          data-friend-search-result={user.username}
          className="flex items-center gap-3 px-4 py-2.5"
        >
          <Initial username={user.username} />
          <a
            href={`#profile/${encodeURIComponent(user.username)}`}
            className="min-w-0 flex-1 truncate text-base font-semibold hover:underline"
          >
            {`@${user.username}`}
          </a>
          <FriendButton
            userId={user.id}
            username={user.username}
            initialState={friendStateFor(user.id, lists)}
          />
        </div>
      ))}
      {note ? (
        <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">{note}</p>
      ) : null}
    </div>
  );
}

export function FriendSearch({ lists }: { lists: FriendSearchLists }): ReactNode {
  const [query, setQuery] = useState('');
  const search = useFriendSearch(query);
  return (
    <div id="profile-friend-search" className="mb-3">
      <label className="block">
        <span className="sr-only">Find friends by username</span>
        <Input
          id="profile-friend-search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value.slice(0, 64))}
          placeholder="Find friends by username"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
        />
      </label>
      <FriendSearchResults
        query={query}
        users={search.users}
        loading={search.loading}
        failed={search.failed}
        lists={lists}
      />
    </div>
  );
}
