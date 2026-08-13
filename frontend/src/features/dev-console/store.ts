/**
 * The in-platform developer console's receiver and ring buffer (#1079 chunk B).
 *
 * This is public/js/dev-console.js, converted. It keeps that module's exact
 * public surface — `window.DevConsole.{setCurrentApp,setButtonVisible,show,
 * hide,toggle,clear,setMode,getMode}` plus the `MODE_*` constants — because
 * app.js, app-view.js and settings.js still call it by that name.
 *
 * ── Why the store is React-free ────────────────────────────────────────
 *
 * Three reasons, all load-bearing:
 *
 *   1. It has to exist BEFORE any React effect runs. app.js line 4537 and
 *      app-view.js line 11055 call `DevConsole.setButtonVisible(...)` with no
 *      `window.DevConsole` guard, on DOMContentLoaded — which fires after the
 *      deferred React entry evaluates but does NOT wait for passive effects.
 *      So the global is installed at MODULE SCOPE (see the bottom of this
 *      file), exactly where the classic script used to define it, and the
 *      island only subscribes.
 *   2. The postMessage listener must not miss anything. It is installed at
 *      module scope too, which is strictly earlier than the old
 *      DOMContentLoaded `init()`.
 *   3. It stays requireable from node:test with no bundler and no React —
 *      tests/dev-console-invariant.test.js loads this file directly.
 *
 * The parts that stay imperative are the ones OUTSIDE the island: the header
 * button, the staging overlay's twin and their two badges live in
 * #platform-header / #staging-overlay, which no chunk has converted yet, so
 * they are still driven by getElementById + classList exactly as before.
 * Everything inside #dev-console-panel is rendered by the island from the
 * snapshot this store publishes.
 */

// The extension is load-bearing for invariant 3 above: node resolves relative
// specifiers by exact filename, so an extensionless import would break the
// direct require the test does. `allowImportingTsExtensions` in
// frontend/tsconfig.json is what lets tsc accept it. kit-surface.ts is itself
// React-free and dependency-free, so the invariant otherwise holds.
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface.ts';

export type DevConsoleLevel = 'error' | 'warn' | 'info' | 'log' | 'debug' | string;

export interface DevConsoleEntry {
  level: DevConsoleLevel;
  args: string[];
  ts: number;
  url: string;
  source?: string;
  line?: number;
  col?: number;
  kind?: string;
}

const MAX_ENTRIES = 500;

export class DevConsoleStore {
  readonly SENTINEL = '__usernodeDevConsole';

  readonly MAX_ENTRIES = MAX_ENTRIES;

  // Visibility mode. Persisted across reloads via localStorage so users don't
  // have to re-set it every session. Only flipped by the toggle in Settings
  // (settings.js) — there's no other UI for it.
  readonly MODE_KEY = 'usernode:devConsoleMode';

  readonly MODE_ERRORS_ONLY = 'errors-only';

  readonly MODE_ALWAYS = 'always';

  /** The CURRENT app's buffer. Replaced (never mutated) so React can compare. */
  entries: DevConsoleEntry[] = [];

  unseenErrors = 0;

  panelOpen = false;

  filter = 'all';

  currentAppSlug: string | null = null;

  /**
   * Tracks whether an app iframe is currently mounted (production App tab or
   * staging overlay). Set by setButtonVisible() — see the comment on that
   * method for why the public name lies a little.
   */
  iframeVisible = false;

  mode: string = this.MODE_ERRORS_ONLY;

  /** Store per-app so switching between apps preserves each app's log. */
  byApp = new Map<string, DevConsoleEntry[]>();

  /** Bumped on every change; the island's useSyncExternalStore snapshot. */
  version = 0;

  private listeners = new Set<() => void>();

  private sheet: KitAdoption | null = null;

  /** Set by the island so the touch path can present the real element. */
  private panelEl: HTMLElement | null = null;

  constructor() {
    this.mode = this.loadMode();
    // Bound once: _onMessage is handed straight to addEventListener, and the
    // legacy module's tests call it as a free function.
    this._onMessage = this._onMessage.bind(this);
    this.toggle = this.toggle.bind(this);
    this.show = this.show.bind(this);
    this.hide = this.hide.bind(this);
    this.clear = this.clear.bind(this);
  }

  // ── React seam ───────────────────────────────────────────────────────

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  };

  getSnapshot = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error('[dev-console] listener failed', err);
      }
    }
  }

  /** The island hands over its root so the touch sheet can adopt it. */
  setPanelElement(el: HTMLElement | null): void {
    this.panelEl = el;
  }

  /** Entries the panel should show, given the current filter. */
  visibleEntries(): DevConsoleEntry[] {
    if (this.filter === 'all') return this.entries;
    return this.entries.filter((e) => e.level === this.filter);
  }

  /** The `N total · N err · N warn` summary the panel header renders. */
  countsLabel(): string {
    const by: Record<string, number> = { error: 0, warn: 0, info: 0, log: 0, debug: 0 };
    for (const e of this.entries) by[e.level] = (by[e.level] || 0) + 1;
    return `${this.entries.length} total · ${by.error} err · ${by.warn} warn`;
  }

  setFilter(filter: string): void {
    if (this.filter === filter) return;
    this.filter = filter;
    this.emit();
  }

  // ── Mode (Settings' "always show" toggle) ────────────────────────────

  private loadMode(): string {
    try {
      return window.localStorage.getItem(this.MODE_KEY) === this.MODE_ALWAYS
        ? this.MODE_ALWAYS
        : this.MODE_ERRORS_ONLY;
    } catch {
      return this.MODE_ERRORS_ONLY;
    }
  }

  /**
   * Public API for Settings. Pass MODE_ERRORS_ONLY (default) or MODE_ALWAYS.
   * Anything else is normalised to errors-only — guards against truthy-string
   * bugs from older callers.
   */
  setMode(mode: string): void {
    const next = mode === this.MODE_ALWAYS ? this.MODE_ALWAYS : this.MODE_ERRORS_ONLY;
    this.mode = next;
    try {
      window.localStorage.setItem(this.MODE_KEY, next);
    } catch {
      /* private mode / storage disabled — the session-only value still applies */
    }
    this._refreshButtonVisibility();
  }

  getMode(): string {
    return this.mode;
  }

  // ── Receiving ────────────────────────────────────────────────────────

  _onMessage(event: { data?: unknown }): void {
    const data = event.data as Record<string, unknown> | null | undefined;
    if (!data || data.sentinel !== this.SENTINEL) return;

    const entry: DevConsoleEntry = {
      level: (data.level as string) || 'log',
      args: Array.isArray(data.args) ? (data.args as string[]) : [String(data.args)],
      ts: (data.ts as number) || Date.now(),
      url: (data.url as string) || '',
      source: data.source as string | undefined,
      line: data.line as number | undefined,
      col: data.col as number | undefined,
      kind: data.kind as string | undefined,
    };

    this._store(entry);

    if (entry.level === 'error' && !this.panelOpen) {
      this.unseenErrors += 1;
    }
    this._updateBadge();
    // An incoming error in errors-only mode may need to flip the icon from
    // hidden to visible. Cheap to re-evaluate on every message; the underlying
    // classList.toggle is idempotent.
    if (entry.level === 'error') this._refreshButtonVisibility();

    this.emit();
  }

  _store(entry: DevConsoleEntry): void {
    const slug = this.currentAppSlug || '_default';
    const list = [...(this.byApp.get(slug) || []), entry];
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    this.byApp.set(slug, list);
    this.entries = list;
  }

  /**
   * Swap active buffer when the user navigates between apps. The header icon's
   * visibility is driven by setButtonVisible() (iframe context) and the
   * resolved mode/error state — see _refreshButtonVisibility().
   */
  setCurrentApp(slug: string | null): void {
    if (this.currentAppSlug === slug) return;
    this.currentAppSlug = slug || null;
    this.entries = this.byApp.get(slug as string) || [];
    this.unseenErrors = 0;
    this._updateBadge();
    if (!slug) {
      this.setButtonVisible(false);
    } else {
      // Different app's error buffer -> recompute visibility. A user switching
      // from an error-laden app to a clean one should see the icon disappear
      // (in errors-only mode).
      this._refreshButtonVisibility();
    }
    this.emit();
  }

  /**
   * Signal that an app iframe is/isn't on screen. The name is a little
   * misleading — it doesn't directly toggle the button, just records the
   * iframe context. The actual icon visibility falls out of mode + error state
   * via _refreshButtonVisibility(). Public name kept for backward compat with
   * the existing callers in app.js / app-view.js.
   */
  setButtonVisible(visible: boolean): void {
    this.iframeVisible = !!visible;
    this._refreshButtonVisibility();
  }

  /**
   * Resolve final visibility from all inputs. Cheap (a couple of class toggles
   * + a small linear scan over the current app's buffer); safe to call from
   * any state-changing method.
   */
  _refreshButtonVisibility(): void {
    const inIframeContext = this.iframeVisible && !!this.currentAppSlug;
    // Errors-only mode hides the icon until the current app's buffer contains
    // at least one error. We also keep it visible while the panel itself is
    // open so the user has a stable focus point even after Clear empties the
    // buffer.
    const hasErrors = this.entries.some((e) => e.level === 'error');
    const show = inIframeContext
      && (this.mode === this.MODE_ALWAYS || hasErrors || this.panelOpen);

    // #dev-console-btn lives in #platform-header and #staging-dev-console-btn
    // in #staging-overlay. #1085 chunk H made the staging overlay an island, so
    // that one IS React-owned now — but this write stays legal, and stays
    // getElementById + classList exactly as the classic module had it, because
    // the button's rendered `className` is CONSTANT and it renders no children:
    // React never issues an attribute update that could reconcile this class
    // away. Same for the badge's text below. See the note in
    // features/staging/staging-overlay.tsx's header.
    const btn = doc()?.getElementById('dev-console-btn');
    const stagingBtn = doc()?.getElementById('staging-dev-console-btn');
    if (btn) btn.classList.toggle('hidden', !show);
    if (stagingBtn) stagingBtn.classList.toggle('hidden', !show);

    if (!show && this.panelOpen) this.hide();
  }

  _updateBadge(): void {
    const label = this.unseenErrors > 99 ? '99+' : String(this.unseenErrors);
    const show = this.unseenErrors > 0;
    for (const id of ['dev-console-badge', 'staging-dev-console-badge']) {
      const badge = doc()?.getElementById(id);
      if (!badge) continue;
      if (show) {
        badge.textContent = label;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  }

  // ── Open / close ─────────────────────────────────────────────────────

  toggle(): void {
    if (this.panelOpen) this.hide();
    else this.show();
  }

  show(): void {
    if (this.panelOpen) return;
    this.panelOpen = true;
    this.unseenErrors = 0;
    this._updateBadge();
    this._refreshButtonVisibility();
    this.emit();
  }

  hide(): void {
    if (this.sheet) {
      // The kit's dismiss animation ends in onDismiss(), which is what clears
      // panelOpen — mirroring the classic module's early return here.
      this.sheet.dismiss();
      return;
    }
    if (!this.panelOpen) return;
    this.panelOpen = false;
    // Closing the panel may take us back to the "no errors, errors-only mode"
    // state — re-evaluate so the icon disappears if appropriate.
    this._refreshButtonVisibility();
    this.emit();
  }

  clear(): void {
    const slug = this.currentAppSlug || '_default';
    this.byApp.set(slug, []);
    this.entries = this.byApp.get(slug) as DevConsoleEntry[];
    this.unseenErrors = 0;
    this._updateBadge();
    this._refreshButtonVisibility();
    this.emit();
  }

  /**
   * Touch platforms: the console rides in a draggable kit bottom sheet (it was
   * already a slide-up panel in spirit). Desktop keeps the fixed bottom panel.
   *
   * Called from the island's effect rather than from show(), so the log rows
   * are already committed to the DOM when the kit measures the sheet's height
   * to seed its slide-up spring (see the matching note in notifications.js).
   */
  presentSheetIfTouch(): void {
    const panel = this.panelEl;
    if (!panel || this.sheet) return;

    // Revealed before the adoption, not after: the kit measures the sheet's
    // height at present time and a `hidden` panel measures zero.
    panel.classList.remove('hidden');
    const sheet = adoptKitSurface({
      kind: 'sheet',
      contentEl: panel,
      home: 'body',
      gate: 'touch',
      onDismiss: () => {
        // `adoptKitSurface` has already dropped the adopted class and put the
        // panel back on <body>; `hidden` is ours, because it is what the
        // island's own visibility means.
        panel.classList.add('hidden');
        this.sheet = null;
        this.panelOpen = false;
        this._refreshButtonVisibility();
        this.emit();
      },
    });
    if (sheet) {
      this.sheet = sheet;
      return;
    }
    // The kit refused, or this is not a touch platform: back to the panel the
    // island renders. adoptKitSurface has already undone whatever it did.
    panel.classList.add('hidden');
  }

  /** True while the kit owns the panel — the island leaves `hidden` alone. */
  get sheetAdopted(): boolean {
    return this.sheet !== null;
  }
}

function doc(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

export const devConsole = new DevConsoleStore();

// Installed at module scope, not from an effect: this file is imported by
// frontend/src/main.tsx's module graph, which evaluates before
// DOMContentLoaded — the same window the classic <script> occupied. See the
// header comment.
if (typeof window !== 'undefined') {
  window.addEventListener('message', devConsole._onMessage);
  (window as unknown as { DevConsole: DevConsoleStore }).DevConsole = devConsole;
}
