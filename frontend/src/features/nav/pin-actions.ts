/**
 * Pin or unpin a community from where it is (18 Oct 2026): its row in the
 * desktop sidebar, a row of All communities, the hub's ⋯ menu. A pin is the
 * account's (./pinned-apps-store.js); this module is only the gestures
 * that reach it.
 *
 * Those rows are links, and a link's own right-click menu is the browser's
 * (Open in new tab among it). So the menu drawn in its place offers that
 * too, and it is drawn only where pins are shown at all: the sidebar of rows
 * (./sidebar-rows.ts). A phone's long press keeps whatever it did.
 */

import type { MouseEvent } from 'react';

import { t } from '../../lib/i18n/runtime';
import { navStore } from './nav-store.js';
import { pinApp, pinnedAppsStore, unpinApp } from './pinned-apps-store.js';

/** What a pin draws before anything has loaded: the community's project's name and face. */
export interface PinTarget {
  slug: string;
  name: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
}

export function isPinned(slug: string): boolean {
  return pinnedAppsStore.get().apps.some((app: { slug: string }) => app.slug === slug);
}

type Ui = {
  toast?: (text: string) => unknown;
  menu?: (opts: unknown) => unknown;
};

function ui(): Ui | undefined {
  return (window as unknown as { PlatformUI?: Ui }).PlatformUI;
}

/** Pin it, or unpin it; four already says so rather than doing nothing. */
export function togglePin(target: PinTarget): void {
  const viewer = navStore.get().viewer;
  if (isPinned(target.slug)) {
    unpinApp(target.slug, viewer);
    return;
  }
  const pinned = pinApp({
    slug: target.slug,
    name: target.name,
    iconUrl: target.iconUrl ?? null,
    iconEmoji: target.iconEmoji ?? null,
  }, viewer);
  if (!pinned) ui()?.toast?.(t('core:rail.pin.fullToast'));
}

/**
 * The right-click menu of a community's row: Pin or Unpin, and Open in new
 * tab, which the browser's own menu offered for the link this replaces.
 */
export function openPinMenu(event: MouseEvent<HTMLElement>, target: PinTarget, href: string): void {
  const kit = ui();
  if (!kit?.menu) return;
  event.preventDefault();
  kit.menu({
    anchorEl: event.currentTarget,
    title: target.name,
    items: [
      {
        label: isPinned(target.slug) ? t('core:rail.pin.unpin') : t('core:rail.pin.add'),
        handler: () => { togglePin(target); },
      },
      {
        label: t('core:rail.pin.newTab'),
        handler: () => { window.open(href, '_blank', 'noopener'); },
      },
    ],
  });
}
