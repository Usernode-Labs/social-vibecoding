/**
 * The apps you left, newest first, for the desktop rail's Recents (#2802).
 *
 * No list on the rail draws them now (18 Oct 2026): each community's app is a
 * row under it in the desktop sidebar, so the strip's Recent apps went. The
 * sidebar still reads a name and a face from here, for a community whose app
 * is still running that the list of yours does not hold
 * (./rail-communities.tsx). Discover's "Opened recently on this device" switch
 * reads the times (../apps/browse.js, #4809).
 *
 * ./parked-store.js keeps ONE app: "which app am I in the middle of", drawn
 * as the phone's Resume strip. The rail's Recents list asks a wider question,
 * "what was I just doing", and answers it with apps AND conversations on one
 * clock. So it needs more than one app, and it needs WHEN each was left, which
 * the parked entry does not carry.
 *
 * Same writer as the parked strip: the router's `UsernodeReact.nav.park(app)`
 * (./mount.ts), called with the app's display data at the moment you leave
 * it. A park with null (the router clearing the strip because you went back
 * INTO an app) removes nothing here: the app is still one you used recently.
 *
 * WHOSE LIST IT IS. The router's session sweep clears the parked app with
 * park(null), but park(null) is also how it clears the strip on the way
 * into an app, so it cannot mean "forget" here. Instead the stored list names
 * the account it was written for, and a list written for anybody else reads
 * as empty: the next person to sign in on this device is never shown the
 * previous one's apps.
 *
 * ../app-context/app-recency.ts is not reused for the reason parked-store.js
 * gives: it is an ordering of slugs with no name or icon, and a list drawn
 * from it would have to fetch both before it could show anything.
 *
 * NOTHING HERE MAY BE CALLED DURING AN INITIAL RENDER. INITIAL is empty,
 * which is what the prerendered document shows; the rail reads storage in an
 * effect. A localStorage read during a first render is a hydration mismatch.
 */

import { createStore } from '../../lib/plain-store.js';
import { readParked } from './parked-store.js';

const KEY = 'usernode_recent_apps_v1';

/** More than any list ever showed (the strip's five, #4417), so a
 *  burst of messages cannot push every app out of storage for good. */
export const RECENT_APPS_MAX = 40;

/**
 * @typedef {object} RecentApp
 * @property {string} slug
 * @property {string} name
 * @property {string|null} iconUrl
 * @property {string|null} iconEmoji
 * @property {string} at  ISO time the app was left, or '' when nobody knows.
 */

/** @type {{ apps: RecentApp[] }} */
const INITIAL = { apps: [] };

export const recentAppsStore = createStore(INITIAL);

function clean(entry) {
  if (!entry || typeof entry.slug !== 'string' || !entry.slug) return null;
  return {
    slug: entry.slug,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.slug,
    iconUrl: typeof entry.iconUrl === 'string' ? entry.iconUrl : null,
    iconEmoji: typeof entry.iconEmoji === 'string' ? entry.iconEmoji : null,
    at: typeof entry.at === 'string' && entry.at ? entry.at : '',
  };
}

/** The list stored for `owner` as it stands, or an empty one. Never throws. */
function readStored(owner) {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.owner === owner && Array.isArray(parsed.apps)) {
      return parsed.apps.map(clean).filter(Boolean);
    }
  } catch {
    // Unreadable is the same as nothing stored.
  }
  return [];
}

/** When an entry was left, for ordering; 0 when nobody knows. */
function leftAt(entry) {
  return Date.parse(entry.at) || 0;
}

/**
 * The list stored for `owner`, or an empty one. Never throws.
 *
 * A device that parked an app before this list existed has it in the parked
 * entry only, so that one app seeds an empty list. It has no clock of its
 * own, so its time is left empty: a guess of "now" would be written back by
 * the next rememberRecentApp and then read as a real time by what asks how
 * recent it is. The parked entry is swept on sign-out, so it is always the
 * current account's.
 *
 * @param {string|null} owner  The signed-in username; null reads nothing.
 */
export function readRecentApps(owner) {
  if (!owner) return [];
  let list = readStored(owner);
  if (!list.length) {
    const parked = readParked();
    if (parked) list = [{ ...parked, at: '' }];
  }
  return list.slice(0, RECENT_APPS_MAX);
}

/**
 * Everything known about what `owner` left, for what asks how recently:
 * this tab's live list, which still holds an app when storage refused it, and
 * the stored one, which holds what another tab left since this one read it.
 * A slug can appear in both.
 *
 * @param {string|null} owner  The signed-in username; null reads nothing stored.
 */
export function recentAppEntries(owner) {
  return [...recentAppsStore.get().apps, ...readRecentApps(owner)];
}

/**
 * Record that `owner` just left `app`: it moves to the front, once.
 *
 * What another tab stored since this one read the list is merged in rather
 * than written over: each app once, at the latest time either side has.
 *
 * With no owner (nobody signed in yet) the store still updates, so the rail
 * shows it for this page, but nothing is written to storage.
 *
 * @param {{ slug?: string, name?: string, iconUrl?: string|null, iconEmoji?: string|null }|null} app
 * @param {string|null} owner  The signed-in username.
 * @param {string} [at]  ISO time; defaults to now. A parameter for the tests.
 */
export function rememberRecentApp(app, owner, at) {
  const next = clean({ ...app, at: at || new Date().toISOString() });
  if (!next) return;
  const latest = new Map();
  for (const item of [...recentAppsStore.get().apps, ...(owner ? readStored(owner) : [])]) {
    const known = latest.get(item.slug);
    if (item.slug !== next.slug && (!known || leftAt(item) > leftAt(known))) latest.set(item.slug, item);
  }
  const others = [...latest.values()].sort((a, b) => leftAt(b) - leftAt(a));
  const apps = [next, ...others].slice(0, RECENT_APPS_MAX);
  recentAppsStore.set({ apps });
  if (!owner) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ owner, apps }));
  } catch {
    // A list that does not survive a reload is better than a throw.
  }
}

/** Remove a blocked app from this account's resume history, including storage. */
export function forgetRecentApp(slug, owner) {
  const apps = recentAppsStore.get().apps.filter((app) => app.slug !== slug);
  recentAppsStore.set({ apps });
  if (!owner) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ owner, apps }));
  } catch {
    // Keep the current view correct when storage is unavailable.
  }
}

/** Exported for the test that pins the key, so it cannot drift silently. */
export const RECENT_APPS_KEY = KEY;
