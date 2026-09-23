/**
 * The side panel's seams, installed at module scope from the browser entry
 * (main.tsx) — the same place and the same reason as ../nav/mount.ts: the
 * router in public/js/app.js calls into them from inside PlatformUI.transition
 * callbacks and from App.init's first restoreFromHash, both before any island
 * effect could have published anything.
 *
 *   window.UsernodeReact.sidePanel       the TOP document's controller
 *                                        (./controller.ts): App.openAppTab,
 *                                        the Messages store and New change
 *                                        `take` routes, App._syncPlatformTabs
 *                                        reports `appPresence`, and the panel's
 *                                        own document talks to `embedded`.
 *   window.UsernodeReact.sidePanelEmbed  the PANEL document's runtime
 *                                        (./embedded.ts), only there: the top
 *                                        document sends it `go`, and
 *                                        App.restoreFromHash asks it `forward`.
 *
 * `<html data-side-panel>` is written here too, from the store: the one
 * attribute the layout keys off (public/css/app.css). <html> is not
 * React-owned — main.tsx hydrates <body> — so it is written directly, and
 * only ever while the panel is on screen.
 */

import { flushSync } from 'react-dom';

import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import { SidePanel, installIntercepts } from './controller';
import { installEmbeddedRuntime } from './embedded';
import { sidePanelStore } from './store.js';

// The router hides the panel inside the same transition callback that takes
// the app off screen; the kit captures the outgoing page from whatever that
// callback did before it returned, so the update has to land synchronously.
sidePanelStore.setFlush(flushSync);

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.sidePanel = SidePanel;

  if (isEmbeddedPanel()) {
    const runtime = installEmbeddedRuntime(window);
    if (runtime) bridge.sidePanelEmbed = runtime;
  } else {
    installIntercepts(window);
    let flagged = false;
    sidePanelStore.subscribe(() => {
      const { open, frameSrc } = sidePanelStore.get();
      const on = !!(open && frameSrc);
      if (on === flagged) return;
      flagged = on;
      document.documentElement.toggleAttribute('data-side-panel', on);
    });
  }
}

export { sidePanelStore };
