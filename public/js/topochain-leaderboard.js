// Topochain public standings (Task 14, public screens). Was a screen of
// its own (#topochain-leaderboard-screen) until the header slim-down made
// it the SECOND TAB of the Leaderboard screen: it renders into
// #topochain-leaderboard-root inside #leaderboard-screen, and open() /
// close() are called by the Leaderboard module (public/js/leaderboard.js)
// when its section flips, not by a navigate* pair in app.js. The legacy
// #topochain/leaderboard hash still lands here — the router aliases it to
// #leaderboard/topochain.
//
// The event picker and the event hero this module used to own moved UP into
// the screen-level bar owned by public/js/topochain-event-context.js when the
// challenges tab joined the screen — one selection, shared with that tab, so
// the standings and the challenge list can never describe different weeks.
// This module subscribes to it and keeps only what is genuinely
// standings-specific: the disclaimer line, the table, pagination and the
// per-row drill-down. (`disclaimer` / `status` / `has_ended` live on the
// `event` object inside GET /api/v4/leaderboard, NOT on /season-events/:id,
// which is why the disclaimer stays here rather than in the shared hero.)
//
// Plus one line that is NOT standings-specific: the challenge tally and
// "View challenges →" cross-link above the table (#981). It exists because
// the completed-challenge list moved off the profile screen onto this
// screen's Challenges tab, and this tab is where most people arrive — see
// _loadChallengeCounts for the (deliberately failure-silent) fetch.
//
// No isAdmin gate: this is a public read, reachable by anyone, signed in
// or not. Everything below _renderShell is unchanged by the merge — the
// module still owns #tc-lb-body / #tc-lb-drill and its own event/page
// state (deliberately NOT routed through Leaderboard._cache).
//
// Every fetch here hits the public /api/v4 group (src/routes/topochain/
// public.js), which is optionally-authenticated but never 401s.
//
// Judgment call (documented up front, not buried): the per-row drill-down
// the task brief asks for is "activities + /users/:id/profile + epoch
// breakdown by wallet". GET /api/v4/leaderboard's row shape (SPEC 923-937,
// formatLeaderboardRow in public.js) deliberately never exposes a row's
// numeric users.id — only a MASKED identifier, an unmasked discord handle
// (maybe null), and the two wallet forms (public_key/bech32m, maybe null).
// That is by design (a public standings page should not leak which
// database row a rank belongs to) and this screen must not route around
// it. So the three calls are wired against what a row ACTUALLY carries:
//   - activities: participant_identifier = the row's bech32m address
//     (falls back to discord) — /leaderboard/user-activities resolves
//     that to a user server-side without ever handing the id back.
//   - epoch breakdown: wallet_address = the row's public_key wallet form.
//   - profile: /users/:id/profile needs a real numeric id, which no public
//     endpoint derives from an identifier. The one legitimate numeric id
//     available client-side is the CURRENTLY SIGNED-IN viewer's own
//     platform users.id (App.user.id — the platform users table IS the
//     topochain users table, migration plan Global Constraint #7), and
//     /api/auth/me also exposes that viewer's own linked wallet
//     (App.user.usernodePubkey). So the profile card only ever renders
//     for the row that matches the signed-in viewer's own wallet ("View
//     my full profile") — never for an arbitrary other row. This is the
//     correct privacy behavior for a public leaderboard, not a shortcut.
'use strict';

const TopochainLeaderboard = {
  _open: false,

  // Unsubscribe handle from TopochainEventContext.onChange.
  _unsub: null,
  _page: 1,
  _perPage: 25,

  // Last successful /leaderboard payload: { event, leaderboard } + meta.
  _data: null,
  _meta: null,
  _loading: false,
  _error: null,
  // Neutral "there is nothing here" copy, distinct from _error (which
  // paints red). Set when the server has no public events at all.
  _empty: null,

  // Challenge tally for the selected event (#981), for the one-line
  // cross-link above the table. Purely additive, exactly like the challenges
  // pane's own personalization pass: a failed/absent count renders NO line
  // and NEVER touches _error — a standings table must not paint a red banner
  // because a decoration alongside it couldn't load.
  _challengeCounts: { total: 0, completed: 0 },

  // Drill-down panel state. `_drillRow` is the clicked row (or null); the
  // three sections load independently so one failing/being unavailable
  // doesn't block the others.
  _drillRow: null,
  _drillActivities: { loading: false, error: null, data: null },
  _drillEpoch: { loading: false, error: null, data: null },
  _drillProfile: { loading: false, error: null, data: null },

  isOpen() { return TopochainLeaderboard._open; },

  // Escapes every character that is dangerous in EITHER text-node context
  // OR a double-quoted attribute-value context (this module interpolates
  // into both — e.g. row data inside data-* attributes). `&`/`<`/`>`
  // alone is not enough for an attribute value: an unescaped `"` lets an
  // interpolated string break out of the attribute and inject new ones.
  // Escaping `'` too covers single-quoted attributes.
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // Safe fetch+parse, ported from admin-console.js's fetchJson: never
  // throws, returns { status, ok, data } with data === null on anything
  // that isn't a clean JSON 2xx.
  async fetchJson(url) {
    try {
      const res = await fetch(url);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return { status: res.status, ok: res.ok, data: null };
      }
      try {
        return { status: res.status, ok: res.ok, data: await res.json() };
      } catch {
        return { status: res.status, ok: res.ok, data: null };
      }
    } catch {
      return { status: 0, ok: false, data: null };
    }
  },

  open() {
    TopochainLeaderboard._open = true;
    TopochainLeaderboard._renderShell();
    // The event bar owns the selection; reload whenever it changes.
    if (window.TopochainEventContext?.onChange) {
      TopochainLeaderboard._unsub = TopochainEventContext.onChange(() => {
        if (!TopochainLeaderboard._open) return;
        TopochainLeaderboard._page = 1;
        TopochainLeaderboard._drillRow = null;
        TopochainLeaderboard._challengeCounts = { total: 0, completed: 0 };
        TopochainLeaderboard.loadLeaderboard();
      });
    }
    TopochainLeaderboard.loadLeaderboard();
  },

  close() {
    TopochainLeaderboard._open = false;
    TopochainLeaderboard._drillRow = null;
    TopochainLeaderboard._challengeCounts = { total: 0, completed: 0 };
    if (TopochainLeaderboard._unsub) {
      TopochainLeaderboard._unsub();
      TopochainLeaderboard._unsub = null;
    }
  },

  _eventId() {
    return window.TopochainEventContext
      ? TopochainEventContext.eventId : null;
  },

  // True when the board on screen is the WHOLE-SEASON aggregate rather than
  // one event's stored snapshots. Read off the last payload's own
  // `event.type` (not the shared context) so it always describes the rows
  // actually rendered, even mid-switch.
  _isSeasonBoard() {
    return TopochainLeaderboard._data?.event?.type === 'season';
  },

  // ── Shell ────────────────────────────────────────────────────────────

  _renderShell() {
    const root = document.getElementById('topochain-leaderboard-root');
    if (!root) return;
    // No title and no event picker of our own: the Leaderboard screen shell
    // titles the page, the section tab above says "Topochain", and the
    // shared event bar (TopochainEventContext) owns the picker + hero.
    root.innerHTML = `
      <div id="tc-lb-body">
        <p class="text-sm text-zinc-500">Loading…</p>
      </div>
      <div id="tc-lb-drill" class="hidden mt-4"></div>`;
  },

  // ── Data loading ─────────────────────────────────────────────────────

  async loadLeaderboard() {
    TopochainLeaderboard._loading = true;
    TopochainLeaderboard._error = null;
    TopochainLeaderboard._empty = null;
    TopochainLeaderboard._renderBody();

    const params = new URLSearchParams();
    const eventId = TopochainLeaderboard._eventId();
    if (eventId != null) {
      params.set('season_event_id', String(eventId));
    }
    params.set('page', String(TopochainLeaderboard._page));
    params.set('per_page', String(TopochainLeaderboard._perPage));

    const { status, ok, data } = await TopochainLeaderboard.fetchJson(
      `/api/v4/leaderboard?${params.toString()}`
    );
    if (!TopochainLeaderboard._open) return;
    TopochainLeaderboard._loading = false;

    if (ok && data?.success) {
      TopochainLeaderboard._data = data.data;
      TopochainLeaderboard._meta = data.meta || null;
      // Learn the server-resolved event id (relevant the first time, when
      // no season_event_id was requested) so the shared picker highlights
      // it and pagination/drill-downs stay pinned to the same event. Fed
      // back silently — a server resolution is not a user choice, so it
      // must not clear the event bar's "nothing is running" caption nor
      // re-notify us (and the challenges pane) into a reload loop.
      if (data.data?.event?.id != null && window.TopochainEventContext?.select) {
        TopochainEventContext.select(data.data.event.id, { silent: true });
      }
    } else {
      TopochainLeaderboard._data = null;
      TopochainLeaderboard._meta = null;
      if (status === 404) {
        // Only reachable now when there are no public events at all (the
        // event bar's default pick covers "none is currently running").
        // That's an empty world, not a failure — render it neutrally.
        TopochainLeaderboard._error = null;
        TopochainLeaderboard._empty = 'No events have been published yet.';
      } else {
        TopochainLeaderboard._empty = null;
        TopochainLeaderboard._error = (data && data.error)
          || 'Failed to load the leaderboard.';
      }
    }
    TopochainLeaderboard._renderBody();
    // The tally lands in a second pass so the table never waits on it. Read
    // the event id back through _eventId() rather than reusing the local
    // above: on the FIRST load that local is null and the id we want is the
    // one the server just resolved and fed into the picker silently.
    TopochainLeaderboard._loadChallengeCounts(TopochainLeaderboard._eventId());
  },

  // The selected event's challenge tally, for the cross-link above the table
  // (#981). Same discipline as the challenges pane's `_loadMine`: additive,
  // one shot, and SILENT on failure — no _error, no banner, no retry. A
  // failure just means the line isn't there.
  async _loadChallengeCounts(eventId) {
    if (eventId == null) return;
    const { ok, data } = await TopochainLeaderboard.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}/challenges`
    );
    // Same staleness guard loadLeaderboard uses, so a fast event switch can
    // never paint one event's tally over another's standings.
    if (!TopochainLeaderboard._open
        || TopochainLeaderboard._eventId() !== eventId) return;
    if (!ok || !data?.success || !Array.isArray(data.data)) return;
    TopochainLeaderboard._challengeCounts = {
      total: data.data.length,
      completed: data.data.filter((c) => c && c.completed === true).length,
    };
    TopochainLeaderboard._renderBody();
  },

  // ── Rendering ────────────────────────────────────────────────────────

  _renderBody() {
    const host = document.getElementById('tc-lb-body');
    if (!host) return;
    const esc = TopochainLeaderboard.esc;

    if (TopochainLeaderboard._loading && !TopochainLeaderboard._data) {
      host.innerHTML = '<p class="text-sm text-zinc-500">Loading…</p>';
      return;
    }
    if (TopochainLeaderboard._error) {
      host.innerHTML = `
        <div class="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
          ${esc(TopochainLeaderboard._error)}
        </div>`;
      return;
    }
    if (TopochainLeaderboard._empty) {
      host.innerHTML = `
        <p class="text-sm text-zinc-500 py-8 text-center">
          ${esc(TopochainLeaderboard._empty)}
        </p>`;
      return;
    }
    const payload = TopochainLeaderboard._data;
    if (!payload) {
      host.innerHTML = '<p class="text-sm text-zinc-500">No data.</p>';
      return;
    }
    const { event, leaderboard } = payload;

    // The event name / status / dates / "nothing is running" caption all
    // render once, in the shared event bar above. The only header this pane
    // keeps is the disclaimer, which is standings-specific copy and only
    // exists on THIS endpoint's event object.
    const disclaimer = event.disclaimer
      ? `<p id="tc-lb-disclaimer" class="text-xs text-zinc-500 mb-3">${esc(event.disclaimer)}</p>`
      : '';

    // The challenge tally + cross-link (#981) — the mirror of the challenges
    // pane's "See where the season stands →". Omitted entirely when the event
    // has no challenges or the count hasn't (or couldn't) load, so an empty
    // or failed tally is invisible rather than a "0 of 0" line.
    const counts = TopochainLeaderboard._challengeCounts || { total: 0, completed: 0 };
    const challengeLine = counts.total > 0
      ? `<p id="tc-lb-challenge-link" class="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
          ${esc(counts.completed)} of ${esc(counts.total)} challenges completed
          <span class="text-zinc-400 dark:text-zinc-600">·</span>
          <button id="tc-lb-to-challenges"
            class="font-medium text-violet-600 dark:text-violet-400 hover:underline">View challenges &rarr;</button>
        </p>`
      : '';

    if (!event.display_leaderboard) {
      host.innerHTML = `${disclaimer}
        <p class="text-sm text-zinc-500 py-8 text-center">
          The leaderboard for this event isn't public yet.
        </p>`;
      return;
    }

    // The cross-link DOES belong here: an event can have challenges before
    // anyone has scored on it, and that is exactly when "go look at the
    // challenges" is the most useful thing this pane can say.
    if (!leaderboard.length) {
      host.innerHTML = `${challengeLine}${disclaimer}
        <p class="text-sm text-zinc-500 py-8 text-center">No leaderboard entries yet.</p>`;
      TopochainLeaderboard._wireChallengeLink();
      return;
    }

    // The season aggregate (`event.type === 'season'`) is resolved through
    // computeStandings, which has no per-EVENT breakdown to report: the
    // server's season path hard-codes event_success_rate (and every other
    // per-event field) to 0, so a "Success rate" column can only ever read
    // "0%" — indistinguishable from a real zero and read as broken data.
    // Drop the column rather than print a number that isn't measured.
    // `event_total_produced_blocks` is NOT in that bucket: the season path
    // maps it from the aggregate's real SUM, so it stays.
    const isSeason = event.type === 'season';
    const rows = leaderboard.map((r, i) => {
      const rankDisplay = r.is_non_podium ? '—' : String(r.rank);
      const nonPodiumTag = r.is_non_podium
        ? ' <span class="text-[10px] uppercase tracking-wide text-zinc-400" title="Excluded from podium ranking">non-podium</span>'
        : '';
      return `
        <tr class="tc-lb-row border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 cursor-pointer" data-row-index="${esc(i)}">
          <td class="px-3 py-2 text-sm font-mono text-zinc-500">${esc(rankDisplay)}</td>
          <td class="px-3 py-2 text-sm">
            <span class="font-medium text-zinc-900 dark:text-zinc-100">${esc(r.display_name)}</span>${nonPodiumTag}
          </td>
          <td class="px-3 py-2 text-sm font-mono text-right">${esc(r.total_points)}<span class="text-zinc-400"> +${esc(r.extra_points)}</span></td>
          <td class="px-3 py-2 text-sm font-mono text-right">${esc(r.event_total_produced_blocks)}</td>
          ${isSeason ? '' : `<td class="px-3 py-2 text-sm font-mono text-right">${esc(r.event_success_rate)}%</td>`}
        </tr>`;
    }).join('');

    const meta = TopochainLeaderboard._meta;
    const pagination = meta ? `
      <div class="flex items-center justify-between mt-3 text-sm">
        <span class="text-zinc-500">Page ${meta.page} of ${Math.max(meta.total_pages, 1)} · ${meta.total} total</span>
        <div class="flex gap-2">
          <button id="tc-lb-prev" class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium disabled:opacity-40" ${meta.page <= 1 ? 'disabled' : ''}>Prev</button>
          <button id="tc-lb-next" class="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium disabled:opacity-40" ${meta.page >= meta.total_pages ? 'disabled' : ''}>Next</button>
        </div>
      </div>` : '';

    host.innerHTML = `${challengeLine}${disclaimer}
      <div class="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table class="w-full">
          <thead class="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th class="px-3 py-2 text-left">Rank</th>
              <th class="px-3 py-2 text-left">User</th>
              <th class="px-3 py-2 text-right">${isSeason ? 'Season points' : 'Points'}</th>
              <th class="px-3 py-2 text-right">Blocks produced</th>
              ${isSeason ? '' : '<th class="px-3 py-2 text-right">Success rate</th>'}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${pagination}`;

    TopochainLeaderboard._wireChallengeLink();
    host.querySelectorAll('.tc-lb-row').forEach((tr) => {
      tr.addEventListener('click', () => {
        const idx = parseInt(tr.dataset.rowIndex, 10);
        TopochainLeaderboard._openDrill(leaderboard[idx]);
      });
    });
    document.getElementById('tc-lb-prev')?.addEventListener('click', () => {
      if (TopochainLeaderboard._page > 1) {
        TopochainLeaderboard._page -= 1;
        TopochainLeaderboard.loadLeaderboard();
      }
    });
    document.getElementById('tc-lb-next')?.addEventListener('click', () => {
      TopochainLeaderboard._page += 1;
      TopochainLeaderboard.loadLeaderboard();
    });
  },

  // Real hash navigation, so the section switch goes through the router and
  // the shared event selection survives it — same reasoning as the challenges
  // pane's `#tc-se-to-standings` link in the opposite direction.
  _wireChallengeLink() {
    document.getElementById('tc-lb-to-challenges')?.addEventListener('click', () => {
      window.location.hash = '#leaderboard/challenges';
    });
  },

  // ── Drill-down panel ─────────────────────────────────────────────────

  _openDrill(row) {
    TopochainLeaderboard._drillRow = row;
    TopochainLeaderboard._drillActivities = { loading: true, error: null, data: null };
    TopochainLeaderboard._drillEpoch = { loading: true, error: null, data: null };
    TopochainLeaderboard._drillProfile = { loading: false, error: null, data: null };
    TopochainLeaderboard._renderDrill();

    const eventId = TopochainLeaderboard._eventId();
    const identifier = row.bech32m || row.discord || null;

    if (identifier && eventId != null) {
      TopochainLeaderboard.fetchJson(
        `/api/v4/leaderboard/user-activities?season_event_id=${encodeURIComponent(eventId)}`
        + `&participant_identifier=${encodeURIComponent(identifier)}`
      ).then(({ ok, data }) => {
        if (TopochainLeaderboard._drillRow !== row) return; // navigated away
        if (ok && data?.success) {
          TopochainLeaderboard._drillActivities = { loading: false, error: null, data: data.data };
        } else {
          TopochainLeaderboard._drillActivities = {
            loading: false, error: (data && data.error) || 'Could not load activities.', data: null,
          };
        }
        TopochainLeaderboard._renderDrill();
      });
    } else {
      TopochainLeaderboard._drillActivities = {
        loading: false, error: 'No identifier available for this row.', data: null,
      };
    }

    if (row.wallet_address && eventId != null) {
      TopochainLeaderboard.fetchJson(
        `/api/v4/leaderboard/epoch-breakdown?wallet_address=${encodeURIComponent(row.wallet_address)}`
        + `&season_event_id=${encodeURIComponent(eventId)}`
      ).then(({ ok, data }) => {
        if (TopochainLeaderboard._drillRow !== row) return;
        if (ok && data?.success) {
          TopochainLeaderboard._drillEpoch = { loading: false, error: null, data: data.data };
        } else {
          TopochainLeaderboard._drillEpoch = {
            loading: false, error: (data && data.error) || 'Could not load the epoch breakdown.', data: null,
          };
        }
        TopochainLeaderboard._renderDrill();
      });
    } else {
      // On the SEASON aggregate every row's wallet forms are null by
      // construction — the server's season path (fetchEventLeaderboardRows)
      // has no single event to resolve an onchain account against, and the
      // epoch breakdown is defined per event anyway. Saying "no wallet
      // linked" there would be wrong about the user (they may well have
      // one) and would read as missing data rather than as a scope the
      // breakdown doesn't have.
      TopochainLeaderboard._drillEpoch = {
        loading: false,
        error: TopochainLeaderboard._isSeasonBoard()
          ? 'The epoch breakdown is per event — pick a single event above to see it.'
          : 'No wallet linked for this row.',
        data: null,
      };
    }

    // Full profile: only for the signed-in viewer's own row (see the
    // file-header comment — no public endpoint maps an arbitrary row back
    // to a numeric users.id).
    const viewer = window.App?.user;
    const isOwnRow = !!(viewer?.id && viewer.usernodePubkey
      && row.wallet_address && viewer.usernodePubkey === row.wallet_address);
    if (isOwnRow) {
      TopochainLeaderboard._drillProfile.loading = true;
      TopochainLeaderboard.fetchJson(
        `/api/v4/users/${encodeURIComponent(viewer.id)}/profile?season_event_id=${encodeURIComponent(eventId)}`
      ).then(({ ok, data }) => {
        if (TopochainLeaderboard._drillRow !== row) return;
        if (ok && data?.success) {
          TopochainLeaderboard._drillProfile = { loading: false, error: null, data: data.data };
        } else {
          TopochainLeaderboard._drillProfile = {
            loading: false, error: (data && data.error) || 'Could not load your profile.', data: null,
          };
        }
        TopochainLeaderboard._renderDrill();
      });
    }
    TopochainLeaderboard._renderDrill();
  },

  _closeDrill() {
    TopochainLeaderboard._drillRow = null;
    TopochainLeaderboard._renderDrill();
  },

  _renderDrill() {
    const host = document.getElementById('tc-lb-drill');
    if (!host) return;
    const row = TopochainLeaderboard._drillRow;
    if (!row) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    host.classList.remove('hidden');
    const esc = TopochainLeaderboard.esc;

    const act = TopochainLeaderboard._drillActivities;
    const activitiesHtml = act.loading
      ? '<p class="text-xs text-zinc-500">Loading activities…</p>'
      : act.error
        ? `<p class="text-xs text-zinc-500">${esc(act.error)}</p>`
        : (act.data && act.data.length
          ? `<ul class="space-y-1">${act.data.map((a) => `
              <li class="flex items-center justify-between gap-3 text-xs">
                <span class="text-zinc-600 dark:text-zinc-300">${esc(a.description || a.activity_type)}</span>
                <span class="font-mono text-zinc-400">+${esc(a.points)}</span>
              </li>`).join('')}</ul>`
          : '<p class="text-xs text-zinc-500">No activities recorded for this event.</p>');

    const epoch = TopochainLeaderboard._drillEpoch;
    const epochHtml = epoch.loading
      ? '<p class="text-xs text-zinc-500">Loading epoch breakdown…</p>'
      : epoch.error
        ? `<p class="text-xs text-zinc-500">${esc(epoch.error)}</p>`
        : (epoch.data && epoch.data.breakdown && epoch.data.breakdown.length
          ? `<div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead class="text-zinc-500"><tr>
                  <th class="text-left py-1">Epoch</th>
                  <th class="text-right py-1">Won slots</th>
                  <th class="text-right py-1">Produced</th>
                  <th class="text-right py-1">Success rate</th>
                </tr></thead>
                <tbody>${epoch.data.breakdown.map((e) => `
                  <tr class="border-t border-zinc-100 dark:border-zinc-800">
                    <td class="py-1 font-mono">${esc(e.epoch)}</td>
                    <td class="py-1 font-mono text-right">${esc(e.total_won_slots)}</td>
                    <td class="py-1 font-mono text-right">${esc(e.chain_total_produced_blocks)}</td>
                    <td class="py-1 font-mono text-right">${esc(e.success_rate)}%</td>
                  </tr>`).join('')}</tbody>
              </table>
            </div>`
          : '<p class="text-xs text-zinc-500">No epoch data for this event.</p>');

    const prof = TopochainLeaderboard._drillProfile;
    const profileHtml = prof.loading
      ? '<p class="text-xs text-zinc-500">Loading your profile…</p>'
      : prof.error
        ? `<p class="text-xs text-zinc-500">${esc(prof.error)}</p>`
        : (prof.data
          ? `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div><span class="text-zinc-500">Rank</span><div class="font-mono">${esc(prof.data.rank ?? '—')}</div></div>
              <div><span class="text-zinc-500">Total points</span><div class="font-mono">${esc(prof.data.total_points)}</div></div>
              <div><span class="text-zinc-500">Produced blocks</span><div class="font-mono">${esc(prof.data.produced_blocks)}</div></div>
              <div><span class="text-zinc-500">Client success rate</span><div class="font-mono">${prof.data.client_success_rate == null ? '—' : `${esc(prof.data.client_success_rate)}%`}</div></div>
              <div><span class="text-zinc-500">Canonical success rate</span><div class="font-mono">${prof.data.canonical_success_rate == null ? '—' : `${esc(prof.data.canonical_success_rate)}%`}</div></div>
            </div>`
          : '');

    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">${esc(row.display_name)}</h3>
          <button id="tc-lb-drill-close" class="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-lg leading-none" aria-label="Close">&times;</button>
        </div>
        ${row.wallet_address ? `<p class="text-xs font-mono text-zinc-400 mb-3 break-all">${esc(row.wallet_address)}</p>` : ''}
        ${prof.data || prof.loading || prof.error ? `<div class="mb-4"><div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Your profile</div>${profileHtml}</div>` : ''}
        <div class="grid sm:grid-cols-2 gap-4">
          <div>
            <div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Activities</div>
            ${activitiesHtml}
          </div>
          <div>
            <div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Epoch breakdown</div>
            ${epochHtml}
          </div>
        </div>
      </div>`;

    document.getElementById('tc-lb-drill-close')
      ?.addEventListener('click', () => TopochainLeaderboard._closeDrill());
  },
};

window.TopochainLeaderboard = TopochainLeaderboard;
