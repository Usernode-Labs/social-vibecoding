import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useDialog } from '../dialogs/use-dialog';
import * as api from './api';
import type { SharedObjectReference, SharedObjectType } from './types';

interface AppChoice { id: number; slug: string; name: string }

export function ShareItemDialog() {
  useUiLanguage();
  const [type, setType] = useState<SharedObjectType>('app');
  const [apps, setApps] = useState<AppChoice[]>([]);
  const [appId, setAppId] = useState<number | null>(null);
  const [itemId, setItemId] = useState('');
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialog = useDialog<SharedObjectReference>('messagesShare', {
    onOpen: (reference) => {
      setType(reference?.type || 'app'); setAppId(reference?.appId || null);
      setItemId(String(reference?.issueNumber || reference?.sessionId || reference?.proposalId || ''));
      setVersion(String(reference?.version || '')); setError('');
    },
  });

  useEffect(() => {
    if (!dialog.isOpen || apps.length) return;
    let alive = true; setLoading(true);
    void api.listApps().then((rows) => { if (alive) setApps(rows); }).catch(() => { if (alive) setError(tr("community:couldn_t_load_your_apps_cf911d9a")); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apps.length, dialog.isOpen]);

  const app = useMemo(() => apps.find((item) => item.id === appId) || null, [appId, apps]);
  const validId = (value: string) => api.strictId(value);
  const canAttach = !!app && (type === 'app' || !!validId(itemId)) && (type !== 'spec' || !!validId(version));

  function attach() {
    if (!app || !canAttach) return;
    const id = validId(itemId);
    const reference: SharedObjectReference = { type, appId: app.id, appSlug: app.slug };
    if (type === 'issue') reference.issueNumber = id || undefined;
    if (type === 'proposal' || type === 'spec') reference.sessionId = id || undefined;
    if (type === 'governance') reference.proposalId = id || undefined;
    if (type === 'spec') reference.version = validId(version) || undefined;
    window.dispatchEvent(new CustomEvent('usernode:messages-object-selected', { detail: reference }));
    dialog.close();
  }

  return (
    <DialogRoot id="messages-share-dialog" layout="scroll" ref={dialog.rootRef} {...dialog.backdropProps}>
      <DialogCard size="md">
        <div className="flex items-center justify-between mb-4"><div><h2 className="text-lg font-bold"><Message id="community:share_item_dbce8c33" /></h2><p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="community:access_is_checked_separately_for_every_recipient_b2563a67" /></p></div><Localized element={<button type="button" onClick={dialog.close} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label={catalogText("community:close_7d9eb7ac")}><XIcon className="w-5 h-5" /></button>} messages={{"aria-label":"community:close_7d9eb7ac"}} /></div>
        <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><Message id="community:item_type_5b71c546" /></span><select value={type} onChange={(event) => { setType(event.target.value as SharedObjectType); setItemId(''); setVersion(''); }} className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"><option value="app"><Message id="community:app_0d04bfeb" /></option><option value="issue"><Message id="community:github_backed_issue_ea5c40fc" /></option><option value="proposal"><Message id="community:code_proposal_800e6d29" /></option><option value="governance"><Message id="community:governance_proposal_5f1d1a55" /></option><option value="spec"><Message id="community:exact_spec_version_e91a9827" /></option></select></label>
        <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><Message id="community:app_0d04bfeb" /></span><select value={appId || ''} disabled={loading} onChange={(event) => setAppId(api.strictId(event.target.value))} className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"><option value=""><LocalizedValue render={() => (loading ? tr("community:loading_apps_f8bcca38") : tr("community:choose_an_app_8b9b4f57"))} /></option>{apps.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {type !== 'app' ? <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><LocalizedValue render={() => (type === 'issue' ? tr("community:issue_number_b90458b6") : type === 'governance' ? tr("community:governance_proposal_id_7ba3cac6") : tr("community:proposal_session_id_3726713b"))} /></span><Input inputMode="numeric" pattern="[0-9]*" value={itemId} onChange={(event) => setItemId(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="123" /></label> : null}
        {type === 'spec' ? <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><Message id="community:spec_version_cd76c4ed" /></span><Input inputMode="numeric" pattern="[0-9]*" value={version} onChange={(event) => setVersion(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="1" /></label> : null}
        <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="community:the_server_resolves_the_live_title_and_state_if__cf33d33a" /></p>
        {error ? <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="neutral" ink="neutral" onClick={dialog.close}><Message id="community:cancel_19766ed6" /></Button><Button type="button" disabled={!canAttach} onClick={attach}><Message id="community:attach_item_dcd3fcd1" /></Button></div>
      </DialogCard>
    </DialogRoot>
  );
}
