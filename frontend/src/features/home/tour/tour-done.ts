/**
 * "Has this account finished the welcome tour?", kept by the account (#3237)
 * and read by Home's Getting started card (#3240).
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
 * Since #3240 the tour no longer starts by itself, so nothing here decides
 * whether it OPENS: the Getting started card's first row, "Take the 1-minute
 * tour", ticks off from the account's answer (src/services/onboarding.js),
 * and that is what the answer is for now. Two rules are left, each a pure
 * function or a guarded write so the tests EXECUTE them:
 *
 *   * BACKFILL. A browser that has the flag when the account does not copies
 *     it to the account, once, so somebody who finished the tour before the
 *     account kept the answer sees that row ticked on every device. Never
 *     while a join screen is still to come or was shown here, because that
 *     is an account an admin has reset (Admin → Users → Reset first run,
 *     which clears the account's flag), and never against the session
 *     snapshot's user: a stale "not done" there could be that reset account,
 *     and copying "done" over it would undo the reset on every device.
 *   * THE WRITE IS FIRE-AND-FORGET. A failure costs an unticked row and
 *     nothing else: it never throws out of this module and never logs a
 *     console.error, which fails proposal checks on any route. A write that
 *     lands says so on `document` (`sv:tour-done`), which is how the card
 *     on the same screen learns to tick the row without a reload.
 */

export const TOUR_DONE_PATH = '/api/me/tour-done';

export interface TourDoneInputs {
  /** The account's answer: `App.user.tourDone`. */
  serverDone: boolean;
  /** This browser's answer (./tour-storage.ts `readDone`). */
  localDone: boolean;
  /** Did this document show the join screen (CommunitiesFirstRun.shownHere)? */
  joinShownHere: boolean;
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
  announceDone();
  return true;
}

/** The event the Getting started card reloads on, so its tour row ticks. */
export const TOUR_DONE_EVENT = 'sv:tour-done';

function announceDone(): void {
  try {
    document.dispatchEvent(new CustomEvent(TOUR_DONE_EVENT));
  } catch {
    /* No document to tell (a test, a worker): the next load reads it. */
  }
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
