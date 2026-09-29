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

export const myStandingStore = createStore({
  /** 'idle' | 'loading' | 'ready' | 'none' — `none` is signed out or no season. */
  status: 'idle',
  ranking: null,
  breakdown: null,
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

/**
 * The card's view, or null for "draw nothing": before the first answer, for
 * a signed-out visitor, and for a season the viewer has no row in AND no
 * points — a card reading "#– · 0 pts" says nothing a newcomer needs.
 */
export function standingView(state) {
  if (state.status !== 'ready' || !state.ranking) return null;
  const r = state.ranking;
  const points = Number(r.total_points || 0);
  if (!r.rank && points === 0) return null;
  return {
    season: r.season_name || 'This season',
    sub: r.total_participants
      ? `${Number(r.total_participants).toLocaleString()} taking part`
      : 'Your standing',
    rank: r.rank ? `#${Number(r.rank)}` : '–',
    detail: `${points.toLocaleString()} pts · you`,
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
      if (token !== MyStanding._token) return;
      myStandingStore.set({ status: 'ready', ranking, breakdown, revealed: readRevealed() });
    } catch (_) {
      if (token !== MyStanding._token) return;
      // Signed out (401), no season, or a network fault: the card is an
      // addition to the tab, so it simply is not drawn.
      myStandingStore.set({ status: 'none', ranking: null, breakdown: null });
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
