/**
 * "Has this account finished the welcome tour?", answered by the account AND
 * by this browser (#3237).
 *
 * The browser's flag (./tour-storage.ts) used to be the whole answer, and it
 * is a poor one on its own: another device, another browser, the phone app
 * beside a browser tab, a storage the user cleared or the browser evicted, a
 * private window, and the move to a new domain each offered the tour again to
 * people who had already finished it. The account keeps the answer now
 * (`users.tour_done_at`, read back as `tourDone` on /api/auth/me). It rides
 * `App.user` like every other field of the user, so the session snapshot
 * carries it too.
 *
 * Three rules, each a pure function here so the tests EXECUTE them:
 *
 *   * DONE is the account's answer OR the browser's. The one exception is a
 *     document that showed the join screen: that starts the tour over whatever
 *     either flag says (#3190). The join screen is itself the server's
 *     say-so. It shows for a new account, or for one an admin reset (Admin →
 *     Users → Reset first run), and the reset clears the account's flag with
 *     it (src/services/onboarding.js resetFirstRun).
 *   * BACKFILL. A browser that has the flag when the account does not copies
 *     it to the account, once, so nobody who finished the tour before the
 *     account kept the answer sees it again on their next device. Never
 *     while a join screen is still to come or was shown here, because that
 *     is an account whose tour is due again, and never against the session
 *     snapshot's user: a stale "not done" there could be an account an admin
 *     has just reset, and copying "done" over it would undo the reset on
 *     every device.
 *   * THE WRITE IS FIRE-AND-FORGET. A failure costs a repeat tour on some
 *     other device and nothing here: it never throws out of this module and
 *     never logs a console.error, which fails proposal checks on any route.
 */

export const TOUR_DONE_PATH = '/api/me/tour-done';

/**
 * How long a boot from the session snapshot waits for its own read of the
 * session before it decides on the snapshot's user after all.
 */
export const SESSION_WAIT_MS = 8_000;

export interface TourDoneInputs {
  /** The account's answer: `App.user.tourDone`, off the freshest user there is. */
  serverDone: boolean;
  /** This browser's answer (./tour-storage.ts `readDone`). */
  localDone: boolean;
  /** Did this document show the join screen (CommunitiesFirstRun.shownHere)? */
  joinShownHere: boolean;
}

/** Is the tour finished for this viewer? */
export function isTourDone({ serverDone, localDone, joinShownHere }: TourDoneInputs): boolean {
  // A first run shown here restarts the tour, even over a "done" that is
  // stale (a snapshot's) or this browser's own.
  if (joinShownHere) return false;
  return serverDone || localDone;
}

/** Should this browser's "done" be copied to the account? */
export function needsBackfill(
  { serverDone, localDone, joinShownHere, joinPending }: TourDoneInputs & {
    /** Is a join screen still to come in this document? */
    joinPending: boolean;
  },
): boolean {
  return localDone && !serverDone && !joinShownHere && !joinPending;
}

// ── The shell's user ───────────────────────────────────────────────────
//
// `App` is a classic-script global (public/js/app.js), so every read is
// through `window` and tolerates it being absent.

interface TourUser {
  id?: number;
  tourDone?: boolean;
}

interface AppHost {
  user?: TourUser | null;
  _sessionFromSnapshot?: boolean;
  bootSession?: () => Promise<unknown>;
  saveSessionSnapshot?: (user: TourUser) => void;
}

function appHost(): AppHost | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { App?: AppHost }).App;
}

/** The account's answer, as the user the shell holds right now has it. */
export function serverDone(userId: number | null): boolean {
  const user = appHost()?.user;
  return userId != null && !!user && user.id === userId && user.tourDone === true;
}

/**
 * Is the user the shell holds the server's answer for this viewer, rather
 * than the session snapshot a boot starts from (app.js `_sessionFromSnapshot`)?
 */
export function sessionVerified(userId: number | null): boolean {
  const host = appHost();
  return userId != null && !!host?.user && host.user.id === userId
    && host._sessionFromSnapshot !== true;
}

/**
 * Resolves once the user the shell holds is the freshest there is.
 *
 * At once on a verified session. On a boot from the session snapshot, once
 * the boot's own read of /api/auth/me has answered (`App.bootSession()`):
 * with the server's user, which app.js has put on `App.user` by then, or with
 * "could not tell" (offline, a 500), where the snapshot IS the freshest user
 * there is. Capped, because a read that never settles must not keep the tour
 * from ever running.
 */
export function whenSessionRead(): Promise<void> {
  const host = appHost();
  if (!host || host._sessionFromSnapshot !== true || typeof host.bootSession !== 'function') {
    return Promise.resolve();
  }
  const read = host.bootSession;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SESSION_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    Promise.resolve().then(() => read.call(host)).then(done, done);
  });
}

/**
 * Tell the account the tour is done: Finish, Skip, and the one-time backfill.
 * Resolves to whether the account has it. Never throws.
 */
export async function markDoneOnServer(userId: number | null): Promise<boolean> {
  if (userId == null) return false;
  try {
    const res = await fetch(TOUR_DONE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    });
    if (!res.ok) {
      console.warn('[tour] "done" not recorded on the account:', res.status);
      return false;
    }
  } catch (err) {
    console.warn('[tour] "done" not recorded on the account:', err);
    return false;
  }
  rememberServerDone(userId);
  return true;
}

/**
 * The account has it now, so this document's user does too, and so does the
 * snapshot the next boot starts from. Not while the shell is running FROM the
 * snapshot: re-writing it then would keep refreshing its age, which is the
 * reason app.js's enterAuthed gives for skipping it too.
 */
function rememberServerDone(userId: number): void {
  try {
    const host = appHost();
    const user = host?.user;
    if (!host || !user || user.id !== userId) return;
    user.tourDone = true;
    if (host._sessionFromSnapshot !== true) host.saveSessionSnapshot?.(user);
  } catch {
    /* The account has it; this document just does not know yet. */
  }
}
