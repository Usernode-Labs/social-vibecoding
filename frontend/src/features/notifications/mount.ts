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
 * `_acceptInvite` re-renders the invites section before it navigates (the
 * kit sheet re-measures itself via presentSheet's ResizeObserver watch, so
 * nothing here has to ask for it). Batched, both would look at the previous
 * frame.
 *
 * `Notifications._store` is the plant that makes the controller's two render
 * methods do anything at all — see the header of ./notifications-store.js for
 * why the dependency points this way and not the other.
 */

import { flushSync } from 'react-dom';

import './notifications.js';
import { notificationsStore } from './notifications-store.js';
import { notificationsSheetStore } from './notifications-sheet-store.js';
import { NotificationsSheet } from './notifications-sheet-controller.js';

notificationsStore.setFlush(flushSync);
// The sheet's own flag needs the flush for the reason every sheet's does:
// `open()` publishes and then hands the element to the kit, which measures
// the content height once, at present time. See lib/sheet-controller.js.
notificationsSheetStore.setFlush(flushSync);

export { notificationsStore, notificationsSheetStore, NotificationsSheet };

if (typeof window !== 'undefined') {
  const host = window as unknown as {
    Notifications?: Record<string, unknown>;
    UsernodeReact?: Record<string, unknown>;
  };
  if (host.Notifications) host.Notifications._store = notificationsStore;
  const bridge = (host.UsernodeReact ||= {});
  bridge.notifications = host.Notifications;
  bridge.notificationsSheet = NotificationsSheet;
}
