/**
 * Share item (#488): the composer's + → Share item, which attaches a
 * Homeroom item to the message being written.
 *
 * #3937 replaced its two dropdowns. What to share is a row of chips, and
 * which app it is in is a list under a search box, narrowed by All / Your
 * projects / Other projects chips (the dropdown's two option groups). The
 * search and the chips combine: a row shows when it is in the chosen group
 * AND its name matches every word typed.
 *
 * The item type row has no "All". It is not a filter of the list: the type
 * IS what gets attached, and each one asks for a different number, so one is
 * always chosen, App by default as before.
 *
 * Enter in the search box does nothing: it must never attach an item the
 * person was still looking for. Attach item stays the only way to attach.
 */

import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Chip, ChipRail } from '@/components/ui/chip';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useDialog } from '../dialogs/use-dialog';
import * as api from './api';
import type { SharedObjectReference, SharedObjectType } from './types';

export interface AppChoice { id: number; slug: string; name: string; mine?: boolean }

/** Which of the apps the list holds: all of them, the viewer's own projects, or the rest. */
export type AppGroup = 'all' | 'mine' | 'others';

/**
 * What can be shared, in the order the dropdown listed it. Two labels are
 * shorter than the dropdown's ("GitHub-backed issue", "Exact spec version"),
 * so the five chips take two rows on a desktop instead of three; the field
 * each one opens still names exactly which number it wants.
 */
export const SHARE_TYPES: ReadonlyArray<{ value: SharedObjectType; label: string }> = [
  { value: 'app', label: 'App' },
  { value: 'issue', label: 'GitHub issue' },
  { value: 'proposal', label: 'Code proposal' },
  { value: 'governance', label: 'Governance proposal' },
  { value: 'spec', label: 'Spec version' },
];

/** The app list's filter chips: "All" first, then the dropdown's two option groups. */
export const APP_GROUPS: ReadonlyArray<{ value: AppGroup; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Your projects' },
  { value: 'others', label: 'Other projects' },
];

/**
 * Pure: the apps the dialog offers, the viewer's own projects first and the
 * rest after, each group in the order the server listed it.
 */
export function orderAppChoices(apps: readonly AppChoice[]): { mine: AppChoice[]; others: AppChoice[] } {
  return { mine: apps.filter((app) => app.mine), others: apps.filter((app) => !app.mine) };
}

/**
 * Pure: whether the group chips are offered. Only when there are two groups
 * to tell apart, as the dropdown only drew its option groups then.
 */
export function offersAppGroups(apps: readonly AppChoice[]): boolean {
  const { mine, others } = orderAppChoices(apps);
  return mine.length > 0 && others.length > 0;
}

/**
 * Pure: the rows the list shows, in orderAppChoices' order. A row is in the
 * chosen group, and its name (or its short name) holds every word of the
 * search, in any case and any order.
 */
export function filterAppChoices(apps: readonly AppChoice[], { query = '', group = 'all' }: { query?: string; group?: AppGroup } = {}): AppChoice[] {
  const { mine, others } = orderAppChoices(apps);
  const pool = group === 'mine' ? mine : group === 'others' ? others : [...mine, ...others];
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return pool;
  return pool.filter((app) => {
    const haystack = `${app.name} ${app.slug}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
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

// The chip primitive at its `bar` size, grown to the 44px tap target below
// `sm`, with the fields' focus ring for keyboard use. At rest it takes the
// field fill: the primitive's resting white is this card's own colour, and a
// white chip on it would read as no chip.
const CHIP_ON = 'h-11 px-4 sm:h-9 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500';
const CHIP_REST = 'h-11 px-4 sm:h-9 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700';
const chipClass = (selected: boolean) => (selected ? CHIP_ON : CHIP_REST);

// A phone scrolls a row of chips sideways, the shell's chip rail; from `sm`
// up the row wraps, since a mouse has no easy way to scroll a rail whose
// scrollbar is hidden. The 4px of padding, taken back by the margin, keeps
// the focus ring inside the rail's clip.
const RAIL = '-m-1 gap-2 p-1 sm:flex-wrap sm:overflow-x-visible';

const LEGEND = 'block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1';

/**
 * The app list's contents: the line that says it is loading or that nothing
 * matches, or one row per app. Nothing at all while the dialog is closed, so
 * the prerendered card is the same empty shell on every load. Exported for
 * the test that draws it.
 */
export function AppChoiceRows({ rows, appId, open, loading, failed, searching, onChoose }: {
  rows: readonly AppChoice[];
  appId: number | null;
  open: boolean;
  loading: boolean;
  /** The list did not load; the dialog's own alert says so. */
  failed: boolean;
  searching: boolean;
  onChoose: (id: number) => void;
}) {
  if (loading) return <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3">Loading apps…</p>;
  if (!open || failed) return null;
  if (!rows.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3">{searching ? 'No apps match your search.' : 'No apps to share from yet.'}</p>;
  }
  return (
    <>
      {rows.map((item) => {
        const selected = item.id === appId;
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={selected}
            data-share-app={item.slug}
            onClick={() => onChoose(item.id)}
            className={`w-full min-h-[44px] sm:min-h-[36px] flex items-center gap-3 rounded-lg px-2 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 ${selected ? 'bg-violet-100 dark:bg-violet-950' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'}`}
          >
            <span className="min-w-0 flex-1 text-sm font-medium truncate">{item.name}</span>
            {selected ? <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">Selected</span> : null}
          </button>
        );
      })}
    </>
  );
}

export function ShareItemDialog() {
  useUiLanguage();
  const [type, setType] = useState<SharedObjectType>('app');
  const [apps, setApps] = useState<AppChoice[]>([]);
  const [appId, setAppId] = useState<number | null>(null);
  // The app the dialog was opened from, until the list it is found in loads.
  const [wantedSlug, setWantedSlug] = useState('');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<AppGroup>('all');
  const [itemId, setItemId] = useState('');
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const dialog = useDialog<SharedObjectReference>('messagesShare', {
    onOpen: (reference) => {
      setType(reference?.type || 'app'); setAppId(prefilledAppId(apps, reference));
      setWantedSlug(reference?.appSlug || '');
      setQuery(''); setGroup('all');
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

  // Opened from an app named by its short name before the list had loaded:
  // choose it once the list is in.
  useEffect(() => {
    if (!wantedSlug || appId || !apps.length) return;
    setAppId(prefilledAppId(apps, { appSlug: wantedSlug }));
    setWantedSlug('');
  }, [apps, appId, wantedSlug]);

  // Opened on an app further down a long list: bring its row into view, the
  // way the dropdown showed the chosen app without being opened. The list
  // scrolls, never the dialog around it, and a frame later, once the card
  // the kit presents has a layout to measure.
  useEffect(() => {
    if (!dialog.isOpen || !appId || typeof requestAnimationFrame !== 'function') return;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!list || !row) return;
      const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top;
    });
    return () => cancelAnimationFrame(frame);
  }, [apps.length, appId, dialog.isOpen]);

  const app = useMemo(() => apps.find((item) => item.id === appId) || null, [appId, apps]);
  const grouped = offersAppGroups(apps);
  const shown = useMemo(() => filterAppChoices(apps, { query, group: grouped ? group : 'all' }), [apps, query, group, grouped]);
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
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
          placeholder="Search apps"
          aria-label="Search apps"
          autoComplete="off"
          enterKeyHint="search"
          className="mb-3"
        />
        <fieldset className="mb-3 min-w-0">
          <legend className={LEGEND}><Message id="community:item_type_5b71c546" /></legend>
          <ChipRail className={RAIL}>
            {SHARE_TYPES.map((option) => (
              <Chip key={option.value} size="bar" data-share-type={option.value} selected={type === option.value} className={chipClass(type === option.value)} onClick={() => { if (option.value !== type) { setType(option.value); setItemId(''); setVersion(''); } }}>{option.label}</Chip>
            ))}
          </ChipRail>
        </fieldset>
        <fieldset className="mb-3 min-w-0">
          <legend className={LEGEND}><Message id="community:app_0d04bfeb" /></legend>
          {grouped ? (
            <ChipRail role="group" aria-label="Filter apps" className={`${RAIL} mb-1`}>
              {APP_GROUPS.map((option) => (
                <Chip key={option.value} size="bar" data-share-group={option.value} selected={group === option.value} className={chipClass(group === option.value)} onClick={() => setGroup(option.value)}>{option.label}</Chip>
              ))}
            </ChipRail>
          ) : null}
          <div ref={listRef} role="listbox" aria-label="Apps" data-share-apps="" className="min-h-12 max-h-60 overflow-y-auto">
            <AppChoiceRows rows={shown} appId={appId} open={dialog.isOpen} loading={loading} failed={!!error} searching={!!query.trim()} onChoose={setAppId} />
          </div>
        </fieldset>
        {type !== 'app' ? <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><LocalizedValue render={() => (type === 'issue' ? tr("community:issue_number_b90458b6") : type === 'governance' ? tr("community:governance_proposal_id_7ba3cac6") : tr("community:proposal_session_id_3726713b"))} /></span><Input inputMode="numeric" pattern="[0-9]*" value={itemId} onChange={(event) => setItemId(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="123" /></label> : null}
        {type === 'spec' ? <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1"><Message id="community:spec_version_cd76c4ed" /></span><Input inputMode="numeric" pattern="[0-9]*" value={version} onChange={(event) => setVersion(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="1" /></label> : null}
        <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="community:the_server_resolves_the_live_title_and_state_if__cf33d33a" /></p>
        {error ? <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="neutral" ink="neutral" onClick={dialog.close}><Message id="community:cancel_19766ed6" /></Button><Button type="button" disabled={!canAttach} onClick={attach}><Message id="community:attach_item_dcd3fcd1" /></Button></div>
      </DialogCard>
    </DialogRoot>
  );
}
