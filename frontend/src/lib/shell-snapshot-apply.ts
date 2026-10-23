/**
 * Publish the remembered top-bar state into the stores, once, after hydration.
 *
 * Separate from ./shell-snapshot.ts on purpose. That module is pure storage
 * and is imported by two WRITERS (the header title bridge and the Improve
 * controller); this one imports the stores it fills, and is imported only by
 * the browser entry. Keeping them apart is what stops a writer pulling the
 * store graph in behind it.
 */

import { headerTitleStore } from '../features/header/header-title-store.js';
import { improveStore } from '../features/improve/improve-store.js';
import { hydrateCommunityScope } from '../features/workshop/community-scope';
import { readShellSnapshot } from './shell-snapshot';
import { isEmbeddedPanel } from './side-panel-mode';
import { readApiCacheScope } from './api-cache-identity';

/** App.SESSION_SNAPSHOT_KEY and its age limit (public/js/app.js). */
const SESSION_KEY = 'usernode.session.v1';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The username this device was last signed in as, read under the rules
 * App.readSessionSnapshot reads the same record by (a user with an id, saved
 * within 30 days), or null. Display-only, like the record itself.
 */
export function snapshotViewer(): string | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap?.cacheScope || snap.cacheScope !== readApiCacheScope(document)) return null;
    const user = snap && snap.user;
    if (!user || !user.id || typeof user.username !== 'string') return null;
    const age = Date.now() - Number(snap.savedAt || 0);
    if (!(age >= 0) || age > SESSION_MAX_AGE_MS) return null;
    return user.username.trim() || null;
  } catch {
    return null;
  }
}

/**
 * THE TAB BAR'S OWN LAST-KNOWN STATE, applied in the same task as hydration.
 *
 * The fifth tab named "Me" on every cold paint and changed a moment later:
 * the name waited for App.enterAuthed, after /api/auth/me answered. On a
 * desktop the sidebar's community rows waited for GET /api/apps, and arrived
 * 185px tall under the page.
 *
 * Both come from this device now, the moment hydration has matched the
 * prerender:
 *   - the viewer from the session snapshot, through the same bridge call
 *     App._syncViewer makes (so Recents and the pinned communities are read
 *     back for them too, and App's own call later changes nothing);
 *   - for that viewer, the list of their communities the sidebar draws its
 *     rows from (../features/workshop/community-scope.ts
 *     hydrateCommunityScope; the community the tab is on is read by the tab
 *     bar's own effect, flushed with the hydration just before this).
 *
 * Everything real still overwrites it: a session the server no longer
 * accepts ends in App.enterAnonymous, which names nobody again.
 */
export function applyNavSnapshot(): void {
  if (isEmbeddedPanel()) return;
  const viewer = snapshotViewer();
  if (viewer) {
    (window as unknown as { UsernodeReact?: { nav?: { setViewer?: (viewer: string) => void } } })
      .UsernodeReact?.nav?.setViewer?.(viewer);
  }
  hydrateCommunityScope(viewer);
}

export function applyShellSnapshot(): void {
  // The side panel's document draws no header at all, and the record is the
  // TOP window's last title — applying it there would only put the running
  // app's name into the panel's title for a moment.
  if (isEmbeddedPanel()) return;
  const snap = readShellSnapshot();
  if (!snap) return;

  // The title only when there IS one worth showing. An empty remembered title
  // would replace "dApps" with a blank chip, which is a different wrong answer
  // rather than a better one.
  if (snap.title) {
    headerTitleStore.set({ text: snap.title, subtitle: snap.subtitle });
    // Kept in step with App.setHeaderTitle, which sets both — a tab reading
    // "dApps" while the bar reads the app's name is the same mismatch one
    // level out.
    try {
      document.title = snap.subtitle ? `${snap.title} · ${snap.subtitle}` : snap.title;
    } catch {
      /* a document that will not take a title is not worth failing boot over */
    }
  }

  // `target` is the whole of what decides whether the Improve row is drawn
  // (`#app-menu-row-improve`, and `#improve-btn` in the header before #2718
  // retired it), so this is the field that makes it appear at hydration
  // rather than after the app fetch.
  //
  // ONLY the target, and nothing else the panel renders from. The remembered
  // slug, name, icon and version would furnish a panel describing an app this
  // document has not loaded and may not be able to — and unlike the row's
  // presence, none of that is visible until someone opens the panel, by which
  // time the real target has long since landed. Restoring what is on screen is
  // the whole job here; restoring a data model is somebody else's bug.
  if (snap.improveTarget === 'platform' || snap.improveTarget === 'app') {
    improveStore.set({ target: snap.improveTarget });
  }
}
