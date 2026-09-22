/**
 * The Workshop screen's chrome: a scope chip, three tabs and a plus (#2718).
 *
 * ── What these three are for ──────────────────────────────────────────
 *
 * The screen under them answers "which of my apps wants something from me".
 * That question has a shape every mini-app host in the study draws the same
 * way, and this is that shape:
 *
 *   THE SCOPE CHIP says what you are looking at and lets you narrow it. From
 *   here it reads "All apps"; picking one is the LINK OUT — Telegram sends
 *   you to the bot's own chat, Steam to that game's community hub, Slack to
 *   the channel's files — and lands you on that app's own Workshop.
 *
 *   THE THREE TABS are the app Workshop's own three words, one level up:
 *   Current status, Needs you, All items. Reusing them rather than inventing
 *   a second set is what makes the two screens read as one place at two
 *   scopes rather than two screens that happen to link.
 *
 *   THE PLUS is across from the tabs, which is where Messages already puts
 *   the control that starts something. It holds what you can ADD from a
 *   screen about every app: a change, a problem report, a new app. The
 *   MANAGE half of that menu — members, approvals, secrets, the fork — is
 *   per-app and belongs on the app's own Workshop, which the chip is the way
 *   to.
 *
 * ── Why the panels expand IN PLACE rather than presenting ─────────────
 *
 * Both the chip's app list and the plus's menu are ordinary children of this
 * screen. They are not sheets, not dialogs and not anchored panels, and that
 * is a deliberate three-way no:
 *
 *   - A kit sheet needs a root in the prerendered document to adopt, an id in
 *     the shell's frozen inventory and a controller with a dismiss contract —
 *     all of it to show a list of your own apps.
 *   - @/components/ui/anchored-panel is fixed to the window's top-right
 *     corner, which is where the bell's panel goes and nowhere near a chip
 *     sitting in the page.
 *   - A popover would unmount while closed, and this screen's own rule is
 *     that its first render is the shipped document.
 *
 * Expanding in place costs none of that: the screen is React-owned end to
 * end, nothing in public/js/** writes inside it, and a panel that renders
 * only once somebody has tapped is a panel the prerender never sees.
 *
 * ── It draws with the primitives, not with new CSS ────────────────────
 *
 * The strip is @/components/ui/tabs — `Tabs`, `TabsList`, `TabsTrigger` and
 * its `SECTION_TAB_*` class tables, the underlined-pill strip the Leaderboard
 * screen's sections already wear. Re-deriving a second tab strip here is how
 * two strips stop matching, and that primitive's header says so.
 */

import { type ReactNode } from 'react';

import {
  Tabs, TabsList, TabsTrigger,
  SECTION_TABS_LIST_BASE, SECTION_TAB_ACTIVE, SECTION_TAB_INACTIVE,
} from '@/components/ui/tabs';
import {
  CheckIcon, ChevronDownIcon, PlusIcon, SparklesIcon,
  Squares2X2Icon, WarningTriangleIcon,
} from '@/components/ui/icons';

import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { workshopStore } from './workshop-store.js';

export type WorkshopTab = 'status' | 'needs' | 'all';

/** The three, in the order the app's own Workshop draws them. */
export const WORKSHOP_TABS: ReadonlyArray<readonly [WorkshopTab, string]> = [
  ['status', 'Current status'],
  ['needs', 'Needs you'],
  ['all', 'All items'],
];

type PickerApp = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
};

const win = () => window as unknown as {
  App?: {
    navigateToApp?: (slug: string, tab?: string) => Promise<unknown> | void;
    showCreateModal?: () => void;
  };
  Improve?: { startSession?: () => void; giveFeedback?: () => void };
};

/**
 * Go to `slug`'s own Workshop, then do the thing the picker was opened for.
 *
 * The await is load-bearing on the two action modes: `navigateToApp` resolves
 * once the app view has opened and the Improve controller knows what it is
 * about, and calling `startSession()` before that would start a change on
 * whatever app the panel was last pointed at. On the scope mode there is
 * nothing after the navigation, which is the case this function exists to
 * make look the same as the other two.
 */
async function goToApp(slug: string, mode: 'scope' | 'change' | 'issue'): Promise<void> {
  workshopStore.set({ picker: null });
  const w = win();
  try {
    await w.App?.navigateToApp?.(slug, 'dev');
  } catch {
    // A navigation that failed has already told the viewer; there is nothing
    // to start on a screen we did not reach.
    return;
  }
  if (mode === 'change') w.Improve?.startSession?.();
  if (mode === 'issue') w.Improve?.giveFeedback?.();
}

const CHIP = 'inline-flex items-center gap-2 max-w-full h-9 pl-2 pr-2.5 rounded-full '
  + 'un-touch-target font-semibold text-sm disabled:opacity-60 '
  + 'border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] '
  + 'text-[color:var(--brand-ink)]';

/**
 * "All apps ⌄", and the list behind it.
 *
 * The chip always says All apps on THIS screen, because this screen is the
 * all-apps one — narrowing navigates rather than filtering. That is not a
 * lesser version of a scope control: it is the same control the app's own
 * Workshop wears to say which app you are in, read from the other end.
 *
 * DISABLED WITH NO APPS, rather than opening an empty list: the one thing
 * behind it is your apps, and a panel that says nothing is worse than a
 * control that says it has nothing to offer.
 */
export function WorkshopScope({ apps, open }: { apps: PickerApp[] | null; open: boolean }) {
  return (
    <button
      id="workshop-scope"
      type="button"
      className={CHIP}
      aria-haspopup="menu"
      aria-expanded={open ? 'true' : 'false'}
      aria-controls="workshop-picker"
      disabled={!apps || apps.length === 0}
      onClick={() => workshopStore.set({ picker: open ? null : 'scope' })}
    >
      <span
        aria-hidden="true"
        className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center bg-white/60 dark:bg-zinc-900/40"
      >
        <Squares2X2Icon className="w-4 h-4" />
      </span>
      <span className="min-w-0 truncate">All apps</span>
      <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
    </button>
  );
}

/**
 * The plus, and why it is on the SCOPE row rather than beside the tabs.
 *
 * It shipped at the tabs' trailing edge, across from them, on the argument
 * that a tab strip's far end is the one place on this screen about doing
 * rather than looking. That was true and it did not fit. Measured in a real
 * browser at 390pt: the three labels need 370px of track and the row left
 * them 314px, so "All items" was cut off mid-word by a scroller
 * `platform-no-scrollbar` had made invisible — the tab was reachable only by
 * a drag nothing on screen suggested.
 *
 * The labels cannot give: they are the app's own Workshop's three words, and
 * that is the whole of why the two screens read as one place at two scopes.
 * So the ROW gives instead. The scope chip is ~170px of a 390pt row and was
 * alone on its line; the plus joins it at the far end, which reads as well —
 * scope on the left says WHAT you are looking at, the plus on the right adds
 * to it, and the tabs below get the full width to themselves.
 *
 * Exported separately rather than folded into WorkshopScope because the two
 * are unrelated controls that happen to share a line, and a component called
 * "scope" that also renders an add button is a name that has stopped being
 * true.
 */
export function WorkshopPlus({ plusOpen }: { plusOpen: boolean }) {
  return (
    <button
      id="workshop-plus"
      type="button"
      className={'ml-auto shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full '
        + 'un-touch-target border border-[color:var(--brand-line)] '
        + 'bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)]'}
      aria-haspopup="menu"
      aria-expanded={plusOpen ? 'true' : 'false'}
      aria-controls="workshop-picker"
      aria-label="Add"
      onClick={() => workshopStore.set({ picker: plusOpen ? null : 'change' })}
    >
      <PlusIcon className="w-5 h-5" aria-hidden="true" />
    </button>
  );
}

/**
 * The three tabs, with the whole row to themselves.
 *
 * ── The bug, measured ──────────────────────────────────────────────────
 *
 * At 390pt the three labels needed 370px of track and the row gave them 314,
 * so "All items" was cut off mid-word by a scroller `platform-no-scrollbar`
 * had made invisible: the tab was reachable only by a drag nothing on screen
 * suggested. Three things fix it, and the order matters — each one is the
 * cheapest concession left once the ones above it are spent.
 *
 * ── 1. The row is the tabs' alone ──────────────────────────────────────
 *
 * The plus moved up to the scope chip's line (WorkshopPlus above), which was
 * carrying one ~170px control on a 390pt row. That is 56px back.
 *
 * ── 2. `px-2.5`, not the recipe's `px-4` ───────────────────────────────
 *
 * SECTION_TAB_BASE is the platform's segmented-control trigger and this is
 * the one call site that cannot afford its padding: each step down buys three
 * tabs times two sides. Everything else about the recipe is kept, so the
 * strip still reads as the same control the Leaderboard and the Kudos pane
 * wear.
 *
 * ── 3. `text-[13px]`, and the app's own Workshop is the precedent ──────
 *
 * This is the one that actually wins it, and it is not a compromise — it is
 * the conclusion the platform already reached about THESE THREE LABELS. The
 * app's own Workshop renders the same three words on a phone at ELEVEN
 * pixels, with the glyph above them (`.dev-ws-tab`, app.css). So "Current
 * status / Needs you / All items at 14px does not fit a phone row" is
 * established, not discovered here; 13px is the largest size that fits a
 * 360pt screen whole, which is a Galaxy and a Pixel, not a museum piece.
 *
 * The labels themselves are what may NOT give: they are the app Workshop's
 * three words, and that is the whole of why the two screens read as one place
 * at two scopes (see WorkshopTab in ./workshop-store.js).
 *
 * ── The floor: truncate, never hide ────────────────────────────────────
 *
 * Whole at 360 and up; below that the labels ellipsize. `min-w-0` on each
 * trigger with a truncating label is what makes that possible — `shrink-0`
 * inside a scroller was what turned "does not fit" into "is silently cut",
 * because flex had no permission to do anything but overflow. And there is no
 * scroller any more: on touch there is no resting scrollbar and
 * `platform-no-scrollbar` removed the desktop one too, so the overflow it
 * allowed was overflow nothing announced. An ellipsis says the same thing and
 * says it in place.
 *
 * ── Why the class is spelled out ───────────────────────────────────────
 *
 * As a COMPLETE LITERAL rather than derived from the recipe with a
 * `.replace()`. Tailwind's extractor is a regex over source text, so a class
 * name a string operation produces at runtime is a class name that never gets
 * compiled — and the failure is silent: the attribute is right in the DOM and
 * the rule behind it does not exist. Every class in the platform's cva tables
 * is spelled out for the same reason (AGENTS.md). The cost is that this one
 * string is kept in step with the recipe by hand, which
 * tests/workshop-scope-tabs.test.js pins.
 */
const WORKSHOP_TAB_CLASS =
  'inline-flex items-center justify-center h-8 px-2.5 rounded-full text-[13px] '
  + 'font-semibold transition-colors min-w-0';

export function WorkshopTabs({ tab, plusOpen: _plusOpen }: { tab: WorkshopTab; plusOpen: boolean }) {
  return (
    <Tabs value={tab} onValueChange={(next) => workshopStore.set({ tab: next as WorkshopTab, picker: null })}>
      <TabsList id="workshop-tabs" className="px-4 pb-1 flex items-center">
        <div className={SECTION_TABS_LIST_BASE + ' min-w-0 max-w-full'}>
          {WORKSHOP_TABS.map(([key, label]) => (
            <TabsTrigger
              key={key}
              id={`workshop-tab-${key}`}
              value={key}
              data-workshop-tab={key}
              className={WORKSHOP_TAB_CLASS}
              activeClassName={SECTION_TAB_ACTIVE}
              inactiveClassName={SECTION_TAB_INACTIVE}
            >
              <span className="min-w-0 truncate">{label}</span>
            </TabsTrigger>
          ))}
        </div>
      </TabsList>
    </Tabs>
  );
}

const ROW = 'w-full flex items-center gap-3 px-4 min-h-[44px] py-2 text-left text-sm '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

function PanelRow({ id, leading, title, detail, trailing, onClick }: {
  id?: string;
  leading?: ReactNode;
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button id={id} type="button" className={ROW} onClick={onClick}>
      <span
        className="shrink-0 flex items-center justify-center w-8 h-8 text-zinc-500 dark:text-zinc-400"
        aria-hidden="true"
      >
        {leading}
      </span>
      <span className="min-w-0 flex-1 flex flex-col">
        <span className="truncate font-medium">{title}</span>
        {detail
          ? <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{detail}</span>
          : null}
      </span>
      {trailing}
    </button>
  );
}

/**
 * The one panel the chip and the plus share.
 *
 * ONE ELEMENT, THREE CONTENTS, because all three occupy the same place under
 * the tab strip and opening one has to close the others — which a single
 * `picker` field in the store makes true by construction rather than by three
 * effects agreeing.
 *
 * The plus opens on its MENU, and picking a row from it swaps this same panel
 * to the app list rather than opening a second one. That is the two-step the
 * design asks for — "pick the app, then describe it" — drawn as one surface
 * changing rather than as a stack, which is also the only version of it that
 * has an obvious way back: the row you came from is still on screen.
 */
export function WorkshopPicker({ picker, apps }: {
  picker: 'scope' | 'change' | 'issue';
  apps: PickerApp[] | null;
}) {
  const rows = apps || [];
  const heading = picker === 'scope' ? 'Which workshop?'
    : picker === 'change' ? 'Which app is the change to?'
      : 'Which app has the problem?';
  const lead = picker === 'scope' ? 'All apps, or one app’s.'
    : picker === 'change' ? 'The change starts in that app’s workshop.'
      : 'The report is filed in that app’s workshop.';

  return (
    <div
      id="workshop-picker"
      role="menu"
      className={'mx-4 mb-3 rounded-2xl overflow-hidden bg-white dark:bg-zinc-900 '
        + 'border border-zinc-200 dark:border-zinc-800'}
    >
      <p className="px-4 pt-3 pb-2 flex flex-col">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{heading}</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{lead}</span>
      </p>
      {picker === 'scope' ? (
        <PanelRow
          id="workshop-picker-all"
          leading={<Squares2X2Icon className="w-5 h-5" />}
          title="All apps"
          trailing={<CheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />}
          onClick={() => workshopStore.set({ picker: null })}
        />
      ) : null}
      {rows.map((app) => (
        <PanelRow
          key={app.slug}
          leading={(
            <span
              data-icon={appIconKind(app as never)}
              className="app-icon-tile w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center text-sm font-bold"
            >
              <AppIconContent app={app as never} />
            </span>
          )}
          title={app.name || app.slug}
          onClick={() => { void goToApp(app.slug, picker); }}
        />
      ))}
      {/* THE ADD MENU'S OWN ROWS, under the apps rather than above them: on
          the two action modes the question at the top is which app, so the
          apps are the answer and these are the way out of the question. */}
      {picker !== 'scope' ? (
        <>
          <PanelRow
            id="workshop-plus-change"
            leading={<SparklesIcon className="w-5 h-5" />}
            title="Propose a change"
            detail={picker === 'change' ? 'Pick an app above' : 'Pick an app, then describe it'}
            onClick={() => workshopStore.set({ picker: 'change' })}
          />
          <PanelRow
            id="workshop-plus-issue"
            leading={<WarningTriangleIcon className="w-5 h-5" />}
            title="Report a problem"
            detail={picker === 'issue' ? 'Pick an app above' : 'Pick an app, then say what is wrong'}
            onClick={() => workshopStore.set({ picker: 'issue' })}
          />
          <PanelRow
            id="workshop-plus-create"
            leading={<PlusIcon className="w-5 h-5" />}
            title="Create a new app"
            detail="Describe it and an AI builds the first version"
            onClick={() => {
              workshopStore.set({ picker: null });
              win().App?.showCreateModal?.();
            }}
          />
        </>
      ) : null}
    </div>
  );
}
