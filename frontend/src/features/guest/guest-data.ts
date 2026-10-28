/**
 * The data behind the guest Discover and the guest project page: what a
 * visitor with no account reads (./guest-discover.tsx, ./guest-project.tsx).
 *
 * Both read the public API only. The directory is GET /api/public/apps,
 * which the landing already loads (features/auth/landing.tsx
 * loadLandingApps); a project's page adds GET /api/public/apps/:slug/overview
 * (src/services/public-project.js). Neither carries a person's name.
 *
 * Everything here is pure except the one fetch, so the sorting and filtering
 * Discover does are unit-tested (tests/guest-discover.test.js).
 */

import { isNative, type PublicApp } from '../auth/shared';

/** A row of GET /api/public/apps, with the fields the guest pages read. */
export interface GuestApp extends PublicApp {
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  featured?: boolean;
  featured_order?: number | null;
  icon_color?: string | null;
  illustration_url?: string | null;
  illustration_dark_url?: string | null;
  active_users?: number;
  member_count?: number;
  open_votes?: number;
  /** How many of its changes the group voted in and are live. */
  merged_count?: number;
  /** The title of the last of them, or null (none, or one still called by its placeholder). */
  latest_change?: string | null;
  /** How many of them went live in the last seven days. */
  merged_week?: number;
  created_at?: string | null;
  last_deploy_at?: string | null;
  last_merged_at?: string | null;
  guest_ready?: boolean;
  contributors?: unknown[];
}

export interface GuestVote {
  id: number;
  pr_number: number | null;
  title: string | null;
  summary: string | null;
  yes: number;
  no: number;
  /**
   * Its before and after, where anybody may see them (src/services/
   * shots-public.js): a phone still the shots agent said shows nobody's
   * private things. `before` is null for a new app's first change.
   */
  pictures?: { before: string | null; after: string } | null;
}

export interface GuestMerged {
  id: number;
  title: string | null;
  summary: string | null;
  merged_at: string | null;
}

export interface GuestOverview {
  app: GuestApp & { builders: number };
  votes: GuestVote[];
  merged: GuestMerged[];
  requests: { total: number; more: boolean; items: { number: number; title: string }[] } | null;
}

/**
 * New accounts start on the waitlist: one made from these pages has no
 * platform access until it is let in (src/services/email-signup.js
 * isWaitlisted), and nothing on the server switches that off for everyone.
 * The guest pages say so where somebody is about to make one: the hero's
 * button ("Join the waitlist") and the sheets for taking part on a
 * project's page. One switch for both, so the day
 * Homeroom lets everyone in (Evan: about four weeks from 21 Oct 2026) is
 * this line.
 */
export const NEW_ACCOUNTS_WAIT = true;

/** The sorts Discover offers, in the order its control shows them. */
export const SORTS = ['trending', 'new', 'built'] as const;
export type GuestSort = (typeof SORTS)[number];

/**
 * The kinds of app, in app-manifest.js APP_CATEGORIES order (the same list
 * Discover's type chips use, features/apps/browse.js CATEGORIES). Only the
 * kinds some app in the directory has get a chip (presentCategories).
 */
export const CATEGORIES = ['games', 'social', 'tools', 'learning', 'creative', 'other'] as const;

/** How many people built it: the directory's contributors, counted. */
export function buildersOf(app: GuestApp): number {
  return Array.isArray(app.contributors) ? app.contributors.length : 0;
}

/** Newest first by when it was made; an app with no date sorts last. */
function createdAt(app: GuestApp): number {
  const t = app.created_at ? Date.parse(app.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * The directory in a sort's order, and only that: Popular is the most people
 * active first, whether or not a visitor can try it. Putting the tryable
 * first (21 Oct 2026) led the list with test and diagnostic apps nobody
 * uses, above a game 42 people play (Evan's review of the live page, 21 Oct
 * 2026); what a visitor can try is Featured's job, and its cards carry Try
 * it wherever they sort. Ties keep the directory's own order.
 */
export function sortApps(apps: readonly GuestApp[], sort: GuestSort): GuestApp[] {
  const indexed = apps.map((app, i) => ({ app, i }));
  const key = (app: GuestApp): number => {
    if (sort === 'new') return createdAt(app);
    if (sort === 'built') return buildersOf(app);
    return app.active_users || 0;
  };
  indexed.sort((a, b) => key(b.app) - key(a.app) || a.i - b.i);
  return indexed.map((x) => x.app);
}

/** The kinds of app the directory has, in CATEGORIES order. */
export function presentCategories(apps: readonly GuestApp[]): string[] {
  const have = new Set(apps.map((a) => a.category).filter(Boolean) as string[]);
  // A row of All and Other alone would sort nothing (the same rule as
  // Discover's own type chips).
  if (![...have].some((c) => c !== 'other')) return [];
  return CATEGORIES.filter((c) => have.has(c));
}

/** What a search and a kind leave of the directory. */
export function filterApps(apps: readonly GuestApp[], query: string, category: string | null): GuestApp[] {
  const q = query.trim().toLowerCase();
  return apps.filter((a) => {
    if (category && a.category !== category) return false;
    if (!q) return true;
    return `${a.name} ${a.description || ''}`.toLowerCase().includes(q);
  });
}

/**
 * The Featured row: what an admin featured (Admin › Featured apps) that a
 * visitor can try, in their order, and nothing else. A project a visitor
 * cannot open is never featured to them: Featured is where playing starts.
 * It is no longer filled up to three with the most active tryable projects:
 * on production those were a test app and a one-player demo (Evan, 21 Oct
 * 2026), so the row is curated by hand, and with nothing featured to try it
 * is not drawn.
 */
export function featuredApps(apps: readonly GuestApp[], tryable: (app: GuestApp) => boolean = () => true): GuestApp[] {
  return apps
    .filter((a) => a.featured && tryable(a))
    .slice()
    .sort((a, b) => (a.featured_order ?? Number.MAX_SAFE_INTEGER) - (b.featured_order ?? Number.MAX_SAFE_INTEGER));
}

/**
 * A count shows only when it is big enough to read as busy (a public app's
 * median is one person active, and a card that says "1 person active" reads
 * as a project nobody uses). Under these, a card says what changed lately.
 */
export const MIN_MEMBERS = 25;
export const MIN_ACTIVE = 10;
export const MIN_BUILDERS = 5;
/** "Updated …" reaches this far back; older says nothing. */
export const UPDATED_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A change the platform made to every app at once (a licence, a README, a
 * dependency bump) is not what a project is about, so a card that has no
 * description of its own does not describe itself with one (28 Oct 2026:
 * four of the eight big cards said "Add an MIT LICENSE to every existing
 * app (#5120)"). The card shows its facts instead.
 */
const HOUSEKEEPING = /\b(licen[cs]e|readme|changelog|\.gitignore|dependenc|bump|every existing app|all existing apps)\b/i;
export function isHousekeepingChange(title: string | null | undefined): boolean {
  return !!title && HOUSEKEEPING.test(title);
}

/** A merged change's title as a person reads it: no "(#5120)" at the end, which only GitHub can follow. */
export function cleanChangeTitle(title: string): string {
  return title.replace(/\s*\(#\d+\)\s*$/, '').trim();
}

/** What a card may say about the project when it has no description: its latest change, unless that was housekeeping. */
export function latestRealChange(app: Pick<GuestApp, 'latest_change'>): string {
  const title = app.latest_change;
  return title && !isHousekeepingChange(title) ? cleanChangeTitle(title) : '';
}

/**
 * What the directory adds up to, for the line under the hero: how many
 * projects, how many changes their groups voted in this week, and how many
 * votes are open right now. Only the figures that are not zero are said.
 */
export function directorySummary(apps: readonly GuestApp[] | null): { apps: number; week: number; votes: number } | null {
  if (!apps || !apps.length) return null;
  let week = 0;
  let votes = 0;
  for (const a of apps) {
    week += a.merged_week || 0;
    votes += a.open_votes || 0;
  }
  return { apps: apps.length, week, votes };
}

/**
 * Whether "Try it" can open the app for this visitor, here. An app that needs
 * no credential at all opens in the landing's own viewer, anywhere. One that
 * shows a guest its view only at its own address (`guest_ready` without
 * `requires_login === false`) opens there by leaving the page, which a phone
 * or desktop browser can come back from; inside the Homeroom app it cannot:
 * the web view has no back of its own, so leaving for the app's address
 * strands the visitor there (landing.tsx's viewer says the same of
 * target=_blank). In the app such a project says "Sign in to use it".
 */
export function canTryHere(app: GuestApp, inApp: boolean): boolean {
  if (app.requires_login === false) return true;
  return !!app.guest_ready && !inApp;
}

/** Inside the Homeroom app (its bridge is there); never during a server render. */
export function inHomeroomApp(): boolean {
  return typeof window !== 'undefined' && isNative();
}

/** Where a project's page is: its hub, the address a signed-in person lands on too. */
export function projectHash(slug: string): string {
  return `#app/${encodeURIComponent(slug)}/workshop`;
}

/**
 * The same page's clean address, `/app/<slug>`: the one Share copies, the
 * server answers with the project's own title and preview
 * (src/routes/project-preview.js), the sitemap lists and the page names as
 * its canonical. Discover's cards link here so a search engine following
 * them finds one address per project; everything after a `#` is invisible
 * to it.
 */
export function projectPath(slug: string): string {
  return `/app/${encodeURIComponent(slug)}`;
}

/**
 * The same page at its changes up for a vote: the Workshop, the place a
 * signed-in person's `?ws=workshop` opens too (dev-board places.ts placeHref).
 */
export function projectVotesHash(slug: string): string {
  return `${projectHash(slug)}?ws=workshop`;
}

/** Whether a project link names its Workshop (projectVotesHash) rather than its hub. */
export function linksToWorkshop(target: string): boolean {
  return /[?&]ws=workshop(?:&|$)/.test(String(target || ''));
}

/** A project's overview, or null when it is not public (404) or cannot be read. */
export async function fetchOverview(slug: string): Promise<GuestOverview | null> {
  try {
    const res = await fetch(`/api/public/apps/${encodeURIComponent(slug)}/overview`);
    if (!res.ok) return null;
    return (await res.json()) as GuestOverview;
  } catch {
    return null;
  }
}
