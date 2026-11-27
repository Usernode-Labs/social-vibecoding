/**
 * HEARTS AND PLAYS, the client's half (src/services/app-popularity.js has the
 * server's): what the panel (./hearts-plays.tsx) and the Communities cards
 * (../communities/card.tsx) show, and the three things a page does about
 * them.
 *
 *   A heart        PUT or DELETE /api/apps/:slug/heart, for an account that
 *                  can see the app. `saveHeart` answers how things stand.
 *   A heart kept   A visitor with no account presses the heart: the sign-in
 *                  sheet opens (features/auth/landing.tsx, the `heart`
 *                  intent), and the heart is kept on this device until an
 *                  account exists (`rememberHeart`). The first panel drawn
 *                  for that app once somebody is signed in gives it
 *                  (`takePendingHeart`). One app at a time; the newest wins.
 *   A visitor's    The landing's viewer keeps an app open for a visitor with
 *   play           no account. Once it has stayed open VISITOR_PLAY_AFTER_MS,
 *                  `watchVisitorPlay` tells POST /api/public/apps/:slug/plays,
 *                  at most once per app per day from this browser. The server
 *                  counts one per source per day whatever arrives; the note
 *                  kept here only saves the request. Somebody signed in is
 *                  never reported from here: their plays are counted from
 *                  the time they spend in the app.
 *
 * Everything kept on the device is guarded: storage can be missing, full or
 * refused (a private window), and then nothing is kept and nothing breaks.
 */

/** A plays figure under this says nothing: a new app does not look unused. */
export const MIN_PLAYS = 20;
/** A card shows how many hearts from here up; the panel shows any. */
export const MIN_CARD_HEARTS = 10;
/** How long an app stays open in the viewer before a visitor's play is counted. */
export const VISITOR_PLAY_AFTER_MS = 10_000;

export const PENDING_HEART_KEY = 'homeroom_pending_heart_v1';
export const VISITOR_PLAYS_KEY = 'homeroom_visitor_plays_v1';

export interface HeartState {
  hearted: boolean;
  hearts: number;
}

const count = (n: unknown): number => Math.max(0, Math.floor(Number(n) || 0));

/** The plays figure a screen shows, or 0 to say nothing. */
export function shownPlays(plays: unknown): number {
  const n = count(plays);
  return n >= MIN_PLAYS ? n : 0;
}

/** The hearts figure a card shows, or 0 to say nothing. */
export function shownCardHearts(hearts: unknown): number {
  const n = count(hearts);
  return n >= MIN_CARD_HEARTS ? n : 0;
}

function heartState(body: unknown): HeartState | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { hearted?: unknown; hearts?: unknown };
  return { hearted: b.hearted === true, hearts: count(b.hearts) };
}

/** Give a heart or take it back. Null when it could not be saved. */
export async function saveHeart(slug: string, hearted: boolean): Promise<HeartState | null> {
  try {
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/heart`, {
      method: hearted ? 'PUT' : 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    return heartState(await res.json());
  } catch {
    return null;
  }
}

/** Whether the signed-in reader has hearted it, and how many have. Null when it cannot be read. */
export async function readHeart(slug: string): Promise<HeartState | null> {
  try {
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/heart`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return heartState(await res.json());
  } catch {
    return null;
  }
}

/** A visitor pressed the heart: keep it for the account they are about to make. */
export function rememberHeart(slug: string): void {
  try {
    if (slug) localStorage.setItem(PENDING_HEART_KEY, slug);
  } catch { /* nothing kept */ }
}

/** Whether a heart was kept for this app; asking takes it, so it is given once. */
export function takePendingHeart(slug: string): boolean {
  try {
    if (!slug || localStorage.getItem(PENDING_HEART_KEY) !== slug) return false;
    localStorage.removeItem(PENDING_HEART_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Today, as the note of a visitor's plays keeps it (UTC, as the server's day is). */
function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function readPlays(): Record<string, string> {
  try {
    const raw = localStorage.getItem(VISITOR_PLAYS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** Whether this browser already reported a play of this app today. */
export function visitorPlayedToday(slug: string, now: number = Date.now()): boolean {
  return readPlays()[slug] === today(now);
}

/** Note today's play of this app, dropping the notes of other days. */
export function noteVisitorPlay(slug: string, now: number = Date.now()): void {
  try {
    const day = today(now);
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(readPlays())) if (value === day) kept[key] = value;
    kept[slug] = day;
    localStorage.setItem(VISITOR_PLAYS_KEY, JSON.stringify(kept));
  } catch { /* nothing kept: the server still counts one a day */ }
}

/**
 * A visitor with no account opened this app in the viewer. Once it has stayed
 * open long enough, report one play, unless this browser already did today.
 * Returns what to call when the app is closed: closing sooner reports nothing.
 * Never retried, and never awaited by anything on screen.
 */
export function watchVisitorPlay(slug: string, { after = VISITOR_PLAY_AFTER_MS, now = Date.now }: {
  after?: number;
  now?: () => number;
} = {}): () => void {
  if (!slug || typeof window === 'undefined' || visitorPlayedToday(slug, now())) return () => {};
  const timer = window.setTimeout(() => {
    if (visitorPlayedToday(slug, now())) return;
    noteVisitorPlay(slug, now());
    void fetch(`/api/public/apps/${encodeURIComponent(slug)}/plays`, { method: 'POST', credentials: 'omit' })
      .catch(() => { /* a play that could not be reported is not counted */ });
  }, after);
  return () => window.clearTimeout(timer);
}
