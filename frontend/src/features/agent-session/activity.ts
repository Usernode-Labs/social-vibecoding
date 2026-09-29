// What an agent session is doing, as the lists mark it (#2779 follow-up):
// Recents, the platform mark's Continue rows and Messages all draw the same
// mark beside a conversation, from the same two fields the server sends.
//
//   - WORKING: its turn is running (the lease is held, which covers a scout
//     or build the turn dispatched). A spinner.
//   - DONE: a turn finished after you last read the conversation. A green
//     dot, which opening the conversation clears.
//
// Pure, so tests and the non-React list models can read it.

export type AgentActivity = 'working' | 'done' | null;

export function agentActivity(session: { busy?: boolean; doneUnseen?: boolean } | null | undefined): AgentActivity {
  if (!session) return null;
  if (session.busy) return 'working';
  if (session.doneUnseen) return 'done';
  return null;
}

/** What a screen reader hears, and the tooltip. */
export const ACTIVITY_LABEL: Record<Exclude<AgentActivity, null>, string> = {
  working: 'Working',
  done: 'Finished',
};
