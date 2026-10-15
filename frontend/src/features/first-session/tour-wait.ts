/**
 * The tour waits for the app (#4900). Onboarding run, 12 Oct 2026, iPhone 17:
 * the made screen let a newcomer on while their app was still being set up,
 * the tour's first card asked them to tap a tile that said "Spinning up..."
 * (a tile opens only once its app runs: home.js appView `clickable`), and its
 * second card, "<app> opens here", stood over the app's "Opening..." cover.
 * The made screen now waits for the app to run (./made.tsx), and the two
 * steps that point at the app wait for it too (TourStep.waitsFor): for a
 * made screen that let them on before it ran, and for an app that takes a
 * moment to open.
 *
 *   running  its tile on Home no longer says it is being set up: the tile's
 *            `data-status`, which App.handleAppStatusUpdate writes the moment
 *            the server says so, and which is what a tap on it reads. A
 *            setup that stopped counts as well: nothing is loading then.
 *   open     the app on its screen, past its loading states: its launch
 *            cover gone (or fading), or, with no frame, any screen of the
 *            App tab's own but "App is spinning up..." and the first
 *            version's "Opening..." check. The first version being built is
 *            the screen the card is written for (AppView._firstVersionView,
 *            `tourSays`).
 *   hub      the project's hub drawn whole: its hero with the community
 *            read (`data-ws-community`), not the skeleton or a draft of it
 *            before that read is in (../dev-board/workshop/workshop.tsx
 *            holds the skeleton until it is). A hub whose read failed draws
 *            the hero without it (`data-ws-community-pending`): that counts.
 *
 * Only what the shell already says is read here; nothing is written into it
 * (./index.tsx Tour draws the wait). It is never a dead end: Skip and Back
 * stay on the card while it waits, and after TOUR_WAIT_MAX_MS the step shows
 * as it always did.
 */

import { t as translate } from '../../lib/i18n/runtime';
import { appFrameStore } from '../app-frame/app-frame-store.js';
import { appStatusStore } from '../app-frame/app-status-store.js';
import { type AppWait, tileOf } from './tour-steps';

/** How often a waiting step looks again. */
export const WAIT_CHECK_MS = 150;

/**
 * How long a waiting step shows no card before it says it is waiting: longer
 * than an app's own reveal cap (AppView.LAUNCH_REVEAL_CAP_MS, two seconds),
 * so an app that opens as it usually does never flashes a "getting ready"
 * card before its step.
 */
export const WAIT_GRACE_MS = 2500;

/** The longest a step waits before it shows anyway. */
export const TOUR_WAIT_MAX_MS = 60000;

/** How often a step waiting on a tile asks the server, in case Home missed the news (a socket that dropped). */
export const WAIT_POLL_MS = 2000;

/** A tile's status says a tap on it does something: anything but still being set up. */
export function tileSettled(status: string | null | undefined): boolean {
  return !!status && status !== 'creating';
}

/** The parts of the App tab's frame (../app-frame/app-frame-store.js) the wait reads. */
export type FrameState = { slug: string; active: boolean; cover: { out?: boolean } | null };

/** The parts of the App tab's own screen (../app-frame/app-status.tsx AppStatusView) the wait reads. */
export type StatusView = { dot?: string | null; message?: string; action?: unknown; tourSays?: boolean } | null;

/**
 * Whether the App tab's own screen is one of its loading ones: none drawn
 * yet, "App is spinning up..." (the amber dot with no button; one waiting on
 * its secrets has Configure secrets), or the first version's check, whose
 * one line is `checking` ("Opening...", changes:appStatus.checking).
 */
export function viewLoading(view: StatusView, checking: string): boolean {
  if (!view) return true;
  if (view.tourSays) return false;
  if (view.dot === 'creating') return !view.action;
  return !view.dot && !view.action && view.message === checking;
}

/** Whether `slug`'s app has opened on its screen: its frame, uncovered, or a screen that is not loading. */
export function appOpened(slug: string, frame: FrameState, view: StatusView, checking: string): boolean {
  if (frame.slug === slug && frame.active) return !frame.cover || !!frame.cover.out;
  return !viewLoading(view, checking);
}

/** Whether what a step waits for is so now, read from the page and the App tab's stores. */
export function appReady(wait: AppWait, slug: string, doc: Pick<Document, 'querySelectorAll'> = document): boolean {
  if (wait === 'hub') {
    return doc.querySelectorAll('#app-content [data-ws-community], #app-content [data-ws-community-pending]').length > 0;
  }
  if (wait === 'running') {
    return Array.from(doc.querySelectorAll(tileOf(slug)))
      .some((el) => tileSettled(el.getAttribute('data-status')));
  }
  const { view } = appStatusStore.get() as { view: StatusView };
  return appOpened(slug, appFrameStore.get(), view, translate('changes:appStatus.checking'));
}
