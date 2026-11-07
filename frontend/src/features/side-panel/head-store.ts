/**
 * The head a page publishes for the COLUMN it is drawn in (#6431).
 *
 * Beside the Homeroom bot page a request or a change has no room for a second
 * header: the column's own heading names it, so the page's status pill and its
 * ⋯ rows belong there too. The page is the panel's own document (./controller.ts
 * frames the platform at `?panel=1`), and its title already crosses to the top
 * document through ./embedded.ts, so the pill and the menu key ride the same
 * report: `{ kind, pill, menuKey }`, paired with the route it was published on
 * when it is sent.
 *
 * Nothing here runs outside an embedded panel. The full page and the
 * Workshop's own side panel (`.dev-ws-side`) are the top document, where
 * `isEmbeddedPanel()` is false, so a page drawn there publishes nothing and
 * looks exactly as it did.
 *
 * The initial value is null, and a page that publishes nothing (a decision, a
 * private thread) leaves it null: the column's heading then has no pill and
 * its ⋯ shows only the two rows it always had.
 */

import { useEffect } from 'react';

import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import { createStore } from '../../lib/plain-store.js';
import type { StatusPillState } from '../dev-board/card/model';

export interface PanelHead {
  /** Which page published it: a request's page or a change's. */
  kind: 'request' | 'change';
  /** The page's own status pill, exactly as its bar draws it; none when it has no status. */
  pill: StatusPillState | null;
  /** The key the page's ⋯ carries in AppView's card menus, or null when it has none. */
  menuKey: string | null;
}

/** Null until a page publishes one; the panel document's alone. */
export const panelHeadStore = createStore<PanelHead | null>(null);

/**
 * Publish `head` for as long as the calling page is on screen. Called by the
 * page's bar (RequestBar, ChangeBar) on every render; the effect is keyed on
 * what the column actually draws, so a re-render that changes nothing does
 * not wake the top document.
 *
 * The pill's `countdown` is not a key: the top document ticks the same clock
 * (`cardNowStore`) and re-derives its label there.
 */
export function usePanelHead(head: PanelHead): void {
  const pill = head.pill;
  useEffect(() => {
    if (!isEmbeddedPanel()) return undefined;
    panelHeadStore.set({ kind: head.kind, pill, menuKey: head.menuKey });
    return () => { panelHeadStore.set(null); };
  }, [
    head.kind, head.menuKey,
    pill?.key, pill?.label, pill?.tone,
    pill?.yes, pill?.no, pill?.fill,
  ]);
}
