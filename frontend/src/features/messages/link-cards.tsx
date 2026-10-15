/**
 * #3660: a Homeroom link in a message, drawn as the card it stands for.
 *
 * Paste a link to a request, a proposal, a community's hub or its discussion
 * into a DM, a group, #general or an app's discussion, and the page it names
 * hangs under the message as the same card a shared item is (./format.tsx
 * `ObjectCard`) — the one Messages already draws for a share and for the
 * Homeroom bot's cards, so a pasted link and a shared card read as one thing.
 *
 * ── Whose eyes ─────────────────────────────────────────────────────────
 *
 * Nothing about the card is stored with the message. Every READER's own
 * session asks the server what each link is (POST /api/link-cards), and the
 * server answers with what that reader may see: the app's view rule, then
 * the item's own (services/shared-objects.js). A page they cannot see comes
 * back unavailable and draws nothing at all — not an "Unavailable" card,
 * which would say a hidden page is there — so the link is left as the plain
 * link everyone already saw in the text.
 *
 * ── Only Homeroom's own pages ──────────────────────────────────────────
 *
 * Which links count is ./homeroom-links.ts: this platform's hosts and this
 * document's origin. Another site's link is never fetched, unfurled or
 * previewed, by the browser or the server.
 *
 * ── One request for many rows ──────────────────────────────────────────
 *
 * A transcript mounts dozens of rows at once. Each row names its links; the
 * links not already known are queued and sent together a beat later, ten to
 * a request, and the answers are kept for the session (five minutes, then
 * asked again the next time a row wants one) so scrolling back does not ask
 * twice. Rows read the answers through one subscription.
 *
 * Effects only: the transcripts are not in the prerendered shell, but a
 * request in a render pass would be a request per render.
 */

import { memo, useEffect, useMemo, useSyncExternalStore } from 'react';

import * as api from './api';
import { ObjectCard } from './format';
import { currentOrigin, homeroomLinkOf, homeroomLinks, sameItem, type HomeroomLink } from './homeroom-links';
import type { SharedObjectCard } from './types';

/** How long an answer stands before a row that wants it asks again. */
const FRESH_MS = 5 * 60 * 1000;
/** A failed request is tried again after this, not on the next render. */
const RETRY_MS = 60 * 1000;
/** The server's cap per request (services/shared-objects.js MAX_LINK_CARDS). */
const PER_REQUEST = 10;
/** How long the queue gathers rows mounting together before it sends. */
const GATHER_MS = 30;

interface Answer { card: SharedObjectCard | null; at: number; ttl: number }

const answers = new Map<string, Answer>();
const inflight = new Set<string>();
const queue = new Map<string, HomeroomLink>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = () => version;

function wanted(key: string, now: number): boolean {
  if (inflight.has(key) || queue.has(key)) return false;
  const answer = answers.get(key);
  return !answer || now - answer.at > answer.ttl;
}

function flush(): void {
  timer = null;
  const batch = [...queue.values()];
  queue.clear();
  for (let i = 0; i < batch.length; i += PER_REQUEST) {
    const chunk = batch.slice(i, i + PER_REQUEST);
    for (const link of chunk) inflight.add(link.key);
    void api.resolveLinkCards(chunk).then((cards) => {
      const at = Date.now();
      chunk.forEach((link, index) => {
        const card = cards[index];
        // Unavailable is an answer, not a failure: it stands as long as a
        // card does, and draws nothing.
        answers.set(link.key, { card: card && card.available ? card : null, at, ttl: FRESH_MS });
      });
    }).catch(() => {
      const at = Date.now();
      // Keep a card already drawn through a failed refresh; only a link
      // with no answer yet waits for the retry with nothing.
      for (const link of chunk) {
        const previous = answers.get(link.key);
        answers.set(link.key, { card: previous?.card || null, at, ttl: RETRY_MS });
      }
    }).finally(() => {
      for (const link of chunk) inflight.delete(link.key);
      emit();
    });
  }
}

/** Ask for the cards of `links` that are not known, or no longer fresh. */
export function requestLinkCards(links: readonly HomeroomLink[]): void {
  const now = Date.now();
  for (const link of links) if (wanted(link.key, now)) queue.set(link.key, link);
  if (queue.size && timer == null) timer = setTimeout(flush, GATHER_MS);
}

/** The cards of `links` that have come back available, in the links' order. */
export function useLinkCards(links: readonly HomeroomLink[]): Array<{ link: HomeroomLink; card: SharedObjectCard }> {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const keys = links.map((link) => link.key).join('|');
  useEffect(() => {
    if (links.length) requestLinkCards(links);
    // `keys` is the identity of `links`: a parent that rebuilds the same
    // list each render must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  return links.flatMap((link) => {
    const card = answers.get(link.key)?.card;
    return card ? [{ link, card }] : [];
  });
}

/**
 * Whether the server has answered for `key` at all: a link with no card yet
 * is either on its way (false) or not one this reader can see (true).
 */
export function linkCardAnswered(key: string): boolean {
  return answers.has(key);
}

/** Forget every answer — for tests, and for an account change in this tab. */
export function resetLinkCards(): void {
  answers.clear();
  inflight.clear();
  queue.clear();
  if (timer != null) { clearTimeout(timer); timer = null; }
  emit();
}

type CardOnMessage = Parameters<typeof sameItem>[1];

/** The page this document is showing, as a link to it would name it. */
function currentPageKey(): string | null {
  try {
    return typeof window !== 'undefined' ? homeroomLinkOf(window.location.href, window.location.origin)?.key || null : null;
  } catch { return null; }
}

/** The cards for links already found: the part that subscribes to the answers. */
function LinkCardList({ links, inboxOnly }: { links: readonly HomeroomLink[]; inboxOnly: boolean }) {
  const cards = useLinkCards(links);
  if (!cards.length) return null;
  return (
    <div className="messages-object-list messages-link-embeds" data-link-embeds="">
      {cards.map(({ link, card }) => (
        // The page the link named, not the server's canonical address for
        // the item: a link to a change's shared page opens that page.
        <ObjectCard key={link.key} object={{ ...card, href: link.href }} inboxOnly={inboxOnly} />
      ))}
    </div>
  );
}

/**
 * The cards under a message for the Homeroom links in its words. `exclude`
 * is the cards the message already carries (a share, the bot's), which a
 * link to the same item does not draw a second time. Renders nothing while
 * the answers are on their way and when no link is to a page this reader
 * can see.
 *
 * Every row with words mounts one, so the scan is memoised on the words and
 * a row with no Homeroom link stops there: only a row that HAS one listens
 * for answers, and an answer landing redraws those rows alone.
 */
export const LinkEmbeds = memo(function LinkEmbeds({ text, exclude, inboxOnly = false }: {
  text: string;
  exclude?: readonly CardOnMessage[];
  /** Drawn in an app's discussion (./format.tsx `recordObjectOrigin`). */
  inboxOnly?: boolean;
}) {
  const links = useMemo(() => {
    // A link to the page being read (the bot's note on a proposal's own
    // discussion links that proposal) is no news there.
    const here = currentPageKey();
    return homeroomLinks(text, currentOrigin())
      .filter((link) => link.key !== here && !(exclude || []).some((object) => sameItem(link, object)));
  }, [text, exclude]);
  return links.length ? <LinkCardList links={links} inboxOnly={inboxOnly} /> : null;
});
