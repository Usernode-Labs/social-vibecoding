import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { confirmAction } from '../../lib/confirm';
import { useDialog } from '../dialogs/use-dialog';
import * as api from './api';
import { inviteMembers, leave, removeMember, useMessagesSnapshot } from './store';
import type { ConversationUser } from './types';
import { UserAvatar } from './format';

export function ConversationMembersDialog() {
  useUiLanguage();
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
    catch (err) { setError(err instanceof Error ? err.message : tr("community:couldn_t_invite_these_people_a19842c3")); }
    finally { setBusy(false); }
  }

  async function remove(user: ConversationUser) {
    // QA 2026-09-24 Q15: the app's confirm dialog, not window.confirm().
    const ok = await confirmAction({ get title() { return tr("community:remove_value1_from_this_group_2533e073", { value1: user.username }); }, get confirmLabel() { return tr("community:remove_c3812fc4"); }, danger: true });
    if (!ok) return;
    setBusy(true); setError('');
    try { await removeMember(user.id); }
    catch (err) { setError(err instanceof Error ? err.message : tr("community:couldn_t_remove_this_member_60b70d59")); }
    finally { setBusy(false); }
  }

  async function leaveCurrent() {
    const transfer = active?.myRole === 'owner' && (active.memberCount || 0) > 1
      ? tr("community:ownership_will_transfer_to_the_oldest_remaining__edc80f07") : '';
    const ok = await confirmAction({
      get title() { return tr("community:leave_value1_3c3762d8", { value1: active?.title || tr("community:this_conversation_ecbd7892") }); },
      message: transfer || undefined,
      get confirmLabel() { return tr("community:leave_fc6e4a40"); },
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setError('');
    try { await leave(); dialog.close(); }
    catch (err) { setError(err instanceof Error ? err.message : tr("community:couldn_t_leave_this_conversation_bbc9e4f7")); }
    finally { setBusy(false); }
  }

  return (
    <DialogRoot id="messages-members-dialog" layout="scroll" ref={dialog.rootRef} {...dialog.backdropProps}>
      <DialogCard size="md">
        <div className="flex items-center justify-between mb-4">
          <div><h2 className="text-lg font-bold"><Message id="community:group_members_dd0fd917" /></h2><p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="community:accepted_members_can_read_the_complete_retained__3a068bd2" /></p></div>
          <Localized element={<button type="button" onClick={dialog.close} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label={catalogText("community:close_7d9eb7ac")}><XIcon className="w-5 h-5" /></button>} messages={{"aria-label":"community:close_7d9eb7ac"}} />
        </div>
        <div className="max-h-56 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
          {active?.members.map((member) => (
            <div key={member.id} className="flex items-center gap-3 py-2">
              <UserAvatar user={member} size="sm" />
              <div className="min-w-0"><div className="text-sm font-medium truncate">@{member.username}</div><div className="text-[11px] text-zinc-500 dark:text-zinc-400 capitalize">{member.role}{member.status !== 'member' ? ` · ${member.status}` : ''}</div></div>
              {active.canManage && member.role !== 'owner' && member.status === 'member' ? <button type="button" disabled={busy} onClick={() => void remove(member)} className="ml-auto text-xs text-red-700 dark:text-red-400 disabled:opacity-50"><Message id="community:remove_c3812fc4" /></button> : null}
            </div>
          ))}
        </div>
        {active?.canInvite ? (
          <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><Message id="community:invite_people_27bf0f2d" /></label>
            {selected.length ? <div className="flex flex-wrap gap-1 mb-2">{selected.map((user) => <button type="button" key={user.id} onClick={() => setSelected((current) => current.filter((item) => item.id !== user.id))} className="rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 px-2 py-1 text-xs">@{user.username} ×</button>)}</div> : null}
            <Localized element={<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={catalogText("community:search_by_username_b7a43e76")} autoComplete="off" />} messages={{"placeholder":"community:search_by_username_b7a43e76"}} />
            {query.trim() ? <div className="mt-1 max-h-32 overflow-y-auto">{available.map((user) => <button type="button" key={user.id} onClick={() => { setSelected((current) => [...current, user]); setQuery(''); }} className="w-full flex items-center gap-2 py-1.5 px-1 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded"><UserAvatar user={user} size="sm" />@{user.username}<span className="ml-auto text-xs text-violet-700 dark:text-violet-400"><Message id="community:add_9fd728c6" /></span></button>)}</div> : null}
            <Button type="button" className="mt-3 w-full" disabled={busy || !selected.length} onClick={() => void invite()}><LocalizedValue render={() => (busy ? tr("community:inviting_a4c2059a") : `Invite ${selected.length || ''}`.trim())} /></Button>
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <button type="button" disabled={busy} onClick={() => void leaveCurrent()} className="text-xs text-red-700 dark:text-red-400 disabled:opacity-50"><Message id="community:leave_group_3475393d" /></button>
          <Button type="button" variant="neutral" ink="neutral" onClick={dialog.close}><Message id="community:done_11a6767d" /></Button>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
