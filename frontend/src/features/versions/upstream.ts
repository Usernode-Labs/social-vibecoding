/**
 * VERSIONS, the client's side (docs/plans/versions.md).
 *
 * Every copy of a project is a VERSION of one ORIGINAL. The original's
 * changes are given to each version that gets its updates, as an ordinary
 * change the version's own group tries and votes on; a version can send its
 * own changes back as a suggestion. On screen that is "your version", "Made
 * from Tier list", "Update from Tier list", "Skip this update" and "Suggest
 * to Tier list"; the code and the routes keep `upstream`, `fork` and
 * `suggest-back`, which nobody reads.
 *
 * This module holds what three surfaces share, so they agree:
 *
 *   - the hub's Update card and From its versions
 *     (../dev-board/workshop/hub-cards.tsx);
 *   - the ⋯'s "Updates from <original>" sheet (./updates-sheet.tsx);
 *   - an update's own page, its Skip and its Ask Homeroom bot to fit it
 *     (../dev-board/topic/change-head.tsx).
 *
 * ── The reads ───────────────────────────────────────────────────────────
 *
 * GET /api/apps/:slug/upstream (a version's side) and GET
 * /api/apps/:slug/versions (an original's hub), one record per slug, shared
 * the way the hub's community record is: read in an effect, never during a
 * render (the island rule), and kept for the page so a hub drawn again draws
 * at once. Every POST below answers the upstream body again, which replaces
 * the record and redraws every reader. A field the server leaves out is
 * read as nothing: an older server draws no card rather than a broken one.
 *
 * The hub's `?shot=hub-version` and `?shot=hub-original`
 * (../dev-board/workshop/hub-shot.ts) answer both reads with made-up states,
 * for the before and after shots; nothing is fetched then.
 */

import { useEffect, useReducer } from 'react';

import { t as translate } from '../../lib/i18n/runtime';
import { hubShot, hubShotUpstream, hubShotVersions } from '../dev-board/workshop/hub-shot';

/** What an update does, read off the original's own diff (never the bot's words). */
export interface UpstreamFacts {
  tablesAdded?: string[];
  destructive?: string[];
  hostsAdded?: string[];
  secretsAdded?: string[];
  ai?: boolean;
  storage?: boolean;
}

/** The version's own changes the update keeps: up to three titles and how many in all. */
export interface UpstreamKeeps {
  count: number;
  titles: string[];
}

export type UpstreamOfferState = 'available' | 'open' | 'needs_fit' | 'skipped' | 'merged' | 'failed';

export interface UpstreamOffer {
  state: UpstreamOfferState;
  sessionId: number | null;
  /** The update's change page (changeHref), once it is a change. */
  href: string | null;
  fromSha: string | null;
  brings: Array<{ title: string }>;
  facts: UpstreamFacts | null;
  keeps: UpstreamKeeps | null;
  conflicts: string[];
}

/** GET /api/apps/:slug/upstream: where a version stands with its original. */
export interface UpstreamState {
  /** Versions are switched on for the platform (Admin › Limits › Versions). */
  enabled: boolean;
  original: { slug: string; name: string; emoji?: string | null; iconUrl?: string | null } | null;
  following: boolean;
  share: boolean;
  canManage: boolean;
  /** The version is private, so its ⋯ offers "Share what we make". */
  private: boolean;
  /** The original moved on since the version last took its changes. */
  behind: boolean;
  offer: UpstreamOffer | null;
}

/** GET /api/apps/:slug/versions: what comes back to an original from its versions. */
export interface VersionsSummary {
  count: number;
  following: number;
  suggestions: Array<{ sessionId: number | null; href: string | null; title: string; from: { slug: string; name: string } | null }>;
  lately: { versions: number; changes: number; rows: Array<{ title: string; from: { slug: string; name: string } | null; at?: string | null }> } | null;
  lastUpdate: { offered: number; took: number; skipped: number; deciding: number } | null;
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);
const count = (value: unknown): number => Math.max(0, Math.floor(Number(value) || 0));
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A server's upstream body, read defensively. Null for anything that is not one. Pure. */
export function readUpstreamBody(raw: unknown): UpstreamState | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, any>;
  const original = b.original && typeof b.original === 'object' && text(b.original.slug)
    ? { slug: text(b.original.slug), name: text(b.original.name) || text(b.original.slug), emoji: b.original.emoji || null, iconUrl: b.original.iconUrl || null }
    : null;
  const o = b.offer && typeof b.offer === 'object' ? b.offer : null;
  const offer: UpstreamOffer | null = o && text(o.state) ? {
    state: o.state as UpstreamOfferState,
    sessionId: Number.isFinite(Number(o.sessionId)) && o.sessionId != null ? Number(o.sessionId) : null,
    href: text(o.href) || null,
    fromSha: text(o.fromSha) || null,
    brings: list<{ title?: unknown }>(o.brings).map((x) => ({ title: text(x && x.title) })).filter((x) => x.title),
    facts: o.facts && typeof o.facts === 'object' ? o.facts as UpstreamFacts : null,
    keeps: o.keeps && typeof o.keeps === 'object'
      ? { count: count(o.keeps.count), titles: list<unknown>(o.keeps.titles).map(text).filter(Boolean) }
      : null,
    conflicts: list<unknown>(o.conflicts).map(text).filter(Boolean),
  } : null;
  return {
    enabled: b.enabled !== false,
    original,
    following: !!b.following,
    share: !!b.share,
    canManage: !!b.canManage,
    private: !!b.private,
    behind: !!b.behind,
    offer,
  };
}

/** A server's versions body, read defensively. Pure. */
export function readVersionsBody(raw: unknown): VersionsSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, any>;
  const from = (f: any) => (f && typeof f === 'object' && text(f.slug) ? { slug: text(f.slug), name: text(f.name) || text(f.slug) } : null);
  return {
    count: count(b.count),
    following: count(b.following),
    suggestions: list<any>(b.suggestions)
      .map((s) => ({ sessionId: s && s.sessionId != null ? Number(s.sessionId) : null, href: text(s && s.href) || null, title: text(s && s.title), from: from(s && s.from) }))
      .filter((s) => s.title),
    lately: b.lately && typeof b.lately === 'object' ? {
      versions: count(b.lately.versions),
      changes: count(b.lately.changes),
      rows: list<any>(b.lately.rows).map((r) => ({ title: text(r && r.title), from: from(r && r.from), at: (r && r.at) || null })).filter((r) => r.title),
    } : null,
    lastUpdate: b.lastUpdate && typeof b.lastUpdate === 'object' ? {
      offered: count(b.lastUpdate.offered),
      took: count(b.lastUpdate.took),
      skipped: count(b.lastUpdate.skipped),
      deciding: count(b.lastUpdate.deciding),
    } : null,
  };
}

/* ── The shared records ─────────────────────────────────────────────── */

const upstream = new Map<string, UpstreamState | null>();
const versions = new Map<string, VersionsSummary | null>();
const reads = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const changed = () => { for (const l of [...listeners]) l(); };

function api(slug: string, tail: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/${tail}`;
}

function read(key: string, url: string, keep: (body: unknown) => void): Promise<void> {
  let pending = reads.get(key);
  if (pending) return pending;
  pending = fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then((body) => { keep(body); })
    .finally(() => { reads.delete(key); changed(); });
  reads.set(key, pending);
  return pending;
}

/** Ask for `slug`'s upstream record again (after a merge or a WS nudge). */
export function reloadUpstream(slug: string): Promise<void> {
  if (!slug) return Promise.resolve();
  const shot = hubShot();
  if (shot) { upstream.set(slug, readUpstreamBody(hubShotUpstream(shot))); changed(); return Promise.resolve(); }
  return read(`u:${slug}`, api(slug, 'upstream'), (body) => { upstream.set(slug, readUpstreamBody(body)); });
}

function reloadVersions(slug: string): Promise<void> {
  if (!slug) return Promise.resolve();
  const shot = hubShot();
  if (shot) { versions.set(slug, readVersionsBody(hubShotVersions(shot))); changed(); return Promise.resolve(); }
  return read(`v:${slug}`, api(slug, 'versions'), (body) => { versions.set(slug, readVersionsBody(body)); });
}

function useShared<T>(slug: string, wanted: boolean, cache: Map<string, T>, reload: (slug: string) => Promise<void>): T | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  // Read on every mount the reader wants it: what is kept draws at once, and
  // the fresh answer redraws it.
  useEffect(() => {
    if (wanted && slug) void reload(slug);
  }, [slug, wanted]);
  return wanted && slug ? cache.get(slug) ?? null : null;
}

/** A version's standing with its original, or null until it is read (and on anything else). */
export function useUpstream(slug: string, wanted: boolean): UpstreamState | null {
  return useShared(slug, wanted, upstream, reloadUpstream);
}

/** Whether `slug`'s upstream record has been asked for and answered (an answer can be "nothing"), and is not being asked again. */
export function upstreamAnswered(slug: string): boolean {
  return !!slug && upstream.has(slug) && !reads.has(`u:${slug}`);
}

/** What an original hears from its versions, or null until it is read. */
export function useVersionsSummary(slug: string, wanted: boolean): VersionsSummary | null {
  return useShared(slug, wanted, versions, reloadVersions);
}

/* ── The actions ───────────────────────────────────────────────────── */

async function post(url: string, body: unknown): Promise<{ res: Response; data: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/**
 * POST /api/apps/:slug/upstream/<open|skip|share>: each answers the GET's
 * body, which becomes the shared record. Throws the server's own sentence,
 * or `fallback`'s words, when it refuses.
 */
export async function upstreamAction(slug: string, action: 'open' | 'skip' | 'share', body: unknown, fallback: string): Promise<UpstreamState | null> {
  const { res, data } = await post(api(slug, `upstream/${action}`), body);
  if (!res.ok) throw new Error((data && data.error) || translate(fallback));
  const next = readUpstreamBody(data);
  if (next) { upstream.set(slug, next); changed(); }
  return next;
}

/**
 * POST /api/apps/:slug/upstream/fit, for an update that clashes with the
 * version's own changes: a request on the version that Homeroom bot builds,
 * as the member who asked. Resolves the request's address.
 */
export async function askToFit(slug: string, fallback: string): Promise<string | null> {
  const { res, data } = await post(api(slug, 'upstream/fit'), {});
  if (!res.ok || (data && data.ok === false)) throw new Error((data && data.error) || translate(fallback));
  void reloadUpstream(slug);
  return text(data && data.href) || null;
}

/**
 * POST /api/apps/:slug/follow-pr {follow}: whether a version gets its
 * original's updates is a line of its dapp.json (`followOriginal`), so
 * changing it is a proposal, as who can see a project is. A 409
 * `already_open` names the one already up, which is as good. Resolves the
 * proposal's address.
 */
export async function proposeFollow(slug: string, follow: boolean, fallback: string): Promise<string | null> {
  const { res, data } = await post(api(slug, 'follow-pr'), { follow });
  if (!res.ok && !(res.status === 409 && data && (data.code === 'already_open' || data.href || data.open))) {
    throw new Error((data && data.error) || translate(fallback));
  }
  return text(data && (data.href || (data.open && data.open.href))) || null;
}

/** Go to an in-app address such as a change's page (`#app/<slug>/dev/changes/<N>`). */
export function goTo(href: string): void {
  if (typeof window === 'undefined' || !href) return;
  if (href.startsWith('#')) window.location.hash = href.slice(1);
  else window.location.assign(href);
}
