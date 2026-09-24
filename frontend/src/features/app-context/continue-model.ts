// The "Continue" rows under the platform mark (#2779 follow-up): the work in
// progress you have on the app the menu is about, so going back to it is one
// tap from anywhere, beside New change. Pure, so tests/app-context-sheet
// tests can read the rules without a browser.
//
// The rules every list of your work follows now:
//   - an agent session is listed as itself, and the changes it started are
//     not listed again beside it: they are worked on in that conversation;
//   - "paused" is not a state of the work (the platform pauses an idle
//     session and resumes it when it is used), so a paused session is listed
//     like any other;
//   - a conversation nothing was said in yet (no title: the first message
//     titles it, and no change) is not work in progress;
//   - conversations first, then the rest, each newest first.

export interface ContinueAgentSession {
  id: number;
  title: string | null;
  status: string;
  lastActivityAt: string | null;
  createdAt?: string | null;
  focusApp: { slug: string | null } | null;
  activeChange: { appSlug: string | null; status: string | null; title: string | null } | null;
}

/** A row of the Improve store (features/improve/improve-controller.js toRow / taskToRow). */
export interface ContinueImproveRow {
  key: string;
  kind: string;
  title: string;
  href: string;
  status: string | null;
  busy?: boolean;
  sortAt?: number;
  agentSessionId?: number | null;
}

export interface ContinueRow {
  key: string;
  kind: 'agent' | 'change';
  href: string;
  title: string;
  detail: string;
}

export const CONTINUE_MAX = 3;

function time(value: string | null | undefined): number {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

/** Which app an agent session is about: its active change's, else its focus. */
function appOf(session: ContinueAgentSession): string | null {
  return (session.activeChange && session.activeChange.appSlug) || (session.focusApp && session.focusApp.slug) || null;
}

function agentDetail(session: ContinueAgentSession): string {
  const change = session.activeChange;
  if (!change) return 'Agent session';
  if (change.status === 'promoted') return 'In vote';
  if (change.status === 'merged') return 'Merged';
  return 'In progress';
}

export function continueRows(
  slug: string | null,
  agentSessions: ContinueAgentSession[],
  improveRows: ContinueImproveRow[],
  max = CONTINUE_MAX,
): ContinueRow[] {
  if (!slug) return [];
  const conversations = agentSessions
    .filter((session) => session.status === 'open' && (session.title || session.activeChange) && appOf(session) === slug)
    .sort((a, b) => (time(b.lastActivityAt) || time(b.createdAt)) - (time(a.lastActivityAt) || time(a.createdAt)))
    .map((session): ContinueRow => ({
      key: `agent:${session.id}`,
      kind: 'agent',
      href: `#messages/agent/${session.id}`,
      title: session.title || (session.activeChange && session.activeChange.title) || 'Agent session',
      detail: agentDetail(session),
    }));
  const changes = improveRows
    .filter((row) => !row.agentSessionId)
    .slice()
    .sort((a, b) => Number(!!b.busy) - Number(!!a.busy) || (b.sortAt || 0) - (a.sortAt || 0))
    .map((row): ContinueRow => ({
      key: `change:${row.key}`,
      kind: 'change',
      href: row.href,
      title: row.title,
      detail: row.status || (row.kind === 'task' ? 'Handed off' : 'In progress'),
    }));
  return [...conversations, ...changes].slice(0, Math.max(0, max));
}
