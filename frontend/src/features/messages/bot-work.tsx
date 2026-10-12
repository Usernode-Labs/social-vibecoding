import { useEffect, useRef, useSyncExternalStore } from 'react';

import * as api from './api';
import { POLL_MS } from './bot-activity-store';
import { WORK_CHANGED_EVENT, jobName, jobTitle } from './bot-shared';
import type { ConversationMessage, HomeroomBotWork } from './types';

export { WORK_CHANGED_EVENT, jobName, jobTitle };

/*
 * #3692: what the Homeroom bot is doing for the viewer, read from the
 * platform's records of its work for them and nobody else (services/
 * homeroom-bot-tray.js): Now, Needs you and History. One request, one
 * story: drawn as the "Your requests" strip under the chat's header
 * (./bot-strip.tsx), which replaced the Activity disc, its panel of tiles
 * and the header's long status line.
 *
 * WHEN IT READS AGAIN. The same realtime Messages already runs on: the
 * bot's news landing in this DM (a new message from it, which the store
 * reloads the thread for; the thread hands its newest id down as `newsKey`),
 * and the live loop starting or finishing work for this person, which
 * reaches every one of their tabs as `homeroom_bot_work_changed` and which
 * public/js/app.js turns into the window event below (as it does after a
 * socket reconnects). Like every conversation event, it carries no data: the
 * strip re-reads its endpoint under the viewer's own session.
 *
 * #8 (WP3): every one of those re-reads asks the server (`fresh`), never the
 * service worker's offline copy, which on a slow answer was the state from
 * before the news; the worker's own late correction (store.ts resync) reads
 * it again too; and while the bot has work in hand and the page is in view,
 * it reads again every POLL_MS, as the activity cards do, for the steps the
 * loop announces nothing for. Only opening the DM keeps the ordinary read.
 *
 * OWNERSHIP. Nothing here draws: the strip is React's, inside the thread
 * pane React already owns. Nothing is read until the sync's effect runs, so
 * a first render matches whatever was drawn before.
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

/** Read the tray again. `fresh` (every read but the DM opening): past the worker's offline copy. */
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

/** The id of the newest message the bot sent here: its news moves its work on. */
export function newestBotMessageId(messages: ConversationMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender.bot && message.id > 0) return message.id;
  }
  return null;
}

/**
 * Keeps the strip in a conversation with the bot current (see the note at
 * the top). `newsKey` is the newest message the bot sent in this DM.
 * Renders nothing.
 */
export function BotWorkSync({ conversationId, newsKey }: { conversationId: number; newsKey: number | null }) {
  const { work } = useBotWork();
  const working = !!work && work.now.length > 0;
  // The newest bot message already accounted for. Null until this
  // conversation's transcript has drawn one: the first value it shows is
  // what was there when the read below was made, not news.
  const seenNews = useRef<number | null>(null);

  // Another conversation is another strip: it reads afresh. The one
  // ordinary read: what the worker kept is a fine first paint, and its late
  // correction reads it again (store.ts resync).
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
    if (!first) loadBotWork();
  }, [newsKey]);

  useEffect(() => {
    const changed = () => loadBotWork();
    window.addEventListener(WORK_CHANGED_EVENT, changed);
    return () => window.removeEventListener(WORK_CHANGED_EVENT, changed);
  }, []);

  // #8 (WP3): while the bot has work in hand, and only while the page is in
  // view, again every POLL_MS: the plan starting after the read, a check
  // finishing, are steps nothing announces.
  useEffect(() => {
    if (!working) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') loadBotWork();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [working]);

  return null;
}
