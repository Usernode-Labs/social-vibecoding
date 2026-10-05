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
import { createDirect, createGroup, setUserBlocked } from './store';
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
  useUiLanguage();
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<ConversationUser[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<ConversationUser[]>([]);
  const [showBlocked, setShowBlocked] = useState(false);
  const search = useUserSearch(query);
  // #2778: the "+" popover opens this on the tab that was chosen — `group`
  // for Group chat, and Direct for anything else (every older caller passes
  // nothing and keeps the tab it always opened on).
  const dialog = useDialog<'direct' | 'group'>('messagesCreate', {
    onOpen: (tab) => {
      setMode(tab === 'group' ? 'group' : 'direct'); setQuery(''); setTitle(''); setSelected([]); setError(''); setShowBlocked(false);
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
    catch (err) { setError(err instanceof Error ? err.message : tr("community:couldn_t_start_this_conversation_12ddde6f")); }
    finally { setSubmitting(false); }
  }

  async function submitGroup() {
    if (!title.trim() || !selected.length) return;
    setSubmitting(true); setError('');
    try { await createGroup(title.trim(), selected.map((user) => user.id)); dialog.close(); }
    catch (err) { setError(err instanceof Error ? err.message : tr("community:couldn_t_create_this_group_268177d8")); }
    finally { setSubmitting(false); }
  }

  async function loadBlocked() {
    setShowBlocked(true);
    try { setBlocked(await api.listBlocks()); } catch { setBlocked([]); }
  }

  async function unblock(user: ConversationUser) {
    try {
      await setUserBlocked(user.id, false);
      setBlocked((current) => current.filter((item) => item.id !== user.id));
    } catch (err) { setError(err instanceof Error ? err.message : tr("community:couldn_t_unblock_this_user_0d5a53e3")); }
  }

  async function block(user: ConversationUser) {
    // QA 2026-09-24 Q15: the app's confirm dialog, not window.confirm().
    const ok = await confirmAction({
      get title() { return tr("community:block_value1_b9dfdc7d", { value1: user.username }); },
      get message() { return tr("community:their_messages_in_shared_chats_and_app_discussio_2202f540"); },
      get confirmLabel() { return tr("community:block_211d0bb8"); },
      danger: true,
    });
    if (!ok) return;
    setSubmitting(true); setError('');
    try {
      await setUserBlocked(user.id, true);
      setBlocked((current) => [...current.filter((item) => item.id !== user.id), user]);
      setQuery('');
    } catch (err) { setError(err instanceof Error ? err.message : tr("community:couldn_t_block_this_person_3b1a2797")); }
    finally { setSubmitting(false); }
  }

  return (
    <DialogRoot id="messages-create-dialog" layout="scroll" ref={dialog.rootRef} {...dialog.backdropProps}>
      <DialogCard size="md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold"><Message id="community:new_message_78f5975a" /></h2>
          <Localized element={<button type="button" onClick={dialog.close} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label={catalogText("community:close_7d9eb7ac")}><XIcon className="w-5 h-5" /></button>} messages={{"aria-label":"community:close_7d9eb7ac"}} />
        </div>
        <Localized element={<div className="grid grid-cols-2 gap-1 p-1 mb-4 rounded-lg bg-zinc-100 dark:bg-zinc-800" role="tablist" aria-label={catalogText("community:conversation_type_9ca49801")}>
          {(['direct', 'group'] as const).map((kind) => (
            <button key={kind} type="button" role="tab" aria-selected={mode === kind} onClick={() => { setMode(kind); setQuery(''); setSelected([]); setError(''); }} className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === kind ? 'bg-white dark:bg-zinc-700 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-zinc-500 dark:text-zinc-400'}`}>
              <LocalizedValue render={() => (kind === 'direct' ? tr("community:direct_002c7c68") : tr("community:group_34ca0e76"))} />
            </button>
          ))}
        </div>} messages={{"aria-label":"community:conversation_type_9ca49801"}} />
        {mode === 'group' ? (
          <label className="block mb-3">
            <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><Message id="community:group_name_762ebb70" /></span>
            <Localized element={<Input placeholder={catalogText("community:design_crew_2eec8b54")} value={title} onChange={(event) => setTitle(event.target.value.slice(0, 80))} maxLength={80} autoComplete="off" />} messages={{"placeholder":"community:design_crew_2eec8b54"}} />
          </label>
        ) : null}
        {selected.length ? (
          <Localized element={<div className="flex flex-wrap gap-1.5 mb-3" aria-label={catalogText("community:selected_members_78a2792c")}>
            {selected.map((user) => (
              <button key={user.id} type="button" onClick={() => setSelected((current) => current.filter((item) => item.id !== user.id))} className="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 px-2 py-1 text-xs">
                @{user.username} <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>} messages={{"aria-label":"community:selected_members_78a2792c"}} />
        ) : null}
        <label className="block">
          <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><LocalizedValue render={() => (mode === 'direct' ? tr("community:find_a_person_9af70da5") : tr("community:invite_people_27bf0f2d"))} /></span>
          <Localized element={<Input placeholder={catalogText("community:search_by_username_b7a43e76")} value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" autoFocus />} messages={{"placeholder":"community:search_by_username_b7a43e76"}} />
        </label>
        <div className="mt-2 min-h-12 max-h-52 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
          {loadingRow(search.loading, query, results.length)}
          {results.map((user) => (
            <div key={user.id} className="flex items-center gap-1 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800">
              <button type="button" disabled={submitting} onClick={() => void choose(user)} className="min-w-0 flex-1 flex items-center gap-3 px-2 py-2 text-left disabled:opacity-50">
                <UserAvatar user={user} size="sm" />
                <span className="text-sm font-medium truncate">@{user.username}</span>
                <span className="ml-auto text-xs text-violet-700 dark:text-violet-400"><LocalizedValue render={() => (mode === 'group' ? tr("community:add_9fd728c6") : tr("community:message_2f77668a"))} /></span>
              </button>
              <LocalizedDynamic element={<button type="button" disabled={submitting} onClick={() => void block(user)} aria-label={tr("community:block_value1_1cff48c9", { value1: user.username })} className="px-2 py-2 text-xs text-red-700 dark:text-red-400 disabled:opacity-50"><Message id="community:block_211d0bb8" /></button>} resolve={() => ({ get "aria-label"() { return tr("community:block_value1_1cff48c9", { value1: user.username }); } })} />
            </div>
          ))}
        </div>
        {error ? <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
          <button type="button" onClick={() => void loadBlocked()} className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"><Message id="community:blocked_people_e11bdf73" /></button>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="neutral" ink="neutral" onClick={dialog.close}><Message id="community:cancel_19766ed6" /></Button>
            {mode === 'group' ? <Button type="button" disabled={submitting || !title.trim() || !selected.length} onClick={() => void submitGroup()}><LocalizedValue render={() => (submitting ? tr("community:creating_c79ed949") : tr("community:create_group_35be9c54"))} /></Button> : null}
          </div>
        </div>
        {showBlocked ? (
          <div className="mt-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
            <div className="text-xs font-semibold mb-1"><Message id="community:blocked_people_e11bdf73" /></div>
            {!blocked.length ? <p className="text-xs text-zinc-500 dark:text-zinc-400 py-2"><Message id="community:nobody_is_blocked_acecbd3f" /></p> : blocked.map((user) => (
              <div key={user.id} className="flex items-center gap-2 py-1.5"><UserAvatar user={user} size="sm" /><span className="text-sm truncate">@{user.username}</span><button type="button" onClick={() => void unblock(user)} className="ml-auto text-xs text-violet-700 dark:text-violet-400"><Message id="community:unblock_712da631" /></button></div>
            ))}
          </div>
        ) : null}
      </DialogCard>
    </DialogRoot>
  );
}

function loadingRow(loading: boolean, query: string, count: number) {
  if (loading) return <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3"><Message id="community:searching_c31723ab" /></p>;
  if (query.trim() && !count) return <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3"><Message id="community:no_matching_users_579f8c39" /></p>;
  return null;
}
