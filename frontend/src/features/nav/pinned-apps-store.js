/**
 * The apps YOU pinned to the desktop strip, by dragging them there (#5323).
 *
 * ./recent-apps-store.js answers "what was I just using"; this one answers
 * "what did I choose to keep here". The list starts empty for everyone, and
 * the only writers are the strip itself (a drag back out unpins) and the
 * drop of a My apps tile on the strip's "Pin here" slot — Home no longer
 * publishes anything (the mirrored top row of #4935 is retired, and its
 * storage key with it).
 *
 * Same shape as the recents list: entries carry the app's display data so the
 * strip can draw before anything has loaded, and the stored list names the
 * account it was written for — a list written for anybody else reads as
 * empty, so the next person to sign in on this device is never shown the
 * previous one's apps. Pinning is per device, like recents are.
 *
 * NOTHING HERE MAY BE CALLED DURING AN INITIAL RENDER. INITIAL is empty,
 * which is what the prerendered document shows; the strip reads storage in an
 * effect. A localStorage read during a first render is a hydration mismatch.
 */

import { createStore } from '../../lib/plain-store.js';

const KEY = 'usernode_pinned_apps_v2';

// The retired #4935 key held Home's mirrored top row. Nothing from it may
// carry over — a pin is now something the viewer chose — so the first read
// clears it, best effort, and it is never read as pins.
const LEGACY_KEY = 'usernode_pinned_apps_v1';

/** Four pins, the same limit as before, so the strip keeps recents a slot. */
export const PINNED_APPS_MAX = 4;

/** @typedef {{ slug: string, name: string, iconUrl: string|null, iconEmoji: string|null }} PinnedApp */

/** @type {{ apps: PinnedApp[] }} */
const INITIAL = { apps: [] };

export const pinnedAppsStore = createStore(INITIAL);

/**
 * The strip's drag state while a My apps tile is in the air: the "Pin here"
 * slot shows what a drop would do ('idle' — dragging, 'ok' — drop pins,
 * 'already' / 'full' — the refusal words). null when nothing is being
 * dragged. Never persisted: it lives for one gesture.
 *
 * @type {{ drop: 'idle'|'ok'|'already'|'full'|null }}
 */
export const pinDropStore = createStore({ drop: null });

function clean(entry) {
  if (!entry || typeof entry.slug !== 'string' || !entry.slug) return null;
  return {
    slug: entry.slug,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.slug,
    iconUrl: typeof entry.iconUrl === 'string' ? entry.iconUrl : null,
    iconEmoji: typeof entry.iconEmoji === 'string' ? entry.iconEmoji : null,
  };
}

/**
 * The list stored for `owner`, or an empty one. Never throws.
 *
 * @param {string|null} owner  The signed-in username; null reads nothing.
 */
export function readPinnedApps(owner) {
  if (!owner) return [];
  try {
    // The mirrored top row is retired; drop it so it never reads as pins.
    try { window.localStorage.removeItem(LEGACY_KEY); } catch { /* best effort */ }
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.owner === owner && Array.isArray(parsed.apps)) {
      return parsed.apps.map(clean).filter(Boolean).slice(0, PINNED_APPS_MAX);
    }
  } catch {
    // Unreadable storage is an empty strip part, not a broken page.
  }
  return [];
}

/**
 * What a drop of `slug` would do right now, off the store's list: 'ok' to
 * append, 'already' when it is pinned, 'full' when four are.
 *
 * @param {string|null|undefined} slug
 * @returns {'ok'|'already'|'full'}
 */
export function pinStatus(slug) {
  const apps = pinnedAppsStore.get().apps;
  if (!slug || apps.some((a) => a.slug === slug)) return 'already';
  if (apps.length >= PINNED_APPS_MAX) return 'full';
  return 'ok';
}

/**
 * Pin `app`: appended to the end of the list when a drop would be accepted,
 * refused otherwise. The store updates, so the strip redraws, and storage
 * keeps it for the next visit when `owner` is set. Returns whether it pinned.
 *
 * @param {{ slug?: string, name?: string, iconUrl?: string|null, iconEmoji?: string|null }} app
 * @param {string|null} owner  The signed-in username; with none the store
 *   still updates, so the strip shows it for this page, but nothing persists.
 */
export function pinApp(app, owner) {
  const entry = clean(app);
  if (!entry || pinStatus(entry.slug) !== 'ok') return false;
  const apps = [...pinnedAppsStore.get().apps, entry];
  pinnedAppsStore.set({ apps });
  if (owner) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ owner, apps }));
    } catch {
      // A list that does not survive a reload is better than a throw.
    }
  }
  return true;
}

/**
 * Take `slug` off the list, from the drag-back-out gesture or the Unpin menu
 * item. Unpinning is not forgetting: the app stays in recents. Returns
 * whether it was pinned.
 *
 * @param {string} slug
 * @param {string|null} owner  The signed-in username; with none the store
 *   still updates, but nothing persists.
 */
export function unpinApp(slug, owner) {
  if (!slug) return false;
  const current = pinnedAppsStore.get().apps;
  if (!current.some((a) => a.slug === slug)) return false;
  const apps = current.filter((a) => a.slug !== slug);
  pinnedAppsStore.set({ apps });
  if (owner) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ owner, apps }));
    } catch {
      // A list that does not survive a reload is better than a throw.
    }
  }
  return true;
}

/** Exported for the test that pins the key, so it cannot drift silently. */
export const PINNED_APPS_KEY = KEY;