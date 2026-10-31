/**
 * #6068: Clear status, the change page's repair action for a change that
 * still says it is being worked on while nothing is running on it.
 *
 * One POST to `/api/sessions/:id/release` (the same act as the Mayor's
 * `release_change`), once, from the press. The route releases only records
 * that are already dead and refuses while anything is really running, so a
 * refusal is expected sometimes: it says what is holding the change.
 *
 * On success the page re-reads its own row (`change-detail-refresh`, the same
 * event the board and the live burst use), so the notice goes away because
 * the change is idle, not because a local flag says so. Until that read
 * lands, the hook keeps a "cleared" word on the page.
 */

import { useEffect, useState } from 'react';

/** The holder kinds the refusal can name, mapped to their catalog ids. */
export const HELD_KIND_MESSAGES: Record<string, string> = {
  operation: 'project:topic.change.stuckBusyHeld.operation',
  bot: 'project:topic.change.stuckBusyHeld.bot',
  build: 'project:topic.change.stuckBusyHeld.build',
  local_agent: 'project:topic.change.stuckBusyHeld.localAgent',
  sync: 'project:topic.change.stuckBusyHeld.sync',
  shots: 'project:topic.change.stuckBusyHeld.shots',
  turn: 'project:topic.change.stuckBusyHeld.turn',
  turn_instance: 'project:topic.change.stuckBusyHeld.turn',
};

export interface ClearStuckResult {
  asking: boolean;
  /** The kinds still holding it after a refusal; null when it did not refuse. */
  refused: string[] | null;
  /** It was released, and the page's own read has not landed yet. */
  cleared: boolean;
  tap: () => void;
}

async function release(changeId: number): Promise<{ ok: true } | { ok: false; held: string[] }> {
  try {
    const response = await fetch(`/api/sessions/${changeId}/release`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => null);
    const held = body && Array.isArray(body.stillHeld)
      ? body.stillHeld.map((h: unknown) => (h && typeof h === 'object' ? String((h as { kind?: unknown }).kind || '') : ''))
      : [];
    return { ok: false, held: held.filter(Boolean) };
  } catch {
    // A network failure says nothing about the change: show the refusal line,
    // which tells the reader to try again.
    return { ok: false, held: [] };
  }
}

/** The Clear status button's one request, and what it left behind. */
export function useClearStuck(changeId: number | null): ClearStuckResult {
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState<string[] | null>(null);
  const [cleared, setCleared] = useState(false);
  // A different change's page starts clean.
  useEffect(() => {
    setAsking(false);
    setRefused(null);
    setCleared(false);
  }, [changeId]);
  const tap = () => {
    if (!changeId || asking) return;
    setAsking(true);
    setRefused(null);
    void release(changeId).then((answer) => {
      setAsking(false);
      if (!answer.ok) {
        setRefused(answer.held);
        return;
      }
      setCleared(true);
      window.dispatchEvent(new CustomEvent('change-detail-refresh', { detail: Number(changeId) }));
    });
  };
  return { asking, refused, cleared, tap };
}
