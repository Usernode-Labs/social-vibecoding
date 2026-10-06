'use strict';

/**
 * #4004: "Send now" — flush the whole offline outbox immediately, over the
 * retry schedule's wait. The sent case is deliberately silent here: the
 * queue's onFlushed wiring already toasts "Your saved feedback has been
 * sent." for an automatic flush and this one alike. Only the nothing-sent
 * outcomes need words, on the result's own fields: a message the server
 * refused for good (it becomes a `failed` record this pass and comes back
 * through the dialog with the words intact), still-offline records that keep
 * their schedule, and a queue another tab emptied first.
 *
 * Its own module, deliberately IMPORT-FREE, because it is drawn into two
 * bundles: the feedback dialog's, via the controller that re-exports it, and
 * the app-context sheet's, via the mark's menu row (actions.tsx). The
 * controller cannot be imported from a .tsx module at all — its top-level
 * `./screenshot-select` import reaches a `module.exports =` file whose
 * assignment clobbers an esbuild CJS bundle's exports (the SSR tests render
 * the sheet that way and came back with screenshot-select's exports instead
 * of the sheet's) — and this module needs nothing but the globals the
 * controller and the queue publish. Resolved at call time: this runs before
 * and after `init()` has captured PlatformUI.
 */
export async function sendQueuedNow() {
  if (typeof window === 'undefined' || !window.FeedbackQueue) return;
  const res = await window.FeedbackQueue.flush('manual');
  const sent = Number(res && res.sent) || 0;
  if (sent > 0) return;
  const failed = Number(res && res.failed) || 0;
  const remaining = Number(res && res.remaining) || 0;
  if (failed > 0) {
    window.PlatformUI?.toast?.("A saved message couldn't be sent. Reopen Suggest an improvement to edit it and try again.");
  } else if (remaining > 0) {
    window.PlatformUI?.toast?.("It'll send automatically when you're back online.");
  } else {
    window.PlatformUI?.toast?.('Nothing to send.');
  }
}
