/**
 * #6233: whether the build this tab loaded is older than a change it shows
 * as Live, so the change can say "Live · reload to get it" and offer Reload.
 *
 * A Homeroom release replaces its servers one at a time, and a tab keeps the
 * interface it loaded until it takes the new release. So a change can be
 * genuinely Live (every server runs it) while THIS tab still shows the
 * version before it. The server knows which merge a build contains: it
 * answers `haveThrough` for the build this tab says it has (`/api/version`
 * with `?have=<sha>`). This store compares that boundary with a change's own
 * merge order.
 *
 * The legacy `public/js/app.js` polls that endpoint, so it publishes here
 * through `window.UsernodeReact.tabBuild` (module scope below, imported by
 * main.tsx). A tab that cannot be compared (no build id, no boundary, the
 * same build as the server) is never "lacking": it shows plain Live.
 */

import { createStore } from './plain-store.js';
import { useStoreState } from './use-store-state';

export interface MergeOrder {
  /** ISO time of the merged change the build is (or a later one). */
  at: string;
  id: number;
}

export interface TabBuildState {
  /** The build this tab's document and bundle came from. */
  loadedSha: string | null;
  /** The build the server is serving now. */
  runningSha: string | null;
  /** The newest merged change the loaded build contains, when known. */
  haveThrough: MergeOrder | null;
  /** The platform's own slug, so a table listing many projects can tell it apart. */
  selfAppSlug: string | null;
}

const EMPTY: TabBuildState = { loadedSha: null, runningSha: null, haveThrough: null, selfAppSlug: null };

export const tabBuildStore = createStore(EMPTY) as {
  get(): TabBuildState;
  set(patch: Partial<TabBuildState>): void;
  subscribe(listener: () => void): () => void;
};

function orderOf(value: unknown): MergeOrder | null {
  if (!value || typeof value !== 'object') return null;
  const at = (value as { at?: unknown }).at;
  const id = Number((value as { id?: unknown }).id);
  const parsed = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) && Number.isFinite(id) ? { at: new Date(parsed).toISOString(), id } : null;
}

/**
 * Publish one `/api/version` answer. `loadedSha` is the build this tab
 * loaded (App.loadedPlatformSha), which is what `?have=` asked about.
 */
export function publish(info: any, loadedSha: string | null): void {
  if (!info || typeof info.sha !== 'string') return;
  const runningSha = info.sha !== 'dev' ? info.sha : null;
  tabBuildStore.set({
    loadedSha: loadedSha || null,
    runningSha,
    haveThrough: orderOf(info.haveThrough),
    selfAppSlug: typeof info.selfAppSlug === 'string' ? info.selfAppSlug : null,
  });
}

export interface ChangeOrder {
  /** The change is Live (`chat_sessions.live_at`). */
  liveAt: string | null | undefined;
  /** When it merged (`merged_at`); the build's boundary is compared in this order. */
  mergedAt?: string | null;
  id?: number | null;
  /** False only for a child app's change, which its own deploy makes live. */
  selfHosted?: boolean | null;
  /** The project's slug, when a list shows several projects. */
  appSlug?: string | null;
}

/** Pure: does the build this tab loaded lack `change`? */
export function tabLacks(change: ChangeOrder | null | undefined, state: TabBuildState = tabBuildStore.get()): boolean {
  if (!change || !change.liveAt || change.selfHosted === false) return false;
  const { loadedSha, runningSha, haveThrough, selfAppSlug } = state;
  // A list of many projects: only the platform's own app has this boundary.
  if (change.appSlug && selfAppSlug && change.appSlug !== selfAppSlug) return false;
  if (!loadedSha || !runningSha || loadedSha === runningSha) return false;
  if (!haveThrough) return false;
  const at = typeof change.mergedAt === 'string' ? Date.parse(change.mergedAt) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(change.id as number)) return false;
  const throughAt = Date.parse(haveThrough.at);
  return at > throughAt || (at === throughAt && Number(change.id) > haveThrough.id);
}

/** The page the reader is on has to take the running build: same as the drawer's Reload. */
export function reload(): void {
  const { runningSha } = tabBuildStore.get();
  try {
    const app = (window as any).App;
    if (!runningSha || !app || typeof app._ensureShellPrefetch !== 'function') {
      window.location.reload();
      return;
    }
    app._ensureShellPrefetch(runningSha)
      .then(() => app._reloadPrefetchedShellIfSafe(runningSha, { force: true }))
      .catch(() => window.location.reload());
  } catch {
    window.location.reload();
  }
}

/** Read the store from a component (a poll landing mid-session repaints it). */
export function useTabBuild(): TabBuildState {
  return useStoreState<TabBuildState>(tabBuildStore as any);
}

// For `public/js/**`: a classic script cannot import this bundle, and the
// version poll runs as soon as the app boots.
try {
  const host = window as any;
  host.UsernodeReact = host.UsernodeReact || {};
  host.UsernodeReact.tabBuild = {
    publish,
    tabLacks: (change: ChangeOrder) => tabLacks(change),
    get: () => tabBuildStore.get(),
    subscribe: (listener: () => void) => tabBuildStore.subscribe(listener),
    reload,
  };
} catch { /* no window (Node, the prerender pass) */ }
