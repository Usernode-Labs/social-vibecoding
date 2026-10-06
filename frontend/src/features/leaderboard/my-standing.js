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
  /** The viewer's earned challenge points, summed from the season's ledger. */
  ledger: 0,
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
 * points — a card reading "#– · 0 pts" says nothing a newcomer needs. That
 * is the only place the standings' emptiness matters now: whenever the
 * ledger is AHEAD of the total shown (points credited since the last
 * rebuild — a season reset, or the standings are simply between updates;
 * #3187 was the empty-row case of it), the card says what it is not yet
 * showing. The clamp keeps the line honest the other way too: points from
 * outside the ledger (block production, adjustments) can leave the
 * standings ahead, and no one is shown a negative gap.
 */
export function standingView(state) {
  if (state.status !== 'ready' || !state.ranking) return null;
  const r = state.ranking;
  const points = Number(r.total_points || 0);
  const gap = Math.max(0, Number(state.ledger || 0) - points);
  if (standingIsEmpty(r) && gap <= 0) return null;
  return {
    season: r.season_name || 'This season',
    sub: r.total_participants
      ? `${Number(r.total_participants).toLocaleString()} taking part`
      : 'Your standing',
    rank: r.rank ? `#${Number(r.rank)}` : '–',
    detail: `${points.toLocaleString()} pts · you`,
    pending: gap > 0 ? `${gap.toLocaleString()} pts earned, not in the standings yet` : null,
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
      // Ask the ledger whenever the ranking resolved a season, ranked or not:
      // a snapshot total can lag the ledger for anyone (a rebuild is due, or
      // a season reset), not only for an empty row. An existing read, scoped
      // to the season the ranking resolved. Global scope (no season_id)
      // reads no ledger, as before.
      let ledger = 0;
      if (ranking && ranking.season_id) {
        const challenges = await fetchData(
          `/challenges-api/challenges?season_id=${encodeURIComponent(ranking.season_id)}`
        ).catch(() => null);
        ledger = ledgerPoints(challenges);
      }
      if (token !== MyStanding._token) return;
      myStandingStore.set({ status: 'ready', ranking, breakdown, ledger, revealed: readRevealed() });
    } catch (_) {
      if (token !== MyStanding._token) return;
      // Signed out (401), no season, or a network fault: the card is an
      // addition to the tab, so it simply is not drawn.
      myStandingStore.set({ status: 'none', ranking: null, breakdown: null, ledger: 0 });
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
