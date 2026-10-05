import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Chip, ChipRail } from '@/components/ui/chip';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useDialog } from '../dialogs/use-dialog';
import * as api from './api';
import type { SharedObjectReference, SharedObjectType } from './types';

export interface AppChoice { id: number; slug: string; name: string; mine?: boolean }

/**
 * Pure: the apps the dialog offers, the viewer's own projects first and the
 * rest after, each group in the order the server listed it.
 */
export function orderAppChoices(apps: readonly AppChoice[]): { mine: AppChoice[]; others: AppChoice[] } {
  return { mine: apps.filter((app) => app.mine), others: apps.filter((app) => !app.mine) };
}

/**
 * Pure: the app the dialog opens on: the one the item it was opened with
 * names, by id or by its short name, when the viewer can see it. Null
 * otherwise, and the person chooses.
 */
export function prefilledAppId(apps: readonly AppChoice[], reference?: Pick<SharedObjectReference, 'appId' | 'appSlug'> | null): number | null {
  if (!reference) return null;
  const byId = reference.appId ? apps.find((app) => app.id === reference.appId) : null;
  if (byId) return byId.id;
  const slug = typeof reference.appSlug === 'string' ? reference.appSlug.trim() : '';
  const bySlug = slug ? apps.find((app) => app.slug === slug) : null;
  return bySlug ? bySlug.id : (reference.appId || null);
}

/**
 * Pure: the apps the search shows, in the server's order. Everything passes
 * through on an empty or whitespace-only query; otherwise the apps whose
 * name contains the query, case-insensitively.
 */
export function filterAppChoices(apps: readonly AppChoice[], query: string): AppChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...apps];
  return apps.filter((app) => app.name.toLowerCase().includes(needle));
}

/** The chip rail's one chip per item type, the short word the row carries. */
const TYPE_CHIPS: readonly { key: SharedObjectType; label: string }[] = [
  { key: 'app', label: 'App' },
  { key: 'issue', label: 'Issue' },
  { key: 'proposal', label: 'Proposal' },
  { key: 'governance', label: 'Governance' },
  { key: 'spec', label: 'Spec' },
];

/** A tappable project row; the picked one is lit, the tint Home's next-step row uses. */
function ProjectRow({ item, selected, onPick }: { item: AppChoice; selected: boolean; onPick: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(item.id)}
      aria-pressed={selected}
      data-app-id={item.id}
      className={`block w-full px-3 py-2 text-left text-sm text-zinc-900 dark:text-zinc-100 ${selected ? 'bg-[var(--lit-tint)]' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'}`}
    >
      {item.name}
    </button>
  );
}

/** One headed group of project rows: "Your projects" or "Other projects". */
function ProjectGroup({ label, apps, appId, onPick }: { label: string; apps: AppChoice[]; appId: number | null; onPick: (id: number) => void }) {
  return (
    <div>
      <p className="px-3 pb-1 pt-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      {apps.map((item) => <ProjectRow key={item.id} item={item} selected={appId === item.id} onPick={onPick} />)}
    </div>
  );
}

export function ShareItemDialog() {
  const [type, setType] = useState<SharedObjectType>('app');
  const [apps, setApps] = useState<AppChoice[]>([]);
  const [appId, setAppId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  // The app the dialog was opened from, until the list it is found in loads.
  const [wantedSlug, setWantedSlug] = useState('');
  const [itemId, setItemId] = useState('');
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialog = useDialog<SharedObjectReference>('messagesShare', {
    onOpen: (reference) => {
      setType(reference?.type || 'app'); setAppId(prefilledAppId(apps, reference));
      setWantedSlug(reference?.appSlug || '');
      setItemId(String(reference?.issueNumber || reference?.sessionId || reference?.proposalId || ''));
      setVersion(String(reference?.version || '')); setError(''); setQuery('');
    },
  });

  useEffect(() => {
    if (!dialog.isOpen || apps.length) return;
    let alive = true; setLoading(true);
    void api.listApps().then((rows) => { if (alive) setApps(rows); }).catch(() => { if (alive) setError('Couldn’t load your apps.'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apps.length, dialog.isOpen]);

  // Opened from an app named by its short name before the list had loaded:
  // choose it once the list is in.
  useEffect(() => {
    if (!wantedSlug || appId || !apps.length) return;
    setAppId(prefilledAppId(apps, { appSlug: wantedSlug }));
    setWantedSlug('');
  }, [apps, appId, wantedSlug]);

  const app = useMemo(() => apps.find((item) => item.id === appId) || null, [appId, apps]);
  const shown = useMemo(() => filterAppChoices(apps, query), [apps, query]);
  const groups = useMemo(() => orderAppChoices(shown), [shown]);
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
        <div className="flex items-center justify-between mb-4"><div><h2 className="text-lg font-bold">Share item</h2><p className="text-xs text-zinc-500 dark:text-zinc-400">Access is checked separately for every recipient.</p></div><button type="button" onClick={dialog.close} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label="Close"><XIcon className="w-5 h-5" /></button></div>
        {/*
            The type as filter chips (the language's own filter chip, the
            same idiom Discover's app list draws): the picked chip is the
            solid inversion, the rail scrolls rather than wrapping, and a
            chip change clears the id and version exactly as the dropdown
            it replaced did. `px-0 py-0` keeps the rail inside the card's
            padding; `px-4` on each chip keeps them compact like the bar
            size's other control rows.
        */}
        <div className="mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Item type</span><ChipRail role="group" aria-label="Item type" className="gap-2 px-0 py-0">{TYPE_CHIPS.map((chip) => <Chip key={chip.key} size="bar" className="px-4" selected={type === chip.key} data-type-chip={chip.key} onClick={() => { setType(chip.key); setItemId(''); setVersion(''); }}>{chip.label}</Chip>)}</ChipRail></div>
        {/*
            The project as a type-to-filter search over tappable rows, the
            viewer's own projects first. `appId` is state, so a search that
            hides the picked project does not clear it: its lit row is back
            when the search is cleared.
        */}
        <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">App</span><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" /></label>
        <div className="mb-3 max-h-56 overflow-y-auto rounded-lg border border-zinc-300 dark:border-zinc-700" role="group" aria-label="Projects">
          {loading ? <p className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">Loading apps…</p>
            : groups.mine.length || groups.others.length ? <>
              {groups.mine.length ? <ProjectGroup label="Your projects" apps={groups.mine} appId={appId} onPick={setAppId} /> : null}
              {groups.others.length ? <ProjectGroup label="Other projects" apps={groups.others} appId={appId} onPick={setAppId} /> : null}
            </>
            : <p className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">No projects match</p>}
        </div>
        {type !== 'app' ? <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">{type === 'issue' ? 'Issue number' : type === 'governance' ? 'Governance proposal ID' : 'Proposal / session ID'}</span><Input inputMode="numeric" pattern="[0-9]*" value={itemId} onChange={(event) => setItemId(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="123" /></label> : null}
        {type === 'spec' ? <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Spec version</span><Input inputMode="numeric" pattern="[0-9]*" value={version} onChange={(event) => setVersion(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="1" /></label> : null}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">The server resolves the live title and state. If access is later removed, the card becomes metadata-free and unavailable.</p>
        {error ? <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="neutral" ink="neutral" onClick={dialog.close}>Cancel</Button><Button type="button" disabled={!canAttach} onClick={attach}>Attach item</Button></div>
      </DialogCard>
    </DialogRoot>
  );
}
