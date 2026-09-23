/**
 * "Message" on a person's page: find or start the direct conversation with
 * them and open it (#messages/<id>).
 *
 * The navigation prototype puts a Message button on every person page
 * (`pageParts` → 'person'), opened from Standings, Kudos or an app's
 * contributors. The product could start a DM only from Messages → "+" →
 * Direct message, and this is THAT path, reused rather than re-derived:
 *
 *   1. the same user search the dialog runs (`api.searchUsers`, the
 *      `scope=messages` directory), matched to the page's handle exactly;
 *   2. the same `createDirect` the dialog's row calls, which POSTs
 *      /api/conversations { kind: 'direct' } and opens the result.
 *
 * Every rule the dialog obeys therefore holds here without a line of its own:
 *
 *   * BLOCKING (#2867). The messages-scoped search leaves out anyone blocked
 *     in either direction, and the server's createDirect refuses such a pair
 *     outright (blockedEitherWay → 404). Either way the answer is "you can't
 *     message them", and it never says which of you blocked whom.
 *   * REQUESTS. A new direct conversation starts as an invitation the other
 *     person accepts; an existing one is found, not duplicated; and after a
 *     decline only the person who declined can reopen it — the server answers
 *     the requester 404, which reads the same as above.
 *   * YOURSELF. The search excludes the viewer, and the button is not drawn on
 *     your own page in the first place.
 *
 * Returns rather than throws, so the button owns its own error line.
 */

import * as api from '../messages/api';
import { createDirect } from '../messages/store';

export type MessagePersonResult = { ok: true } | { ok: false; message: string };

/** The exact-handle match out of a prefix search's results. Pure, for tests. */
export function exactMatch<T extends { username: string }>(users: T[], handle: string): T | null {
  const want = String(handle || '').trim().toLowerCase();
  if (!want) return null;
  return users.find((user) => String(user.username || '').toLowerCase() === want) || null;
}

export async function messagePerson(username: string): Promise<MessagePersonResult> {
  const handle = String(username || '').trim().replace(/^@/, '');
  if (!handle) return { ok: false, message: 'There is nobody here to message.' };
  let user: { id: number; username: string } | null = null;
  try {
    user = exactMatch(await api.searchUsers(handle), handle);
  } catch {
    return { ok: false, message: 'Couldn’t reach Messages. Check your connection and try again.' };
  }
  if (!user || !user.id) return { ok: false, message: `You can’t message @${handle}.` };
  try {
    await createDirect(user.id);
    return { ok: true };
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 404) return { ok: false, message: `You can’t message @${handle} right now.` };
    return { ok: false, message: 'Couldn’t start this conversation. Try again.' };
  }
}
