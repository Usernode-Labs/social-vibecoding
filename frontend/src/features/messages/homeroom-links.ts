/**
 * #3660: the links in a message that name one of Homeroom's own pages, and
 * which page each one names.
 *
 * A link pasted into a DM or a discussion becomes a card under the message
 * when it points at Homeroom itself — a request, a proposal, a governance
 * question, an app, a community's hub or its discussion. Nothing else is ever
 * looked at: a link to any other site stays the plain link it was, and this
 * never fetches anything. It only READS the address; ./link-cards.tsx asks
 * the platform's own server what the page is, for the person reading, so a
 * card someone cannot see never draws (services/shared-objects.js
 * `hydrateLink`).
 *
 * ── Which addresses are Homeroom's ─────────────────────────────────────
 *
 * The shell's own hosts and the bare domain, over https on the default port,
 * plus whatever origin this document is on (a staging preview, a local
 * stack). That is the same pair of rules the challenge cards' in-app links
 * use (features/leaderboard/topochain-challenges.js `_inAppRoute`), with the
 * bare domain and `www.` added because a person pasting "onhomeroom.com/…"
 * means Homeroom. A host that only CONTAINS the name — `onhomeroom.com.example`,
 * `evilonhomeroom.com` — is someone else's.
 *
 * ── Which page ─────────────────────────────────────────────────────────
 *
 * The router's own vocabulary (public/js/app.js `restoreFromHash`), in both
 * spellings it accepts: the clean path (`/app/<slug>/dev/issues/12`) and the
 * fragment (`/#app/<slug>/dev/issues/12`). A fragment wins when both are
 * there, as it does in the router — "Copy link to message" writes the page's
 * path and a `#messages/…` fragment, and that link is a message, not the app
 * the path happened to name. Anything the router would read as something
 * else, or that does not parse, is no card.
 */

export type LinkCardType = 'app' | 'hub' | 'discussion' | 'issue' | 'proposal' | 'governance';

export interface HomeroomLink {
  type: LinkCardType;
  appSlug: string;
  /** `issue`: the request's number. */
  issueNumber?: number;
  /** `proposal`: the change's session id, the number in its address. */
  sessionId?: number;
  /** `governance`: the question's id. */
  proposalId?: number;
  /**
   * The in-app address the card opens, rebuilt from what was parsed rather
   * than copied out of the link, so nothing but a slug and a number from the
   * pasted text ever reaches an `href`.
   */
  href: string;
  /** One identity per page: two links to the same request draw one card. */
  key: string;
}

/** Homeroom's own hosts besides this document's: the shell's two and the bare domain. */
export const HOMEROOM_HOSTS: readonly string[] = Object.freeze([
  'onhomeroom.com',
  'www.onhomeroom.com',
  'app.onhomeroom.com',
  'my.onhomeroom.com',
]);

/** The most cards one message grows: a list of links is not a list of cards. */
export const MAX_LINK_EMBEDS = 3;

/*
 * A URL in running text: from the scheme to the first character no address
 * of ours contains. Brackets and parentheses end it, so a markdown link
 * `[label](https://…)` yields the address alone, and `<…>` autolinks and
 * quotes do too. Trailing sentence punctuation is trimmed below.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`()[\]{}]+/gi;
const TRAILING = /[.,;:!?*_~]+$/;
// The router's slug grammar for a clean app path (App._appRouteFromPath).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;
const MAX_ID = 2_147_483_647;

function id(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const n = Number(value);
  return n <= MAX_ID ? n : null;
}

/** Whether `url` is one of Homeroom's own pages' addresses. */
export function isHomeroomUrl(url: URL, origin?: string | null): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  if (origin && url.origin === origin) return true;
  return url.protocol === 'https:' && !url.port && HOMEROOM_HOSTS.includes(url.hostname.toLowerCase());
}

/** The route an address names, the way the router reads it: the fragment, else the path. */
export function routeOf(url: URL): string {
  const fragment = url.hash.replace(/^#/, '').split('?')[0];
  const raw = fragment || url.pathname.replace(/^\/+/, '');
  return raw.replace(/\/+$/, '');
}

function page(type: LinkCardType, slug: string, href: string, extra: Partial<HomeroomLink> = {}): HomeroomLink {
  const ref = extra.issueNumber ?? extra.sessionId ?? extra.proposalId ?? '';
  return { type, appSlug: slug, href, key: `${type}:${slug}:${ref}`, ...extra };
}

/** The page a route names, or null when it names none this embeds. */
export function pageOf(route: string): HomeroomLink | null {
  let parts: string[];
  try { parts = route.split('/').map(decodeURIComponent); } catch { return null; }
  // #messages/app/<slug>: an app's channel, opened in the inbox.
  if (parts[0] === 'messages' && parts[1] === 'app' && SLUG_RE.test(parts[2] || '') && parts.length === 3) {
    return page('discussion', parts[2], `#app/${parts[2]}/dev/chat`);
  }
  if (parts[0] !== 'app' || !SLUG_RE.test(parts[1] || '')) return null;
  const slug = parts[1];
  const tab = parts[2] || 'app';
  const base = `#app/${slug}`;
  if (tab === 'app' || tab === 'full') return parts.length <= 3 ? page('app', slug, `${base}/app`) : null;
  // The Workshop and its retired spellings are the community's hub.
  if (tab === 'workshop' || tab === 'board' || tab === 'activity') return page('hub', slug, `${base}/workshop`);
  if (tab === 'group-chat') return page('discussion', slug, `${base}/dev/chat`);
  if (tab !== 'dev') return null;
  const section = parts[3];
  const ref = parts[4];
  if (!section) return page('hub', slug, `${base}/workshop`);
  if (section === 'chat') return page('discussion', slug, `${base}/dev/chat`);
  // A list with no id is the card list, which is the hub; an id that does
  // not parse is no card at all, not the list it would fall back to.
  if (!ref) return ['issues', 'proposals', 'governance', 'sessions', 'shared'].includes(section)
    ? page('hub', slug, `${base}/workshop`)
    : null;
  const n = id(ref);
  if (!n) return null;
  if (section === 'issues') return page('issue', slug, `${base}/dev/issues/${n}`, { issueNumber: n });
  if (section === 'governance') return page('governance', slug, `${base}/dev/governance/${n}`, { proposalId: n });
  // A change: its proposal page, its shared session's page, or its dev
  // session. One card for all three — the server shows it only where the
  // change itself is visible (shared, up for a vote, or the reader's own).
  if (section === 'proposals' || section === 'shared' || section === 'sessions') {
    return page('proposal', slug, `${base}/dev/${section}/${n}`, { sessionId: n });
  }
  return null;
}

/** The page one address names, when it is one of Homeroom's. */
export function homeroomLinkOf(href: string, origin?: string | null): HomeroomLink | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (!isHomeroomUrl(url, origin)) return null;
  return pageOf(routeOf(url));
}

/**
 * The Homeroom pages a message's text links to, in order, each once, at
 * most `max` of them. `origin` is this document's (`location.origin`); a
 * caller with no document passes null and only the named hosts count.
 */
export function homeroomLinks(text: string, origin?: string | null, max = MAX_LINK_EMBEDS): HomeroomLink[] {
  const found: HomeroomLink[] = [];
  const seen = new Set<string>();
  if (!text || max <= 0) return found;
  for (const match of String(text).matchAll(URL_RE)) {
    const link = homeroomLinkOf(match[0].replace(TRAILING, ''), origin);
    if (!link || seen.has(link.key)) continue;
    seen.add(link.key);
    found.push(link);
    if (found.length >= max) break;
  }
  return found;
}

/** This document's origin, or null where there is no document. */
export function currentOrigin(): string | null {
  try { return typeof window !== 'undefined' ? window.location.origin || null : null; } catch { return null; }
}

/**
 * Whether a link names the same item as a card already on the message (a
 * share, or a Homeroom bot card), which it then does not draw twice.
 */
export function sameItem(
  link: HomeroomLink,
  object: { type: string; appSlug?: string; issueNumber?: number; sessionId?: number; proposalId?: number },
): boolean {
  if (object.type !== link.type || object.appSlug !== link.appSlug) return false;
  if (link.type === 'issue') return object.issueNumber === link.issueNumber;
  if (link.type === 'proposal') return object.sessionId === link.sessionId;
  if (link.type === 'governance') return object.proposalId === link.proposalId;
  return true;
}
