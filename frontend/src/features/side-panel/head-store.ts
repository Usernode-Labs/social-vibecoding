/**
 * The head a page publishes for the COLUMN it is drawn in (#6431).
 *
 * Beside the Homeroom bot page a request or a change has no room for a second
 * header: the column's own heading names it, so the page's status pill and its
 * ⋯ rows belong there too. The page is the panel's own document (./controller.ts
 * frames the platform at `?panel=1`), and its title already crosses to the top
 * document through ./embedded.ts, so the pill and the menu key ride the same
 * report: `{ kind, pill, menuKey, route }`, the last being the route the page
 * was drawn for. The panel document reports it only while that route still
 * names the page on screen.
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

import { useContext, useEffect } from 'react';

import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import { createStore } from '../../lib/plain-store.js';
import { TopicPageContext } from '../dev-board/topic/topic-store';
import type { StatusPillState } from '../dev-board/card/model';

export interface PanelHead {
  /** Which page published it: a request's page or a change's. */
  kind: 'request' | 'change';
  /** The page's own status pill, exactly as its bar draws it; none when it has no status. */
  pill: StatusPillState | null;
  /** The key the page's ⋯ carries in AppView's card menus, or null when it has none. */
  menuKey: string | null;
  /**
   * #6608: the route the page was DRAWN for, not the route at publish time.
   * The panel's document reports the head under a route only when this one is
   * that page, so a bar still mounted from the page the viewer left cannot
   * adopt the new route's heading.
   */
  route: string | null;
}

/** What a page's bar publishes: the store adds `route` from its own context. */
export type PanelHeadInput = Omit<PanelHead, 'route'>;

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
export function usePanelHead(head: PanelHeadInput): void {
  const pill = head.pill;
  // #6608: the route this page was drawn for, carried with its head.
  const { route } = useContext(TopicPageContext);
  useEffect(() => {
    if (!isEmbeddedPanel()) return undefined;
    panelHeadStore.set({ kind: head.kind, pill, menuKey: head.menuKey, route: route || null });
    return () => { panelHeadStore.set(null); };
  }, [
    head.kind, head.menuKey, route,
    pill?.key, pill?.label, pill?.tone,
    pill?.yes, pill?.no, pill?.fill,
  ]);
}
