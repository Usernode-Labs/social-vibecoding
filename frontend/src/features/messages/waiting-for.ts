import type { ConversationUser } from './types';

/**
 * Whose acceptance a first message waits on: the peer when it has a username,
 * else the first invited member, named or not. `unknown` says that person's
 * username did not come with the row, so the line uses its own wording
 * instead of taking the stand-in as a name. With nobody to name, `name` is
 * empty and the line says so without one.
 */
export function waitingFor(active: {
  peer?: Pick<ConversationUser, 'username' | 'unnamed'> | null;
  members: ReadonlyArray<Pick<ConversationUser, 'username' | 'unnamed'> & { status?: string }>;
}): { name: string; unknown: boolean } {
  const person = (active.peer?.username ? active.peer : active.members.find((member) => member.status === 'invited')) || null;
  const name = person?.username || '';
  return { name, unknown: !!name && !!person?.unnamed };
}
