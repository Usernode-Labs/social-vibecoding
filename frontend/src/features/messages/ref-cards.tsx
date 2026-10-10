/**
 * #4241: a request's `#N` chip in a message about its project (#3770), tapped.
 *
 * A reply that names requests it already showed draws no second card for
 * them, so its "#7, #8 and #9" are chips. A tap on one goes to the card that
 * request already has in this conversation (a shared card, a bot's head card
 * or its activity card), scrolled to and flashed; with none loaded, the card
 * opens under the message itself, and a second tap folds it away. A modified
 * click still opens the request's page in a new tab.
 *
 * The chips are injected markup (./channels.ts `decorateRefs`), so the press
 * is read by delegation on the message body (./format.tsx `MessageMarkdown`),
 * and the cards are found by what they already say: their link to the
 * request, or the activity card's `data-bot-activity-request`.
 */

import { issueRefHref } from './channels';
import { ObjectCard } from './format';
import { pageOf, type HomeroomLink } from './homeroom-links';
import { linkCardAnswered, useLinkCards } from './link-cards';
import type { SharedObjectCard } from './types';

/** How long the found card's message stays lit: app.css `.messages-message-focus`. */
const FLASH_MS = 2400;

/**
 * The card request `n` of `appSlug` already has in the conversation `from`
 * is in, nearest the chip: the last one above it, else the first below. The
 * thread pane and the conversation each search themselves.
 */
export function findRequestCard(from: Element, appSlug: string, n: number): HTMLElement | null {
  const scope: ParentNode = from.closest('.messages-thread-scroll') || from.ownerDocument;
  const href = issueRefHref(appSlug, String(n));
  const activity = `${appSlug}#${n}`;
  let above: HTMLElement | null = null;
  let below: HTMLElement | null = null;
  // #4564: a ready card leading a change block names its request
  // (`data-bot-ready-request`), so a chip in a row whose request card was
  // dropped still finds the card at the top of its block.
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('a.messages-object-card[href], [data-bot-activity-request], [data-bot-ready-request]'))) {
    const match = el.matches('a.messages-object-card')
      ? el.getAttribute('href') === href
      : el.getAttribute('data-bot-activity-request') === activity || el.getAttribute('data-bot-ready-request') === activity;
    if (!match) continue;
    if (el.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) above = el;
    else if (!below) below = el;
  }
  return above || below;
}

/** Bring a found card into view and light the message it hangs on. */
export function revealCard(card: HTMLElement): void {
  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  if (card.tabIndex >= 0) card.focus({ preventScroll: true });
  const lit = (card.closest('article') as HTMLElement | null) || card;
  lit.classList.remove('messages-message-focus');
  // Restart the flash when the same card is found twice in a row.
  void lit.offsetWidth;
  lit.classList.add('messages-message-focus');
  window.setTimeout(() => lit.classList.remove('messages-message-focus'), FLASH_MS);
}

/** The requests a message's chips opened in place, under its words. */
export function RefCards({ appSlug, numbers }: { appSlug: string; numbers: readonly number[] }) {
  const links = numbers.map((n) => pageOf(`app/${appSlug}/dev/issues/${n}`)).filter((link): link is HomeroomLink => !!link);
  const read = useLinkCards(links);
  if (!links.length) return null;
  return (
    <div className="messages-object-list mt-1 max-w-[480px]" data-ref-cards="">
      {links.map((link) => {
        const found = read.find((entry) => entry.link.key === link.key)?.card;
        const answered = linkCardAnswered(link.key);
        // Until the server answers, and when this reader cannot see it, the
        // request by its number alone: it still opens the request's page.
        const card: SharedObjectCard = found || {
          type: 'issue', available: true, appSlug, issueNumber: link.issueNumber,
          title: answered ? 'Open this request' : 'Loading…',
        };
        return (
          <div key={link.key} data-ref-card={link.issueNumber} aria-busy={!found && !answered ? true : undefined}>
            <ObjectCard object={{ ...card, author: null, state: null, href: link.href }} />
          </div>
        );
      })}
    </div>
  );
}
