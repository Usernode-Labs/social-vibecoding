import { useEffect, useRef, useSyncExternalStore } from 'react';

import * as api from './api';
import { WORK_CHANGED_EVENT } from './bot-shared';
import { handleEvent } from './store';
import type { HomeroomBotActivity } from './types';

/*
 * #3736: the state of the activity cards in the Homeroom bot's DM
 * (./bot-activity.tsx draws them), kept in one place for every card.
 *
 * A card's state is read, never pushed: the server reads every card of the
 * viewer's from the bot's records in one go (services/homeroom-bot-
 * activity.js), and this keeps that one read for the whole transcript. It
 * reads again when the bot's news lands in the DM (the newest bot message
 * changes, which is also how a new card arrives), when the loop starts or
 * ends work for the viewer (`homeroom_bot_work_changed`, which
 * public/js/app.js turns into the tray's window event, as it does after a
 * socket reconnects), and, only while a card is still going and the page is
 * in view, once a minute: the one step the loop announces nothing for is the
 * plan starting after the read. Like every conversation event, none of them
 * carries data.
 *
 * Opening the DM also asks the server, once, to give a card to any of the
 * viewer's work the bot has under way without one (work begun before cards
 * existed, or looked at again after a restart): catchUpBotActivity below.
 */

/** Asked again this often while a card is going, in case a step was not announced. */
export const POLL_MS = 60 * 1000;

export interface BotActivitySnapshot {
  cards: ReadonlyMap<number, HomeroomBotActivity>;
  /** The first read has landed. */
  loaded: boolean;
  /** The last read failed (what was read before is kept). */
  failed: boolean;
}

const EMPTY: BotActivitySnapshot = { cards: new Map(), loaded: false, failed: false };
let snapshot: BotActivitySnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: BotActivitySnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getBotActivity(): BotActivitySnapshot {
  return snapshot;
}

export function useBotActivity(): BotActivitySnapshot {
  return useSyncExternalStore(subscribe, getBotActivity, () => EMPTY);
}

// Only the newest read may land: an older one finishing late is dropped.
let seq = 0;
let inFlight: Promise<void> | null = null;

/** Read every card's state again. `fresh`: past the worker's offline copy. */
export function loadBotActivity({ fresh = true }: { fresh?: boolean } = {}): Promise<void> {
  const mine = ++seq;
  const run: Promise<void> = api.getHomeroomBotActivity({ fresh }).then((cards) => {
    if (mine !== seq) return;
    publish({ cards: new Map(cards.map((card) => [card.messageId, card])), loaded: true, failed: false });
  }).catch(() => {
    if (mine === seq) publish({ ...snapshot, failed: true });
  }).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

/** A card drawn before anything was read (or anywhere the sync is not): read once. */
export function ensureBotActivity(): void {
  if (!snapshot.loaded && !snapshot.failed && !inFlight) void loadBotActivity({ fresh: false });
}

/**
 * The bot's DM `conversationId` opened: work the bot has under way for the
 * viewer without a card gets one (the server sends it, at the end of the
 * DM). When one was added, the transcript and the cards read again, as the
 * bot's news arriving over the socket would make them, socket or not. A
 * failure costs nothing: the next opening asks again.
 */
export function catchUpBotActivity(conversationId: number): Promise<void> {
  return api.catchUpHomeroomBotActivity().then((added) => {
    if (!added) return;
    handleEvent({ type: 'conversation_message_created', conversationId });
    void loadBotActivity();
  }).catch(() => {});
}

/**
 * Keeps the cards in the bot's DM current (see the note at the top), for
 * BotActivitySync. `newsKey` is the newest message the bot sent there.
 */
export function useBotActivitySync(conversationId: number, newsKey: number | null): void {
  const { cards } = useBotActivity();
  const going = [...cards.values()].some((card) => card.state === 'working');
  // The newest bot message already accounted for: the first one the
  // transcript draws is what was there when the read below was made.
  const seenNews = useRef<number | null>(null);

  // Another conversation reads afresh, and opening it gives work already
  // under way the cards it is missing.
  useEffect(() => {
    seenNews.current = null;
    void loadBotActivity({ fresh: false });
    void catchUpBotActivity(conversationId);
  }, [conversationId]);

  // The bot's news here moves its work on, and a new card is news.
  useEffect(() => {
    if (newsKey === null || seenNews.current === newsKey) return;
    const first = seenNews.current === null;
    seenNews.current = newsKey;
    if (!first) void loadBotActivity();
  }, [newsKey]);

  useEffect(() => {
    const changed = () => { void loadBotActivity(); };
    window.addEventListener(WORK_CHANGED_EVENT, changed);
    return () => window.removeEventListener(WORK_CHANGED_EVENT, changed);
  }, []);

  useEffect(() => {
    if (!going) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadBotActivity();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [going]);
}
