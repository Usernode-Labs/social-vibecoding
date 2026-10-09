/**
 * The Dev board's "merged but not released" banner, as a view model.
 *
 * The platform's own merges do not deploy from the platform: routes/votes.js
 * merges the PR, and the repository's Actions workflow, a Helm release, Argo
 * CD and a rollout do the rest, outside anything this process runs. When one
 * of those fails, the proposal reads "merged" here while production serves
 * the previous commit — #2589 did for half an hour, because one registry
 * connection dropped during the image build, and nobody was told.
 * services/release-watch.js notices the gap (main ahead of the running build
 * past a release's normal time) and records what it found; this banner is
 * where the board says so, in one sentence above the cards, with the run on
 * GitHub to click through to when there is one.
 *
 * Published by `AppView._renderReleaseStallNotice` from the promoted list's
 * `releaseStall` block (routes/votes.js), the same load that feeds the
 * merges-paused banner beside it.
 */

import { t } from '../../lib/i18n/runtime';
import { createStore } from '../../lib/plain-store.js';

export type ReleaseStallKind = 'workflow_failed' | 'workflow_running' | 'rollout_missing' | 'unknown';

export interface ReleaseStallState {
  /** A merged commit has not become the running release. */
  stalled: boolean;
  /** What the watch found — see services/release-watch.js. */
  kind: ReleaseStallKind | null;
  /** The merged commit, abbreviated. */
  sha: string | null;
  /** The PR that merged it, when the squash subject named one. */
  prNumber: number | null;
  /** The build that is serving instead, abbreviated. */
  running: string | null;
  /** The workflow run on GitHub, when one was found (https://github.com/… only). */
  runUrl: string | null;
}

export const releaseStallStore = createStore<ReleaseStallState>({
  stalled: false, kind: null, sha: null, prNumber: null, running: null, runUrl: null,
});

/** The banner's sentence — one spelling, for the frame and its tests. */
/**
 * The banner's sentence, as message ids. One whole message per finding, per
 * way the merge is named (a squash merge names its PR, with or without the
 * commit; a direct push only has the commit), and per whether the build still
 * serving is known: `[without it, with it]`.
 */
type StallSubject = 'prCommit' | 'pr' | 'commit';
const STALL_TEXT: Record<ReleaseStallKind, Record<StallSubject, [string, string]>> = {
  workflow_failed: {
    prCommit: ['project:releaseStall.failed.prCommit', 'project:releaseStall.failed.prCommitRunning'],
    pr: ['project:releaseStall.failed.pr', 'project:releaseStall.failed.prRunning'],
    commit: ['project:releaseStall.failed.commit', 'project:releaseStall.failed.commitRunning'],
  },
  workflow_running: {
    prCommit: ['project:releaseStall.slow.prCommit', 'project:releaseStall.slow.prCommitRunning'],
    pr: ['project:releaseStall.slow.pr', 'project:releaseStall.slow.prRunning'],
    commit: ['project:releaseStall.slow.commit', 'project:releaseStall.slow.commitRunning'],
  },
  rollout_missing: {
    prCommit: ['project:releaseStall.notRolled.prCommit', 'project:releaseStall.notRolled.prCommitRunning'],
    pr: ['project:releaseStall.notRolled.pr', 'project:releaseStall.notRolled.prRunning'],
    commit: ['project:releaseStall.notRolled.commit', 'project:releaseStall.notRolled.commitRunning'],
  },
  unknown: {
    prCommit: ['project:releaseStall.noRun.prCommit', 'project:releaseStall.noRun.prCommitRunning'],
    pr: ['project:releaseStall.noRun.pr', 'project:releaseStall.noRun.prRunning'],
    commit: ['project:releaseStall.noRun.commit', 'project:releaseStall.noRun.commitRunning'],
  },
};

export function releaseStallText(s: Pick<ReleaseStallState, 'kind' | 'sha' | 'prNumber' | 'running'>): string {
  // A squash merge names its PR; a direct push only has the commit.
  const subject: StallSubject = s.prNumber ? (s.sha ? 'prCommit' : 'pr') : 'commit';
  const ids = (s.kind && STALL_TEXT[s.kind]) || STALL_TEXT.unknown;
  return t(ids[subject][s.running ? 1 : 0], {
    pr: s.prNumber || '',
    commit: s.sha || t('project:releaseStall.unknownCommit'),
    running: s.running || '',
  });
}
