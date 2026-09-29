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
export function releaseStallText(s: Pick<ReleaseStallState, 'kind' | 'sha' | 'prNumber' | 'running'>): string {
  // A squash merge names its PR; a direct push only has the commit.
  const merged = s.prNumber
    ? `PR #${s.prNumber}${s.sha ? ` (${s.sha})` : ''} merged`
    : `Commit ${s.sha || '(unknown)'} landed on main`;
  const running = s.running ? ` The platform is still running ${s.running}.` : '';
  switch (s.kind) {
    case 'workflow_failed':
      return `${merged} but was not released: its release workflow did not complete.${running}`
        + ' Run it on main to release the latest commit; a later merge would also carry this change.';
    case 'workflow_running':
      return `${merged} and its release workflow is still running, well past the usual couple of minutes.${running}`;
    case 'rollout_missing':
      return `${merged} and its release workflow succeeded, but the platform has not rolled onto it.${running}`;
    default:
      return `${merged} but is not running yet, and no release workflow run could be found for it.${running}`;
  }
}
