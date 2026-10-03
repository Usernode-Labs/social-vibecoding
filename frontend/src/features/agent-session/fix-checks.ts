// #3755: an agent chat notices its change's failing checks, and offers to fix
// them.
//
// The staging card already said "1 check failing", in red, in its corner, and
// the conversation under it said nothing: the person had to spot it and type
// "fix the failing check" themselves. Now, once a run's checks settle failing
// and nothing is working, the chat says so at its end, naming the checks, and
// offers Fix it. The tap sends the Mayor a message asking for the fix, with
// each check and what it reported, so it starts from what failed. Nothing
// starts without the tap: a turn spends the person's credits.
//
// ONE OFFER PER RUN. A run is the time its verdict was stored
// (`failingChecks.at`, the change's checks_checked_at). The offer stands
// until the person says anything after that time. Fix it is such a message,
// and so is anything they type instead, which answers the offer as surely as
// the tap. So it never comes back for the run it was made for, whatever the
// turn after it did. A re-run (or the fix's own push) puts the checks back to
// running, which hides it; the next failing verdict is a new run and a new
// offer. Pure, so the rule is read in one place a test can read.

import type { AgentChange, AgentMessage } from './api';

/** A change still open to more work: a fix to one in a vote revises it, as any push does. */
const OPEN = new Set(['active', 'paused', 'promoted']);

/** How much of what a check reported goes into the message, per check. */
const REASON_CHARS = 240;

export interface FixChecksOffer {
  /** The change and its run: a new run is a new offer. */
  key: string;
  changeId: number;
  prNumber: number | null;
  /** How many checks failed in all. */
  total: number;
  /** The first few of them, in the order the suite ran them. */
  checks: Array<{ name: string; reason: string }>;
}

function timeOf(value: string | null | undefined): number {
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? at : NaN;
}

/**
 * The offer the conversation makes now, or null. `busy`: the Mayor or a
 * coding agent is working (the offer waits for it). `unsent`: messages of
 * the person's the server has not shown back yet.
 */
export function fixChecksOffer({ change, busy, messages, unsent = 0 }: {
  change: AgentChange | null | undefined;
  busy: boolean;
  messages: AgentMessage[];
  unsent?: number;
}): FixChecksOffer | null {
  if (!change || busy || unsent > 0) return null;
  if (change.checkState !== 'failing' || !OPEN.has(change.status || '')) return null;
  const failing = change.failingChecks;
  if (!failing || !Array.isArray(failing.checks) || !failing.checks.length) return null;
  // Without the run's time there is no telling whether it was answered.
  const at = timeOf(failing.at);
  if (Number.isNaN(at)) return null;
  const answered = messages.some((message) => message.role === 'user' && timeOf(message.createdAt) >= at);
  if (answered) return null;
  return {
    key: `${change.id}:${failing.at}`,
    changeId: change.id,
    prNumber: change.prNumber || null,
    total: Math.max(Number(failing.total) || 0, failing.checks.length),
    checks: failing.checks,
  };
}

function oneLine(text: string, max = REASON_CHARS) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** "PR #88", or the change, before it has a pull request. */
export function fixChecksWhere(offer: Pick<FixChecksOffer, 'prNumber'>): string {
  return offer.prNumber ? `PR #${offer.prNumber}` : 'this change';
}

/** The offer's heading: "1 check failed on PR #88". */
export function fixChecksHeading(offer: Pick<FixChecksOffer, 'prNumber' | 'total'>): string {
  const n = offer.total;
  return `${n} check${n === 1 ? '' : 's'} failed on ${fixChecksWhere(offer)}`;
}

/**
 * What Fix it sends, as the person's own message: which checks failed and
 * what each reported. The Mayor reads the rest (get_change) and dispatches
 * the coding agent, as it does when the person types the same ask.
 */
export function fixChecksMessage(offer: FixChecksOffer): string {
  const where = fixChecksWhere(offer);
  const head = offer.total === 1
    ? `Please fix the failing check on ${where}.`
    : `Please fix the ${offer.total} failing checks on ${where}.`;
  const lines = offer.checks.map((check) => {
    const reason = check.reason ? oneLine(check.reason) : '';
    return `- "${oneLine(check.name, 200)}"${reason ? `, which reported: ${reason}` : ''}`;
  });
  const more = offer.total - offer.checks.length;
  if (more > 0) lines.push(`- and ${more} more`);
  return [head, '', ...lines].join('\n');
}
