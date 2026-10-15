/**
 * The apps at the top of My apps on Home, for the desktop strip (#4935).
 *
 * ./recent-apps-store.js answers "what was I just using"; this one answers
 * "what did I put first". Home is the only writer: its grid render names the
 * apps in its top row (the part people arrange and can see) through
 * `UsernodeReact.nav.setPinnedApps`, and the strip leads with them so the
 * two look like one place, not two lists that overlap.
 *
 * Same shape as the recents list: entries carry the app's display data so the
 * strip can draw before Home has loaded, and the stored list names the
 * account it was written for — a list written for anybody else reads as
 * empty, so the next person to sign in on this device is never shown the
 * previous one's apps.
 *
 * NOTHING HERE MAY BE CALLED DURING AN INITIAL RENDER. INITIAL is empty,
 * which is what the prerendered document shows; the strip reads storage in an
 * effect. A localStorage read during a first render is a hydration mismatch.
 */

import { createStore } from '../../lib/plain-store.js';

const KEY = 'usernode_pinned_apps_v1';

/** Home's top row is four columns wide, so four is the most there is. */
export const PINNED_APPS_MAX = 4;

/** @typedef {{ slug: string, name: string, iconUrl: string|null, iconEmoji: string|null }} PinnedApp */

/** @type {{ apps: PinnedApp[] }} */
const INITIAL = { apps: [] };

export const pinnedAppsStore = createStore(INITIAL);

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
 * Publish Home's top row as `owner`'s pinned apps: the store updates, so the
 * strip redraws, and storage keeps it for the next visit before Home loads.
 *
 * With no owner (nobody signed in) the store still updates, so the strip
 * shows it for this page, but nothing is written to storage. A list whose
 * slug, name and icons are unchanged from the stored one is a no-op: Home
 * re-renders often (a drag, a search clearing), and each paint must not
 * rewrite storage for the same row.
 *
 * @param {Array<{ slug?: string, name?: string, iconUrl?: string|null, iconEmoji?: string|null }>} apps
 * @param {string|null} owner  The signed-in username.
 */
export function setPinnedApps(apps, owner) {
  const cleaned = (apps || []).map(clean).filter(Boolean).slice(0, PINNED_APPS_MAX);
  const current = pinnedAppsStore.get().apps;
  const same = cleaned.length === current.length
    && cleaned.every((app, i) => (
      app.slug === current[i].slug
      && app.name === current[i].name
      && app.iconUrl === current[i].iconUrl
      && app.iconEmoji === current[i].iconEmoji
    ));
  if (same) return;
  pinnedAppsStore.set({ apps: cleaned });
  if (!owner) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ owner, apps: cleaned }));
  } catch {
    // A list that does not survive a reload is better than a throw.
  }
}

/** Exported for the test that pins the key, so it cannot drift silently. */
export const PINNED_APPS_KEY = KEY;
