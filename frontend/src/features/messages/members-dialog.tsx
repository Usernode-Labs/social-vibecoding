import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDialog } from '../dialogs/use-dialog';
import * as api from './api';
import { inviteMembers, leave, removeMember, useMessagesSnapshot } from './store';
import type { ConversationUser } from './types';
import { UserAvatar } from './format';

export function ConversationMembersDialog() {
  const snap = useMessagesSnapshot();
  const active = snap.active;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationUser[]>([]);
  const [selected, setSelected] = useState<ConversationUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useDialog('messagesMembers', {
    onOpen: () => { setQuery(''); setResults([]); setSelected([]); setError(''); },
  });

  useEffect(() => {
    if (!dialog.isOpen || !query.trim()) { setResults([]); return; }
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        const users = await api.searchUsers(query);
        if (alive) setResults(users);
      } catch { if (alive) setResults([]); }
    }, 180);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [dialog.isOpen, query]);

  const available = useMemo(() => results.filter((user) =>
    !active?.members.some((member) => member.id === user.id && ['member', 'invited'].includes(member.status))
    && !selected.some((item) => item.id === user.id)), [active, results, selected]);

  async function invite() {
    if (!selected.length) return;
    setBusy(true); setError('');
    try { await inviteMembers(selected.map((user) => user.id)); setSelected([]); setQuery(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t invite these people.'); }
    finally { setBusy(false); }
  }

  async function remove(user: ConversationUser) {
    if (!window.confirm(`Remove @${user.username} from this group?`)) return;
    setBusy(true); setError('');
    try { await removeMember(user.id); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t remove this member.'); }
    finally { setBusy(false); }
  }

  async function leaveCurrent() {
    const transfer = active?.myRole === 'owner' && (active.memberCount || 0) > 1
      ? ' Ownership will transfer to the oldest remaining member.' : '';
    if (!window.confirm(`Leave ${active?.title || 'this conversation'}?${transfer}`)) return;
    setBusy(true); setError('');
    try { await leave(); dialog.close(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t leave this conversation.'); }
    finally { setBusy(false); }
  }

  return (
    <div ref={dialog.rootRef} id="messages-members-dialog" className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60" {...dialog.backdropProps}>
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-5 w-full max-w-md shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <div><h2 className="text-lg font-bold">Group members</h2><p className="text-xs text-zinc-500">Accepted members can read the complete retained history.</p></div>
            <button type="button" onClick={dialog.close} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="Close">×</button>
          </div>
          <div className="max-h-56 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
            {active?.members.map((member) => (
              <div key={member.id} className="flex items-center gap-3 py-2">
                <UserAvatar user={member} size="sm" />
                <div className="min-w-0"><div className="text-sm font-medium truncate">@{member.username}</div><div className="text-[11px] text-zinc-500 capitalize">{member.role}{member.status !== 'member' ? ` · ${member.status}` : ''}</div></div>
                {active.canManage && member.role !== 'owner' && member.status === 'member' ? <button type="button" disabled={busy} onClick={() => void remove(member)} className="ml-auto text-xs text-red-600 dark:text-red-400 disabled:opacity-50">Remove</button> : null}
              </div>
            ))}
          </div>
          {active?.canInvite ? (
            <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
              <label className="block text-xs font-medium text-zinc-500 mb-1">Invite people</label>
              {selected.length ? <div className="flex flex-wrap gap-1 mb-2">{selected.map((user) => <button type="button" key={user.id} onClick={() => setSelected((current) => current.filter((item) => item.id !== user.id))} className="rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 px-2 py-1 text-xs">@{user.username} ×</button>)}</div> : null}
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by username" autoComplete="off" />
              {query.trim() ? <div className="mt-1 max-h-32 overflow-y-auto">{available.map((user) => <button type="button" key={user.id} onClick={() => { setSelected((current) => [...current, user]); setQuery(''); }} className="w-full flex items-center gap-2 py-1.5 px-1 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded"><UserAvatar user={user} size="sm" />@{user.username}<span className="ml-auto text-xs text-violet-600">Add</span></button>)}</div> : null}
              <Button type="button" className="mt-3 w-full" disabled={busy || !selected.length} onClick={() => void invite()}>{busy ? 'Inviting…' : `Invite ${selected.length || ''}`.trim()}</Button>
            </div>
          ) : null}
          {error ? <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
          <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
            <button type="button" disabled={busy} onClick={() => void leaveCurrent()} className="text-xs text-red-600 dark:text-red-400 disabled:opacity-50">Leave group</button>
            <Button type="button" variant="outline" onClick={dialog.close}>Done</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
