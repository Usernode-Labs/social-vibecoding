// A GitHub repository URL as the platform accepts it: https (with or
// without www, a trailing slash or .git) or the ssh spelling.

// Parse the variants we want to accept from the user. Returns
// { owner, repo } or null. We deliberately don't accept arbitrary git
// hosts: this is GitHub-specific to match the rest of the platform.
export function parseGithubUrl(input: unknown): { owner: string; repo: string } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  // Match the create-app field's helpful default on the server so direct or
  // stale clients get the same result. Preserve explicit schemes so invalid
  // protocols remain invalid, and preserve the long-supported SSH spelling.
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(s);
  const normalized = !hasScheme && !/^git@github\.com:/i.test(s)
    ? `https://${s}`
    : s;

  // Strip an optional .git suffix and any trailing slash so all four URL
  // shapes (https, https/, https.git, ssh) collapse to "owner/repo".
  const cleaned = normalized.replace(/\.git$/i, '').replace(/\/+$/, '');

  // https://github.com/owner/repo
  let m = cleaned.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (!m) {
    // git@github.com:owner/repo
    m = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  }
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  // Guard against query strings or fragments leaking into the repo name.
  if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) return null;
  return { owner, repo };
}
