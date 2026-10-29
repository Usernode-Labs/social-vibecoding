/**
 * What a link to code, a change or a request is, read from its address.
 *
 * Every repository, pull request, issue and commit link on screen used to be
 * GitHub's, and said so: "View PR on GitHub", "Open on GitHub", the GitHub
 * mark. Since GitHub suspended the account that held the app repositories
 * (25 Oct 2026; docs/plans/github-independence-build.md) that is no longer
 * true of most of them:
 *
 *   - an app's repository is on Homeroom's own git host (`apps.repo_url`,
 *     e.g. https://git.onhomeroom.com/apps/<repo>), and so are its commits;
 *   - a request's `htmlUrl` is its own page in Homeroom
 *     (`https://<domain>/#app/<slug>/dev/issues/<n>`, or `/#app/…` where the
 *     server has no domain), never GitHub;
 *   - a proposal's `pr_url` is its change page
 *     (`…/#app/<slug>/dev/changes/<N>`), except for the platform's own
 *     repository, which stays on GitHub, and old rows.
 *
 * So a site decides by the address, through `linkKind`:
 *
 *   'github'    a github.com page. It keeps its GitHub label and mark.
 *   'homeroom'  a page of Homeroom itself. Not an outbound link: where the
 *               viewer is already on it, or on something that opens it, it
 *               is not drawn as a link at all; elsewhere it is an in-app link
 *               (`homeroomRoute`) with a plain label.
 *   'code'      any other web address: the git host's repository or commit
 *               page. Labelled as code ("View code", "Code") with a neutral
 *               code mark.
 *   null        nothing usable (empty, or not http(s)): no link.
 *
 * Plain JS with no import, like ./plain-store.js: classic scripts under
 * public/js cannot import from the bundle, so the module also publishes
 * itself as `window.RepoLink` (main.tsx imports it before anything renders),
 * and a test that evaluates a module in a vm can run its text with the
 * `export`s stripped.
 */

const GITHUB_HOST = /^(?:www\.)?github\.com$/i;

/** @param {unknown} url */
function text(url) {
  return typeof url === 'string' ? url.trim() : '';
}

/** @param {string} s */
function webUrl(s) {
  let u;
  try { u = new URL(s); } catch { return null; }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
}

/**
 * The in-app route (`#app/…`) a Homeroom page's address names, else null.
 * @param {unknown} url
 * @returns {string | null}
 */
export function homeroomRoute(url) {
  const s = text(url);
  if (!s) return null;
  if (s.startsWith('#app/')) return s;
  if (s.startsWith('/#app/')) return s.slice(1);
  const u = webUrl(s);
  if (!u || GITHUB_HOST.test(u.hostname)) return null;
  return (u.pathname === '/' || u.pathname === '') && u.hash.startsWith('#app/') ? u.hash : null;
}

/**
 * 'github' | 'homeroom' | 'code', or null for nothing usable. See the header.
 * @param {unknown} url
 * @returns {'github' | 'homeroom' | 'code' | null}
 */
export function linkKind(url) {
  if (homeroomRoute(url)) return 'homeroom';
  const u = webUrl(text(url));
  if (!u) return null;
  return GITHUB_HOST.test(u.hostname) ? 'github' : 'code';
}

/** @param {unknown} url */
export function isGithubUrl(url) {
  return linkKind(url) === 'github';
}

// An address that names a repository: a web address with an owner and a name
// after its host, or the short SSH form git reads (`git@host:owner/name.git`).
// The host is not asked about here — app repositories live on Homeroom's own
// git host, on GitHub and on other git servers alike (#5940) — only that the
// address has an owner and a name. src/services/repo-ref.js is the server's
// own parser and the real gate; this is the browser's copy of the same
// question, used by Suggest an improvement and comment mode.
const REPO_WEB = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+/i;
const REPO_SSH = /^[^\s/@]+@[^/\s:]+:[^/\s]+\/[^/\s]+(?:\.git)?$/;

/** @param {unknown} url */
export function namesRepo(url) {
  const s = text(url);
  return !!s && (REPO_WEB.test(s) || REPO_SSH.test(s));
}

/**
 * An anchor's attributes for `url`: a Homeroom page opens in place, at its
 * route; anything else in a new tab, with no handle on this window. Null when
 * it is no link.
 * @param {unknown} url
 * @returns {{ href: string, target?: string, rel?: string } | null}
 */
export function linkAttrs(url) {
  const kind = linkKind(url);
  if (!kind) return null;
  if (kind === 'homeroom') return { href: /** @type {string} */ (homeroomRoute(url)) };
  return { href: text(url), target: '_blank', rel: 'noopener' };
}

/**
 * A request's page in Homeroom, `#app/<slug>/dev/issues/<n>`: where a
 * request is, for every app (requests are Homeroom's own rows), whatever host
 * the app's code is on. '' without a slug or a number.
 * @param {unknown} slug
 * @param {unknown} number
 */
export function requestRoute(slug, number) {
  const n = Number(number);
  const s = text(slug);
  return s && Number.isInteger(n) && n > 0 ? `#app/${encodeURIComponent(s)}/dev/issues/${n}` : '';
}

const RepoLink = { linkKind, homeroomRoute, isGithubUrl, linkAttrs, requestRoute, namesRepo };

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).RepoLink = RepoLink;
}

export default RepoLink;
