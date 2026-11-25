/**
 * WHERE THE CHANGE PREVIEW STANDS (Nov 2026).
 *
 * The preview used to fill whichever document opened it: the whole window,
 * or, on a wide screen, the side panel's framed copy of Homeroom, where it
 * stacked its own black bar under the panel's header. Now the TOP window
 * draws it (a Preview press in the panel's document is handed up to it,
 * AppView.ensureStaging) and places it by three rules, tried in order:
 *
 *   column   beside the thread, in the detail column (../ai/detail.ts kind
 *            `preview`), when that column gives it at least MIN_COLUMN px:
 *            the Homeroom bot tab (list | thread | preview from 1500px,
 *            thread | preview in halves below), a request's page, the
 *            Workshop.
 *   panel    the side panel's place: beside a running app, or when a column
 *            would be narrower than MIN_COLUMN. The running app beside it is
 *            marked Live.
 *   full     the whole window: a phone, a page with no column, or a change
 *            whose declared screenshots are all desktop sizes (the preview
 *            answer's `wide`), where a column would show the wrong layout.
 *
 * Full window (the header's button) covers the window from a column or a
 * panel and docks back to it; the spot stays reserved underneath.
 *
 * ── The frame never moves ──────────────────────────────────────────────
 *
 * `#staging-iframe` is one element whose identity is pinned (a reparented or
 * re-created iframe reloads, and a reload throws away what the person did in
 * the preview). So the preview is never put INTO the column or the panel: the
 * overlay that holds the frame is positioned OVER the spot. The column draws
 * an empty placeholder (`[data-preview-slot]`, ../detail/detail-pane.tsx) for
 * the layout to make room around; this module measures it, and the panel,
 * and follows them as the window or a divider moves.
 */

import { closeDetail, detailEntry, openDetail, subscribeDetail } from '../ai/detail';
import { isBesideAi } from '../side-panel/controller';
import { sidePanelStore } from '../side-panel/store.js';
import { stagingHandlers, stagingStore } from './staging-store.js';

/** The narrowest column a preview stands in; below it, it takes the panel instead. */
export const MIN_COLUMN = 400;

/** A phone: the preview always takes the whole screen. Matches the detail column's own. */
export const PHONE_QUERY = '(max-width: 767px)';

export type Placement = 'full' | 'column' | 'panel';

/**
 * The layout the address remembers beside the preview (`preview-at`, Nov
 * 2026): where it stood, and whether the person had made it Full window. It
 * rides in the preview's own query so a refresh — or a later visit to the
 * same link — comes back in the same layout.
 */
export type PreviewLayout = 'full' | 'column' | 'panel' | 'column-full' | 'panel-full';

/** Pure: a remembered layout, or null for anything not one of them. */
export function parseLayout(value: unknown): PreviewLayout | null {
  return value === 'full' || value === 'column' || value === 'panel'
    || value === 'column-full' || value === 'panel-full' ? value : null;
}

/** Pure: the layout a placement and its Full window flag name in the address. */
export function layoutOf(s: { placement: Placement; expanded: boolean }): PreviewLayout {
  if (s.placement === 'column') return s.expanded ? 'column-full' : 'column';
  if (s.placement === 'panel') return s.expanded ? 'panel-full' : 'panel';
  return 'full';
}

export interface PlacementFacts {
  /** A phone-width window. */
  phone: boolean;
  /** The change declared desktop-size screenshots only. */
  wide: boolean;
  /** The side panel is open beside a running app (not beside the bot tab's page). */
  besideApp: boolean;
  /** The side panel is open at all. */
  panelOpen: boolean;
  /** The width the detail column gave the preview, or null when the page has none. */
  columnWidth: number | null;
}

/** Pure: the rules above, in order. */
export function choosePlacement(f: PlacementFacts): Placement {
  if (f.phone || f.wide) return 'full';
  if (f.besideApp) return f.panelOpen ? 'panel' : 'full';
  if (f.columnWidth != null && f.columnWidth >= MIN_COLUMN) return 'column';
  if (f.panelOpen) return 'panel';
  return 'full';
}

export interface Rect { left: number; top: number; width: number; height: number }

function rectOf(el: Element | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) { resolve(); return; }
      requestAnimationFrame(() => step(left - 1));
    };
    step(n);
  });
}

function slotEl(): Element | null {
  return document.querySelector('[data-preview-slot]');
}

function panelEl(): Element | null {
  return document.getElementById('platform-side-panel');
}

function panelOpen(): boolean {
  const s = sidePanelStore.get() as { open?: boolean; frameSrc?: string | null };
  return !!(s.open && s.frameSrc && rectOf(panelEl()));
}

// The current placement's watchers, undone by unplacePreview.
let cleanup: Array<() => void> = [];
// Bumped by every place/unplace, so a placement still measuring when another
// begins (a second Preview press) drops its result.
let generation = 0;
// Set while this module closes the column itself, so its own close does not
// read as the person closing it.
let closingColumn = false;

function watch(target: () => Element | null, kind: Placement): void {
  const update = () => {
    const rect = rectOf(target());
    if (rect) stagingStore.set(stagingStore.get().beside ? { rect, liveSpot: liveSpot() } : { rect });
  };
  if (typeof ResizeObserver === 'function') {
    const el = target();
    if (el) {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      cleanup.push(() => ro.disconnect());
    }
  }
  window.addEventListener('resize', update);
  cleanup.push(() => window.removeEventListener('resize', update));

  if (kind === 'column') {
    // The column went away (its ×, Escape, another detail opened in its
    // place, the list's tab): the preview goes with it.
    cleanup.push(subscribeDetail(() => {
      if (closingColumn) return;
      const entry = detailEntry();
      if (!entry || entry.kind !== 'preview') stagingHandlers.onBack?.();
      else requestAnimationFrame(update);
    }));
  } else if (kind === 'panel') {
    // The panel closed or went with its app: so does the preview.
    cleanup.push(sidePanelStore.subscribe(() => {
      if (!panelOpen()) stagingHandlers.onBack?.();
      else requestAnimationFrame(update);
    }));
  }
}

export interface PlaceInput {
  /** The change's session id, for the column's own entry. */
  sessionId?: number | null;
  /**
   * The project and whether the preview is read only (20 Nov 2026), kept
   * with the column's entry so the thread it stands beside can ask for it
   * again when the person comes back to it (../ai/detail.ts reopenDetail).
   */
  slug?: string | null;
  readOnly?: boolean;
  /** The preview answer's `wide`. */
  wide?: boolean;
  /**
   * Reopened from its address (a reload, a pasted link): the page under it
   * may not have drawn its column yet, so it waits up to SETTLE_MS for one
   * before it keeps the whole window.
   */
  settle?: boolean;
  /**
   * The layout the address remembered (`preview-at`), read back on a reload.
   * A phone and a change declared for large screens still win. Otherwise
   * `full` keeps the whole window without opening a column, `panel` prefers
   * the side panel, and `column` waits for the page's column instead of
   * giving up on its first narrow measurement.
   */
  layout?: string | null;
}

/** How long a preview reopened from its address waits for the page's column. */
export const SETTLE_MS = 4000;

/**
 * Place the preview that is opening. Returns the placement chosen. The store
 * starts at `full`, so the overlay is on screen (with its loader) at once and
 * moves to its spot within a frame or two.
 */
export async function placePreview(input: PlaceInput = {}): Promise<Placement> {
  unplacePreview();
  const mine = ++generation;
  const wide = !!input.wide;
  const phone = typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
  const open = panelOpen();
  const besideApp = open && !isBesideAi();
  const addressed = parseLayout(input.layout);
  // A phone and a change declared for large screens win over the address.
  const remembered = phone || wide ? null : addressed;
  const rememberedColumn = remembered === 'column' || remembered === 'column-full';
  const rememberedPanel = remembered === 'panel' || remembered === 'panel-full';
  // A link can ask for the whole window on purpose: no column is drawn then.
  const fullOnPurpose = remembered === 'full';
  // `column-full` / `panel-full` stand Full window over the spot they dock to.
  const fullFrame = (rememberedColumn || rememberedPanel) && !!remembered && remembered.endsWith('-full');

  let columnWidth: number | null = null;
  // A panel already open is its own spot; otherwise the column is measured
  // as it always is, unless the address asked for the whole window.
  const drawColumn = !phone && !wide && !besideApp && !fullOnPurpose && !(rememberedPanel && open);
  if (drawColumn) {
    openDetail({
      kind: 'preview',
      ref: { sessionId: Number(input.sessionId) || undefined },
      version: null,
      payload: { staging: { slug: input.slug || null, readOnly: input.readOnly !== false } },
    });
    await frames(2);
    if (mine !== generation) return 'full';
    const rect = rectOf(slotEl());
    columnWidth = rect ? rect.width : null;
  }

  let placement: Placement;
  if (fullOnPurpose) placement = 'full';
  else if (rememberedPanel && open) placement = 'panel';
  else if (rememberedColumn && columnWidth != null && columnWidth >= MIN_COLUMN) placement = 'column';
  else placement = choosePlacement({ phone, wide, besideApp, panelOpen: open, columnWidth });

  // A remembered column is waited for even after a narrow first measurement:
  // on a cold load the page may still be laying it out, and giving up early
  // is what dropped a refreshed preview into the whole window. A fresh press
  // (no layout) waits exactly as it always has.
  const waitForColumn = placement !== 'column' && !phone && !wide && !besideApp
    && detailEntry()?.kind === 'preview'
    && (rememberedColumn || (!!input.settle && columnWidth == null));
  if (placement !== 'column' && !waitForColumn && detailEntry()?.kind === 'preview') closeColumn();

  const target = placement === 'column' ? slotEl : placement === 'panel' ? panelEl : null;
  const rect = target ? rectOf(target()) : null;
  const beside = placement === 'panel' && besideApp ? 'app' : null;
  stagingStore.set({
    placement: rect ? placement : 'full',
    rect,
    wide: wide && !phone,
    beside,
    liveSpot: beside ? liveSpot() : null,
    // While a remembered column is still being waited for, the preview stands
    // in the whole window or the panel's place as it always would; it is
    // expanded only once it reaches the spot the address named.
    expanded: !waitForColumn && fullFrame && !!rect && (placement === 'column' || placement === 'panel'),
    // G, J (20 Nov 2026): which change this is, for a live draft's own controls.
    sessionId: Number(input.sessionId) || null,
  });
  if (target && rect) watch(target, placement);
  if (waitForColumn) settleIntoColumn(mine, { keepNarrowSlot: rememberedColumn, fullFrame });
  // A phone always fills the screen; an address that remembered another
  // layout keeps it, so a later visit on a wide window still comes back to
  // the column it was in.
  else if (!phone || !addressed) publishLayout();
  return rect ? placement : 'full';
}

/** Write the layout the preview is now in beside its address. */
function publishLayout(): void {
  stagingHandlers.onLayout?.(layoutOf(stagingStore.get()));
}

/**
 * The preview stands in the whole window while the page that will give it a
 * column is still being drawn (a cold load): it moves into the column once
 * the column is there and wide enough, and keeps the whole window if none
 * comes within SETTLE_MS, or the column's entry is closed meanwhile.
 *
 * A layout remembered from the address (`keepNarrowSlot`) keeps waiting for a
 * narrow slot until the deadline, because on a cold load a column measured
 * before it is laid out is not the column the person had.
 */
function settleIntoColumn(mine: number, { keepNarrowSlot = false, fullFrame = false } = {}): void {
  const deadline = Date.now() + SETTLE_MS;
  const tick = () => {
    if (mine !== generation) return;
    if (detailEntry()?.kind !== 'preview') return;
    const rect = rectOf(slotEl());
    if (rect && rect.width >= MIN_COLUMN) {
      // Stop following the spot it stood in meanwhile (the panel's place).
      for (const undo of cleanup.splice(0)) {
        try { undo(); } catch { /* a watcher that is already gone */ }
      }
      stagingStore.set({ placement: 'column', rect, beside: null, liveSpot: null, expanded: fullFrame });
      watch(slotEl, 'column');
      publishLayout();
      return;
    }
    if (Date.now() >= deadline || (!keepNarrowSlot && rect)) {
      closeColumn();
      // Today's rules had already chosen where it stands; the address now
      // names that, so a later refresh asks for what it got.
      publishLayout();
      return;
    }
    setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
}

/** After the app's name in the shell's header, where the Live mark goes. */
function liveSpot(): { left: number; top: number } | null {
  const name = rectOf(document.getElementById('header-title-name'));
  return name ? { left: name.left + name.width + 10, top: Math.round(name.top + name.height / 2 - 11) } : null;
}

function closeColumn(): void {
  closingColumn = true;
  try { closeDetail(); } finally { closingColumn = false; }
}

/** The preview closed: stop following its spot and give the column back. */
export function unplacePreview(): void {
  generation += 1;
  for (const undo of cleanup.splice(0)) {
    try { undo(); } catch { /* a watcher that is already gone */ }
  }
  if (detailEntry()?.kind === 'preview') closeColumn();
}

/** Full window, or back to the column or the panel it came from. */
export function togglePreviewSize(): boolean {
  const s = stagingStore.get();
  if (s.placement === 'full') return false;
  stagingStore.set({ expanded: !s.expanded });
  // The address follows, so a refresh keeps the Dock or Full window the
  // person just chose.
  publishLayout();
  return !s.expanded;
}
