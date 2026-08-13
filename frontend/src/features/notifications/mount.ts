/**
 * The legacy → React seam for the bell drawer (#1191 slice 6, conversion 2).
 *
 * Same job as ../profile/mount.ts, with one difference forced by the harnesses:
 * ./notifications.js exports NOTHING and imports nothing, because nine
 * `vm.runInNewContext` / `runInContext` sandboxes across
 * tests/devchat-alerts.test.js and tests/social-push-web.test.js compile its
 * real shipped source as a CLASSIC script. So this file imports it for its
 * side effect and then reaches the controller the same way app.js does — off
 * `window` — rather than by name.
 *
 * `setFlush(flushSync)` because the legacy callers read the DOM on the line
 * after they render: `_onItemClick` marks a row read and then routes, and
 * `_acceptInvite` re-renders the invites section and then asks the kit to
 * re-measure the sheet it lives in. Batched, both would look at the previous
 * frame.
 *
 * `Notifications._store` is the plant that makes the controller's two render
 * methods do anything at all — see the header of ./notifications-store.js for
 * why the dependency points this way and not the other.
 */

import { flushSync } from 'react-dom';

import './notifications.js';
import { notificationsStore } from './notifications-store.js';

notificationsStore.setFlush(flushSync);

export { notificationsStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as {
    Notifications?: Record<string, unknown>;
    UsernodeReact?: Record<string, unknown>;
  };
  if (host.Notifications) host.Notifications._store = notificationsStore;
  const bridge = (host.UsernodeReact ||= {});
  bridge.notifications = host.Notifications;
}
