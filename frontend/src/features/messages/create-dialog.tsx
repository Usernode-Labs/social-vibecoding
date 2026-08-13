import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDialog } from '../dialogs/use-dialog';
import * as api from './api';
import { createDirect, createGroup } from './store';
import type { ConversationUser } from './types';
import { UserAvatar } from './format';

function useUserSearch(query: string) {
  const [users, setUsers] = useState<ConversationUser[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setUsers([]); setLoading(false); return; }
    let alive = true;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api.searchUsers(q);
        if (alive) setUsers(result);
      } catch { if (alive) setUsers([]); }
      finally { if (alive) setLoading(false); }
    }, 180);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query]);
  return { users, loading };
}

export function CreateConversationDialog() {
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<ConversationUser[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<ConversationUser[]>([]);
  const [showBlocked, setShowBlocked] = useState(false);
  const search = useUserSearch(query);
  const dialog = useDialog('messagesCreate', {
    onOpen: () => {
      setMode('direct'); setQuery(''); setTitle(''); setSelected([]); setError(''); setShowBlocked(false);
    },
  });

  const results = useMemo(
    () => search.users.filter((user) => !selected.some((item) => item.id === user.id)),
    [search.users, selected],
  );

  async function choose(user: ConversationUser) {
    if (mode === 'group') {
      setSelected((current) => [...current, user].slice(0, 99));
      setQuery('');
      return;
    }
    setSubmitting(true); setError('');
    try { await createDirect(user.id); dialog.close(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t start this conversation.'); }
    finally { setSubmitting(false); }
  }

  async function submitGroup() {
    if (!title.trim() || !selected.length) return;
    setSubmitting(true); setError('');
    try { await createGroup(title.trim(), selected.map((user) => user.id)); dialog.close(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t create this group.'); }
    finally { setSubmitting(false); }
  }

  async function loadBlocked() {
    setShowBlocked(true);
    try { setBlocked(await api.listBlocks()); } catch { setBlocked([]); }
  }

  async function unblock(user: ConversationUser) {
    try {
      await api.setBlock(user.id, false);
      setBlocked((current) => current.filter((item) => item.id !== user.id));
    } catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t unblock this user.'); }
  }

  return (
    <div ref={dialog.rootRef} id="messages-create-dialog" className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60" {...dialog.backdropProps}>
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-5 w-full max-w-md shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">New message</h2>
            <button type="button" onClick={dialog.close} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="Close">×</button>
          </div>
          <div className="grid grid-cols-2 gap-1 p-1 mb-4 rounded-lg bg-zinc-100 dark:bg-zinc-800" role="tablist" aria-label="Conversation type">
            {(['direct', 'group'] as const).map((kind) => (
              <button key={kind} type="button" role="tab" aria-selected={mode === kind} onClick={() => { setMode(kind); setQuery(''); setSelected([]); setError(''); }} className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === kind ? 'bg-white dark:bg-zinc-700 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-zinc-500 dark:text-zinc-400'}`}>
                {kind === 'direct' ? 'Direct' : 'Group'}
              </button>
            ))}
          </div>
          {mode === 'group' ? (
            <label className="block mb-3">
              <span className="block text-xs font-medium text-zinc-500 mb-1">Group name</span>
              <Input value={title} onChange={(event) => setTitle(event.target.value.slice(0, 80))} placeholder="Design crew" maxLength={80} autoComplete="off" />
            </label>
          ) : null}
          {selected.length ? (
            <div className="flex flex-wrap gap-1.5 mb-3" aria-label="Selected members">
              {selected.map((user) => (
                <button key={user.id} type="button" onClick={() => setSelected((current) => current.filter((item) => item.id !== user.id))} className="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 px-2 py-1 text-xs">
                  @{user.username} <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="block">
            <span className="block text-xs font-medium text-zinc-500 mb-1">{mode === 'direct' ? 'Find a person' : 'Invite people'}</span>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by username" autoComplete="off" autoFocus />
          </label>
          <div className="mt-2 min-h-12 max-h-52 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
            {loadingRow(search.loading, query, results.length)}
            {results.map((user) => (
              <button key={user.id} type="button" disabled={submitting} onClick={() => void choose(user)} className="w-full flex items-center gap-3 px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-lg disabled:opacity-50">
                <UserAvatar user={user} size="sm" />
                <span className="text-sm font-medium truncate">@{user.username}</span>
                <span className="ml-auto text-xs text-violet-600 dark:text-violet-400">{mode === 'group' ? 'Add' : 'Message'}</span>
              </button>
            ))}
          </div>
          {error ? <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
          <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
            <button type="button" onClick={() => void loadBlocked()} className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Blocked people</button>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" onClick={dialog.close}>Cancel</Button>
              {mode === 'group' ? <Button type="button" disabled={submitting || !title.trim() || !selected.length} onClick={() => void submitGroup()}>{submitting ? 'Creating…' : 'Create group'}</Button> : null}
            </div>
          </div>
          {showBlocked ? (
            <div className="mt-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
              <div className="text-xs font-semibold mb-1">Blocked people</div>
              {!blocked.length ? <p className="text-xs text-zinc-500 py-2">Nobody is blocked.</p> : blocked.map((user) => (
                <div key={user.id} className="flex items-center gap-2 py-1.5"><UserAvatar user={user} size="sm" /><span className="text-sm truncate">@{user.username}</span><button type="button" onClick={() => void unblock(user)} className="ml-auto text-xs text-violet-600 dark:text-violet-400">Unblock</button></div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function loadingRow(loading: boolean, query: string, count: number) {
  if (loading) return <p className="text-xs text-zinc-500 px-2 py-3">Searching…</p>;
  if (query.trim() && !count) return <p className="text-xs text-zinc-500 px-2 py-3">No matching users.</p>;
  return null;
}
