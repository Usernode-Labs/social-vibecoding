/**
 * The Communities screen's All chip (#3051), and nothing else now.
 *
 * ── What it was ───────────────────────────────────────────────────────
 *
 * This file held the Workshop's scope chip and the "Which project?" panel
 * behind it, on both ends of the Workshop: the all-apps screen's "All ⌄",
 * and on one app's page the header's name and ⌄ (#2768, #3295), whose panel
 * expanded in place at the top of the page.
 *
 * ── What it is ────────────────────────────────────────────────────────
 *
 * The Communities tab is a community now, and "Your communities"
 * (./community-switcher.tsx) is how you change which: a sheet on a phone, a
 * menu on a wide window, opened from the lit tab, the header's name and ⌄,
 * and this chip. So the panel went, and the chip stays as the list's header:
 * the grid, "All" and the ⌄, saying the list is all of your communities and
 * offering the switcher. The header's own `#header-scope-switch` is the same
 * control on a phone (features/header/header-title.tsx).
 *
 * The chip is in the prerendered document (the id inventory and a declared
 * check resolve against it), closed; `open` is the switcher's, which only
 * ever opens after the first paint.
 */

import { ChevronDownIcon, Squares2X2Icon } from '@/components/ui/icons';

import { toggleSwitcher } from './community-scope';

const CHIP = 'inline-flex items-center gap-2 max-w-full h-9 pl-2 pr-2.5 rounded-full '
  + 'un-touch-target font-semibold text-sm disabled:opacity-60 '
  + 'border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] '
  + 'text-[color:var(--brand-ink)]';

/** The all-communities chip's id. */
export const ALL_APPS_SCOPE_ID = 'workshop-scope';

/** "All ⌄" at the head of the Communities screen: opens "Your communities". */
export function AllAppsScope({ open }: { open: boolean }) {
  return (
    <button
      id={ALL_APPS_SCOPE_ID}
      type="button"
      className={CHIP}
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      aria-controls="community-switcher"
      aria-label="All your communities, or open one"
      onClick={(e) => toggleSwitcher('list', e.currentTarget)}
    >
      <Squares2X2Icon className="w-5 h-5 shrink-0 ml-0.5" aria-hidden="true" />
      <span className="min-w-0 truncate">All</span>
      <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
    </button>
  );
}
