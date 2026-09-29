/**
 * "Open app" — put the app an agent conversation is about on screen, with
 * the conversation docked beside it in the side panel.
 *
 * Two existing mechanisms, sequenced. In the TOP document:
 *   1. `SidePanel.pend(route)` plants `?side=agent/<id>` on the address in
 *      place — no history entry, and the router's own appPresence(true) →
 *      restoreFromAddress() reads it the moment the app is on screen and
 *      opens the panel on the conversation.
 *   2. `App.openAppTab(slug, 'app')` opens the app the way the launcher
 *      does: switchTab for the running app, navigateToApp for any other.
 * In the PANEL's own document (the chat is already docked), the App tab is
 * forwarded to the top window through the embedded runtime's openApp —
 * which is `App._forwardAppTab` there — and the chat simply stays beside
 * whatever opens. Distinguishing the two documents is
 * lib/side-panel-mode.ts's isEmbeddedPanel().
 *
 * Lifecycle is the panel's existing one: navigating from the full-screen
 * chat to the app exits this document's store (the panel document's owns
 * the live conversation); the panel survives switching to another app and
 * drops with the app. A navigation that never lands leaves the parameter
 * until drop() clears it — the same give-up restoreFromAddress already has.
 */

import { isEmbeddedPanel } from '../../lib/side-panel-mode';

/**
 * The panel route a conversation is showing: its own id, or `new` while it
 * is unsent. The same spelling agentSessionAddress writes (store.ts), inlined
 * here so this module stays free of that store's module-scope side effects —
 * its controller assigns itself onto window.UsernodeReact at import time,
 * which would overwrite whoever is driving the conversation in a test that
 * stubs it.
 */
function panelRoute(sessionId: number | 'new' | null): string {
  return `agent/${sessionId == null ? 'new' : sessionId}`;
}

/**
 * Open `slug` with the conversation docked beside it. Safe to call from
 * either document. `name` is display only (a tooltip); it takes no part in
 * the routing.
 */
export async function openFocusedApp({ slug, name: _name }: {
  slug: string;
  name?: string | null;
}): Promise<void> {
  if (typeof window === 'undefined' || !slug) return;

  // Already docked: the top window is the one to open the app in. The panel
  // stays; App._forwardAppTab replaces the running app if it is another one.
  if (isEmbeddedPanel()) {
    const embed = (window as unknown as {
      UsernodeReact?: { sidePanelEmbed?: { openApp?: (slug: string) => void } };
    }).UsernodeReact?.sidePanelEmbed;
    try { embed?.openApp?.(slug); } catch { /* the frame is going away */ }
    return;
  }

  // Top document: plant the panel page, then open the app. openAppTab
  // switches tabs for the running app and navigates for any other.
  const state = (window as unknown as {
    UsernodeReact?: {
      agentSession?: { currentId?: () => number | 'new' | null };
      sidePanel?: { pend?: (route: string) => boolean; clearPending?: () => void };
    };
  }).UsernodeReact;
  const current = state?.agentSession?.currentId?.();
  const route = panelRoute(current);
  try { state?.sidePanel?.pend?.(route); } catch { /* the write itself guards */ }

  const app = (window as unknown as {
    App?: { openAppTab?: (slug: string, tab?: string) => unknown };
  }).App;
  try {
    await app?.openAppTab?.(slug, 'app');
  } catch {
    // The app never came on screen: take the parameter back out, so the
    // address is not left naming a panel page nobody is showing. (A reload
    // while the app IS loading is restoreFromAddress's own give-up, not this.)
    state?.sidePanel?.clearPending?.();
  }
}
