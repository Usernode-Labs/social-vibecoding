/**
 * The legacy → React seam for the Improve panel.
 *
 * Same shape as ../work-drawer/mount.ts: the controller already imports its
 * store directly (it is an importing module — it needs the kit-surface seam),
 * so all this file does is install the flush and publish the controller on the
 * bridge.
 *
 * `setFlush(flushSync)` is load-bearing here for the reason it is everywhere
 * else in the shell: `Improve.open()` publishes `open: true` and then hands
 * `#improve-panel` to the kit, which measures the content's height ONCE at
 * present time to seed the sheet's slide-up spring. Batched, that measurement
 * would read the previous frame — a panel whose rows have not rendered — and
 * the sheet would spring to the wrong height.
 */

import { flushSync } from 'react-dom';

import { Improve } from './improve-controller.js';
import { improveStore } from './improve-store.js';

improveStore.setFlush(flushSync);

export { improveStore, Improve };

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.improve = Improve;
}
