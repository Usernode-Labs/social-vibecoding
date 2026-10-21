/**
 * #4367: the in-app link to a change. One with a pull request is addressed by
 * its number (`#app/<slug>/dev/changes/<N>`, the "Change #N" on screen); one
 * without, such as a draft or a plan, by its session id. The topic page
 * redirects an old session-id link of a change with a pull request to the
 * same form, so a caller without the number still lands right.
 *
 * The slug is encoded here; pass it raw. The server's twin is
 * `changeHref` in src/services/change-destination.js.
 */
export function changeHref(slug: string, sessionId: number | string | null | undefined,
  prNumber?: number | string | null): string {
  const base = `#app/${encodeURIComponent(String(slug || ''))}/dev`;
  const pr = Number(prNumber);
  return Number.isInteger(pr) && pr > 0
    ? `${base}/changes/${pr}`
    : `${base}/proposals/${Number(sessionId)}`;
}
