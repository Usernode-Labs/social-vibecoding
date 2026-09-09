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
import { readShellSnapshot } from './shell-snapshot';

export function applyShellSnapshot(): void {
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

  // `target` is the whole of what decides whether #improve-btn is drawn, so
  // this is the field that makes the button appear at hydration rather than
  // after the app fetch.
  //
  // ONLY the target, and nothing else the panel renders from. The remembered
  // slug, name, icon and version would furnish a panel describing an app this
  // document has not loaded and may not be able to — and unlike the button's
  // presence, none of that is visible until someone opens the panel, by which
  // time the real target has long since landed. Restoring what is on screen is
  // the whole job here; restoring a data model is somebody else's bug.
  if (snap.improveTarget === 'platform' || snap.improveTarget === 'app') {
    improveStore.set({ target: snap.improveTarget });
  }
}
