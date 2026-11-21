/**
 * WHICH COLUMN THE SIDE PANEL IS BESIDE THE AI PAGE (#6394, 6 Nov 2026).
 *
 * A plan, or a change's before and after, opened from a request that is
 * itself open in the side panel stands beside it: list | request | plan. The
 * middle column there is #platform-side-panel, an island of its own outside
 * #ai-screen, so the AI page cannot hand its divider the thread's settings as
 * a prop. This store is the seam: the AI page writes a slot while the column
 * shows a page and a detail stands beside it, and SidePanel reads it for its
 * own divider. With no slot the panel's edge stays what it was — Main's, or an
 * app's.
 *
 * The initial state is the prerender, so nothing differs on the first render.
 * The slot is held in an object because lib/plain-store.js merges a patch: a
 * bare null could be written once but never read back over an older object.
 */

import type { RefObject } from 'react';

import { createStore } from '../../lib/plain-store.js';
import type { LayoutProbe } from './resize';

export interface PanelEdge {
  /** The stored width this edge sets (`--ai-col-chosen-w` in three columns). */
  widthKey: string;
  /** How the edge measures its column: the list's floor and the preview. */
  probe: () => LayoutProbe;
  /** The preview, so a resize of it re-reads the bound. */
  watch: RefObject<HTMLElement | null>;
}

/**
 * The list's one-pane wiring for the panel's own edge (#6973). While a
 * request, change or decision page is the column, the divider people drag is
 * the panel's, so it is given the same hide-and-restore callbacks the thread
 * column has (#6963). Null everywhere else, so the edge keeps its width.
 */
export interface PanelSnap {
  collapsed: boolean;
  onCollapse(): void;
  onRestore(): void;
}

export const panelEdgeStore = createStore<{ slot: PanelEdge | null; snap: PanelSnap | null }>({
  slot: null,
  snap: null,
});
