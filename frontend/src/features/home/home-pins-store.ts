/**
 * HOME'S PINNED COMMUNITIES (One Home, #6361): what the grid draws, and the
 * reads behind it.
 *
 *   pins    GET /api/me/home-pins (src/services/home-pins.js), the account's
 *           list in its order. A community can be pinned without joining.
 *   joined  GET /api/apps?scope=joined, the communities the viewer is in, for
 *           the All communities tile (the ones in it but not pinned).
 *   owed    GET /api/workshop/counts, each community's votes waiting on the
 *           viewer, for the tiles' blue number. An automatic membership the
 *           viewer never took part in (`unchosen`) owes nothing, as on the
 *           Communities tab before it.
 *
 * Read once the shell knows who is signed in, and again whenever a join or a
 * leave lands (Home.MEMBERSHIP_EVENT): joining pins the community on the
 * server, so the list is read back rather than guessed.
 */
import { createStore } from '../../lib/plain-store.js';
import { keepDevicePins, takeDevicePins } from '../guest/device-pins';

export interface HomePin {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  iconColor: string | null;
  member: boolean;
}

export interface JoinedCommunity {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  icon_color?: string | null;
  demo?: boolean;
}

export interface HomePinsState {
  ready: boolean;
  pins: HomePin[];
  joined: JoinedCommunity[];
  owed: Record<string, number>;
}

const INITIAL: HomePinsState = { ready: false, pins: [], joined: [], owed: {} };

export const homePinsStore = createStore<HomePinsState>(INITIAL);

async function readJson(url: string): Promise<any> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let loading: Promise<void> | null = null;

/** Read all three. Quiet on failure: the grid keeps what it had. */
export function loadHomePins(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const [pinsBody, appsBody, countsBody] = await Promise.all([
        readJson('/api/me/home-pins'),
        readJson('/api/apps?scope=joined').catch(() => ({ apps: [] })),
        readJson('/api/workshop/counts').catch(() => ({ counts: {} })),
      ]);
      const joined = (Array.isArray(appsBody?.apps) ? appsBody.apps : [])
        .filter((a: any) => a && a.slug && a.is_member && !a.demo);
      const owed: Record<string, number> = {};
      for (const [slug, c] of Object.entries(countsBody?.counts || {}) as Array<[string, any]>) {
        owed[slug] = c && !c.unchosen ? Math.max(0, Number(c.needs) || 0) : 0;
      }
      homePinsStore.set({ ready: true, pins: Array.isArray(pinsBody?.pins) ? pinsBody.pins : [], joined, owed });
    } catch {
      homePinsStore.set({ ready: true });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function toast(text: string) {
  try { (window as any).PlatformUI?.toast?.(text); } catch { /* no kit */ }
}

/**
 * Pin or unpin a community on Home. Optimistic: the tile moves at once, and
 * the server's answer (the whole list) replaces it. `say` writes the toast.
 */
export async function setHomePin(pin: Omit<HomePin, 'member'> & { member?: boolean }, on: boolean, say: {
  pinned: string; unpinned: string; failed: (reason: string) => string;
}): Promise<boolean> {
  const before = homePinsStore.get().pins;
  const next = on
    ? (before.some((p) => p.slug === pin.slug) ? before : [...before, { member: false, ...pin } as HomePin])
    : before.filter((p) => p.slug !== pin.slug);
  homePinsStore.set({ pins: next });
  try {
    const res = await fetch(`/api/me/home-pins/${encodeURIComponent(pin.slug)}`, {
      method: on ? 'PUT' : 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    if (Array.isArray(body?.pins)) homePinsStore.set({ pins: body.pins });
    toast(on ? say.pinned : say.unpinned);
    return true;
  } catch (err) {
    homePinsStore.set({ pins: before });
    toast(say.failed(err instanceof Error ? err.message : String(err)));
    return false;
  }
}

/**
 * Pins kept on this device while signed out move to the account, once, at
 * the first session (One Home, #6361; ../guest/device-pins.ts). Quiet when
 * there are none; a toast says how many moved when there were.
 */
let importing: Promise<void> | null = null;
export function importDevicePins(say: (count: number) => string): Promise<void> {
  if (importing) return importing;
  importing = (async () => {
    const pins = takeDevicePins();
    if (!pins.apps.length && !pins.communities.length) return;
    // A request that fails puts its pins back on the device, for the next
    // session to move; a slug the server refuses (gone, or not visible) is
    // dropped, as the import route skips it.
    const post = (url: string, body: unknown) => fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((res) => res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401)).catch(() => false);
    const left = { apps: [] as string[], communities: [] as string[] };
    if (pins.communities.length && !(await post('/api/me/home-pins/import', { slugs: pins.communities }))) {
      left.communities = pins.communities;
    }
    for (const slug of pins.apps) {
      if (!(await post(`/api/apps/${encodeURIComponent(slug)}/favorite`, { favorited: true }))) left.apps.push(slug);
    }
    keepDevicePins(left);
    const moved = pins.apps.length - left.apps.length + pins.communities.length - left.communities.length;
    if (moved) toast(say(moved));
    try { await (window as any).Home?.load?.(); } catch { /* the grid reads them on its next load */ }
  })().finally(() => { importing = null; });
  return importing;
}

/** Keep the list fresh: after a join or a leave, and once signed in. */
export function wireHomePins(moveMessage?: (count: number) => string): () => void {
  if (typeof document === 'undefined') return () => {};
  const reload = (event: Event) => {
    // Signed out: nothing to read, and nothing of the last account to keep.
    if (event.type === 'sv:session' && !(event as CustomEvent).detail?.user) {
      homePinsStore.set({ ...INITIAL });
      return;
    }
    if (event.type === 'sv:session' && moveMessage) {
      void importDevicePins(moveMessage).then(() => loadHomePins());
      return;
    }
    void loadHomePins();
  };
  document.addEventListener('sv:membership-changed', reload);
  document.addEventListener('sv:session', reload);
  return () => {
    document.removeEventListener('sv:membership-changed', reload);
    document.removeEventListener('sv:session', reload);
  };
}
