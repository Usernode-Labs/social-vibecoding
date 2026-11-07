'use strict';

import { useEffect, useMemo, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Search or jump (#6454) — the control room's command palette.
//
// ⌘K / Ctrl+K anywhere in the open console, or the band's "Search or jump…"
// button, opens a dialog listing the sections the viewer may see
// (AdminConsole._visibleSections(), handed in by AdminConsole.openPalette), so
// public mode lists only Health & status and Node & chain. Typing filters by
// label, by group and by the synonyms below; arrow keys move, Enter opens,
// Escape (or a press on the backdrop) closes, and focus goes back to wherever
// it was before the dialog opened.
//
// Opening a section goes through the chassis (AdminConsole.jumpTo: setSection
// on a desktop, the phone's drill-in otherwise), never through a hash write of
// its own. The dialog renders into #admin-palette-host, an empty static host
// in the console's chassis, through the same portal seam the sections use;
// close() unmounts it. The key listener belongs to the chassis, which binds it
// in open() and removes it in close().
//
// The console's text stays in code (frontend/locales/README.md lists it).

export interface PaletteSection { key: string; label: string; group: string }

// Words people reach for that are not in a section's label. Lower case; a
// query matches when it is the start of any of these words.
export const SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  overview: ['dashboard', 'home', 'stuck', 'orphan', 'attention'],
  status: ['health', 'workers', 'uptime', 'docker', 'load'],
  node: ['chain', 'blocks', 'explorer'],
  incidents: ['errors', 'exceptions', 'unexpected', 'bugs'],
  push: ['notifications', 'apns', 'fcm'],
  merges: ['pull requests', 'pr', 'deploy'],
  rollover: ['containers', 'restart'],
  'staging-reap': ['previews', 'staging', 'cleanup'],
  reports: ['reports', 'abuse', 'flags', 'moderation'],
  users: ['accounts', 'people', 'roles', 'quota'],
  limits: ['caps', 'quota', 'credit'],
  codes: ['invites', 'activation'],
  'model-costs': ['spend', 'llm', 'budget', 'cost', 'tokens', 'pricing'],
  mail: ['email', 'mail', 'bounce', 'bounces', 'smtp', 'delivery'],
  'email-templates': ['email', 'templates'],
  sms: ['text', 'phone'],
  'db-export': ['backup', 'dump', 'database', 'export'],
  analytics: ['charts', 'metrics', 'mau'],
  apps: ['projects', 'apps', 'usage'],
  'sql-console': ['sql', 'query', 'database'],
  'sign-in': ['login', 'oauth', 'apple', 'google'],
  'homeroom-bot': ['bot', 'mayor', 'benchmark'],
});

/** The sections that match `query`, best first: label starts, then words, then synonyms. */
export function matchSections(sections: PaletteSection[], query: string): PaletteSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  const scored: Array<{ s: PaletteSection; score: number; i: number }> = [];
  sections.forEach((s, i) => {
    const label = s.label.toLowerCase();
    const words = label.split(/[^a-z0-9]+/).filter(Boolean);
    const syn = SYNONYMS[s.key] || [];
    let score = 0;
    if (label.startsWith(q)) score = 4;
    else if (words.some((w) => w.startsWith(q))) score = 3;
    else if (syn.some((w) => w.startsWith(q) || w.split(' ').some((p) => p.startsWith(q)))) score = 2;
    else if (label.includes(q) || s.group.toLowerCase().startsWith(q)) score = 1;
    if (score) scored.push({ s, score, i });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.map((x) => x.s);
}

const OPTION = 'flex items-center justify-between gap-3 w-full text-start rounded-md px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200';
const OPTION_ACTIVE = 'flex items-center justify-between gap-3 w-full text-start rounded-md px-3 py-2 text-sm bg-violet-600 text-white';

function Palette(props: { sections: PaletteSection[]; onPick: (key: string) => void; onClose: () => void }) {
  const { sections, onPick, onClose } = props;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const results = useMemo(() => matchSections(sections, query), [sections, query]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: { key: string; preventDefault(): void }) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[active];
      if (hit) onPick(hit.key);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      id="admin-palette"
      className={AdminUI.dialogOverlay}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search or jump"
        className="w-full max-w-lg self-start mt-[12vh] bg-white dark:bg-zinc-900 rounded-2xl p-3 shadow-xl"
      >
        <input
          ref={inputRef}
          id="admin-palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="admin-palette-list"
          aria-activedescendant={results[active] ? `admin-palette-opt-${results[active].key}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search sections, or type spend, errors, backup…"
          className={AdminUI.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul ref={listRef} id="admin-palette-list" role="listbox" aria-label="Sections"
          className="mt-2 max-h-[50vh] overflow-y-auto">
          {results.map((s, i) => (
            <li
              key={s.key}
              id={`admin-palette-opt-${s.key}`}
              role="option"
              aria-selected={i === active ? 'true' : 'false'}
              data-admin-palette-option={s.key}
              className={i === active ? OPTION_ACTIVE : OPTION}
              onMouseMove={() => { if (i !== active) setActive(i); }}
              onClick={() => onPick(s.key)}
            >
              <span className="truncate">{s.label}</span>
              <span className={i === active ? 'text-xs text-white/80' : 'text-xs text-zinc-500 dark:text-zinc-400'}>{s.group}</span>
            </li>
          ))}
        </ul>
        {!results.length ? (
          <p className={`${AdminUI.muted} px-3 py-2`}>No section matches that.</p>
        ) : null}
        <p className="mt-2 flex items-center gap-2 px-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span className={AdminUI.kbd}>↑</span><span className={AdminUI.kbd}>↓</span>
          <span>to move</span>
          <span className={AdminUI.kbd}>Enter</span>
          <span>to open</span>
          <span className={AdminUI.kbd}>Esc</span>
          <span>to close</span>
        </p>
      </div>
    </div>
  );
}

let host: Element | null = null;
let returnFocus: HTMLElement | null = null;

const AdminPalette = {
  isOpen(): boolean { return !!host; },

  open(sections: PaletteSection[], onPick: (key: string) => void) {
    const el = document.getElementById('admin-palette-host');
    if (!el || host) return;
    host = el;
    returnFocus = document.activeElement as HTMLElement | null;
    const pick = (key: string) => {
      // Close first: the focus restore must not land on a control the
      // section switch is about to replace, so it goes before the jump.
      AdminPalette.close({ restoreFocus: false });
      onPick(key);
    };
    mountLegacyPortal(el, <Palette sections={sections} onPick={pick} onClose={() => AdminPalette.close()} />);
  },

  close(opts?: { restoreFocus?: boolean }) {
    if (!host) return;
    unmountLegacyPortal(host);
    host = null;
    const back = returnFocus;
    returnFocus = null;
    if (opts?.restoreFocus === false) return;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  },
};

// Published on the global, like the section modules: the chassis
// (AdminConsole.openPalette and its key listener) reaches it there, because
// this module arrives with the lazy section chunk. Guarded for the prerender.
if (typeof window !== 'undefined') (window as any).AdminPalette = AdminPalette;

export { AdminPalette };
