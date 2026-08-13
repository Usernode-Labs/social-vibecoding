// The Challenges pane's subtree — #1191 slice 6, conversion 7, and the last
// of the Leaderboard screen's three innerHTML hosts to go.
//
// ── What this renders ──────────────────────────────────────────────────
//
// Everything `TopochainChallenges._renderShell()` used to innerHTML into
// #challenges-root: the grid host, and the two full-screen overlays that sit
// on top of it. The descriptors come from ./topochain-challenges-store.js,
// which that module fills; nothing here decides anything. The completed
// split, the summary tally, the deep-link resolution, the scheme guard on the
// CTA — all of it stays in the .js, which is both the island rule's
// "converted markup is like-for-like" and what keeps
// tests/challenge-deep-link.test.js able to run the real controller in a vm.
//
// ── Initial render ─────────────────────────────────────────────────────
//
// `mounted` is false until the pane is first opened, and this returns null
// until it flips. That is not an optimisation: the shipped
// #challenges-root is EMPTY, the SSG prerender pass evaluates this module,
// and anything rendered here on the first pass would land in
// public/index.html and change the structural baseline. The store's header
// says the same thing from the other end.
//
// ── Two things that are NOT portals ────────────────────────────────────
//
// Both overlays are `fixed inset-0 z-50` children of #challenges-root, which
// is where the markup put them and where they still are. They cover the
// viewport by position, not by parentage, so there is nothing for a portal to
// solve — and a portal would put React-managed nodes outside the island,
// which is the one thing the island rule is about.
//
// Backdrop dismiss keeps its original test verbatim: `e.target.id === <the
// overlay root>`, not `e.target === e.currentTarget`. They agree today, and
// the id form is the one the markup shipped.
//
// ── Whitespace ─────────────────────────────────────────────────────────
//
// Where the old strings put a bare space between two interpolations, the
// space is baked into a neighbouring string instead — the participant row's
// points-and-rate and the card's contribution note are composed in
// ./topochain-challenges.js for exactly that reason. `{' '}` is not available
// here (tests/shell-build.test.js rejects it: adjacent text children are
// React #418 in a hydrating tree).

import { Fragment } from 'react';
import type { ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { topochainChallengesStore } from './topochain-challenges-store.js';

// The controller, by name. It is published on `window` for its legacy callers
// (./leaderboard.js's lazy mount, app.js's pull-to-refresh and its #982
// deep-link branch) and read back the same way here, so this component adds
// no second import edge to a file that must stay loadable as a classic
// script.
const controller = () => (window as {
  TopochainChallenges?: {
    _openIdx(idx: number): void;
    _toStandings(): void;
    _moreBreakdown(): void;
    closeChallengeDetail(): void;
    closeUserProfile(): void;
    openUserProfile(userId: number): void;
  };
}).TopochainChallenges;

// ── Descriptor shapes (see the builders in ./topochain-challenges.js) ────

type CardView = {
  key: string;
  idx: number;
  featured: boolean;
  done: boolean;
  label: string;
  goal: string;
  task: string;
  reward: string | null;
  mineNote: string | null;
};

type GroupView = { key: string; heading: string | null; cards: CardView[] };

type GridView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'cards'; summary: string; groups: GroupView[] };

type EntryRow = { key: string; userId: number; name: string; nonPodium: boolean; points: string };

type EntriesView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'list'; hasMore: boolean; rows: EntryRow[] };

type CtaView = { kind: 'link'; href: string; label: string } | { kind: 'text'; label: string };

type DetailView = {
  label: string;
  goal: string;
  description: string | null;
  mineNote: string | null;
  requirements: string | null;
  rewardLogic: string | null;
  cta: CtaView | null;
  totals: string | null;
  entries: EntriesView;
};

type ProfileView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
    kind: 'profile';
    name: string;
    stats: { label: string; value: string }[];
    activities: { key: string; text: string; points: string }[] | null;
  };

// ── Class strings, carried over verbatim from the retired templates ──────

const GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';
const CARD = 'tc-se-card bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 '
  + 'dark:border-zinc-800 p-4 cursor-pointer hover:border-violet-400 '
  + 'dark:hover:border-violet-600 transition-colors';
const CARD_FEATURED = ' ring-1 ring-violet-500/40';
const CARD_DONE = ' opacity-60';
const CARD_LABEL = 'text-[10px] uppercase tracking-wide text-violet-600 '
  + 'dark:text-violet-400 font-semibold';
const DONE_CHIP = 'shrink-0 inline-block px-2 py-0.5 rounded-full text-[0.65rem] font-semibold '
  + 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
const MINE_NOTE = 'text-xs text-emerald-600 dark:text-emerald-400 mt-2 font-medium';
const GROUP_HEADING = 'text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2';
const GRID_ERROR = 'rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 '
  + 'dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm';

const OVERLAY = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4';
// Split either side of the max-width, which is the one thing the two panels
// disagree about — so each still renders its class attribute in the order the
// markup shipped rather than with the width tacked on the end.
const PANEL_HEAD = 'bg-white dark:bg-zinc-900 rounded-xl p-6 w-full';
const PANEL_TAIL = 'max-h-[85vh] overflow-y-auto shadow-xl border border-zinc-200 '
  + 'dark:border-zinc-800';
const CLOSE_X = 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-xl leading-none';
const ENTRY_ROW = 'tc-se-entry flex items-center justify-between gap-3 text-xs p-1.5 rounded '
  + 'hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer';
// × as a character, not `&times;` — the entity was HTML source; this is text.
const TIMES = '×';

// ── Grid ────────────────────────────────────────────────────────────────

function Card({ view }: { view: CardView }): ReactNode {
  return (
    <div
      className={CARD + (view.featured ? CARD_FEATURED : '') + (view.done ? CARD_DONE : '')}
      onClick={() => controller()?._openIdx(view.idx)}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className={CARD_LABEL}>{view.label}</div>
        {view.done ? <span className={DONE_CHIP}>Completed</span> : null}
      </div>
      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1">{view.goal}</div>
      <p className="text-xs text-zinc-500 line-clamp-2">{view.task}</p>
      {view.reward ? (
        <p className="text-xs text-violet-500 mt-2 font-medium">{view.reward}</p>
      ) : null}
      {view.mineNote ? <p className={MINE_NOTE}>{view.mineNote}</p> : null}
    </div>
  );
}

function Grid({ view }: { view: GridView | null }): ReactNode {
  // Before the first load there is nothing to say — the pane opens, the fetch
  // starts and the loading line arrives on the very next render.
  if (!view) return null;
  if (view.kind === 'loading') {
    return <p className="text-sm text-zinc-500">Loading challenges…</p>;
  }
  if (view.kind === 'error') return <div className={GRID_ERROR}>{view.message}</div>;
  if (view.kind === 'empty') {
    return <p className="text-sm text-zinc-500 py-8 text-center">No challenges for this event yet.</p>;
  }
  return (
    <>
      <p
        id="tc-se-challenge-summary"
        className="text-sm text-zinc-500 dark:text-zinc-400 mb-3"
      >
        {view.summary}
      </p>
      {/*
          Fragment, not a wrapping <div>: the two grids and the subheading
          between them were siblings in the string this replaces, and a
          container here would take the heading's `mt-6` out of the same
          margin context.
      */}
      {view.groups.map((g) => (
        <Fragment key={g.key}>
          {g.heading ? <div className={GROUP_HEADING}>{g.heading}</div> : null}
          <div className={GRID}>
            {g.cards.map((c) => <Card key={c.key} view={c} />)}
          </div>
        </Fragment>
      ))}
      <div className="mt-4 text-center">
        <button
          id="tc-se-to-standings"
          className="text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline"
          onClick={() => controller()?._toStandings()}
        >
          See where the season stands →
        </button>
      </div>
    </>
  );
}

// ── Detail overlay ──────────────────────────────────────────────────────

function Cta({ view }: { view: CtaView }): ReactNode {
  if (view.kind === 'text') {
    return (
      <p className="mb-3 text-xs text-zinc-500">
        {view.label} <span className="italic">(link unavailable)</span>
      </p>
    );
  }
  // `href` reached here only by passing TopochainChallenges.safeHref — an
  // http(s)-only scheme check. There is deliberately no fallback branch: a
  // link that failed it is a different descriptor kind, handled above.
  return (
    <a
      href={view.href}
      target="_blank"
      rel="noopener"
      className="inline-block mb-3 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
    >
      {view.label}
    </a>
  );
}

function Entries({ view }: { view: EntriesView }): ReactNode {
  if (view.kind === 'loading') {
    return <p className="text-xs text-zinc-500">Loading participants…</p>;
  }
  if (view.kind === 'error') return <p className="text-xs text-zinc-500">{view.message}</p>;
  if (view.kind === 'empty') return <p className="text-xs text-zinc-500">No participants yet.</p>;
  return (
    <>
      <ul className="space-y-1">
        {view.rows.map((row) => (
          <li
            key={row.key}
            className={ENTRY_ROW}
            onClick={() => {
              if (Number.isInteger(row.userId)) controller()?.openUserProfile(row.userId);
            }}
          >
            <span className="text-zinc-700 dark:text-zinc-200">
              {row.name}
              {/* The leading space lived between the two spans in the old
                  string; it is inside this one now, for the reason the header
                  gives. */}
              {row.nonPodium ? <span className="text-zinc-400"> (non-podium)</span> : null}
            </span>
            <span className="font-mono text-zinc-400">{row.points}</span>
          </li>
        ))}
      </ul>
      {view.hasMore ? (
        <button
          id="tc-se-breakdown-more"
          className="mt-2 text-xs text-violet-500 hover:text-violet-400"
          onClick={() => controller()?._moreBreakdown()}
        >
          Load more
        </button>
      ) : null}
    </>
  );
}

function DetailPanel({ view }: { view: DetailView }): ReactNode {
  return (
    <>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className={CARD_LABEL}>{view.label}</div>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{view.goal}</h2>
        </div>
        <button
          id="tc-se-detail-close"
          className={CLOSE_X}
          aria-label="Close"
          onClick={() => controller()?.closeChallengeDetail()}
        >
          {TIMES}
        </button>
      </div>
      {view.description ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-2">{view.description}</p>
      ) : null}
      {view.mineNote ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 font-medium">
          {view.mineNote}
        </p>
      ) : null}
      {view.requirements ? (
        <p className="text-xs text-zinc-500 mb-2">
          <span className="font-medium">Requirements:</span> {view.requirements}
        </p>
      ) : null}
      {view.rewardLogic ? (
        <p className="text-xs text-zinc-500 mb-3">
          <span className="font-medium">Reward logic:</span> {view.rewardLogic}
        </p>
      ) : null}
      {view.cta ? <Cta view={view.cta} /> : null}
      <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3">
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Participants</div>
        {view.totals ? <p className="text-xs text-zinc-500 mb-2">{view.totals}</p> : null}
        <Entries view={view.entries} />
      </div>
    </>
  );
}

// ── Profile overlay ─────────────────────────────────────────────────────

function ProfileBody({ view }: { view: ProfileView }): ReactNode {
  if (view.kind === 'loading') return <p className="text-sm text-zinc-500">Loading…</p>;
  if (view.kind === 'error') return <p className="text-sm text-zinc-500">{view.message}</p>;
  return (
    <>
      <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-3">{view.name}</h2>
      <div className="grid grid-cols-2 gap-2 text-xs mb-4">
        {view.stats.map((s) => (
          <div key={s.label}>
            <span className="text-zinc-500">{s.label}</span>
            <div className="font-mono">{s.value}</div>
          </div>
        ))}
      </div>
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Activities</div>
      {view.activities ? (
        <ul className="space-y-1">
          {view.activities.map((a) => (
            <li key={a.key} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-zinc-600 dark:text-zinc-300">{a.text}</span>
              <span className="font-mono text-zinc-400">{a.points}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">No activities recorded.</p>
      )}
    </>
  );
}

// ── The pane ────────────────────────────────────────────────────────────

export function ChallengesPane(): ReactNode {
  const state = useStoreState(topochainChallengesStore) as {
    mounted: boolean;
    grid: GridView | null;
    detail: DetailView | null;
    profile: ProfileView | null;
  };

  // The prerender state, and the state before the pane's first open.
  if (!state.mounted) return null;

  return (
    <>
      <div id="tc-se-grid">
        <Grid view={state.grid} />
      </div>
      {/* Challenge detail overlay */}
      <div
        id="tc-se-detail-overlay"
        className={state.detail ? OVERLAY : `hidden ${OVERLAY}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).id === 'tc-se-detail-overlay') {
            controller()?.closeChallengeDetail();
          }
        }}
      >
        <div id="tc-se-detail-panel" className={`${PANEL_HEAD} max-w-lg ${PANEL_TAIL}`}>
          {state.detail ? <DetailPanel view={state.detail} /> : null}
        </div>
      </div>
      {/* User profile overlay */}
      <div
        id="tc-se-profile-overlay"
        className={state.profile ? OVERLAY : `hidden ${OVERLAY}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).id === 'tc-se-profile-overlay') {
            controller()?.closeUserProfile();
          }
        }}
      >
        <div id="tc-se-profile-panel" className={`${PANEL_HEAD} max-w-md ${PANEL_TAIL}`}>
          {state.profile ? (
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <ProfileBody view={state.profile} />
              </div>
              <button
                id="tc-se-profile-close"
                className={`${CLOSE_X} shrink-0`}
                aria-label="Close"
                onClick={() => controller()?.closeUserProfile()}
              >
                {TIMES}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
