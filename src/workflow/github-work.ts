// GitHub I/O shared by the machines' work handlers.

import type { Json, WorkContext } from './kernel/index.ts';
import { legacy } from './legacy.ts';

import { permanent } from './work-errors.ts';

export { missingSecrets, permanent } from './work-errors.ts';
export const gone = (err: any) => err?.status === 404 || err?.status === 410;
// GitHub work retries from 30 s, doubling, up to 30 min apart.
export const backoff = (attempt: number) => Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** (attempt - 1));
// How far before an attempt's own clock reading to look for its comment.
const COMMENT_LOOKBACK_MS = 10 * 60 * 1000;

// Close an issue or pull request, then comment on it. Each step is
// checkpointed. A reply GitHub never delivered can still hide a comment it
// created, so the comment carries a marker, and a retry that may have posted
// it looks for the marker before posting again. A thing already gone counts
// as closed. `what` names the GitHub call, written out below so the list of
// what the machines call (tests/lib/workflow-boundary.js) can read it.
export async function closeAndComment(
  { input, resumeFrom, checkpoint }: Pick<WorkContext, 'input' | 'resumeFrom' | 'checkpoint'>,
  what: 'issue' | 'pullRequest' | 'reopenIssue',
): Promise<Json> {
  const gh = legacy('services/github');
  if (!gh.isEnabled()) throw permanent('GitHub is not configured');
  // `commenting` is when an attempt started posting the comment.
  const done = (resumeFrom || {}) as { closed?: boolean; commenting?: string | boolean; commented?: boolean };
  if (!done.closed) {
    try {
      if (what === 'issue') await gh.closeIssue(input.owner, input.repo, input.number);
      else if (what === 'reopenIssue') await gh.reopenIssue(input.owner, input.repo, input.number);
      else await gh.closePR(input.owner, input.repo, input.number);
    } catch (err) {
      if (gone(err)) return { gone: true };
      throw err;
    }
    await checkpoint({ closed: true });
  }
  if (input.comment && !done.commented) {
    const marker = input.marker ? `<!-- ${input.marker} -->` : null;
    let posted = false;
    if (done.commenting && marker) {
      // A comment that attempt created is newer than it, so read only the
      // comments since then (less a margin for clocks). A thread still too
      // long to read whole cannot say; try again later.
      const started = typeof done.commenting === 'string' ? Date.parse(done.commenting) : NaN;
      const since = Number.isFinite(started) ? new Date(started - COMMENT_LOOKBACK_MS).toISOString() : null;
      const thread = await gh.fetchIssueComments(input.owner, input.repo, input.number, { since });
      if (thread.note) throw new Error(`Could not read the issue's comments: ${thread.note}`);
      posted = thread.comments.some((c: { body?: string }) => String(c.body || '').includes(marker));
      if (!posted && thread.truncated) throw new Error('Could not read every recent comment to look for the earlier one');
    }
    if (!posted) {
      await checkpoint({ closed: true, commenting: new Date().toISOString() });
      await gh.createIssueComment(input.owner, input.repo, input.number,
        marker ? `${input.comment}\n\n${marker}` : input.comment);
    }
    await checkpoint({ closed: true, commented: true });
  }
  return { closed: true };
}
