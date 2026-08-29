/**
 * #dev-console-panel — the first fully React-owned panel of #1079 chunk B.
 *
 * public/js/dev-console.js is retired by this file plus ./store.ts: the
 * receiver, the per-app ring buffer and the header-button/badge bookkeeping
 * live in the store (React-free, installed at module scope as
 * `window.DevConsole`), and everything inside the panel — the counts summary,
 * the filtered log and the empty hint — is rendered here.
 *
 * ── The three rules this island obeys ──────────────────────────────────
 *
 *  1. FIRST RENDER IS THE SHIPPED MARKUP. The panel prerenders hidden, with an
 *     empty counts span, an empty log and a hidden empty-hint — byte for byte
 *     what the hand-written shell had. Live content is gated behind `live`,
 *     which only turns on in an effect, so hydration can never disagree with
 *     the document even if a forwarded message lands between module
 *     evaluation and hydration.
 *  2. `className` IS CONSTANT. The kit's bottom sheet writes
 *     `platform-sheet-adopted` onto this very root on touch platforms, so the
 *     class string is never re-rendered; `hidden` goes through
 *     lib/legacy-dom.ts's ref-based toggle instead.
 *  3. THE BUTTONS OUTSIDE STAY LEGACY. #dev-console-btn (in #platform-header)
 *     and #staging-dev-console-btn (deep inside #staging-overlay) are not part
 *     of this island — neither region is converted — so they are bound by id
 *     from an effect, exactly where the classic module's init() bound them.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { XIcon } from '@/components/ui/icons';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { devConsole, type DevConsoleEntry } from './store';

/** How close to the bottom counts as "following the tail" (px). */
const STICK_SLACK_PX = 40;

function LogRow({ entry }: { entry: DevConsoleEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false });
  const meta = entry.source ? ` @ ${entry.source}${entry.line ? `:${entry.line}` : ''}` : '';
  return (
    <div className={`dc-log-entry dc-log-${entry.level}`}>
      <span className="dc-log-time">{time}</span>
      <span className="dc-log-level">{entry.level.toUpperCase()}</span>
      <span className="dc-log-msg">{entry.args.join(' ') + meta}</span>
    </div>
  );
}

export function DevConsolePanel() {
  const version = useSyncExternalStore(
    devConsole.subscribe,
    devConsole.getSnapshot,
    () => 0,
  );

  // Gate for everything the classic module only produced at runtime. See rule
  // 1 above: the prerendered document has none of it, so neither may the
  // hydrating render.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  const showLive = live && version > 0;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const emptyRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const open = devConsole.panelOpen;
  const entries = devConsole.visibleEntries();

  useHiddenClass(panelRef, !open);
  useHiddenClass(emptyRef, !(showLive && devConsole.entries.length === 0));

  // Hand the root to the store so the touch path can adopt it into a kit
  // sheet, and bind the two out-of-island buttons.
  useIsomorphicLayoutEffect(() => {
    devConsole.setPanelElement(panelRef.current);
    return () => devConsole.setPanelElement(null);
  }, []);

  useEffect(() => {
    // The staging overlay covers the global header (z-40) and so hides the
    // header's dev-console button. A twin inside the overlay's chrome keeps
    // the console reachable while previewing staging; same handler, separately
    // updated badge.
    const ids = ['dev-console-btn', 'staging-dev-console-btn'];
    const bound: HTMLElement[] = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('click', devConsole.toggle);
      bound.push(el);
    }
    // Apply the initial mode to both buttons in case markup ships with them
    // visible (the staging twin has no `hidden` class).
    devConsole._refreshButtonVisibility();
    return () => {
      for (const el of bound) el.removeEventListener('click', devConsole.toggle);
    };
  }, []);

  // Opening: present the kit sheet on touch. Deliberately an effect and not
  // part of store.show() — the rows have to be committed before the kit
  // measures the sheet's height to seed its slide-up spring.
  useEffect(() => {
    if (!open) return;
    devConsole.presentSheetIfTouch();
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
  }, [open]);

  // Follow the tail while the user is at the bottom, exactly like the classic
  // module's appendLogEntry did.
  useIsomorphicLayoutEffect(() => {
    const el = logRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [version]);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK_PX;
  }, []);

  return (
    <div
      ref={panelRef}
      id="dev-console-panel"
      className="hidden fixed left-0 right-0 bottom-0 z-50 flex flex-col bg-zinc-950 border-t border-zinc-700"
      style={{ height: "40vh", maxHeight: "60vh" }}
    >
      <div className="flex items-center gap-3 px-3 py-2 border-b border-zinc-800 shrink-0 text-sm">
        <span className="font-medium text-zinc-200">
          Developer console
        </span>
        <span id="dev-console-counts" className="text-xs text-zinc-500 dark:text-zinc-300">
          {showLive ? devConsole.countsLabel() : null}
        </span>
        <span className="flex-1">
        </span>
        <select
          id="dev-console-filter"
          className="text-xs bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-zinc-200"
          onChange={(e) => devConsole.setFilter(e.target.value)}
        >
          <option value="all">
            All
          </option>
          <option value="error">
            Errors
          </option>
          <option value="warn">
            Warnings
          </option>
          <option value="info">
            Info
          </option>
          <option value="log">
            Log
          </option>
          <option value="debug">
            Debug
          </option>
        </select>
        <button
          id="dev-console-clear"
          className="text-xs text-zinc-500 hover:text-zinc-200 dark:text-zinc-300"
          onClick={() => devConsole.clear()}
        >
          Clear
        </button>
        <button
          id="dev-console-close"
          className="text-zinc-500 hover:text-zinc-100 dark:text-zinc-300"
          aria-label="Close"
          onClick={() => devConsole.hide()}
        >
          <XIcon className="w-4 h-4" />
        </button>
      </div>
      <div
        ref={logRef}
        id="dev-console-log"
        className="flex-1 overflow-y-auto font-mono text-xs leading-relaxed p-2 space-y-0.5"
        onScroll={onLogScroll}
      >
        {showLive
          ? entries.map((entry, i) => <LogRow key={`${entry.ts}-${i}`} entry={entry} />)
          : null}
      </div>
      <div
        ref={emptyRef}
        id="dev-console-empty-hint"
        className="hidden px-3 py-2 text-xs text-zinc-500 border-t border-zinc-800 shrink-0 dark:text-zinc-300"
      >
        No messages yet. If this app was created before dev-console support shipped, ask the coding agent in Dev Chat to "add dev-console forwarding to public/index.html".
      </div>
    </div>
  );
}
