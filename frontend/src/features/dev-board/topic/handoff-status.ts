/**
 * What Homeroom knows of a person's own coding agent on a project
 * (GET /api/apps/:slug/dev-flow/status): whether it can see their connector,
 * and their fork of the project once it is ready. Read by "Build it with your
 * own Claude Code" (./own-agent-link.tsx), once it is opened.
 */

export interface HandoffStatus {
  connectors?: { count?: number };
  fork?: { state?: string; owner?: string; repo?: string; url?: string; pageUrl?: string } | null;
  [key: string]: unknown;
}

/** Rejects when the read fails; the caller's link works without it. */
export async function handoffStatus(slug: string): Promise<HandoffStatus> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/dev-flow/status`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(String(response.status));
  return await response.json() as HandoffStatus;
}
