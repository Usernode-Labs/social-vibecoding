/**
 * A thread's own rows on its page's ⋯ (31 Oct 2026, from the review of how
 * threads show): Notify me or Mute, Merge into another thread, Split one
 * out, Break it up and, on a request, Build it with your own Claude Code.
 * They sat on the page as pills and a fold, under every request and change.
 *
 * The ⋯ is the card menu (public/js/app-view.js `_cardMenuItems`), whose
 * rows are descriptors with closures, so a head publishes its rows there
 * (`AppView._setThreadCardActions`) under the ⋯'s key, one list per
 * `source`, and takes them back when it goes. The rows act through the
 * newest closures the head rendered with, so a row never acts on a state
 * the page has moved past.
 */

import { useEffect, useRef } from 'react';

export interface ThreadMenuRow {
  /** The row's words, already translated. */
  label: string;
  /** Its tooltip. */
  title?: string | null;
  /** A key of AppView.MENU_ICONS. */
  icon?: string;
  act: () => void;
}

/** The key a request's ⋯ carries, whether or not the request has rows of its own. */
export const requestMenuKey = (menuKey: string | null | undefined, number: number): string => menuKey || `request:${number}`;

/** The key a change's ⋯ carries (AppView._topicViewFor's `detail:` key). */
export const changeMenuKey = (menuKey: string | null | undefined, id: number | null): string => menuKey || (id ? `detail:proposal:${id}` : '');

export function useThreadMenu(key: string | null | undefined, source: string, rows: readonly ThreadMenuRow[]): void {
  const latest = useRef(rows);
  latest.current = rows;
  const signature = rows.map((r) => `${r.icon || ''}|${r.label}|${r.title || ''}`).join('\n');
  useEffect(() => {
    const av = typeof window !== 'undefined' ? (window as any).AppView : null;
    if (!key || !av || typeof av._setThreadCardActions !== 'function') return undefined;
    av._setThreadCardActions(key, source, latest.current.map((row, i) => ({
      label: row.label,
      title: row.title || null,
      icon: row.icon || 'default',
      act: () => latest.current[i]?.act(),
    })));
    return () => av._setThreadCardActions(key, source, []);
  }, [key, source, signature]);
}
