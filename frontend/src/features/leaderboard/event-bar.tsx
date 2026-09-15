/**
 * `#leaderboard-event-bar` — the picker and hero the two Topochain-domain
 * panes share.
 *
 * The only writer of the DOM below that host. ./topochain-event-context.js
 * still owns everything that makes the bar WORK — the events list, the default
 * pick, the detail fetch and its stale-response guard, the subscriber list
 * both panes register with — and pushes a view model into
 * ./event-bar-store.js. This file spells it as markup, class string for class
 * string.
 *
 * ── The `<select>` is a plain one, deliberately ────────────────────────
 *
 * `@/components/ui/select` exists and is the shell's field-styled native
 * select: a filled `bg-zinc-100` box at `rounded-lg`, drawn for forms. The
 * ITERATION 03 board draws this picker as something else, a full-width white
 * pill on the card surface with the event's name at 15px and a blue chevron.
 * So it stays a native `<select>` (the value/onChange contract and the
 * dapp.json anchor on `#tc-ev-select` are unchanged) with the chevron drawn
 * over it. The visible "Event" label went with the board; `aria-label` keeps
 * the control named.
 *
 * ── Challenges draws no hero ───────────────────────────────────────────
 *
 * The Challenges tab names the event in its own progress ("3/9 done in
 * Season 2") and in the picker, so a hero card repeating the name and dates
 * above it is left out there. Standings keeps its hero until a slice of its own.
 * The section comes from ./section-store.ts, the seam the tab strip reads.
 *
 * ── `hidden` on the host is still someone else's ───────────────────────
 *
 * `Leaderboard._applySection()` toggles `.hidden` on `#leaderboard-event-bar`
 * — the Kudos tab has no event dimension. That is safe for exactly the reason
 * frontend/src/lib/legacy-dom.ts documents and the two pane roots already rely
 * on: the host's `className` is rendered ONCE, as a constant, in
 * ./index.tsx, and React never writes the attribute again. This component
 * renders the host's CHILDREN, never the host.
 */

import { ChevronDownIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { eventBarStore } from './event-bar-store.js';
import { useLeaderboardSection } from './section-store';

interface EventOptionView {
  id: number;
  label: string;
}

type HeroView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | {
    kind: 'event';
    name: string;
    statusLabel: string;
    statusClass: string;
    description: string | null;
    dates: string;
    /** " · 12 taking part", or null when the server sent no count. */
    participants: string | null;
    /** Whole-season standings — the selection is the season aggregate. */
    seasonNote: boolean;
    /** Nothing is running; this is the most recent event, not a choice. */
    fallbackNote: boolean;
  };

interface EventBarState {
  mounted: boolean;
  options: EventOptionView[];
  placeholder: string | null;
  selectedId: number | null;
  hero: HeroView | null;
}

function context(): any {
  return (typeof window !== 'undefined' ? (window as any).TopochainEventContext : null) || null;
}

function Hero({ hero }: { hero: HeroView }) {
  if (hero.kind === 'loading') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }
  if (hero.kind === 'error') {
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
        {hero.message}
      </div>
    );
  }
  if (hero.kind === 'empty') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">No event selected.</p>;
  }
  return (
    <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{hero.name}</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${hero.statusClass}`}>
          {hero.statusLabel}
        </span>
      </div>
      {hero.description ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-300 mt-2">{hero.description}</p>
      ) : null}
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
        {hero.dates}
        {hero.participants}
      </p>
      {/*
          A season-type selection is badged and captioned for WHAT IT IS rather
          than for its own window, which has usually closed while the season is
          still the dataset on screen.
      */}
      {hero.seasonNote ? (
        <p id="tc-ev-season-note" className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
          {'Whole-season standings: every public event in this season, combined. '}
          Pick a single event above to see just its results.
        </p>
      ) : null}
      {hero.fallbackNote ? (
        <p id="tc-ev-fallback-note" className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
          Nothing is running right now, so this shows the most recent event.
        </p>
      ) : null}
    </div>
  );
}

const PICKER = 'w-full appearance-none rounded-2xl border border-zinc-200 dark:border-zinc-800 '
  + 'bg-white dark:bg-zinc-900 py-3 pl-4 pr-11 text-[0.9375rem] font-medium text-zinc-800 '
  + 'dark:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500';

export function EventBarView({
  mounted, options, placeholder, selectedId, hero, section,
}: EventBarState & { section?: string }) {
  if (!mounted) return null;
  const showHero = hero != null && section !== 'challenges';
  return (
    <>
      <div className="relative w-full sm:max-w-xs">
        <select
          id="tc-ev-select"
          aria-label="Event"
          className={PICKER}
          // A `<select>`'s onChange IS the native `change` event — it fires
          // on commit, not per keystroke — so the paged-query rule that
          // applies to text inputs does not apply here.
          value={placeholder !== null ? '' : String(selectedId ?? '')}
          onChange={(e) => {
            const id = parseInt(e.target.value, 10);
            if (!Number.isInteger(id)) return;
            context()?.select?.(id);
          }}
        >
          {placeholder !== null ? <option value="">{placeholder}</option> : null}
          {options.map((ev) => (
            <option key={ev.id} value={String(ev.id)}>{ev.label}</option>
          ))}
        </select>
        <ChevronDownIcon
          aria-hidden="true"
          className="pointer-events-none absolute right-4 top-1/2 h-[1.125rem] w-[1.125rem] -translate-y-1/2 text-violet-600 dark:text-violet-400"
        />
      </div>
      <div id="tc-ev-hero" className={showHero ? 'mt-3' : undefined}>
        {showHero && hero ? <Hero hero={hero} /> : null}
      </div>
    </>
  );
}

export function EventBar() {
  const { section } = useLeaderboardSection();
  return <EventBarView {...useStoreState<EventBarState>(eventBarStore)} section={section} />;
}
