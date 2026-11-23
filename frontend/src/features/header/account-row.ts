/**
 * The account block's rows in Settings (Node, Wallet, Staking), in the list
 * rows' own measure: 15px at 650 over a 13px figure, 48px tall, as every
 * other card's rows on the page (ListRow). They were 14px medium rows at
 * 44px, the one denser card on the page (phone review #120, 23 Nov 2026).
 * Complete literals, for Tailwind's extractor.
 */

/** The row: its padding, height and the hairline under it (none under the last). */
export const ACCOUNT_ROW
  = 'flex items-center gap-3 px-4 py-3 min-h-[48px] w-full text-start relative'
  + " after:absolute after:bottom-0 after:start-12 after:end-0 after:h-px"
  + " after:bg-zinc-100 dark:after:bg-zinc-800 after:content-[''] last:after:hidden"
  + ' text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800';

/** The row's name. */
export const ACCOUNT_ROW_TITLE = 'text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100';

/** A figure or state at the row's end that says nothing is wrong or known yet. */
export const ACCOUNT_ROW_MUTED = 'ms-auto text-[0.8125rem] text-zinc-500 dark:text-zinc-400';

/** Node states in which the wallet cannot be read either. */
export const NODE_DOWN = new Set(['unavailable', 'offline']);
