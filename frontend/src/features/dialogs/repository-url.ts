/**
 * Canonicalise a repository address before the import flow verifies or
 * submits it. Explicit schemes stay untouched so the server can reject
 * unsupported protocols through its existing validation path. The SSH form
 * is also preserved because parseGithubUrl has always accepted it.
 */
import { normalizeSchemeLessUrl } from '../../lib/url';

const GITHUB_SSH = /^git@github\.com:/i;

export function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim();
  if (GITHUB_SSH.test(trimmed)) return trimmed;
  return normalizeSchemeLessUrl(trimmed);
}
