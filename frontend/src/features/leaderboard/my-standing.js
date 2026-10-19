// The viewer's own standing — the card at the top of the Challenges tab
// (./your-standing.tsx): "#22 of 161 people".
//
// The rank and the token allocation used to lead the Me screen. The
// navigation prototype's Me is a compact card with three stat cards and a
// "More" list, and its "Challenges & standings" row lands on a Challenges
// page whose FIRST card is this one. So the numbers moved with the row that
// leads to them, and the read moved with the numbers: the session-scoped
// /challenges-api ranking Profile made, scoped to the active season by the
// server (`season_id=active`, #2777).
//
// The Semi design (2026-10-16) took the season out of the card: no season
// name, no note on how often the standings update, and no points by event
// (so no breakdown read). What is left is where the viewer stands and among
// how many people. #5473 put the update note back on the card
// (./your-standing.tsx draws it), because people could not tell why their
// rank moved with no activity of their own.
//
// The token figure keeps its one-time "Reveal" acknowledgement under the
// SAME storage key the profile used, so nobody who already revealed it is
// asked again because it changed screens.
'use strict';

import { createStore } from '../../lib/plain-store.js';
import { t } from '../../lib/i18n/runtime';
import { tokenView } from '../profile/profile-store.js';

export const REVEAL_KEY = 'sv:profile_tokens_revealed';

export const myStandingStore = createStore({
  /** 'idle' | 'loading' | 'ready' | 'none' — `none` is signed out or no season. */
  status: 'idle',
  ranking: null,
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
 * a signed-out visitor, and for a viewer with no row in the standings AND no
 * points — a card reading "#–" says nothing a newcomer needs. The exception
 * is someone who HAS earned challenge points the standings have not caught
 * up with (#3187): for them "no card" read as "0 points, no rank", so the
 * card stays and says the points are not in the standings yet.
 *
 * `rank` and `people` are numbers (null and 0 when unknown); the card spells
 * them as one message, "#22 of 161 people".
 */
export function standingView(state) {
  if (state.status !== 'ready' || !state.ranking) return null;
  const r = state.ranking;
  const pending = standingIsEmpty(r) ? Number(state.pending || 0) : 0;
  if (standingIsEmpty(r) && pending <= 0) return null;
  const rank = Number(r.rank);
  const people = Number(r.total_participants);
  return {
    rank: Number.isInteger(rank) && rank > 0 ? rank : null,
    people: Number.isFinite(people) && people > 0 ? Math.floor(people) : 0,
    pending: pending > 0
      ? t('leaderboard:standing.pending', { count: pending, points: pending.toLocaleString() }) : null,
    token: tokenView(r, state.revealed),
  };
}

const MyStanding = {
  _token: 0,

  async load() {
    const token = ++MyStanding._token;
    if (myStandingStore.get().status === 'idle') myStandingStore.set({ status: 'loading' });
    try {
      const ranking = await fetchData('/challenges-api/me/ranking?season_id=active');
      // Only when the standings have nothing for the viewer: ask the ledger
      // whether challenge points are waiting for the next snapshot. An
      // existing read, scoped to the season the ranking resolved.
      let pending = 0;
      if (ranking && standingIsEmpty(ranking) && ranking.season_id) {
        const challenges = await fetchData(
          `/challenges-api/challenges?season_id=${encodeURIComponent(ranking.season_id)}`
        ).catch(() => null);
        pending = ledgerPoints(challenges);
      }
      if (token !== MyStanding._token) return;
      myStandingStore.set({ status: 'ready', ranking, pending, revealed: readRevealed() });
    } catch (_) {
      if (token !== MyStanding._token) return;
      // Signed out (401), no season, or a network fault: the card is an
      // addition to the tab, so it simply is not drawn.
      myStandingStore.set({ status: 'none', ranking: null, pending: 0 });
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
