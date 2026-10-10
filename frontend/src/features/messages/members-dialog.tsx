import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { confirmAction } from '../../lib/confirm';
import { useMessages } from '../../lib/i18n/react';
import { useDialog } from '../dialogs/use-dialog';
import * as api from './api';
import { inviteMembers, leave, removeMember, useMessagesSnapshot } from './store';
import type { ConversationUser } from './types';
import { dotText } from './bot-shared';
import { UserAvatar } from './format';

/** A member's role and invitation status as the roster words them: message ids. */
const ROLE_LABELS: Record<string, string> = {
  owner: 'messages:members.role.owner',
  member: 'messages:members.role.member',
};
const STATUS_LABELS: Record<string, string> = {
  invited: 'messages:members.status.invited',
  declined: 'messages:members.status.declined',
  left: 'messages:members.status.left',
  removed: 'messages:members.status.removed',
};

export function ConversationMembersDialog() {
  const t = useMessages('messages');
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
    catch (err) { setError(err instanceof Error ? err.message : t('messages:members.error.invite')); }
    finally { setBusy(false); }
  }

  async function remove(user: ConversationUser) {
    // QA 2026-09-24 Q15: the app's confirm dialog, not window.confirm().
    const ok = await confirmAction({ title: user.unnamed ? t('messages:members.remove.titleUnknown') : t('messages:members.remove.title', { username: user.username }), confirmLabel: t('messages:members.remove.confirm'), danger: true });
    if (!ok) return;
    setBusy(true); setError('');
    try { await removeMember(user.id); }
    catch (err) { setError(err instanceof Error ? err.message : t('messages:members.error.remove')); }
    finally { setBusy(false); }
  }

  async function leaveCurrent() {
    const transfer = active?.myRole === 'owner' && (active.memberCount || 0) > 1
      ? t('messages:members.leave.transfer') : '';
    const ok = await confirmAction({
      title: active?.untitled ? t('messages:members.leave.titleUntitled')
        : active?.title ? t('messages:members.leave.title', { group: active.title }) : t('messages:members.leave.titleUnnamed'),
      message: transfer || undefined,
      confirmLabel: t('messages:members.leave.confirm'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setError('');
    try { await leave(); dialog.close(); }
    catch (err) { setError(err instanceof Error ? err.message : t('messages:members.error.leave')); }
    finally { setBusy(false); }
  }

  return (
    <DialogRoot id="messages-members-dialog" layout="scroll" ref={dialog.rootRef} {...dialog.backdropProps}>
      <DialogCard size="md">
        <div className="flex items-center justify-between mb-4">
          <div><h2 className="text-lg font-bold">{t('messages:members.title')}</h2><p className="text-xs text-zinc-500 dark:text-zinc-400">{t('messages:members.subtitle')}</p></div>
          <button type="button" onClick={dialog.close} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label={t('core:common.close')}><XIcon className="w-5 h-5" /></button>
        </div>
        <div className="max-h-56 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
          {active?.members.map((member) => (
            <div key={member.id} className="flex items-center gap-3 py-2">
              <UserAvatar user={member} size="sm" />
              <div className="min-w-0"><div className="text-sm font-medium truncate">@{member.username}</div><div className="text-[11px] text-zinc-500 dark:text-zinc-400 capitalize">{dotText([
                ROLE_LABELS[member.role] ? t(ROLE_LABELS[member.role]) : member.role,
                member.status !== 'member' ? (STATUS_LABELS[member.status] ? t(STATUS_LABELS[member.status]) : member.status) : null,
              ])}</div></div>
              {active.canManage && member.role !== 'owner' && member.status === 'member' ? <button type="button" disabled={busy} onClick={() => void remove(member)} className="ml-auto text-xs text-red-700 dark:text-red-400 disabled:opacity-50">{t('messages:members.removeButton')}</button> : null}
            </div>
          ))}
        </div>
        {active?.canInvite ? (
          <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">{t('messages:members.invitePeople')}</label>
            {selected.length ? <div className="flex flex-wrap gap-1 mb-2">{selected.map((user) => <button type="button" key={user.id} onClick={() => setSelected((current) => current.filter((item) => item.id !== user.id))} className="rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 px-2 py-1 text-xs">@{user.username} ×</button>)}</div> : null}
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('messages:members.searchPlaceholder')} autoComplete="off" />
            {query.trim() ? <div className="mt-1 max-h-32 overflow-y-auto">{available.map((user) => <button type="button" key={user.id} onClick={() => { setSelected((current) => [...current, user]); setQuery(''); }} className="w-full flex items-center gap-2 py-1.5 px-1 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded"><UserAvatar user={user} size="sm" />@{user.username}<span className="ml-auto text-xs text-violet-700 dark:text-violet-400">{t('messages:members.add')}</span></button>)}</div> : null}
            <Button type="button" className="mt-3 w-full" disabled={busy || !selected.length} onClick={() => void invite()}>{busy ? t('messages:members.inviting') : selected.length ? t('messages:members.inviteCount', { count: selected.length }) : t('messages:members.inviteNone')}</Button>
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <button type="button" disabled={busy} onClick={() => void leaveCurrent()} className="text-xs text-red-700 dark:text-red-400 disabled:opacity-50">{t('messages:members.leaveGroup')}</button>
          <Button type="button" variant="neutral" ink="neutral" onClick={dialog.close}>{t('core:common.done')}</Button>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
