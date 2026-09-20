/**
 * "Has this account finished the welcome tour?", answered without the server.
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

/** Settings' "Replay the tour" clears the flag so the next Home start runs. */
export function clearDone(userId: number | null): void {
  const key = keyFor(userId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* A replay that cannot clear the flag still opens the tour right now. */
  }
}

export function currentUserId(): number | null {
  const app = (window as { App?: { user?: { id?: number } | null } }).App;
  const id = app && app.user ? app.user.id : null;
  return typeof id === 'number' ? id : null;
}
