/**
 * The legacy → React seam for the Settings screen (#1191 slice 6,
 * conversion 8).
 *
 * `setFlush(flushSync)` for the same reason as the other converted screens:
 * `setSection()` calls `_renderNav()` and then `_renderContent()`, which reads
 * the DOM (`host.querySelectorAll('[data-settings-section]')`) and then calls
 * `_syncFooter()`, which reads `footer.parentElement`. Batched, the footer
 * move would measure the previous frame's column.
 *
 * Two plants, not imports, because ./settings.js is a classic IIFE with no
 * exports and tests/settings-mobile-push.test.js runs its real source through
 * `vm.runInContext` — see ./settings-nav-store.js's header.
 *
 *   * `_store` — the two nav hosts' descriptors.
 *   * `_footerHome` — the placeholder seam for `#settings-footer`, which
 *     `_syncFooter()` physically re-parents into the content column on a
 *     phone. There is no portal here and there is no kit surface either: the
 *     node just moves, and the comment left in its place keeps the slot React
 *     rendered it into open. Created lazily, on first use, because the
 *     element only exists once the island has hydrated.
 */

import { flushSync } from 'react-dom';

import { createPlaceholderHome, type PlaceholderHome } from '../../lib/kit-surface';
import './settings.js';
// First-run terms-consent trigger (issue #1297): rides in the bundle here,
// after settings.js, because it presents Settings.showTermsSheet on the
// once-per-document `sv:authed` boot signal.
import './terms-first-run.js';
import { settingsNavStore } from './settings-nav-store.js';
import { usernodeSectionStore, type UsernodeSectionState } from './sections/usernode-store';

settingsNavStore.setFlush(flushSync);

export { settingsNavStore };

/**
 * The footer's seam, resolved on first use. #settings-footer is rendered by
 * the island, so it does not exist when this module runs; the seam has to
 * outlive that first lookup, though, because the comment it plants is the
 * only record of where the node came from.
 */
function lazyFooterHome(): PlaceholderHome {
  let inner: PlaceholderHome | null = null;
  const resolve = () => {
    if (!inner) {
      const el = document.getElementById('settings-footer');
      if (el) inner = createPlaceholderHome(el, 'settings-footer-home');
    }
    return inner;
  };
  return {
    lift: () => resolve()?.lift(),
    restore: () => resolve()?.restore(),
    get lifted() {
      return resolve()?.lifted ?? false;
    },
  };
}

if (typeof window !== 'undefined') {
  const host = window as unknown as {
    Settings?: Record<string, unknown>;
    UsernodeReact?: Record<string, unknown>;
  };
  if (host.Settings) {
    host.Settings._store = settingsNavStore;
    host.Settings._footerHome = lazyFooterHome();
  }
  const bridge = (host.UsernodeReact ||= {});
  bridge.settings = host.Settings;
  // #settings-usernode-section's seam. settings.js is a 5,000-line module a
  // dozen tests load in a `vm`, so it reaches React by name rather than
  // importing — the same constraint dev-chat.js has.
  bridge.settingsUsernode = {
    publish(state: UsernodeSectionState) { usernodeSectionStore.set(state); },
  };
}
