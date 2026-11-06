/**
 * PINS KEPT ON THIS DEVICE, signed out (One Home, #6361).
 *
 * A visitor can pin before they have an account: an app (its tile opens the
 * app) and a community (its tile opens the project's page). Both lists live
 * in this browser only, and move to the account the first time a session
 * starts here (../home/home-pins-store.ts importDevicePins): the communities
 * through POST /api/me/home-pins/import, the apps through each app's
 * favorite route. Then the device's lists are cleared.
 *
 * localStorage can be missing, full or refused (a private window); every
 * read and write is guarded, and the lists simply start empty then.
 */
import { createStore } from '../../lib/plain-store.js';

export const DEVICE_PINS_KEY = 'homeroom_device_pins_v1';

export interface DevicePins {
  apps: string[];
  communities: string[];
}

function read(): DevicePins {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DEVICE_PINS_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s) : []);
    return { apps: list(parsed?.apps), communities: list(parsed?.communities) };
  } catch {
    return { apps: [], communities: [] };
  }
}

function write(pins: DevicePins): void {
  try {
    if (!pins.apps.length && !pins.communities.length) localStorage.removeItem(DEVICE_PINS_KEY);
    else localStorage.setItem(DEVICE_PINS_KEY, JSON.stringify(pins));
  } catch { /* kept for this page only */ }
}

/** Empty until mounted, so the prerender and the first render agree. */
export const devicePinsStore = createStore<DevicePins & { ready: boolean }>({ apps: [], communities: [], ready: false });

export function loadDevicePins(): void {
  devicePinsStore.set({ ...read(), ready: true });
}

export function toggleDevicePin(kind: 'apps' | 'communities', slug: string): boolean {
  const now = read();
  const on = !now[kind].includes(slug);
  const next = { ...now, [kind]: on ? [...now[kind], slug] : now[kind].filter((s) => s !== slug) };
  write(next);
  devicePinsStore.set({ ...next, ready: true });
  return on;
}

/** Take the lists away, for the move to an account. */
export function takeDevicePins(): DevicePins {
  const now = read();
  write({ apps: [], communities: [] });
  devicePinsStore.set({ apps: [], communities: [], ready: true });
  return now;
}

/** Put back what did not move (a failed request), for the next session to try again. */
export function keepDevicePins(left: DevicePins): void {
  if (!left.apps.length && !left.communities.length) return;
  const now = read();
  const merged = {
    apps: [...new Set([...left.apps, ...now.apps])],
    communities: [...new Set([...left.communities, ...now.communities])],
  };
  write(merged);
  devicePinsStore.set({ ...merged, ready: true });
}
