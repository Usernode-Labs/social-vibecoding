'use strict';

import { mountLegacyPortal } from '../../../lib/legacy-portals';
import { ApiTesterScreen } from './api-tester.tsx';
import { AppVersionScreen } from './app-version.tsx';
import { OnchainAccountsScreen } from './onchain-accounts.tsx';
import { SettingsScreen } from './settings.tsx';
import { SqlConsoleScreen } from './sql-console.tsx';
import { WaitlistScreen } from './waitlist.tsx';

// The programme console's React screens, and the portal seam that mounts them
// (#1120 slice 24).
//
// admin-topochain.js's eleven screens are converting one at a time, so the two
// renderers have to coexist inside one module for the length of the run.
// `_renderSub` looks a screen up here first and falls through to its own
// `switch` when it is not listed, which makes each conversion a one-line
// registry entry plus a deleted `case`.
//
// Why a map of mounters rather than a map of components: admin-topochain.js is
// plain JavaScript. It can hold a reference to a component, but it cannot
// render one, and adding a JSX build step to a 4,500-line imperative file to
// convert one screen would be the tail wagging the dog. Each entry closes over
// its own JSX here instead; the module keeps `unmountLegacyPortal`, which needs
// no JSX at all.
//
// The host is genuinely single-owner, which is what makes this a legitimate
// ownership boundary: `_renderShell` recreates `#admin-topo-content` wholesale
// on every screen switch and `_renderSub` fills it once, so exactly one screen
// occupies it at a time. `_renderShell` unmounts the previous portal BEFORE the
// innerHTML that discards the node — rule 1 in lib/legacy-portals.tsx.

export const TOPO_REACT_SCREENS: Record<string, { mount(host: Element): void }> = {
  'api-tester': { mount(host) { mountLegacyPortal(host, <ApiTesterScreen />); } },
  'app-version': { mount(host) { mountLegacyPortal(host, <AppVersionScreen />); } },
  'onchain-accounts': { mount(host) { mountLegacyPortal(host, <OnchainAccountsScreen />); } },
  settings: { mount(host) { mountLegacyPortal(host, <SettingsScreen />); } },
  'sql-console': { mount(host) { mountLegacyPortal(host, <SqlConsoleScreen />); } },
  waitlist: { mount(host) { mountLegacyPortal(host, <WaitlistScreen />); } },
};
