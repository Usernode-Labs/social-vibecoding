/**
 * What the About pane SAYS — pure, so the wording is pinned by tests with
 * plain objects rather than by a browser.
 *
 * ── The note is one sentence, about WHO builds it ──────────────────────
 *
 * "Supply Line’s community builds it together." The pane's job with a
 * newcomer is to say what an app is and who makes it; how the group's
 * approvals, votes and checks work is the Workshop's "How voting works"
 * popover (../dev-board/voting-help.tsx), a tap away for anyone who wants
 * them. The sentence is the same for every approval regime and for a viewer
 * who cannot propose, because it no longer describes the rules — so it takes
 * the app's NAME and nothing else from the row.
 */

export type AppRow = Record<string, any>;

/** The note under an app's actions: the community builds it together. */
export function appNote(name: string): string {
  return `${name}’s community builds it together.`;
}

/** The platform's note: the same sentence, about Homeroom itself. */
export function platformNote(name: string): string {
  return `${name}’s community builds it together.`;
}

/**
 * "14 members" beside the builders' avatars — the count the apps list
 * already carries for every row (GET /api/apps: member_count). Null when the
 * count is not a positive integer: no members yet, or the row has not landed
 * (a cold tab reads the list a moment later, and the line appears then).
 */
export function membersText(row: AppRow | null | undefined): string | null {
  const raw = row ? row.member_count : null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(n) || n < 1) return null;
  return n === 1 ? '1 member' : `${n.toLocaleString()} members`;
}

/** The app's tagline: its manifest's one-line description (HomePanels.appBlurb's rule). */
export function taglineOf(row: AppRow | null | undefined): string | null {
  const snap = row && row.manifest_snapshot;
  const raw = snap && typeof snap === 'object' ? snap.description : null;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 160) : null;
}

/** The short SHA of what is running, from either payload shape. */
export function shortVersionOf(row: AppRow | null | undefined): string | null {
  if (!row) return null;
  if (row.version && typeof row.version === 'object' && row.version.shortSha) {
    return String(row.version.shortSha);
  }
  return row.main_sha ? String(row.main_sha).slice(0, 7) : null;
}

export interface StatCard { key: 'apps' | 'members' | 'merged'; value: string; label: string }

/** About Homeroom's three cards, in the design's order. */
export function statCards(stats: { apps?: number; members?: number; merged?: number } | null): StatCard[] {
  const n = (v: unknown) => {
    const x = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const s = stats || {};
  const apps = n(s.apps);
  const members = n(s.members);
  const merged = n(s.merged);
  return [
    { key: 'apps', value: apps.toLocaleString(), label: apps === 1 ? 'app' : 'apps' },
    { key: 'members', value: members.toLocaleString(), label: members === 1 ? 'member' : 'members' },
    { key: 'merged', value: merged.toLocaleString(), label: 'live' },
  ];
}

export interface ContributorView { who: string; initial: string; merged: number }

/**
 * One contributor row, from GET /api/apps/:slug/contributors' shape — the
 * payload Discover's app page reads (../apps/browse.js contributorRowView).
 */
export function contributorView(c: AppRow | null | undefined): ContributorView {
  const who = (c && typeof c.username === 'string' && c.username) || 'unknown';
  const merged = parseInt(String(c ? c.merged_count : 0), 10) || 0;
  return { who, initial: (who[0] || '?').toUpperCase(), merged };
}

/**
 * The Open button's words, the way Discover's app page words them
 * (../apps/browse.js _renderDetail): Resume for the app you left, Open for
 * one that can open, and the reason for one that cannot.
 */
export function openLabel(status: string | null | undefined, parked: boolean): { label: string; canOpen: boolean } {
  const canOpen = status === 'running' || status === 'awaiting_secrets';
  if (canOpen) return { label: parked ? 'Resume' : 'Open', canOpen };
  if (status === 'creating') return { label: 'Spinning up…', canOpen };
  if (status === 'error') return { label: 'Not running', canOpen };
  return { label: status || 'Unavailable', canOpen };
}
