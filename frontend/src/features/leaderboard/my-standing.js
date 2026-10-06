// The viewer's own standing in the active season — the card at the top of
// the Challenges tab (./your-standing.tsx).
//
// These four numbers used to lead the Me screen: points, rank, the
// per-event breakdown and the token allocation. The navigation prototype's
// Me is a compact card with three stat cards and a "More" list, and its
// "Challenges & standings" row lands on a Challenges page whose FIRST card
// is exactly this one ("Season 3 · #3 · 9 pts · you"). So the numbers moved
// with the row that leads to them, and the reads moved with the numbers:
// the same two session-scoped /challenges-api reads Profile made, scoped to
// the active season by the server (`season_id=active`, #2777).
//
// The token figure keeps its one-time "Reveal" acknowledgement under the
// SAME storage key the profile used, so nobody who already revealed it is
// asked again because it changed screens.
'use strict';

import { createStore } from '../../lib/plain-store.js';
import { breakdownRows, tokenView } from '../profile/profile-store.js';

export const REVEAL_KEY = 'sv:profile_tokens_revealed';

// Standings are read from leaderboard snapshots, which the challenge scorer
// rebuilds on a timer (CHALLENGE_SCORER_AGGREGATE_HOURS, six hours by
// default), while a challenge credits its points the moment it is done. The
// interval is server config the client never sees, hence "every few hours".
// The standings pane's empty hint says the same sentence.
export const STANDINGS_UPDATE_NOTE =
  'Standings update every few hours; points from challenges you just finished appear at the next update.';

export const myStandingStore = createStore({
  /** 'idle' | 'loading' | 'ready' | 'none' — `none` is signed out or no season. */
  status: 'idle',
  ranking: null,
  breakdown: null,
  /** Challenge points credited to the viewer that the standings do not show yet. */
  pending: 0,
  revealed: false,
});

function readRevealed() {
  try { return localStorage.getItem(REVEAL_KEY) === '1'; } catch (_) { return false; }
}

async function fetchData(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  if (body && typeof body === 'object' && 'success' in body) {
    if (body.success === false) throw new Error('API error');
    return body.data;
  }
  return body;
}

/** Whether the standings have nothing for the viewer yet: no rank, no points. */
function standingIsEmpty(r) {
  return !r.rank && Number(r.total_points || 0) === 0;
}

/**
 * The viewer's own challenge points in a season, summed from the per-viewer
 * `activities_total` each /challenges-api/challenges row carries: the points
 * ledger, which is credited at once rather than at the next snapshot.
 */
export function ledgerPoints(challenges) {
  if (!Array.isArray(challenges)) return 0;
  return challenges.reduce((sum, c) => {
    const n = Number(c && c.activities_total);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

/**
 * The card's view, or null for "draw nothing": before the first answer, for
 * a signed-out visitor, and for a season the viewer has no row in AND no
 * points — a card reading "#– · 0 pts" says nothing a newcomer needs. The
 * exception is someone who HAS earned challenge points the standings have
 * not caught up with (#3187): for them "no card" read as "0 points, no
 * rank", so the card stays and says when the points will count.
 */
export function standingView(state) {
  if (state.status !== 'ready' || !state.ranking) return null;
  const r = state.ranking;
  const points = Number(r.total_points || 0);
  // `pending` is the GAP: what the ledger has credited that the standings do
  // not show yet, empty standing or not (#4017) — around the weekly reset the
  // ranked card too can sit below what was earned while the snapshot lags.
  const pending = Number(state.pending || 0);
  if (standingIsEmpty(r) && pending <= 0) return null;
  return {
    season: r.season_name || 'This season',
    sub: r.total_participants
      ? `${Number(r.total_participants).toLocaleString()} taking part`
      : 'Your standing',
    rank: r.rank ? `#${Number(r.rank)}` : '–',
    detail: `${points.toLocaleString()} pts · you`,
    pending: pending > 0 ? `${pending.toLocaleString()} pts earned, not in the standings yet` : null,
    note: STANDINGS_UPDATE_NOTE,
    breakdown: breakdownRows(state.breakdown).map((row, i) => ({
      key: `${row.label}:${i}`,
      label: row.label,
      points: `${Number(row.points || 0).toLocaleString()} pts`,
    })),
    token: tokenView(r, state.revealed),
  };
}

const MyStanding = {
  _token: 0,

  async load() {
    const token = ++MyStanding._token;
    if (myStandingStore.get().status === 'idle') myStandingStore.set({ status: 'loading' });
    try {
      const [ranking, breakdown] = await Promise.all([
        fetchData('/challenges-api/me/ranking?season_id=active'),
        fetchData('/challenges-api/me/breakdown?season_id=active&include_activity=0&include_progress=0')
          .catch(() => null),
      ]);
      // Ask the ledger what the viewer's challenge completions earned,
      // whether the standings show it or not (#4017): an empty standing is
      // not the only lag case, a ranked one can sit below the ledger too
      // around the weekly reset. The read is the same existing one, scoped
      // to the season the ranking resolved, and what is stored is the GAP —
      // the standings' share of the ledger is already on the card, so the
      // line names only the missing difference. A clamp, not a sum: a
      // standings total that already carries every point (or more, from
      // sources the per-challenge ledger does not see) draws no line.
      let pending = 0;
      if (ranking && ranking.season_id) {
        const challenges = await fetchData(
          `/challenges-api/challenges?season_id=${encodeURIComponent(ranking.season_id)}`
        ).catch(() => null);
        pending = Math.max(0, ledgerPoints(challenges) - Number(ranking.total_points || 0));
      }
      if (token !== MyStanding._token) return;
      myStandingStore.set({ status: 'ready', ranking, breakdown, pending, revealed: readRevealed() });
    } catch (_) {
      if (token !== MyStanding._token) return;
      // Signed out (401), no season, or a network fault: the card is an
      // addition to the tab, so it simply is not drawn.
      myStandingStore.set({ status: 'none', ranking: null, breakdown: null, pending: 0 });
    }
  },

  revealTokens() {
    try { localStorage.setItem(REVEAL_KEY, '1'); } catch (_) { /* private mode */ }
    myStandingStore.set({ revealed: true });
  },

  // The web terms sheet; an accept un-gates the allocation on the next read.
  reviewTerms() {
    const settings = typeof window !== 'undefined' ? window.Settings : null;
    if (settings && typeof settings.showTermsSheet === 'function') {
      settings.showTermsSheet(() => { void MyStanding.load(); });
    }
  },
};

export { MyStanding };
