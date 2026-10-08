/**
 * Live reads (#4177): one place that knows what is on screen and re-reads it
 * after a gap.
 *
 * ── The gap ────────────────────────────────────────────────────────────
 *
 * The screens read their data once and then stay current from the sockets.
 * That is right only while the first read was fresh and no socket event was
 * ever missed, and four ordinary things break it, each silently:
 *
 *   - the service worker answered a slow read from an older saved copy
 *     (public/sw.js, API_TIMEOUT_MS) and later posts `api-updated` for it;
 *   - a socket dropped, and whatever was broadcast meanwhile is gone;
 *   - the server's cross-instance relay could not deliver an event and sent
 *     `resync_hint` instead (src/services/ws-bus.js);
 *   - the tab was hidden or frozen long enough to miss things.
 *
 * Recovery used to be two hand-kept lists in public/js/app.js
 * (`refreshActiveScreen`, `resyncCurrentView`), and whatever was not on them
 * stayed wrong until a reload: a proposal's Discussion opened empty in a new
 * tab and stayed empty, because the late correction reached a screen loader
 * that deliberately left the thread alone.
 *
 * ── The seam ───────────────────────────────────────────────────────────
 *
 * Whatever shows server data registers a re-read with `watch`, for as long
 * as it shows it, and says which reads it owns (`reads`, by URL). The
 * triggers all arrive here:
 *
 *   - everything is re-read when the events socket reconnects or is told to
 *     resync (App.resyncCurrentView calls `resync('reconnect')`), when the
 *     tab comes back after `AWAY_MS` hidden, and when the browser comes back
 *     online;
 *   - one read is re-read when the service worker corrects it.
 *
 * A re-read fetches with `FRESH` (`cache: 'no-cache'`): the worker then waits
 * for the network instead of answering from the copy being replaced
 * (`wantsFreshAnswer` in public/sw.js). Nothing runs while the tab is hidden;
 * what was asked for then runs when it is seen again. Triggers that arrive
 * together (a reconnect, its hint, the tab coming back) are coalesced into
 * one pass, and each watcher runs at most once per pass.
 *
 * Screens move here one at a time. Those not moved yet are still refreshed
 * by the two lists in app.js, which keep working as they did.
 *
 * Classic scripts in public/js/** reach it as window.UsernodeReact.liveReads.
 */

import { API_UPDATED_EVENT } from './service-worker';

export type ResyncReason = 'reconnect' | 'visible' | 'online' | 'correction' | 'manual';

/** What a watcher is asked to re-read: everything it shows, or these reads. */
export interface Resync {
  /** The last trigger of the pass; `reasons` has every one. */
  reason: ResyncReason;
  /** Every trigger gathered into this pass, in order. */
  reasons: ResyncReason[];
  /** Absolute URLs of the corrected reads this watcher owns; null for everything. */
  urls: string[] | null;
}

export interface WatchOptions {
  /**
   * The reads this watcher owns, so a correction to one of them reaches it.
   * Without it, the watcher hears only the everything-re-reads.
   */
  reads?: (url: URL) => boolean;
}

type Reread = (resync: Resync) => unknown;

interface Watcher {
  reread: Reread;
  reads: ((url: URL) => boolean) | null;
}

/** The fetch init a re-read uses; see the header. */
export const FRESH: RequestInit = Object.freeze({ cache: 'no-cache' as RequestCache });

/** How long triggers are gathered before one pass runs. */
export const COALESCE_MS = 250;

/**
 * Hidden at least this long counts as away. Shorter, the sockets were still
 * delivering (a hidden tab keeps them), and a re-read is not worth its cost.
 */
export const AWAY_MS = 30_000;

const watchers = new Set<Watcher>();
let pendingAll = false;
const pendingReasons = new Set<ResyncReason>();
const pendingUrls = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let hiddenSince: number | null = null;
let doc: { visibilityState?: string } | null = typeof document !== 'undefined' ? document : null;
let origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';

function isHidden(): boolean {
  try {
    return !!doc && doc.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

function absolute(url: string): string | null {
  try {
    return new URL(url, origin).href;
  } catch {
    return null;
  }
}

/**
 * Register a re-read for as long as its data is on screen. Returns the
 * function that unregisters it.
 */
export function watch(reread: Reread, options: WatchOptions = {}): () => void {
  const watcher: Watcher = { reread, reads: options.reads || null };
  watchers.add(watcher);
  return () => { watchers.delete(watcher); };
}

/**
 * Ask for a re-read: of everything on screen, or (with `url`) of the one
 * read the service worker corrected.
 */
export function resync(reason: ResyncReason, url?: string | null): void {
  if (url) {
    const href = absolute(url);
    if (!href) return;
    pendingUrls.add(href);
  } else {
    pendingAll = true;
  }
  pendingReasons.delete(reason);
  pendingReasons.add(reason);
  schedule();
}

function schedule(): void {
  // A hidden tab reads nothing; `seen` schedules the pass when it is back.
  if (isHidden() || timer) return;
  timer = setTimeout(flush, COALESCE_MS);
}

function run(watcher: Watcher, resyncArg: Resync): void {
  try {
    const out = watcher.reread(resyncArg) as { catch?: (fn: () => void) => unknown } | undefined;
    if (out && typeof out.catch === 'function') out.catch(() => {});
  } catch {
    // One screen's failed re-read must not stop the others'.
  }
}

/** Run the gathered re-reads now. Exported for tests. */
export function flush(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (isHidden()) return;
  const all = pendingAll;
  const urls = [...pendingUrls];
  const reasons: ResyncReason[] = pendingReasons.size ? [...pendingReasons] : ['manual'];
  const reason = reasons[reasons.length - 1];
  pendingAll = false;
  pendingUrls.clear();
  pendingReasons.clear();
  if (!all && !urls.length) return;
  for (const watcher of [...watchers]) {
    if (all) { run(watcher, { reason, reasons, urls: null }); continue; }
    const reads = watcher.reads;
    if (!reads) continue;
    const owned = urls.filter((href) => {
      try { return reads(new URL(href)); } catch { return false; }
    });
    if (owned.length) run(watcher, { reason, reasons, urls: owned });
  }
}

function onVisibility(): void {
  if (isHidden()) {
    if (hiddenSince == null) hiddenSince = Date.now();
    return;
  }
  const away = hiddenSince != null && Date.now() - hiddenSince >= AWAY_MS;
  hiddenSince = null;
  if (away) resync('visible');
  else schedule();
}

interface EventTargetLike {
  addEventListener(type: string, fn: (event: Event) => void): void;
}

let installed = false;

/**
 * Listen for the triggers that arrive as browser events, and publish the
 * bridge. Idempotent. Takes its window and document so tests can hand in
 * fakes; the browser installs it from the import in main.tsx.
 */
export function installLiveReads(
  win: (EventTargetLike & { UsernodeReact?: Record<string, unknown>; location?: { origin: string } }) | null
    = typeof window !== 'undefined' ? window as never : null,
  docArg: (EventTargetLike & { visibilityState?: string }) | null
    = typeof document !== 'undefined' ? document as never : null,
): void {
  if (!win || installed) return;
  installed = true;
  doc = docArg;
  if (win.location?.origin) origin = win.location.origin;
  if (isHidden()) hiddenSince = Date.now();
  docArg?.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('online', () => resync('online'));
  win.addEventListener(API_UPDATED_EVENT, (event) => {
    const url = (event as CustomEvent<{ url?: string }>).detail?.url;
    if (url) resync('correction', url);
  });
  const bridge = (win.UsernodeReact ||= {});
  bridge.liveReads = { watch, resync, FRESH };
}

/** Forget every watcher and anything pending. Tests only. */
export function _resetLiveReads(): void {
  watchers.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  pendingAll = false;
  pendingReasons.clear();
  pendingUrls.clear();
  hiddenSince = null;
  installed = false;
}

installLiveReads();
