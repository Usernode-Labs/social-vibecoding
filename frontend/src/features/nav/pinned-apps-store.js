/**
 * The communities YOU pinned to the desktop sidebar (#5323; 18 Oct 2026).
 *
 * They were apps, pinned to the desktop strip by dragging a My apps tile
 * there, and kept on each device. Each community's app is the first row
 * under it in the sidebar now, so a pin keeps the community there, in a
 * Pinned section of its own (./rail-pinned.tsx), and A PIN IS THE ACCOUNT'S:
 * the server holds the list (GET/PUT/DELETE /api/me/community-pins,
 * src/services/community-pins.js), so it follows you to another computer,
 * and leaving a community drops its pin there. A community and its app
 * share a slug, so the entries below are what they always were.
 *
 * ── Three keys on this device ────────────────────────────────────────
 *
 * - KEY: the account's list as this device last read it, so the sidebar
 *   draws the pins at once and the server's answer replaces them after.
 * - DEVICE_KEY: the pins a device kept before they were the account's. The
 *   first read for an account sends them up once (POST .../import, which
 *   keeps the ones that account may pin and skips the rest without asking
 *   anything), then forgets them.
 * - LEGACY_KEY: Home's mirrored top row (#4935), retired; cleared, never
 *   read as pins.
 *
 * Every stored list names the account it was written for, and a list
 * written for anybody else reads as empty, so the next person to sign in on
 * this device is never shown the previous one's pins.
 *
 * ── Writes land at once, then the account's answer stands ────────────
 *
 * A pin or an unpin changes the list here first, so the sidebar moves under
 * the press, then goes to the server, whose answer is the list from then
 * on. A refusal (four already, or a community you are not in, which the
 * fetch wrapper turns into a Join prompt first: lib/join-required.ts) reads
 * the account's list again. An answer for an account no longer signed in
 * here is dropped (`generation`). With nobody signed in the list changes
 * for this page and nothing is sent or stored.
 *
 * NOTHING HERE MAY BE CALLED DURING AN INITIAL RENDER. INITIAL is empty,
 * which is what the prerendered document shows; the sidebar reads storage in
 * an effect. A localStorage read during a first render is a hydration
 * mismatch.
 */

import { createStore } from '../../lib/plain-store.js';

const KEY = 'usernode_community_pins_v1';

// The pins a device kept before pins were the account's (#5323): sent up
// once, then removed.
const DEVICE_KEY = 'usernode_pinned_apps_v2';

// The retired #4935 key held Home's mirrored top row. Nothing from it may
// carry over — a pin is something the viewer chose — so the first read
// clears it, best effort, and it is never read as pins.
const LEGACY_KEY = 'usernode_pinned_apps_v1';

/** Four pins, the same limit as before. src/services/community-pins.js says the same. */
export const PINNED_APPS_MAX = 4;

/** @typedef {{ slug: string, name: string, iconUrl: string|null, iconEmoji: string|null }} PinnedApp */

/** @type {{ apps: PinnedApp[] }} */
const INITIAL = { apps: [] };

export const pinnedAppsStore = createStore(INITIAL);

/**
 * The sidebar's drag state while a My apps tile is in the air: the "Pin
 * here" slot shows what a drop would do ('idle' — dragging, 'ok' — drop
 * pins, 'already' / 'full' — the refusal words). null when nothing is being
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

function cleanList(apps) {
  return Array.isArray(apps) ? apps.map(clean).filter(Boolean).slice(0, PINNED_APPS_MAX) : [];
}

// The list stored under `key` for `owner`, or an empty one. Never throws.
function readList(key, owner) {
  if (!owner) return [];
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.owner === owner) return cleanList(parsed.apps);
  } catch {
    // Unreadable storage is an empty list, not a broken page.
  }
  return [];
}

function store(owner, apps) {
  if (!owner) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ owner, apps }));
  } catch {
    // A list that does not survive a reload is better than a throw.
  }
}

/**
 * The account's pins as this device last read them for `owner`, or an empty
 * list. Never throws.
 *
 * @param {string|null} owner  The signed-in username; null reads nothing.
 */
export function readPinnedApps(owner) {
  if (!owner) return [];
  try { window.localStorage.removeItem(LEGACY_KEY); } catch { /* best effort */ }
  return readList(KEY, owner);
}

/** The window's fetch, which the join-required wrapper sits on; none in a test without one. */
function pinsFetch() {
  return typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
}

// Bumped for every read, and for every change of who is signed in: an
// answer that arrives for an older one is not the list any more.
let generation = 0;

function settle(owner, pins) {
  const apps = cleanList(pins);
  pinnedAppsStore.set({ apps });
  store(owner, apps);
}

/**
 * Read `owner`'s pins from the account, sending up first the ones this
 * device kept before pins were the account's. With no owner it only drops
 * any answer still on its way for the last one. Resolves when settled;
 * never rejects (a failed read leaves the stored list as it is).
 *
 * @param {string|null} owner
 */
export async function loadPins(owner) {
  const gen = ++generation;
  const send = pinsFetch();
  if (!owner || !send) return;
  try {
    const device = readList(DEVICE_KEY, owner);
    const res = device.length
      ? await send('/api/me/community-pins/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs: device.map((app) => app.slug) }),
      })
      : await send('/api/me/community-pins', { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = await res.json();
    if (device.length) {
      try { window.localStorage.removeItem(DEVICE_KEY); } catch { /* sent once is enough */ }
    }
    if (gen !== generation || !body || !Array.isArray(body.pins)) return;
    settle(owner, body.pins);
  } catch {
    // The stored list stands until the next read.
  }
}

// The account's answer to one pin or unpin: the list as it now stands, or,
// for a refusal or a failure, the list read again.
async function sendChange(owner, method, slug) {
  const send = pinsFetch();
  if (!owner || !send) return;
  const gen = generation;
  try {
    const res = await send(`/api/me/community-pins/${encodeURIComponent(slug)}`, { method, credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (gen !== generation) return;
    if (res.ok && body && Array.isArray(body.pins)) settle(owner, body.pins);
    else await loadPins(owner);
  } catch {
    if (gen === generation) await loadPins(owner);
  }
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
 * Pin `app`'s community: appended to the end of the list when a drop would
 * be accepted, refused otherwise. The store updates at once, so the sidebar
 * redraws, and the account is told. Returns whether it pinned.
 *
 * @param {{ slug?: string, name?: string, iconUrl?: string|null, iconEmoji?: string|null }} app
 * @param {string|null} owner  The signed-in username; with none the store
 *   still updates, so the sidebar shows it for this page, but nothing is sent.
 */
export function pinApp(app, owner) {
  const entry = clean(app);
  if (!entry || pinStatus(entry.slug) !== 'ok') return false;
  const apps = [...pinnedAppsStore.get().apps, entry];
  pinnedAppsStore.set({ apps });
  store(owner, apps);
  void sendChange(owner, 'PUT', entry.slug);
  return true;
}

/**
 * Take `slug` off the list, from the drag-back-out gesture or an Unpin menu
 * item. Unpinning is not leaving: you stay in the community. Returns whether
 * it was pinned.
 *
 * @param {string} slug
 * @param {string|null} owner  The signed-in username; with none the store
 *   still updates, but nothing is sent.
 */
export function unpinApp(slug, owner) {
  if (!slug) return false;
  const current = pinnedAppsStore.get().apps;
  if (!current.some((a) => a.slug === slug)) return false;
  const apps = current.filter((a) => a.slug !== slug);
  pinnedAppsStore.set({ apps });
  store(owner, apps);
  void sendChange(owner, 'DELETE', slug);
  return true;
}

/**
 * Leaving a community drops its pin on the account (the pin's key is the
 * membership's), so drop it here too, with nothing to send. Home announces
 * a landed membership change (Home.MEMBERSHIP_EVENT); ./mount.ts listens.
 *
 * @param {string} slug
 * @param {string|null} owner
 */
export function forgetPin(slug, owner) {
  const current = pinnedAppsStore.get().apps;
  if (!slug || !current.some((a) => a.slug === slug)) return;
  const apps = current.filter((a) => a.slug !== slug);
  pinnedAppsStore.set({ apps });
  store(owner, apps);
}

/** Exported for the tests that pin the keys, so they cannot drift silently. */
export const PINNED_APPS_KEY = KEY;
export const PINNED_APPS_DEVICE_KEY = DEVICE_KEY;
