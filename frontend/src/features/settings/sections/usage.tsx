import { SectionHeading } from '@/components/ui/field';

import { useMessages } from '../../../lib/i18n/react';
import { AiBudgetRow } from '../../header/ai-budget';
import { BuildingTime } from '../building-time';

/**
 * The viewer's AI allowance and this week's spend — the first part of the
 * "AI usage & models" page.
 *
 * Both lived in the Anthropic API key part until the settings restructure,
 * where the figure most builders open Settings to find sat under the name of
 * a key most of them never add. The ids are unchanged (#drawer-row-ai-budget
 * inside AiBudgetRow, #settings-spend and its rows), and so is everything
 * that fills them: features/header/ai-credit.js for the allowance,
 * Settings._refreshSpend() for the spend card, which stays hidden unless a
 * key is saved.
 */
export function UsageSection() {
  // Subscribed: settings.js fills the two figures and rewrites
  // #settings-spend-reset in the viewer's own clock each time it reveals the
  // card, so the prerendered sentence there is only what shows before that.
  const t = useMessages('settings');
  return (
    <div data-settings-section="usage" className="hidden">
      <SectionHeading title={t('settings:usage.title')}>
        {t('settings:usage.intro')}
      </SectionHeading>
      {/*
          The viewer's own weekly AI allowance (#555, #2571), used vs. remaining.

          THE UI OVERHAUL took this out of the hamburger drawer, where it was a
          status row nobody acts on from a menu, and put it in the Anthropic
          API key pane, the page about "what happens when your allowance runs
          out". The settings restructure gave it a part of its own at the head
          of that same page, where the key now follows it.

          The row is `features/header/ai-budget.tsx` now: it renders from a
          store `features/header/ai-credit.js` publishes into, instead of
          being an empty `#ai-budget-slot` that module `innerHTML`ed. It still
          ships EMPTY and VISIBLE — the me-scoped fetch that fills it is what
          confirms there is an audience, and the row hides itself only once
          that fetch has answered with nothing to show.
      */}
      {/* The allowance, as the first row of a card. */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden mb-3">
        <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
          <AiBudgetRow />
        </div>
      </div>
      {/*
          The Homeroom bot's building time this week, and the requests that
          used it (../building-time.tsx). React's alone: it renders an empty
          marker until the section first shows, then reads the week.
      */}
      <BuildingTime />
      {/*
          #119 — spend breakdown for BYOK users. Filled by
          Settings._refreshSpend() on modal open; hidden while loading,
          on fetch failure, or when no key is saved. Rows are ordered
          limit-first to match the billing order (#212). #2571 moved both
          figures to the allowance's own window: one card cannot state a
          week's platform spend beside a day's own-key spend.
      */}
      <div id="settings-spend" className="hidden mb-3">
        <div className="px-1 pb-1 text-[15px] text-zinc-500 dark:text-zinc-500">
          {t('settings:usage.spend.heading')}
        </div>
        <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 flex justify-between gap-3 text-[17px] text-zinc-900 dark:text-zinc-100">
            <span>
              {t('settings:usage.spend.platform')}
            </span>
            <span id="settings-spend-platform" className="tabular-nums text-zinc-500 dark:text-zinc-400">
            </span>
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 flex justify-between gap-3 text-[17px] text-zinc-900 dark:text-zinc-100">
            <span>
              {t('settings:usage.spend.ownKey')}
            </span>
            <span id="settings-spend-byok" className="tabular-nums text-zinc-500 dark:text-zinc-400">
            </span>
          </div>
          {/*
              #3230: the prerendered words are the server's UTC boundary;
              Settings._refreshSpend() rewrites them in the viewer's own
              clock, with the UTC instant on `title`, as it reveals the card.
          */}
          <div id="settings-spend-reset" className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800 text-[15px] text-zinc-500 dark:text-zinc-500">
            {t('settings:usage.spend.resetUtc')}
          </div>
        </div>
      </div>
    </div>
  );
}
