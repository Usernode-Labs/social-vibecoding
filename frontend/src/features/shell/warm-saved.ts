/**
 * Fill this phone's saved copies ahead of need (the native-offline proposal,
 * 18 Nov 2026).
 *
 * A screen draws what this device kept (lib/kept-copies.ts) when Homeroom
 * cannot be reached, but it keeps only what was opened: in the offline test a
 * cold launch with no network found no conversation list and no communities
 * saved, though both had been on screen the day before. Native apps keep what
 * you are likely to open next while the connection is good. This does the
 * same for the few screens a person opens first, in the phone app only (where
 * losing signal is the ordinary case), once a session is confirmed, when the
 * page has been quiet a while, on a connection that is not metered or slow,
 * and at most every WARM_EVERY_MS: the Messages list, the newest
 * conversations' first page, and the communities and pins.
 *
 * Every read is the screen's own (the same functions, the same addresses), so
 * it keeps its copy the way an open would, and nothing here draws anything.
 */

import { isOffline } from '../../lib/offline';
import { getConversation, listConversations, listMessages } from '../messages/api';
import { loadHomePins } from '../home/home-pins-store';
import { isNativeApp } from '../mobile-install/environment';

/** How long the page waits after the session is confirmed. */
export const WARM_AFTER_MS = 8000;
/** At most this often per device. */
export const WARM_EVERY_MS = 30 * 60 * 1000;
/** The newest conversations whose first page is read ahead. */
export const WARM_CONVERSATIONS = 3;

const LAST_KEY = 'usernode:kept-warm:at';

function goodConnection(): boolean {
  const c = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!c) return true;
  if (c.saveData) return false;
  return !c.effectiveType || !/(^|-)2g$/.test(c.effectiveType);
}

function due(now: number): boolean {
  try {
    const last = Number(localStorage.getItem(LAST_KEY) || 0);
    return !(last > 0 && now - last < WARM_EVERY_MS && last <= now);
  } catch {
    return true;
  }
}

/** Read the first screens ahead, now. Exported for the tests. */
export async function warmSaved(now: number = Date.now()): Promise<void> {
  if (isOffline() || !goodConnection() || !due(now)) return;
  try { localStorage.setItem(LAST_KEY, String(now)); } catch { /* it reads again next time */ }
  const conversations = await listConversations().catch(() => []);
  const newest = [...conversations]
    .filter((item) => item && item.id)
    .slice(0, WARM_CONVERSATIONS);
  await Promise.all([
    loadHomePins().catch(() => undefined),
    ...newest.map((item) => Promise.all([
      getConversation(item.id).catch(() => null),
      listMessages(item.id).catch(() => null),
    ])),
  ]);
}

let installed = false;

/** Warm once per page, after the session is confirmed. Idempotent. */
export function installWarmSaved(): void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener('sv:session', () => {
    // The bridge says it is the phone app once it has loaded, so it is
    // asked here rather than at boot.
    const signedIn = !!(window as unknown as { App?: { user?: { id?: unknown } } }).App?.user?.id;
    if (!signedIn || timer || !isNativeApp()) return;
    timer = setTimeout(() => { void warmSaved(); }, WARM_AFTER_MS);
  });
}
