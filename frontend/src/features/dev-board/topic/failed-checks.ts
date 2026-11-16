/**
 * A change's failed checks, said and fixed from its own page: the Testing
 * card (./change-head.tsx) and the Checks step under Details
 * (./topic-head.tsx).
 *
 * - The plain-words sentence for a failed run, read from
 *   GET /api/sessions/:id/checks-explanation (services/checks-explanation.js)
 *   once per run and language for the whole page, so the card and the step
 *   share one read. Until it answers, and when it has nothing, both show the
 *   failure's own words (app-view.js `_failureInWords`). Read in an effect:
 *   the first render is the failure's own words on the server and in the
 *   browser alike.
 * - Fix it: opens the viewer's thread with Homeroom bot about the change,
 *   where they ask it to fix what failed.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { getLanguage } from '../../../lib/i18n/runtime';
import type { ChecksExplainView, FixChecksView } from './model';

const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// ── The sentence ─────────────────────────────────────────────────────

/** Run and language → the sentence, or null once read with none. */
const explained = new Map<string, string | null>();
const reading = new Set<string>();

/** `&demo=1` on a staging ?demo=1 page, whose mock changes answer for themselves. */
function demoQS(): string {
  const av = typeof window === 'undefined' ? null : (window as any).AppView;
  return av && typeof av._demoQS === 'function' && av._demoQS() ? '&demo=1' : '';
}

function readExplanation(ex: ChecksExplainView, language: string, key: string) {
  if (explained.has(key) || reading.has(key)) return;
  reading.add(key);
  fetch(`/api/sessions/${ex.id}/checks-explanation?lang=${encodeURIComponent(language)}${demoQS()}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => {
      const text = body && typeof body.explanation === 'string' ? body.explanation.trim() : '';
      explained.set(key, text || null);
    })
    .catch(() => { explained.set(key, null); })
    .finally(() => {
      reading.delete(key);
      notify();
    });
}

/** The model's sentence for this run, or null while it is read and when there is none. */
export function useChecksExplanation(ex: ChecksExplainView | null | undefined): string | null {
  const language = getLanguage() || 'en';
  const key = ex ? `${ex.id}|${ex.at}|${language}` : '';
  const text = useSyncExternalStore(subscribe, () => (key ? explained.get(key) ?? null : null), () => null);
  useEffect(() => {
    if (ex && key) readExplanation(ex, language, key);
  }, [key]);
  return text;
}

// ── Fix it ───────────────────────────────────────────────────────────

/**
 * Fix it: the viewer's thread with Homeroom bot about the change, started or
 * found (app-view.js `askBotForChanges`), where they ask it to fix what
 * failed.
 */
export function askFix(fix: FixChecksView): void {
  (window as any).AppView?.askBotForChanges?.(fix.changeId, fix.title ?? null, fix.prNumber);
}
