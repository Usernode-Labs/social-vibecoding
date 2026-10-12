/**
 * What the About pane SAYS — pure, so the wording is pinned by tests with
 * plain objects rather than by a browser.
 *
 * ── How it is built: one warm line, the mechanics a tap away (#4218) ────
 *
 * The note under the actions used to spell out the app's approval regime —
 * who may suggest, which votes count, an admin's yes on a locked app, the
 * checks — assembled per app so it stayed true for each of the three regimes
 * the platform runs (services/governance.js). It was accurate and it was the
 * longest thing a newcomer read on the pane. It says who builds it now, and
 * the pane links "How changes work" to the app's Workshop, where the voting
 * help (../dev-board/voting-help.tsx) spells the rules out for THIS app.
 */

import { t } from '../../lib/i18n/runtime';

export type AppRow = Record<string, any>;

/** The build line under an app's actions: "Notes’s community builds it together." */
export function appNote(name: string | null | undefined): string {
  const who = typeof name === 'string' && name.trim() ? name.trim() : '';
  return who
    ? t('agent:appContext.about.note.app', { app: who })
    : t('agent:appContext.about.note.thisApp');
}

/**
 * The platform's line. `restricted` when this viewer is not served its row:
 * they cannot open its workshop either, so the line says so rather than
 * leaving them a link the platform would refuse.
 */
export function platformNote(name: string | null | undefined, restricted: boolean): string {
  const who = typeof name === 'string' && name.trim() ? name.trim() : 'Homeroom';
  return restricted
    ? t('agent:appContext.about.note.platformRestricted', { name: who })
    : t('agent:appContext.about.note.platform', { name: who });
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

/**
 * The pill beside the builders' avatars (#4218): how many people are in the
 * app's community, since the avatars stop at four. Nothing for none or an
 * unknown count: a zero says nothing.
 */
export function membersPillText(count: unknown): string | null {
  const n = typeof count === 'number' ? count : parseInt(String(count ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return t('agent:appContext.about.members', { count: n, formatted: n.toLocaleString() });
}

/**
 * The version, as a plain row under More (#4218): "App version: a1b2c3d".
 * The platform names a version by its commit, as every version surface here
 * does. While a new build deploys, it says so; with no version, no row.
 */
export function versionRowText(version: string | null, deploying: boolean, platform: boolean): string | null {
  if (deploying) {
    if (version) {
      return platform
        ? t('agent:appContext.about.version.platformDeploying', { version })
        : t('agent:appContext.about.version.appDeploying', { version });
    }
    return platform
      ? t('agent:appContext.about.version.platformDeployingOnly')
      : t('agent:appContext.about.version.appDeployingOnly');
  }
  if (!version) return null;
  return platform
    ? t('agent:appContext.about.version.platform', { version })
    : t('agent:appContext.about.version.app', { version });
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
    { key: 'apps', value: apps.toLocaleString(), label: t('agent:appContext.about.stat.apps', { count: apps }) },
    { key: 'members', value: members.toLocaleString(), label: t('agent:appContext.about.stat.members', { count: members }) },
    { key: 'merged', value: merged.toLocaleString(), label: t('agent:appContext.about.stat.live', { count: merged }) },
  ];
}

export interface ContributorView { who: string; initial: string; merged: number }

/**
 * One contributor row, from GET /api/apps/:slug/contributors' shape — the
 * payload Discover's app page reads (../apps/browse.js contributorRowView).
 */
export function contributorView(c: AppRow | null | undefined): ContributorView {
  const who = (c && typeof c.username === 'string' && c.username) || t('agent:appContext.about.contributor.unknown');
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
  if (canOpen) return { label: parked ? t('agent:appContext.about.open.resume') : t('agent:appContext.about.open.open'), canOpen };
  if (status === 'creating') return { label: t('agent:appContext.about.open.spinningUp'), canOpen };
  if (status === 'error') return { label: t('agent:appContext.about.open.notRunning'), canOpen };
  return { label: status || t('agent:appContext.about.open.unavailable'), canOpen };
}
