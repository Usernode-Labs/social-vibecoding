/**
 * NEW CHAT NAMES ITSELF IN THE BAR, ON A PHONE (one look, 25 Nov 2026).
 *
 * 26 Nov 2026: New chat has a title card of its own on a phone now, as it
 * has from 768px and as a thread has, so the words it publishes for the bar
 * are the tab's own name and no second line: "(‹) Homeroom bot". The bar is
 * still borrowed for the back disc, and everything below about how it is
 * claimed and given back holds. What follows is how it was first drawn.
 *
 * The design review drew New chat on a phone as a page of its own under the
 * blue bar: the bar's white back disc, "New chat" over "Only you can see
 * it", and the bell and the Homeroom menu where they always are. The chat
 * itself starts with the bot's mark on the page's wash, with no head of its
 * own (app.css, ONE LOOK · HOMEROOM BOT AND NEW CHAT).
 *
 * The bar already draws exactly that for a conversation on Messages' drawer
 * (../nav-drawer/header-drawer.tsx, ../nav-drawer/messages-drawer.ts): the
 * back disc, a button and never an href'd arrow, so a phone's own history
 * swipe stays off while a finger pans the drawer; the name over its line,
 * moving with the drawer's depth. So the bot tab's drawer borrows it while
 * its new chat is the level in view, with the list's own name ("Homeroom
 * bot") where Messages' says "Messages", so the slide reads as this tab's:
 *
 *   level 0   Homeroom bot                      the plain bar, as before
 *   level 1   (‹) New chat                       the borrowed bar
 *                 Only you can see it
 *
 * A thread opened from the list is not New chat: it keeps the plain bar and
 * draws its own head under it, as it always has, so nothing here is drawn
 * for it.
 *
 * WHO SAYS WHAT. The words are the chat's own (../messages/new-thread.tsx
 * NewThreadPanel publishes them while it is drawn inside the bot's drawer,
 * `NewChatInBar`), so a Claude Code or ChatGPT set-up names itself as its
 * head did. Where it is and how it goes back are the page's (./index.tsx):
 * the drawer's level, its pan, and the slide back to the list.
 *
 * BORROWED, AND GIVEN BACK AS IT WAS. The drawer's store and depth are
 * Messages' own. The claim is taken only while the bot tab is the screen on
 * show, and given back only while it is still this tab's: the depth goes
 * back to what it was, so a conversation left open on Messages is named
 * there again when it is next shown. Nothing is drawn before mount: the
 * prerender is the plain bar.
 */

import { createContext, useEffect, useRef } from 'react';

import { createStore } from '../../lib/plain-store.js';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { SLIDE_MS } from '../nav-drawer/drawer-math';
import { reducedMotion } from '../nav-drawer/drawer-store';
import {
  messagesDepth, messagesDrawerStore, publishMessagesDrawer, registerMessagesBack, type MessagesDrawerState,
} from '../nav-drawer/messages-drawer';
import { navStore } from '../nav/nav-store.js';

/** What New chat's head says, said in the bar instead. */
export interface NewChatWords {
  title: string;
  sub: string;
}

/** The words of the new chat in the bot tab's drawer, while it is drawn there; null otherwise. */
export const newChatWordsStore = createStore<NewChatWords | null>(null);

export function publishNewChatWords(words: NewChatWords | null): void {
  const was = newChatWordsStore.get();
  if (was === words || (was && words && was.title === words.title && was.sub === words.sub)) return;
  newChatWordsStore.set(words);
}

/** True inside the bot tab's phone drawer, where New chat is named by the bar (./phone-drawer.tsx ThreadPane). */
export const NewChatInBar = createContext(false);

const OFF: MessagesDrawerState = { on: false, level: 0, title: '', sub: '' };

/**
 * The page's side of it (./index.tsx). `shown`: the new chat is the drawer's
 * level in view on a phone, and the tab is up. `away`: the drawer is sliding
 * back to the list from it (the words follow, then the bar is given back);
 * anything else gives it back at once. `list` and `back` are the list's name
 * and its arrow's.
 */
export function useNewChatBar({ shown, away, list, back, onBack }: {
  shown: boolean;
  away: boolean;
  list: string;
  back: string;
  onBack: () => void;
}): { pan: (depth: number | null, lands?: 0 | 1) => void } {
  const words = useStoreState(newChatWordsStore);
  // The depth the drawer's header was at before the claim, given back with it.
  const claim = useRef<{ before: number; state: MessagesDrawerState } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const ours = () => {
    const now = messagesDrawerStore.get();
    return !!claim.current && now.on && now.list === claim.current.state.list && now.title === claim.current.state.title;
  };
  const release = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const had = claim.current;
    if (!had) return;
    const mine = ours();
    // Cleared first: giving the store back notifies the watch below.
    claim.current = null;
    if (mine) {
      publishMessagesDrawer(OFF);
      messagesDepth.cut(had.before);
    }
  };
  useIsomorphicLayoutEffect(() => {
    if (shown && words) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      const state: MessagesDrawerState = { on: true, level: 1, title: words.title, sub: words.sub, list, back };
      const first = !claim.current;
      if (first) claim.current = { before: messagesDepth.live(), state };
      else claim.current!.state = state;
      // The bar arrives with the chat: from the list's name to the chat's.
      if (first) messagesDepth.cut(0);
      publishMessagesDrawer(state);
      if (first) messagesDepth.slide(1);
      return;
    }
    if (!claim.current) return;
    if (away && words) {
      // Back to the list: the words slide back to its name, then the bar is the plain one again.
      const state: MessagesDrawerState = { ...claim.current.state, level: 0 };
      claim.current.state = state;
      publishMessagesDrawer(state);
      messagesDepth.slide(0);
      if (!timer.current) timer.current = setTimeout(release, reducedMotion() ? 0 : SLIDE_MS);
      return;
    }
    release();
  }, [shown, away, words?.title, words?.sub, list, back]); // eslint-disable-line react-hooks/exhaustive-deps
  // The bar's arrow is the page's back to its list while the claim stands.
  useEffect(() => (claim.current && shown ? registerMessagesBack(() => backRef.current()) : undefined), [shown, !!words]); // eslint-disable-line react-hooks/exhaustive-deps
  // Messages publishes its own drawer when its route moves (its phone-drawer's
  // layout effect). While this tab is the screen on show and the claim
  // stands, the bar stays New chat's.
  useEffect(() => messagesDrawerStore.subscribe(() => {
    const had = claim.current;
    if (!had || ours()) return;
    if (navStore.get().screen !== 'ai-screen') return;
    publishMessagesDrawer(had.state);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Unmounted with the claim standing (the layout changed): give it back.
  useEffect(() => () => release(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    // The drawer's pan, followed by the words; let go, they settle where it lands.
    pan: (depth, lands) => {
      if (!claim.current) return;
      if (depth == null) messagesDepth.slide(lands ?? claim.current.state.level);
      else messagesDepth.set(depth);
    },
  };
}
