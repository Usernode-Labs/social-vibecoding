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
 * ── What this screen no longer carries ────────────────────────────────
 *
 * A TAB STRIP and a PLUS. The strip was Current status / Needs you / All
 * items, the app Workshop's own three words one level up, and the plus opened
 * a two-step "which app, then what" menu. Both are gone.
 *
 * The strip's trouble was not that it did not fit — it did, after three
 * concessions — but what it was filtering. Those three words are about one
 * app's ITEMS; up here the list is of APPS, each row already carrying both of
 * its numbers, so the tabs hid whole apps in order to say something their
 * rows were saying anyway. The plus went with it: "Propose a change" and
 * "Report a problem" both have to be asked inside an app, so asking "which
 * app?" first was a step in front of a step, and "Create a new app" is a tile
 * on Home.
 *
 * What is left is the screen's own question — which workshop, and how much is
 * in each — answered by the scope chip, the legend's totals and the rows.
 */

import { type ReactNode } from 'react';

import {
  CheckIcon, ChevronDownIcon, Squares2X2Icon,
} from '@/components/ui/icons';

import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { workshopStore } from './workshop-store.js';

type PickerApp = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
};

const win = () => window as unknown as {
  App?: { navigateToApp?: (slug: string, tab?: string) => Promise<unknown> | void };
};

/**
 * Go to `slug`'s own Workshop.
 *
 * It took a MODE too, while the plus's two action rows landed here: the await
 * was load-bearing there, because `navigateToApp` resolves once the Improve
 * controller knows what the app view is about and calling `startSession()`
 * before that would start a change on whatever app the panel was last pointed
 * at. The scope chip is the only caller left and there is nothing after the
 * navigation — but the await stays, so a refused navigation cannot look like
 * a completed one.
 */
async function goToApp(slug: string): Promise<void> {
  workshopStore.set({ picker: null });
  try {
    await win().App?.navigateToApp?.(slug, 'dev');
  } catch {
    // A navigation that failed has already told the viewer. The panel is
    // closed either way, which is the state this screen wants.
  }
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
 * The scope chip's panel: which workshop you are looking at.
 *
 * IT WAS SHARED WITH THE PLUS, and three contents in one element was the
 * whole point — the chip's app list and the plus's two action modes occupied
 * the same place under the strip, so one `picker` field made "opening one
 * closes the others" true by construction rather than by three effects
 * agreeing. The plus is retired from this screen, so the field has one value
 * left and this panel has one job.
 */
export function WorkshopPicker({ apps }: { apps: PickerApp[] | null }) {
  const rows = apps || [];
  const heading = 'Which workshop?';
  const lead = 'All apps, or one app’s.';

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
      <PanelRow
        id="workshop-picker-all"
        leading={<Squares2X2Icon className="w-5 h-5" />}
        title="All apps"
        trailing={<CheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />}
        onClick={() => workshopStore.set({ picker: null })}
      />
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
          onClick={() => { void goToApp(app.slug); }}
        />
      ))}
    </div>
  );
}
