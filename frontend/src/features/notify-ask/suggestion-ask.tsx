import { createStore } from '../../lib/plain-store.js';
import { useStoreState } from '../../lib/use-store-state';
import { NotifyAsk } from './notify-ask';

/*
 * The notification ask on the feedback dialog's confirmation, when Homeroom
 * bot builds what was suggested ("Your idea is underway!", B8): the moment
 * the person is waiting for "ready to try".
 *
 * The confirmation is drawn by ../dialogs/feedback-controller.js, which
 * owns every node in it by id; this is a separate React child under it that
 * the controller never writes into. It only says when the ask is wanted,
 * through this store (showSuggestionAsk on the bot's confirmation,
 * hideSuggestionAsk as it goes), and the ask decides the rest. The
 * controller reaches the two through window.UsernodeReact.notifyAsk, as it
 * reaches Messages: it imports nothing from React's side.
 */

const store = createStore({ open: false, key: 0 });

/** The bot's confirmation is up: ask, from a fresh card. */
export function showSuggestionAsk(): void {
  store.set((s: { open: boolean; key: number }) => ({ open: true, key: s.key + 1 }));
}

/** The confirmation went (another post, the dialog closed). */
export function hideSuggestionAsk(): void {
  store.set({ open: false });
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { UsernodeReact?: Record<string, unknown> };
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.notifyAsk = { showSuggestion: showSuggestionAsk, hideSuggestion: hideSuggestionAsk };
}

export function SuggestionAsk() {
  const { open, key } = useStoreState(store) as { open: boolean; key: number };
  if (!open) return null;
  return <NotifyAsk key={key} moment="suggestion" className="mb-4" />;
}
