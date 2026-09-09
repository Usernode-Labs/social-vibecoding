/**
 * The home screen's two small hosts, as view models: the iOS widget-editing
 * strip above the launcher grid, and the "Show all N apps" button below it.
 *
 * ── Why these are a second store, not part of grid-store ──────────────
 *
 * They are different HOSTS. `#app-list` is the launcher canvas that the drag
 * gesture physically reorders, and `gridStore` is deliberately never pushed
 * mid-drag (see its header). These two sit outside it — that is the whole
 * reason they were moved out of the grid in the first place — and they are
 * repainted on exactly the same `Home.render()` pass. Folding them into the
 * grid model would tie their paint to a guard that is about the canvas.
 *
 * Same discipline as gridStore otherwise: plain serialisable data, no React
 * import, and an initial value that renders the empty markup the hand-written
 * shell shipped, so hydration cannot mismatch.
 */

import { createStore } from '../../lib/plain-store.js';

import type { IconView } from './grid-store';

/**
 * One pinned shortcut on the device, as the strip draws it. `slug` is null
 * for an entry another dapp pinned — those show up too, with a letter icon
 * and no SV app behind them, and are just as removable and reorderable.
 */
export interface WidgetTileView {
  id: string;
  slug: string | null;
  name: string;
  icon: IconView;
}

export interface WidgetStripState {
  /**
   * `Home._widgetUiActive()` — the section is revealed, the device pins
   * through the WIDGET mechanism, and the registry has been fetched. False
   * everywhere but the iOS app, which is why the host ships hidden.
   */
  active: boolean;
  helpVisible: boolean;
  tiles: WidgetTileView[];
}

export interface HomeChromeState {
  /** 0 hides "Show all N apps"; otherwise the count it names. */
  moreCount: number;
  strip: WidgetStripState;
}

export const INITIAL_CHROME: HomeChromeState = {
  moreCount: 0,
  strip: { active: false, helpVisible: false, tiles: [] },
};

export const chromeStore = createStore<HomeChromeState>(INITIAL_CHROME);

if (typeof window !== 'undefined') {
  (window as unknown as { HomeChromeStore?: unknown }).HomeChromeStore = chromeStore;
}
