// The Leaderboard screen's History section (#leaderboard/seasons): the
// seasons that have ended, who won each, who won each of its events, and
// where the viewer finished.
//
// The navigation prototype's Challenges page has four segments —
// Challenges, Standings, History, Kudos — and History was the one the
// product did not have. The event <select> in #leaderboard-event-bar could
// reach a past event, one at a time; nothing laid the seasons out side by
// side. GET /api/v4/season-history (src/services/topochain/season-history.js)
// reads them all in one call, and this module owns that one fetch and the
// view model ./history-pane.tsx draws, the same split as the three other
// panes on this screen: the WORDS and the decisions are here, in plain JS a
// `node --test` suite can import, and the .tsx only spells them as markup.
//
// Mounted lazily by Leaderboard._applySection the first time the tab shows,
// like its siblings, and torn down by Leaderboard.close(). The fetch is
// cheap and the server caches it, so every open re-reads; close() only stops
// a late answer from painting a pane nobody is looking at.
'use strict';

import { createStore } from '../../lib/plain-store.js';

/**
 * `mounted: false` is the prerender state — the root ships empty and hidden,
 * so nothing may render until the section is first opened.
 */
export const historyStore = createStore({
  mounted: false,
  /** 'loading' | 'error' | 'ready' */
  status: 'loading',
  /** GET /api/v4/season-history's `data.seasons`, as received. */
  seasons: [],
});

/** The month a season ended, with its year once that is not this one. */
export function endedLabel(iso, now = new Date()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const date = new Date(t);
  const opts = date.getFullYear() === now.getFullYear()
    ? { month: 'long' }
    : { month: 'long', year: 'numeric' };
  try {
    return `ended ${date.toLocaleDateString(undefined, opts)}`;
  } catch (_) {
    return null;
  }
}

/** One avatar letter, the first letter or digit of the name. */
export function initialOf(name) {
  const match = String(name || '').match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : '?';
}

/**
 * The sentence under a season's name. The prototype's "Lee won with 31 pts ·
 * you finished #4", with the two honest variants it never had to draw: a
 * season nobody placed in, and a viewer who took part without a rank (a
 * podium-excluded account).
 */
export function resultLine(season) {
  const parts = [];
  if (season.winner) {
    parts.push(`${season.winner.name} won with ${Number(season.winner.points || 0).toLocaleString()} pts`);
  } else {
    parts.push('No winner was recorded');
  }
  const you = season.you;
  if (you && you.rank) parts.push(`you finished #${you.rank}`);
  else if (you) parts.push('you took part');
  return parts.join(' · ');
}

/** The pane's whole view, from the store. Pure, for the tests. */
export function historyView(state, now = new Date()) {
  if (!state.mounted) return { kind: 'none' };
  if (state.status === 'loading') return { kind: 'loading' };
  if (state.status === 'error') {
    return { kind: 'error', message: 'Couldn’t load past seasons. Try again later.' };
  }
  const seasons = Array.isArray(state.seasons) ? state.seasons : [];
  if (!seasons.length) {
    return {
      kind: 'empty',
      message: 'No season has ended yet. When one does, its winners are listed here.',
    };
  }
  return {
    kind: 'seasons',
    seasons: seasons.map((s) => ({
      key: String(s.season_id),
      name: String(s.name || 'Season'),
      ended: endedLabel(s.ends_at, now),
      winnerInitial: s.winner ? initialOf(s.winner.name) : null,
      line: resultLine(s),
      events: (Array.isArray(s.events) ? s.events : []).map((ev) => ({
        key: String(ev.id),
        label: ev.winner ? `${ev.name} · ${ev.winner.name}` : `${ev.name} · no winner`,
      })),
    })),
  };
}

function demoQuery() {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch (_) {
    return '';
  }
}

const LeaderboardHistory = {
  _open: false,
  _token: 0,

  open() {
    LeaderboardHistory._open = true;
    historyStore.set({ mounted: true });
    return LeaderboardHistory.refresh();
  },

  close() {
    LeaderboardHistory._open = false;
    LeaderboardHistory._token++;
  },

  async refresh() {
    const token = ++LeaderboardHistory._token;
    // Keep what is on screen while a refresh runs; only a first load shows
    // the placeholders.
    if (!historyStore.get().seasons.length) historyStore.set({ status: 'loading' });
    try {
      const res = await fetch(`/api/v4/season-history${demoQuery()}`, { credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      if (token !== LeaderboardHistory._token) return;
      if (!res.ok || !body || body.success === false || !body.data) throw new Error(`HTTP ${res.status}`);
      historyStore.set({
        status: 'ready',
        seasons: Array.isArray(body.data.seasons) ? body.data.seasons : [],
      });
    } catch (err) {
      if (token !== LeaderboardHistory._token) return;
      console.warn('[leaderboard] history load failed', err);
      if (!historyStore.get().seasons.length) historyStore.set({ status: 'error' });
    }
  },
};

// Published by name, like its three siblings: ./leaderboard.js mounts it
// from _applySection and reaches it through `window`. Guarded for the SSG
// prerender pass, which evaluates this graph in Node.
if (typeof window !== 'undefined') window.LeaderboardHistory = LeaderboardHistory;

export { LeaderboardHistory };
