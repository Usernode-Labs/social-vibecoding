/**
 * "Has this account finished the welcome tour?", as THIS BROWSER remembers it.
 *
 * The account keeps the answer too (./tour-done.ts), and the tour is done
 * when either says so; this is the browser's half. It still matters: it is
 * what a browser that finished the tour before the account kept the answer
 * copies to the account, and it answers on a session the server has not
 * confirmed yet.
 *
 * Lifted verbatim in shape from the `#home-welcome` banner this tour replaces
 * (#1561), and for the reason its header comment gave: the platform publishes
 * no account-creation date to the client, so "first sign-in" cannot be asked
 * as "is this account new". "You have not finished this yet" is the same
 * answer for a new account and the right answer for an existing one, who has
 * equally never been walked through the place.
 *
 * The key carries the user id, so two accounts on one device each get their
 * own answer and signing out of one does not silence the other.
 *
 * Every access is wrapped: Safari throws on storage in private mode, and a
 * tour is not worth a boot error. Storage denied SHOWS the tour rather than
 * retiring it, which is the same direction the banner failed in.
 *
 * The key is NEW rather than a read of the banner's. Dismissing a one-line
 * strip is not finishing an eight-step tour, so an account that dismissed the
 * banner has still never been shown any of this.
 */

const KEY_PREFIX = 'usernode:home-tour-done:';

export function keyFor(userId: number | null): string | null {
  return userId == null ? null : `${KEY_PREFIX}${userId}`;
}

export function readDone(userId: number | null): boolean {
  const key = keyFor(userId);
  if (!key) return true; // Nobody to welcome yet.
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // Storage denied: offer the tour rather than never. Skip and Finish still
    // close it for this visit, which is the graceful half of the failure.
    return false;
  }
}

export function writeDone(userId: number | null): void {
  const key = keyFor(userId);
  if (!key) return;
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* A finish that cannot be persisted still closes the tour for now. */
  }
}

/**
 * Settings' "Replay the tour" clears this browser's flag, and a join screen
 * shown in this document does too. Neither touches the account's: the replay
 * leaves it set until the replay finishes, and the reset that brings a join
 * screen back has already cleared it.
 */
export function clearDone(userId: number | null): void {
  const key = keyFor(userId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* A replay that cannot clear the flag still opens the tour right now. */
  }
}

/*
 * ── Where the viewer had got to, across a reload ───────────────────────
 *
 * The step is kept in sessionStorage, not localStorage, on purpose: it is a
 * property of THIS visit. A page reload under the tour keeps the page session
 * -- the shell switching itself to a newly cached build after a cold boot
 * (App._reloadPrefetchedShellIfSafe), the boot-time session reconcile -- so
 * the tour comes back at the step the viewer had reached instead of at step
 * 1, which is what read as "looping between the first and second step". A
 * new tab or the next launch is a new session, and a tour that was never
 * finished starts from the top there, as it should.
 *
 * Per account, wrapped, and failing toward "nothing saved", for the reasons
 * the done flag gives above.
 */

const STEP_PREFIX = 'usernode:home-tour-step:';

export function stepKeyFor(userId: number | null): string | null {
  return userId == null ? null : `${STEP_PREFIX}${userId}`;
}

/** The step a tour in progress had reached in this page session, or null. */
export function readStep(userId: number | null): number | null {
  const key = stepKeyFor(userId);
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    // Digits only: Number('') is 0, and a step 0 that nobody wrote is a
    // restart dressed up as a resume.
    return raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

export function writeStep(userId: number | null, index: number): void {
  const key = stepKeyFor(userId);
  if (!key) return;
  try {
    sessionStorage.setItem(key, String(index));
  } catch {
    /* A step that cannot be kept costs a reload its place, nothing more. */
  }
}

/** Finish and Skip both clear it: a finished tour has nowhere to resume. */
export function clearStep(userId: number | null): void {
  const key = stepKeyFor(userId);
  if (!key) return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Nothing to keep, nothing lost. */
  }
}

export function currentUserId(): number | null {
  const app = (window as { App?: { user?: { id?: number } | null } }).App;
  const id = app && app.user ? app.user.id : null;
  return typeof id === 'number' ? id : null;
}
