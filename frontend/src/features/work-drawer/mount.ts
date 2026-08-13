/**
 * The legacy → React seam for the cog drawer (#1191 slice 6, conversion 4).
 *
 * Thinner than ../notifications/mount.ts, because ./work-drawer.js imports its
 * store directly — it is already an importing module (the kit-surface seam), so
 * there is no reason to plant the dependency at runtime. All this file does is
 * install the flush and publish the controller on the bridge.
 *
 * `setFlush(flushSync)` because the legacy callers read the DOM on the line
 * after they render: show() renders the list and then hands the panel to the
 * kit, which measures its height once to seed the slide-up spring. Batched, the
 * sheet would measure the previous frame — an empty drawer.
 */

import { flushSync } from 'react-dom';

import './work-drawer.js';
import { workDrawerStore } from './work-drawer-store.js';

workDrawerStore.setFlush(flushSync);

export { workDrawerStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as {
    WorkDrawer?: Record<string, unknown>;
    UsernodeReact?: Record<string, unknown>;
  };
  const bridge = (host.UsernodeReact ||= {});
  bridge.workDrawer = host.WorkDrawer;
}
