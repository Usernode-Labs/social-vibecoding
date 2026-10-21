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
 * - Fix it: the dev chat's own Fix it message (../../agent-session/
 *   fix-checks.ts) sent to the change's build conversation without leaving
 *   the page. From the tap until that conversation's turn ends, the card
 *   says the change is being fixed. The turn's end is read off the
 *   conversation list, which the server's pushes keep current on every page,
 *   so nothing here polls: reading the conversation itself would mark it
 *   seen and answer the bell's "finished" row before its owner saw it.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { getLanguage, t } from '../../../lib/i18n/runtime';
import { sendTurnInBackground } from '../../agent-session/api';
import { fixChecksMessage } from '../../agent-session/fix-checks';
import { loadAgentSessions, useAgentSessions } from '../../agent-session/store';
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
 * How long after the tap the card says "Fixing" whatever the list says: the
 * conversation's turn starts at once, and the push that says so reaches the
 * list a moment later.
 */
const GRACE_MS = 20_000;
const STORAGE_KEY = 'homeroom:fix-checks-asked';

/** Change and run → when Fix it was tapped (epoch ms). */
const asked = new Map<string, number>();
try {
  const kept = typeof sessionStorage === 'undefined' ? null : JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  if (kept && typeof kept === 'object') {
    for (const [key, at] of Object.entries(kept)) if (typeof at === 'number') asked.set(key, at);
  }
} catch { /* a private window: kept for this page only */ }

function keep() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...asked].slice(-20))));
  } catch { /* a private window: kept for this page only */ }
}

const fixKey = (fix: FixChecksView) => `${fix.changeId}|${fix.at}`;

/**
 * Send the Fix it message to the change's build conversation. Resolves null
 * when it was taken, else the reason it was not ("still working", no
 * credits), in the server's own words.
 */
export async function askFix(fix: FixChecksView): Promise<string | null> {
  const message = fixChecksMessage({
    key: fixKey(fix),
    changeId: fix.changeId,
    prNumber: fix.prNumber,
    total: fix.total,
    checks: fix.checks,
  });
  const clientMessageId = `fix-${fix.changeId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    await sendTurnInBackground(fix.agentSessionId, message, clientMessageId);
  } catch (error) {
    return (error as Error)?.message || t('agent:session.error.turnRefused');
  }
  asked.set(fixKey(fix), Date.now());
  keep();
  notify();
  void loadAgentSessions();
  return null;
}

/**
 * A Fix it button's state, for the card and the Checks step alike: whether
 * it is sending, the refusal it got (null when none), and the tap.
 */
export function useFixAsk(fix: FixChecksView | null | undefined) {
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const tap = async () => {
    if (!fix || asking) return;
    setAsking(true);
    setRefused(null);
    const error = await askFix(fix);
    setAsking(false);
    setRefused(error);
  };
  return { asking, refused, tap: () => { void tap(); } };
}

/**
 * Whether the change is being fixed now: Fix it was tapped for this run, and
 * its conversation is still working (or was tapped a moment ago). A fix that
 * pushes a commit starts a new run, which ends this by itself; a turn that
 * ends without one puts the card back to the failure, with Fix it again.
 */
export function useFixing(fix: FixChecksView | null | undefined): boolean {
  const key = fix ? fixKey(fix) : '';
  const since = useSyncExternalStore(subscribe, () => (key ? asked.get(key) ?? 0 : 0), () => 0);
  const sessions = useAgentSessions();
  const [, setTick] = useState(0);
  const young = since > 0 && Date.now() - since < GRACE_MS;
  useEffect(() => {
    if (!young) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), GRACE_MS - (Date.now() - since) + 50);
    return () => clearTimeout(timer);
  }, [since, young]);
  if (!fix || !since) return false;
  if (young) return true;
  const listed = sessions.find((session) => session.id === fix.agentSessionId);
  return listed ? !!listed.busy : true;
}
