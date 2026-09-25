// The "Continue" rows under the platform mark (#2779 follow-up): your agent
// sessions, so going back to one is a tap from anywhere. Pure, so tests can
// read the rules without a browser.
//
// The rules:
//   - every app's, not only the one the menu is open on, and on Home too: a
//     session is yours to continue wherever you are, and the old per-app
//     filter hid a change you had just started whenever the app it named was
//     not the one on screen (or it named none);
//   - the five most recent, and `more` when there are others, which the menu
//     answers with "Show more" (Messages' Agents list);
//   - agent sessions only: a conversation stands for the changes it started,
//     and the Workshop is one row above for everything else;
//   - "paused" is not a state of the work (the platform pauses an idle
//     session and resumes it when it is used), so it is listed like any other;
//   - a conversation nothing was said in yet (no title, since the first
//     message titles it, and no change) is not work in progress;
//   - newest first, each with the mark the other lists draw (./activity):
//     a spinner while it works, a green dot once it finished unseen.

import { agentActivity, type AgentActivity } from '../agent-session/activity';

export interface ContinueAgentSession {
  id: number;
  title: string | null;
  status: string;
  lastActivityAt: string | null;
  createdAt?: string | null;
  focusApp: { slug: string | null } | null;
  activeChange: { appSlug: string | null; status: string | null; title: string | null } | null;
  busy?: boolean;
  doneUnseen?: boolean;
}

export interface ContinueRow {
  key: string;
  href: string;
  title: string;
  detail: string;
  activity: AgentActivity;
}

export interface ContinueList {
  rows: ContinueRow[];
  /** More sessions qualify than the rows show. */
  more: boolean;
}

export const CONTINUE_MAX = 5;

function time(value: string | null | undefined): number {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

function agentDetail(session: ContinueAgentSession): string {
  const change = session.activeChange;
  if (!change) return 'Agent session';
  if (change.status === 'promoted') return 'In vote';
  if (change.status === 'merged') return 'Merged';
  return 'In progress';
}

export function continueRows(
  agentSessions: ContinueAgentSession[],
  max = CONTINUE_MAX,
): ContinueList {
  const current = agentSessions
    .filter((session) => session.status === 'open' && (session.title || session.activeChange))
    .sort((a, b) => (time(b.lastActivityAt) || time(b.createdAt)) - (time(a.lastActivityAt) || time(a.createdAt)));
  const shown = Math.max(0, max);
  const rows = current
    .slice(0, shown)
    .map((session): ContinueRow => ({
      key: `agent:${session.id}`,
      href: `#messages/agent/${session.id}`,
      title: session.title || (session.activeChange && session.activeChange.title) || 'Agent session',
      detail: agentDetail(session),
      activity: agentActivity(session),
    }));
  return { rows, more: current.length > shown };
}
