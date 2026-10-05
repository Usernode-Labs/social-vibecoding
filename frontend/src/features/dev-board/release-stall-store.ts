import { t as tr } from "../../lib/i18n/runtime";
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
    ? tr("workshop:pr_value1_value2_merged_07ad1dfc", { value1: s.prNumber, value2: s.sha ? ` (${s.sha})` : '' })
    : tr("workshop:commit_value1_landed_on_main_8e007a6b", { value1: s.sha || tr("workshop:message_8fe7794d43e7") });
  const running = s.running ? tr("workshop:the_platform_is_still_running_value1_6eed9a1e", { value1: s.running }) : '';
  switch (s.kind) {
    case 'workflow_failed':
      return tr("workshop:value1_but_was_not_released_its_release_workflow_430b4fad", { value1: merged, value2: running })
        + tr("workshop:run_it_on_main_to_release_the_latest_commit_a_la_0e7cf1b9");
    case 'workflow_running':
      return tr("workshop:value1_and_its_release_workflow_is_still_running_724ba8ad", { value1: merged, value2: running });
    case 'rollout_missing':
      return tr("workshop:value1_and_its_release_workflow_succeeded_but_th_b1b69096", { value1: merged, value2: running });
    default:
      return tr("workshop:value1_but_is_not_running_yet_and_no_release_wor_9bf4277a", { value1: merged, value2: running });
  }
}
