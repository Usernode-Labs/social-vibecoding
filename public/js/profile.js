// Profile screen — the mobile app's native Profile screen absorbed into SV
// (profile-and-settings-to-web migration, NATIVE-BRIDGE.md). Renders the
// user's rank + points, token allocation (with reveal), points breakdown,
// and completed challenges from the in-process /challenges-api routes
// (src/routes/topochain/mobile.js).
//
// Identity comes from the platform session: since the topochain merge,
// leaderboard participants ARE platform users, so the /me/* routes scope
// to the signed-in session server-side. The bridge's getProfileInfo()
// participant id (bridge v3) is no longer consulted for data.
//
// Hosted in #profile-root; mounted/unmounted by App.navigateToProfile /
// App._exitProfile when the #profile hash route is active.

const Profile = {
  _open: false,
  _loading: false,
  // { ranking, breakdown, challenges, season } — kept across open/close so
  // re-entering the screen paints instantly, then refreshes.
  _data: null,

  // The token figure stays blurred until the user taps "Reveal" once;
  // mirrors the native TokenAllocationReveal acknowledgement.
  _REVEAL_KEY: 'sv:profile_tokens_revealed',

  isOpen() { return Profile._open; },

  async open() {
    Profile._open = true;
    Profile._render();
    await Profile._load();
  },

  close() {
    Profile._open = false;
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
    if (Profile._loading) return;
    Profile._loading = true;
    try {
      // Scope everything to the active season, like the challenges screen.
      const seasonsRaw = await Profile._fetchJson('/challenges-api/seasons');
      const seasons = Array.isArray(seasonsRaw)
        ? seasonsRaw
        : (seasonsRaw && seasonsRaw.seasons) || [];
      const active = seasons.find((s) => s.is_active) ||
        seasons[seasons.length - 1] || null;
      const seasonId = active ? (active.season_id ?? active.id) : null;
      const seasonQS = seasonId != null ? `?season_id=${seasonId}` : '';

      const [ranking, breakdown, challenges] = await Promise.all([
        Profile._fetchJson(`/challenges-api/me/ranking${seasonQS}`),
        Profile._fetchJson(
          '/challenges-api/me/breakdown?include_activity=1' +
          (seasonId != null ? `&season_id=${seasonId}` : ''))
          .catch(() => null),
        seasonId != null
          ? Profile._fetchJson(
              `/challenges-api/challenges?season_id=${seasonId}`)
              .catch(() => [])
          : Promise.resolve([]),
      ]);

      Profile._data = {
        season: active,
        ranking,
        breakdown,
        challenges: Array.isArray(challenges) ? challenges : [],
      };
    } catch (err) {
      console.warn('[profile] load failed:', err);
      if (!Profile._data) Profile._data = { error: true };
    } finally {
      Profile._loading = false;
    }
    if (Profile._open) Profile._render();
  },

  // ── rendering ─────────────────────────────────────────────────────────

  _el(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  },

  _render() {
    const root = document.getElementById('profile-root');
    if (!root) return;
    root.textContent = '';

    const d = Profile._data;
    if (!d) {
      root.appendChild(Profile._el('div',
        'text-sm text-zinc-400 py-8 text-center', 'Loading profile…'));
      return;
    }
    if (d.error) {
      root.appendChild(Profile._el('div',
        'text-sm text-zinc-400 py-8 text-center',
        'Could not load your profile — check your connection and try again.'));
      return;
    }
    const r = d.ranking || {};

    // Rank + points header (native ScoreHeader equivalent).
    const head = Profile._el('div', 'text-center mb-5');
    head.appendChild(Profile._el('div',
      'text-4xl font-extrabold tracking-tight',
      Number(r.total_points || 0).toLocaleString()));
    head.appendChild(Profile._el('div',
      'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mt-1',
      'points'));
    const sub = [];
    if (r.rank) {
      sub.push(`Rank #${r.rank}` +
        (r.total_participants ? ` of ${r.total_participants}` : ''));
    }
    const seasonName = r.season_name ||
      (d.season && d.season.name) || null;
    if (seasonName) sub.push(seasonName);
    if (sub.length) {
      head.appendChild(Profile._el('div',
        'text-sm text-zinc-500 dark:text-zinc-400 mt-2', sub.join(' · ')));
    }
    root.appendChild(head);

    // Token allocation card.
    root.appendChild(Profile._renderTokenCard(r));

    // Points breakdown.
    const bkRows = Profile._breakdownRows(d.breakdown);
    if (bkRows.length > 0) {
      root.appendChild(Profile._el('div',
        'text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2',
        'Points breakdown'));
      const box = Profile._el('div',
        'rounded-xl border border-zinc-200 dark:border-zinc-800 ' +
        'divide-y divide-zinc-100 dark:divide-zinc-800');
      for (const rowDef of bkRows) {
        const row = Profile._el('div',
          'flex items-center gap-3 px-3 py-2 text-sm');
        row.appendChild(Profile._el('span', 'flex-1 min-w-0 truncate',
          rowDef.label));
        row.appendChild(Profile._el('span',
          'shrink-0 font-semibold text-violet-600 dark:text-violet-400',
          `${Number(rowDef.points || 0).toLocaleString()} pts`));
        box.appendChild(row);
      }
      root.appendChild(box);
    }

    // Completed challenges.
    const completed = d.challenges.filter((c) => c.completed);
    root.appendChild(Profile._el('div',
      'text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2',
      'Completed challenges'));
    if (completed.length === 0) {
      root.appendChild(Profile._el('div',
        'text-sm text-zinc-400 py-2', 'No completed challenges yet.'));
    }
    for (const c of completed) {
      const card = Profile._el('div',
        'rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 mb-2 ' +
        'flex items-center gap-3');
      const body = Profile._el('div', 'flex-1 min-w-0');
      body.appendChild(Profile._el('div', 'font-medium text-sm truncate',
        c.goal || c.task));
      if (c.category) {
        body.appendChild(Profile._el('div',
          'text-xs text-zinc-500 dark:text-zinc-400 mt-0.5', c.category));
      }
      card.appendChild(body);
      card.appendChild(Profile._el('span',
        'shrink-0 px-2 py-0.5 rounded-full text-[0.65rem] font-semibold ' +
        'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        'Completed'));
      root.appendChild(card);
    }
  },

  // The backend zeroes total_tokens until terms are accepted, so a gated
  // allocation must show the terms notice, never a fake 0 balance
  // (mirrors the native TokenAllocationGatedNotice).
  _renderTokenCard(ranking) {
    const card = Profile._el('div',
      'rounded-xl border border-zinc-200 dark:border-zinc-800 p-4');

    if (ranking.terms_accepted === false) {
      card.appendChild(Profile._el('div', 'font-semibold mb-1',
        'Token allocation withheld'));
      card.appendChild(Profile._el('div',
        'text-sm text-zinc-500 dark:text-zinc-400 mb-3',
        'Review and accept the terms to see your token allocation.'));
      const btn = Profile._el('button',
        'px-3 py-1.5 rounded-lg text-sm font-medium border ' +
        'border-violet-500 text-violet-600 dark:text-violet-400 ' +
        'hover:bg-violet-50 dark:hover:bg-violet-950', 'Review terms');
      btn.addEventListener('click', () => {
        if (window.usernode &&
            typeof window.usernode.openNativeScreen === 'function') {
          window.usernode.openNativeScreen('terms').catch((err) => {
            console.warn('[profile] openNativeScreen(terms) failed:', err);
            if (window.PlatformUI) {
              PlatformUI.toast('Could not open the terms screen');
            }
          });
        }
      });
      card.appendChild(btn);
      return card;
    }

    const amount = Number(ranking.total_tokens || 0);
    const revealed = localStorage.getItem(Profile._REVEAL_KEY) === '1';

    card.appendChild(Profile._el('div',
      'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1',
      'Token allocation'));
    const value = Profile._el('div',
      'text-2xl font-bold' + (revealed ? '' : ' blur-md select-none'),
      amount.toLocaleString());
    value.setAttribute('aria-hidden', revealed ? 'false' : 'true');
    card.appendChild(value);
    card.appendChild(Profile._el('div',
      'text-xs text-zinc-500 dark:text-zinc-400 mt-2',
      'Allocations are provisional and subject to the program terms.'));

    if (!revealed) {
      const btn = Profile._el('button',
        'mt-3 px-3 py-1.5 rounded-lg text-sm font-medium border ' +
        'border-violet-500 text-violet-600 dark:text-violet-400 ' +
        'hover:bg-violet-50 dark:hover:bg-violet-950', 'Reveal');
      btn.addEventListener('click', () => {
        localStorage.setItem(Profile._REVEAL_KEY, '1');
        Profile._render();
      });
      card.appendChild(btn);
    }
    return card;
  },

  // Flattens the /me/breakdown response (event | season | global scope)
  // into label/points rows: one per event, plus offchain points when
  // present.
  _breakdownRows(breakdown) {
    if (!breakdown || typeof breakdown !== 'object') return [];
    const rows = [];
    const pushEvent = (ev) => {
      if (!ev) return;
      const name = (ev.event && ev.event.name) || ev.event_name || 'Event';
      rows.push({ label: name, points: ev.total_points });
    };
    if (breakdown.scope === 'event') {
      pushEvent(breakdown);
    } else if (Array.isArray(breakdown.events)) {
      breakdown.events.forEach(pushEvent);
    } else if (Array.isArray(breakdown.seasons)) {
      for (const season of breakdown.seasons) {
        (season.events || []).forEach(pushEvent);
      }
    }
    if (Number(breakdown.offchain_points || 0) > 0) {
      rows.push({ label: 'Bonus points', points: breakdown.offchain_points });
    }
    return rows;
  },
};

window.Profile = Profile;
