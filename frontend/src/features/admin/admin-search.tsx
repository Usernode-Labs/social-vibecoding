'use strict';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { AdminUI } from './admin-console.js';
import { dialogShowing } from '../improve/suggest-shortcut';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Search the admin console (#6455): ⌘K / Ctrl+K, or the band's Search button,
// opens a dialog listing the queues and every section this viewer may open,
// matched by label and by the words people reach for (spend → Model costs,
// bounce → Email delivery, …). Arrow keys move, Enter opens, Escape closes and
// focus returns to where it was.
//
// The key listener is the console's, attached by AdminConsole.open() and
// removed by close() (the hooks below), so ⌘K means "your communities" again
// the moment the console is left. While the console is open it answers ⌘K
// first and prevents the default, and the communities shortcut stands down on
// `defaultPrevented` as it does for Settings' own ⌘K.
//
// The dialog renders into #admin-search-host, an empty static node the chassis
// ships (./index.tsx), mounted on open and unmounted on close.

export interface SearchEntry { kind: 'queue' | 'section'; key: string; label: string; group?: string }

/** Words people use for a section that its label does not say. */
export const SYNONYMS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  'model-costs': ['spend', 'llm', 'budget', 'cost', 'money'],
  mail: ['mail', 'email', 'bounce', 'smtp', 'delivery'],
  incidents: ['errors', 'error', 'exceptions', 'bugs'],
  reports: ['reports', 'abuse', 'flag', 'moderation'],
  'db-export': ['backup', 'dump', 'database'],
  limits: ['caps', 'quota', 'spend'],
  status: ['health', 'workers', 'uptime'],
  users: ['accounts', 'people', 'admins'],
  apps: ['projects', 'usage'],
  push: ['notifications'],
  'sign-in': ['login', 'oauth', 'apple', 'google'],
});

/** The entries a query matches, best first: a label match before a synonym's. Pure. */
export function searchMatches(entries: ReadonlyArray<SearchEntry>, query: string): SearchEntry[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries.slice();
  const scored: Array<{ e: SearchEntry; score: number; i: number }> = [];
  entries.forEach((e, i) => {
    const label = e.label.toLowerCase();
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (label.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) score = 1;
    else if (label.includes(q)) score = 2;
    else if (e.kind === 'section' && (SYNONYMS[e.key] || []).some((w) => w.startsWith(q) || q.startsWith(w))) score = 3;
    else if (e.key.includes(q)) score = 4;
    if (score >= 0) scored.push({ e, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.e);
}

/** ⌘K or Ctrl+K, with no Shift or Alt. Pure. */
export function isSearchKey(e: { key?: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; repeat?: boolean; isComposing?: boolean } | null): boolean {
  if (!e || (e.key !== 'k' && e.key !== 'K')) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  return !(e.shiftKey || e.altKey || e.repeat || e.isComposing);
}

const consoleApi = (): any => (typeof window !== 'undefined' ? (window as any).AdminConsole : null);

let returnFocus: HTMLElement | null = null;

function host(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.getElementById('admin-search-host') : null;
}

export function isSearchOpen(): boolean {
  return !!host()?.firstElementChild;
}

export function closeSearch(): void {
  const el = host();
  if (el) unmountLegacyPortal(el);
  const back = returnFocus;
  returnFocus = null;
  try { back?.focus?.(); } catch { /* the node went: nothing to return to */ }
}

function pick(entry: SearchEntry): void {
  const c = consoleApi();
  returnFocus = null;
  closeSearch();
  if (!c) return;
  if (entry.kind === 'queue') c._openQueue(entry.key);
  else c.go(entry.key);
}

export function openSearch(): void {
  const c = consoleApi();
  const el = host();
  if (!c || !c._open || !el || isSearchOpen()) return;
  returnFocus = (document.activeElement as HTMLElement | null) || null;
  mountLegacyPortal(el, <SearchDialog entries={c.searchEntries()} />);
}

function SearchDialog({ entries }: { entries: SearchEntry[] }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const matches = useMemo(() => searchMatches(entries, query), [entries, query]);
  const at = Math.min(active, Math.max(0, matches.length - 1));

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-search-index="${at}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [at]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(matches.length - 1, at + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, at - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (matches[at]) pick(matches[at]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
  };

  return (
    <div id="admin-search" className={AdminUI.dialogOverlay}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeSearch(); }}>
      <div role="dialog" aria-modal="true" aria-label="Search the admin console" className={`${AdminUI.dialogPanel} !p-3`}
        onKeyDown={onKeyDown}>
        <input ref={input} id="admin-search-input" type="search" autoComplete="off" spellCheck={false}
          placeholder="Search sections and queues" aria-label="Search sections and queues"
          role="combobox" aria-expanded="true" aria-controls="admin-search-results"
          aria-activedescendant={matches[at] ? `admin-search-opt-${at}` : undefined}
          className={AdminUI.input} value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
        <ul id="admin-search-results" ref={list} role="listbox" aria-label="Results" className="mt-2 max-h-80 overflow-y-auto">
          {matches.map((m, i) => (
            <li key={`${m.kind}:${m.key}`} id={`admin-search-opt-${i}`} role="option" aria-selected={i === at}
              data-search-index={i} data-search-entry={`${m.kind}:${m.key}`}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm cursor-pointer ${i === at
                ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-700 dark:text-zinc-300'}`}
              onMouseEnter={() => setActive(i)} onClick={() => pick(m)}>
              <span className="flex-1 min-w-0 truncate">{m.label}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{m.kind === 'queue' ? 'Queue' : m.group}</span>
            </li>
          ))}
          {!matches.length ? <li className={`${AdminUI.muted} px-3 py-2`}>Nothing matches.</li> : null}
        </ul>
      </div>
    </div>
  );
}

// The console's key listener, attached while it is open. On `document`, so it
// runs before the communities shortcut's listener on `window`.
function onKey(e: KeyboardEvent): void {
  const c = consoleApi();
  if (!c || !c._open || e.defaultPrevented || !isSearchKey(e)) return;
  if (isSearchOpen()) { e.preventDefault(); closeSearch(); return; }
  // Another dialog or sheet in front of the console keeps the key.
  if (dialogShowing(document)) return;
  e.preventDefault();
  openSearch();
}

let attached = false;

const hooks = {
  attach() {
    if (attached || typeof document === 'undefined') return;
    document.addEventListener('keydown', onKey);
    attached = true;
  },
  detach() {
    if (!attached) return;
    document.removeEventListener('keydown', onKey);
    attached = false;
    if (isSearchOpen()) { returnFocus = null; closeSearch(); }
  },
};

if (typeof window !== 'undefined') {
  const c = (window as any).AdminConsole;
  if (c) {
    c._searchHooks = hooks;
    if (c._open) hooks.attach();
  }
}

export const AdminSearch = { open: openSearch, close: closeSearch, attach: hooks.attach, detach: hooks.detach };
