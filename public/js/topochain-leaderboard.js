// Topochain public leaderboard screen (Task 14, public screens). Full-page
// SPA screen hosted at hash route #topochain/leaderboard, hosted in
// #topochain-leaderboard-screen / #topochain-leaderboard-root
// (public/index.html) and mounted/unmounted by
// App.navigateToTopochainLeaderboard / App._exitTopochainLeaderboard
// (public/js/app.js) — the same shape as the admin console
// (public/js/admin-console.js), minus the isAdmin gate: this is a public
// read, reachable by anyone, signed in or not.
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

  // Full events list (GET /season-events?include_past=1), for the picker.
  _events: [],
  // Selected season_event_id. null until loadEvents() resolves a default
  // (or, failing that, the first /leaderboard fetch resolves "current"
  // and we learn which event that was).
  _eventId: null,
  // True when the default we picked is an event that has already ENDED —
  // i.e. nothing is running right now. Drives the explanatory caption and
  // the picker's placeholder label. Cleared as soon as the user chooses an
  // event themselves: from then on the selection is theirs, not a fallback.
  _endedFallback: false,
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
    TopochainLeaderboard.loadEvents();
  },

  close() {
    TopochainLeaderboard._open = false;
    TopochainLeaderboard._drillRow = null;
  },

  // ── Shell ────────────────────────────────────────────────────────────

  _renderShell() {
    const root = document.getElementById('topochain-leaderboard-root');
    if (!root) return;
    root.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 class="text-xl font-bold text-zinc-900 dark:text-zinc-100">Topochain leaderboard</h1>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-zinc-500 dark:text-zinc-400">Event</span>
          <select id="tc-lb-event-select"
            class="rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1.5 text-sm max-w-[16rem]">
            <option value="">Loading…</option>
          </select>
        </label>
      </div>
      <div id="tc-lb-body">
        <p class="text-sm text-zinc-500">Loading…</p>
      </div>
      <div id="tc-lb-drill" class="hidden mt-4"></div>`;

    document.getElementById('tc-lb-event-select').addEventListener('change', (e) => {
      const id = parseInt(e.target.value, 10);
      TopochainLeaderboard._eventId = Number.isInteger(id) ? id : null;
      // An explicit choice is not a fallback — drop the caption.
      TopochainLeaderboard._endedFallback = false;
      TopochainLeaderboard._page = 1;
      TopochainLeaderboard._drillRow = null;
      TopochainLeaderboard.loadLeaderboard();
    });
  },

  // ── Data loading ─────────────────────────────────────────────────────

  async loadEvents() {
    const { ok, data } = await TopochainLeaderboard.fetchJson(
      '/api/v4/season-events?include_past=1'
    );
    if (!TopochainLeaderboard._open) return;
    if (ok && data?.success && Array.isArray(data.data)) {
      TopochainLeaderboard._events = data.data;
      // Between events nothing satisfies the server's "current" rule and
      // GET /leaderboard 404s, which used to paint a red error banner on
      // the default landing state. Resolve a default here instead: the
      // running event when there is one, else the most recent ended one
      // (TopochainEvents.pickDefault). Only when the list itself is empty
      // do we fall through to the server default and its 404.
      if (TopochainLeaderboard._eventId == null &&
          window.TopochainEvents) {
        const pick = TopochainEvents.pickDefault(data.data,
          { requireLeaderboard: true });
        if (pick) {
          TopochainLeaderboard._eventId = pick.id;
          TopochainLeaderboard._endedFallback = TopochainEvents.hasEnded(pick);
        }
      }
      TopochainLeaderboard._renderEventOptions();
    }
    // The picker is a nice-to-have; the leaderboard fetch below still
    // works (against the server's own "current event" default) even if
    // this list failed to load.
    TopochainLeaderboard.loadLeaderboard();
  },

  _renderEventOptions() {
    const sel = document.getElementById('tc-lb-event-select');
    if (!sel) return;
    const esc = TopochainLeaderboard.esc;
    const current = TopochainLeaderboard._eventId;
    // Placeholder label tracks reality: "Current event" is a lie between
    // events, where the screen deliberately opens on the last one.
    const placeholder = TopochainLeaderboard._endedFallback
      ? 'Most recent event' : 'Current event';
    const options = [`<option value="">${esc(placeholder)}</option>`]
      .concat(TopochainLeaderboard._events.map((ev) => {
        const selected = current === ev.id ? ' selected' : '';
        const tag = ev.is_current ? ' (current)' : (ev.is_active ? '' : ' (past)');
        return `<option value="${esc(ev.id)}"${selected}>${esc(ev.name)}${esc(tag)}</option>`;
      }));
    sel.innerHTML = options.join('');
    // Reflect a server-resolved "current" event id back into the select
    // once we know it, so the picker doesn't just sit on the placeholder.
    if (current != null) sel.value = String(current);
  },

  async loadLeaderboard() {
    TopochainLeaderboard._loading = true;
    TopochainLeaderboard._error = null;
    TopochainLeaderboard._empty = null;
    TopochainLeaderboard._renderBody();

    const params = new URLSearchParams();
    if (TopochainLeaderboard._eventId != null) {
      params.set('season_event_id', String(TopochainLeaderboard._eventId));
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
      // no season_event_id was requested) so the picker highlights it and
      // pagination/drill-downs stay pinned to the same event.
      if (data.data?.event?.id != null) {
        TopochainLeaderboard._eventId = data.data.event.id;
        TopochainLeaderboard._renderEventOptions();
      }
    } else {
      TopochainLeaderboard._data = null;
      TopochainLeaderboard._meta = null;
      if (status === 404) {
        // Only reachable now when there are no public events at all (the
        // fallback in loadEvents() covers "none is currently running").
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

    const statusBadge = {
      active: 'bg-green-500/20 text-green-600 dark:text-green-300',
      upcoming: 'bg-amber-500/20 text-amber-600 dark:text-amber-300',
      ended: 'bg-zinc-500/20 text-zinc-500 dark:text-zinc-400',
    }[event.status] || 'bg-zinc-500/20 text-zinc-500';

    // Between events we deliberately open on the last one — say so, so the
    // standings don't read as live. Only when the fallback actually fired.
    const fallbackNote = (TopochainLeaderboard._endedFallback && event.has_ended)
      ? `<p id="tc-lb-fallback-note" class="text-xs text-zinc-500 mt-2">
           Nothing is running right now — showing the most recent event.
         </p>`
      : '';

    const hero = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 mb-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100">${esc(event.name)}</h2>
          <span class="text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge}">${esc(event.status)}</span>
        </div>
        ${event.disclaimer ? `<p class="text-xs text-zinc-500 mt-1">${esc(event.disclaimer)}</p>` : ''}
        ${fallbackNote}
      </div>`;

    if (!event.display_leaderboard) {
      host.innerHTML = `${hero}
        <p class="text-sm text-zinc-500 py-8 text-center">
          The leaderboard for this event isn't public yet.
        </p>`;
      return;
    }

    if (!leaderboard.length) {
      host.innerHTML = `${hero}
        <p class="text-sm text-zinc-500 py-8 text-center">No leaderboard entries yet.</p>`;
      return;
    }

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
          <td class="px-3 py-2 text-sm font-mono text-right">${esc(r.event_success_rate)}%</td>
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

    host.innerHTML = `${hero}
      <div class="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table class="w-full">
          <thead class="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th class="px-3 py-2 text-left">Rank</th>
              <th class="px-3 py-2 text-left">User</th>
              <th class="px-3 py-2 text-right">Points</th>
              <th class="px-3 py-2 text-right">Blocks produced</th>
              <th class="px-3 py-2 text-right">Success rate</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${pagination}`;

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

  // ── Drill-down panel ─────────────────────────────────────────────────

  _openDrill(row) {
    TopochainLeaderboard._drillRow = row;
    TopochainLeaderboard._drillActivities = { loading: true, error: null, data: null };
    TopochainLeaderboard._drillEpoch = { loading: true, error: null, data: null };
    TopochainLeaderboard._drillProfile = { loading: false, error: null, data: null };
    TopochainLeaderboard._renderDrill();

    const eventId = TopochainLeaderboard._eventId;
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
      TopochainLeaderboard._drillEpoch = {
        loading: false, error: 'No wallet linked for this row.', data: null,
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
