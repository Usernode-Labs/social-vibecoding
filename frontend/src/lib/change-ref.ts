/**
 * How a change's number is written, by where the project's code is hosted.
 *
 * On Homeroom's own git host a project's requests and changes share one
 * counter, so a number names one thing and `#N` is right for both. On GitHub
 * the pull request counter is GitHub's own and drifts past the request
 * numbers (src/services/pr-metadata.js says why), so a change written `#6230`
 * could be read as request #6230. There a change reads `PR 6230`, and `#N` is
 * only ever a request. Homeroom's own repository is still on GitHub.
 *
 * The answer comes from the repository address the app already holds
 * (`appData.repo_url`), never a new stored field. A missing address counts as
 * not GitHub, which keeps today's `#N`.
 */

import { isGithubUrl } from './repo-link.js';

/** Whether a project's code, at `repoUrl`, is on GitHub. */
export function changesOnGithub(repoUrl: unknown): boolean {
  return isGithubUrl(repoUrl);
}

/** Whether the open project's code is on GitHub (AppView.appData.repo_url). */
export function projectChangesOnGithub(): boolean {
  if (typeof window === 'undefined') return false;
  const appData = (window as any).AppView?.appData;
  return changesOnGithub(appData?.repo_url);
}

/**
 * A stored line's `PR #1234` written `PR 1234`, for display only. System
 * lines keep `PR #N` in the database because readers there match on it; the
 * screens show the number without the `#`, so it cannot be read as a request.
 */
export function plainPrRefs(text: string): string {
  return String(text).replace(/\bPR #(\d+)/g, 'PR $1');
}
