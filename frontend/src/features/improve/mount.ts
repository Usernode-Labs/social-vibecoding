/**
 * The legacy → React seam for the Improve feature.
 *
 * Same shape as ../work-drawer/mount.ts: the controller already imports its
 * store directly, so all this file does is install the flush and publish the
 * controller on the bridge.
 *
 * `setFlush(flushSync)` was load-bearing for a presentation this controller
 * no longer owns: `Improve.open()` published `open: true` and then handed
 * `#improve-panel` to the kit, which measures the content's height ONCE at
 * present time to seed the sheet's slide-up spring — batched, that
 * measurement read the previous frame and the sheet sprang to the wrong
 * height. The panel retired (#2718 review) and ../app-context/ makes that
 * measurement now. It stays because the rule is not about presentation: a
 * store this shell's classic scripts write has to flush synchronously, or a
 * publish and the DOM it implies land in different frames.
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
