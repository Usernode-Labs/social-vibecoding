import { useEffect, useRef, useSyncExternalStore } from 'react';

import * as api from './api';
import { WORK_CHANGED_EVENT, jobName, jobTitle } from './bot-shared';
import type { ConversationMessage, HomeroomBotWork } from './types';

export { WORK_CHANGED_EVENT, jobName, jobTitle };

/*
 * Where each of the viewer's requests stands: one track per request (GET
 * /api/ai/tracks, each its stored work state with what its card draws:
 * services/work-state.js, services/homeroom-bot-track.js). A request's
 * thread marks its tries from it, a private thread's bar draws it, and the
 * Messages list's line for the bot's chat counts it.
 *
 * WHEN IT READS AGAIN (5 Nov 2026: no timer). When a request's stage moves,
 * the server pushes `work_state` to everyone who may view its project, and
 * public/js/app.js turns that, `homeroom_bot_work_changed` and a socket that
 * reconnected into the window event below; the bot's news landing in its
 * chat reads it too. Every read asks the server (`fresh`), never the service
 * worker's offline copy, but the first, which is a fine first paint that the
 * worker's own late correction reads again.
 *
 * OWNERSHIP. Nothing here draws. Nothing is read until the sync's effect
 * runs, so a first render matches whatever was drawn before.
 */

// ── The store: what was read ───────────────────────────

export interface BotWorkState {
  /** Null until the first read lands. */
  work: HomeroomBotWork | null;
  /** The last read failed (what was read before is kept). */
  failed: boolean;
}

const INITIAL: BotWorkState = { work: null, failed: false };
let state: BotWorkState = INITIAL;
const listeners = new Set<() => void>();

function publish(next: Partial<BotWorkState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBotWork(): BotWorkState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

// Only the newest read may land: an older one finishing late is dropped.
let seq = 0;

/** Read the tracks again. `fresh` (every read but the first): past the worker's offline copy. */
export function loadBotWork({ fresh = true }: { fresh?: boolean } = {}): void {
  const mine = ++seq;
  api.getHomeroomBotWork({ fresh }).then((work) => {
    if (mine === seq) publish({ work, failed: false });
  }).catch(() => {
    if (mine === seq) publish({ failed: true });
  });
}

function resetBotWork(): void {
  seq += 1;
  publish(INITIAL);
}

// A burst of pushes (a vote is a few within a second) is one read.
const GATHER_MS = 400;
let gather: number | null = null;
function loadSoon(): void {
  if (typeof window === 'undefined') return;
  if (gather !== null) return;
  gather = window.setTimeout(() => { gather = null; loadBotWork(); }, GATHER_MS);
}

/** The id of the newest message the bot sent here: its news moves its work on. */
export function newestBotMessageId(messages: ConversationMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender.bot && message.id > 0) return message.id;
  }
  return null;
}

/**
 * Keeps the tracks current in a conversation with the bot (see the note at
 * the top). `newsKey` is the newest message the bot sent in this chat.
 * Renders nothing.
 */
export function BotWorkSync({ conversationId, newsKey }: { conversationId: number; newsKey: number | null }) {
  // The newest bot message already accounted for. Null until this
  // conversation's transcript has drawn one: the first value it shows is
  // what was there when the read below was made, not news.
  const seenNews = useRef<number | null>(null);

  // Another conversation reads afresh. The one ordinary read: what the
  // worker kept is a fine first paint, and its late correction reads it
  // again (store.ts resync).
  useEffect(() => {
    resetBotWork();
    seenNews.current = null;
    loadBotWork({ fresh: false });
  }, [conversationId]);

  // The bot's news here moves its work on.
  useEffect(() => {
    if (newsKey === null || seenNews.current === newsKey) return;
    const first = seenNews.current === null;
    seenNews.current = newsKey;
    if (!first) loadSoon();
  }, [newsKey]);

  useWorkChanged();
  return null;
}

/** Reads the tracks again when a request's stage moves (the window event), for as long as it is mounted. */
export function useWorkChanged(active = true): void {
  useEffect(() => {
    if (!active) return undefined;
    const changed = () => loadSoon();
    window.addEventListener(WORK_CHANGED_EVENT, changed);
    return () => window.removeEventListener(WORK_CHANGED_EVENT, changed);
  }, [active]);
}
