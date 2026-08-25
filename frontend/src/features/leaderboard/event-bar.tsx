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
 * select. It is not used here: its base is `w-full` and its variants pad
 * `px-3 py-2`, where this picker is `max-w-[16rem]` at `px-2 py-1.5`. Routing
 * it through the primitive would move the control's size on a screen whose
 * contract for this conversion is that nothing moves. The classes below are
 * already in the widget language — the reskin reached them through the token
 * layer — so what is left is a sizing decision with its own evidence to
 * gather, not part of a renderer swap.
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

import { useStoreState } from '../../lib/use-store-state';
import { eventBarStore } from './event-bar-store.js';

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
          {'Whole-season standings — every public event in this season, combined. '}
          Pick a single event above to see just its results.
        </p>
      ) : null}
      {hero.fallbackNote ? (
        <p id="tc-ev-fallback-note" className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
          Nothing is running right now — showing the most recent event.
        </p>
      ) : null}
    </div>
  );
}

export function EventBarView({
  mounted, options, placeholder, selectedId, hero,
}: EventBarState) {
  if (!mounted) return null;
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-3 mb-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">Event</span>
          <select
            id="tc-ev-select"
            className="rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1.5 text-sm max-w-[16rem]"
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
        </label>
      </div>
      <div id="tc-ev-hero">
        {hero ? <Hero hero={hero} /> : null}
      </div>
    </>
  );
}

export function EventBar() {
  return <EventBarView {...useStoreState<EventBarState>(eventBarStore)} />;
}
