// Challenges screen — the mobile app's native Challenges tab absorbed into
// SV (app-as-SV-chrome migration, NATIVE-BRIDGE.md). Renders the active
// season, its challenge list, and the season points leaderboard from the
// public leaderboard service via the server's read-only /challenges-api
// passthrough (server.js). No bridge dependency — works identically on
// desktop and inside the app webview.
//
// Hosted in #challenges-root; mounted/unmounted by App.navigateToChallenges
// / App._exitChallenges when the #challenges hash route is active.

const Challenges = {
  _open: false,
  _loading: false,
  // { season, challenges, leaderboard } — kept across open/close so
  // re-entering the screen paints instantly, then refreshes.
  _data: null,

  isOpen() { return Challenges._open; },

  async open() {
    Challenges._open = true;
    Challenges._render();
    await Challenges._load();
  },

  close() {
    Challenges._open = false;
  },

  async _fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // The leaderboard API wraps every response in { success, data }.
    if (body && typeof body === 'object' && 'success' in body) {
      if (body.success === false) throw new Error('API error');
      return body.data;
    }
    return body;
  },

  async _load() {
    if (Challenges._loading) return;
    Challenges._loading = true;
    try {
      // Seasons first — everything else is scoped to the active one.
      const seasonsRaw = await Challenges._fetchJson('/challenges-api/seasons');
      const seasons = Array.isArray(seasonsRaw)
        ? seasonsRaw
        : (seasonsRaw && seasonsRaw.seasons) || [];
      const active = seasons.find((s) => s.is_active) ||
        seasons[seasons.length - 1] || null;
      const seasonId = active ? (active.season_id ?? active.id) : null;

      let [challenges, leaderboard] = await Promise.all([
        seasonId != null
          ? Challenges._fetchJson(
              `/challenges-api/challenges?season_id=${seasonId}&active_only=1`)
          : Promise.resolve([]),
        seasonId != null
          ? Challenges._fetchJson(
              `/challenges-api/leaderboard?season_id=${seasonId}` +
              '&page=1&per_page=20').catch(() => null)
          : Promise.resolve(null),
      ]);

      // Between events the active-only list is empty; fall back to the full
      // season list so the screen still has content (matches "browse all"
      // rather than a blank state).
      let allSeason = false;
      if (seasonId != null &&
          (!Array.isArray(challenges) || challenges.length === 0)) {
        challenges = await Challenges._fetchJson(
          `/challenges-api/challenges?season_id=${seasonId}`).catch(() => []);
        allSeason = true;
      }

      Challenges._data = {
        season: active,
        challenges: Array.isArray(challenges) ? challenges : [],
        allSeason,
        leaderboard,
      };
    } catch (err) {
      console.warn('[challenges] load failed:', err);
      if (!Challenges._data) Challenges._data = { error: true };
    } finally {
      Challenges._loading = false;
    }
    if (Challenges._open) Challenges._render();
  },

  // ── rendering ─────────────────────────────────────────────────────────

  _el(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  },

  _render() {
    const root = document.getElementById('challenges-root');
    if (!root) return;
    root.textContent = '';

    const d = Challenges._data;
    if (!d) {
      root.appendChild(Challenges._el('div',
        'text-sm text-zinc-400 py-8 text-center', 'Loading challenges…'));
      return;
    }
    if (d.error) {
      root.appendChild(Challenges._el('div',
        'text-sm text-zinc-400 py-8 text-center',
        'Could not load challenges — check your connection and try again.'));
      return;
    }

    // Season header
    if (d.season) {
      const head = Challenges._el('div', 'mb-4');
      head.appendChild(Challenges._el('div', 'text-xl font-bold',
        d.season.name || 'Season'));
      const range = Challenges._seasonRange(d.season);
      if (range) {
        head.appendChild(Challenges._el('div',
          'text-xs text-zinc-500 dark:text-zinc-400', range));
      }
      root.appendChild(head);
    }

    // Challenge cards
    const list = d.challenges
      .filter((c) => c.enabled !== false)
      .sort((a, b) =>
        (b.featured === true) - (a.featured === true) ||
        (a.display_order || 0) - (b.display_order || 0));
    if (list.length === 0) {
      root.appendChild(Challenges._el('div',
        'text-sm text-zinc-400 py-4', 'No active challenges right now.'));
    } else {
      root.appendChild(Challenges._el('div',
        'text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-2',
        d.allSeason ? 'Season challenges' : 'Active challenges'));
    }
    for (const c of list) {
      root.appendChild(Challenges._renderCard(c));
    }

    // Leaderboard
    const entries = d.leaderboard &&
      (d.leaderboard.leaderboard || d.leaderboard.entries);
    if (Array.isArray(entries) && entries.length > 0) {
      root.appendChild(Challenges._el('div',
        'text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2',
        'Season leaderboard'));
      const board = Challenges._el('div',
        'rounded-xl border border-zinc-200 dark:border-zinc-800 ' +
        'divide-y divide-zinc-100 dark:divide-zinc-800');
      for (const e of entries) {
        const row = Challenges._el('div',
          'flex items-center gap-3 px-3 py-2 text-sm');
        row.appendChild(Challenges._el('span',
          'w-8 shrink-0 text-zinc-400 font-mono text-xs', `#${e.rank}`));
        row.appendChild(Challenges._el('span', 'flex-1 min-w-0 truncate',
          e.display_name || `Participant ${e.participant_id}`));
        row.appendChild(Challenges._el('span',
          'shrink-0 font-semibold text-violet-600 dark:text-violet-400',
          `${Number(e.total_points || 0).toLocaleString()} pts`));
        board.appendChild(row);
      }
      root.appendChild(board);
    }
  },

  _renderCard(c) {
    const card = Challenges._el('div',
      'rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 mb-3' +
      (c.featured ? ' ring-1 ring-violet-500/40' : ''));

    const top = Challenges._el('div', 'flex items-center gap-2 mb-1');
    if (c.category) {
      top.appendChild(Challenges._el('span',
        'px-2 py-0.5 rounded-full text-[0.65rem] font-semibold uppercase ' +
        'tracking-wide bg-zinc-100 dark:bg-zinc-800 text-zinc-500 ' +
        'dark:text-zinc-400', c.category));
    }
    if (c.completed) {
      top.appendChild(Challenges._el('span',
        'px-2 py-0.5 rounded-full text-[0.65rem] font-semibold ' +
        'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        'Completed'));
    }
    card.appendChild(top);

    card.appendChild(Challenges._el('div', 'font-semibold', c.goal || c.task));
    if (c.task && c.goal) {
      card.appendChild(Challenges._el('div',
        'text-sm text-zinc-500 dark:text-zinc-400 mt-0.5', c.task));
    }
    if (c.reward) {
      card.appendChild(Challenges._el('div',
        'text-xs font-medium text-violet-600 dark:text-violet-400 mt-2',
        `Reward: ${c.reward}`));
    }
    return card;
  },

  _seasonRange(season) {
    const fmt = (iso) => {
      if (!iso) return null;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return null;
      return new Date(t).toLocaleDateString(undefined,
        { month: 'short', day: 'numeric' });
    };
    const start = fmt(season.starts_at);
    const end = fmt(season.ends_at);
    if (start && end) return `${start} – ${end}`;
    if (end) return `Ends ${end}`;
    return null;
  },
};

window.Challenges = Challenges;
