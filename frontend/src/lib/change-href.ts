/**
 * #4367/#6718: the in-app link to a change. One with a pull request is
 * addressed by its number, followed by its own session id when the caller
 * knows it (`#app/<slug>/dev/changes/<N>/<sessionId>`, the "Change #N" on
 * screen). The id is what makes the link open THAT change: several changes
 * can share one pull request number (#6482), so a number alone can resolve to
 * another of them. A caller that knows only the number gets
 * `#app/<slug>/dev/changes/<N>`, and one without a pull request — a draft or
 * a plan — its session id alone. The topic page redirects an old session-id
 * link of a change with a pull request to the same form, so a caller without
 * the number still lands right.
 *
 * The slug is encoded here; pass it raw. The server's twin is
 * `changeHref` in src/services/change-destination.js.
 */
export function changeHref(slug: string, sessionId: number | string | null | undefined,
  prNumber?: number | string | null): string {
  const base = `#app/${encodeURIComponent(String(slug || ''))}/dev`;
  const pr = Number(prNumber);
  if (Number.isInteger(pr) && pr > 0) {
    const id = Number(sessionId);
    return Number.isInteger(id) && id > 0
      ? `${base}/changes/${pr}/${id}`
      : `${base}/changes/${pr}`;
  }
  return `${base}/proposals/${Number(sessionId)}`;
}
