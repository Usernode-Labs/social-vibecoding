// Topochain public standings (Task 14, public screens). Was a screen of
// its own (#topochain-leaderboard-screen) until the header slim-down made
// it the SECOND TAB of the Leaderboard screen: it renders into
// #topochain-leaderboard-root inside #leaderboard-screen, and open() /
// close() are called by the Leaderboard module (./leaderboard.js)
// when its section flips, not by a navigate* pair in app.js. The legacy
// #topochain/leaderboard hash still lands here — the router aliases it to
// #leaderboard/topochain.
//
// The event picker and the event hero this module used to own moved UP into
// the screen-level bar owned by ./topochain-event-context.js when the
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

  // ./topochain-standings-store.js, planted by ./mount.ts (#1191 slice 6,
  // conversion 5). Planted rather than imported because this file is still
  // evaluated as a CLASSIC SCRIPT by tests/standings-screen.test.js, which
  // renders the real season and per-event boards through `new Function(src)`.
  // Null in that harness until it plants its own; every write below tolerates
  // that, which is also what makes the SSG prerender pass a no-op here.
  _store: null,

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

  // Was the module's escaper, for a time when every value here was
  // interpolated into an HTML string — into text nodes AND into `data-*`
  // attribute values, which is why it escaped quotes too. Conversion 5 made
  // ./topochain-standings.tsx the only writer of this pane, so React escapes
  // both contexts on write and nothing calls this any more.
  //
  // It stays as `str()` because the COERCION was load-bearing independently of
  // the escaping: the payload's numeric fields are rendered straight, and
  // `null`/`undefined` had to read as an empty string rather than as the word
  // "null" — which is exactly what React would print for a `String(null)`.
  str(s) {
    return String(s == null ? '' : s);
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

  // The pane's two hosts (#tc-lb-body, #tc-lb-drill) used to be written here
  // as an innerHTML string on every open. They are ./topochain-standings.tsx's
  // now; all this does is flip the pane on and seed the "Loading…" body the
  // string carried, which is what the very next line of open() replaces once
  // loadLeaderboard() starts. Same one-shot semantics, no DOM.
  _renderShell() {
    TopochainLeaderboard._store?.set({ mounted: true, body: { state: 'loading' }, drill: null });
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

  // Every branch below used to end in an `innerHTML` assignment plus a sweep
  // that re-attached the row / pagination / cross-link listeners it had just
  // destroyed. It builds a DESCRIPTOR now and pushes it into the store;
  // ./topochain-standings.tsx renders it and carries its own handlers, which
  // is why the three `addEventListener` sweeps and _wireChallengeLink are
  // gone. The BRANCHING is untouched — the states, their order and their copy
  // are exactly what the string version produced.
  _renderBody() {
    TopochainLeaderboard._store?.set({ body: TopochainLeaderboard.bodyView() });
  },

  bodyView() {
    const str = TopochainLeaderboard.str;

    if (TopochainLeaderboard._loading && !TopochainLeaderboard._data) {
      return { state: 'loading' };
    }
    if (TopochainLeaderboard._error) {
      return { state: 'error', message: str(TopochainLeaderboard._error) };
    }
    if (TopochainLeaderboard._empty) {
      return { state: 'empty', message: str(TopochainLeaderboard._empty) };
    }
    const payload = TopochainLeaderboard._data;
    if (!payload) return { state: 'none' };
    const { event, leaderboard } = payload;

    // The event name / status / dates / "nothing is running" caption all
    // render once, in the shared event bar above. The only header this pane
    // keeps is the disclaimer, which is standings-specific copy and only
    // exists on THIS endpoint's event object.
    const disclaimer = event.disclaimer ? str(event.disclaimer) : null;

    // The challenge tally + cross-link (#981) — the mirror of the challenges
    // pane's "See where the season stands →". Omitted entirely when the event
    // has no challenges or the count hasn't (or couldn't) load, so an empty
    // or failed tally is invisible rather than a "0 of 0" line.
    const counts = TopochainLeaderboard._challengeCounts || { total: 0, completed: 0 };
    const challengeLine = counts.total > 0
      ? { completed: str(counts.completed), total: str(counts.total) }
      : null;

    if (!event.display_leaderboard) {
      return { state: 'private', disclaimer };
    }

    // The cross-link DOES belong here: an event can have challenges before
    // anyone has scored on it, and that is exactly when "go look at the
    // challenges" is the most useful thing this pane can say.
    if (!leaderboard.length) {
      return { state: 'noentries', challengeLine, disclaimer };
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
    // ONE list drives both the header row and every body row — the renderer
    // maps over it twice. The string version spelled the two out separately
    // and dropped the success-rate cell with a second, matching conditional,
    // which is a skewed table one edit away; here a column cannot exist in the
    // head without existing in the body.
    const columns = isSeason
      ? ['rank', 'user', 'points', 'blocks']
      : ['rank', 'user', 'points', 'blocks', 'success'];
    const headers = {
      rank: 'Rank',
      user: 'User',
      points: isSeason ? 'Season points' : 'Points',
      blocks: 'Blocks produced',
      success: 'Success rate',
    };

    const rows = leaderboard.map((r, i) => ({
      index: i,
      rank: r.is_non_podium ? '—' : String(r.rank),
      nonPodium: !!r.is_non_podium,
      user: str(r.display_name),
      points: str(r.total_points),
      extra: str(r.extra_points),
      blocks: str(r.event_total_produced_blocks),
      success: str(r.event_success_rate),
    }));

    const meta = TopochainLeaderboard._meta;
    const pagination = meta ? {
      page: meta.page,
      totalPages: Math.max(meta.total_pages, 1),
      total: meta.total,
      prevDisabled: meta.page <= 1,
      nextDisabled: meta.page >= meta.total_pages,
    } : null;

    return {
      state: 'table',
      challengeLine,
      disclaimer,
      isSeason,
      columns,
      headers,
      rows,
      pagination,
    };
  },

  // The three things a rendered body can DO. They were closures over the
  // innerHTML'd nodes; the renderer calls them by name now, so the behaviour
  // stays in this module and only the wiring moved.
  _openRowAt(index) {
    const rows = TopochainLeaderboard._data?.leaderboard;
    if (!Array.isArray(rows) || !rows[index]) return;
    TopochainLeaderboard._openDrill(rows[index]);
  },

  _prevPage() {
    if (TopochainLeaderboard._page > 1) {
      TopochainLeaderboard._page -= 1;
      TopochainLeaderboard.loadLeaderboard();
    }
  },

  _nextPage() {
    TopochainLeaderboard._page += 1;
    TopochainLeaderboard.loadLeaderboard();
  },

  // Real hash navigation, so the section switch goes through the router and
  // the shared event selection survives it — same reasoning as the challenges
  // pane's `#tc-se-to-standings` link in the opposite direction.
  _goToChallenges() {
    window.location.hash = '#leaderboard/challenges';
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

  // Same shape as _renderBody: a descriptor, not markup. `null` is the closed
  // panel — the renderer emits #tc-lb-drill with its `hidden` class, which is
  // what the `classList.add('hidden')` + `innerHTML = ''` pair did.
  _renderDrill() {
    TopochainLeaderboard._store?.set({ drill: TopochainLeaderboard.drillView() });
  },

  drillView() {
    const str = TopochainLeaderboard.str;
    const row = TopochainLeaderboard._drillRow;
    if (!row) return null;

    // The three sections load independently, so each keeps its own
    // loading/error/data triple all the way to the renderer rather than being
    // collapsed here — one failing must not blank the other two.
    const act = TopochainLeaderboard._drillActivities;
    const activities = {
      loading: !!act.loading,
      error: act.error ? str(act.error) : null,
      items: (!act.loading && !act.error && Array.isArray(act.data))
        ? act.data.map((a) => ({
          label: str(a.description || a.activity_type),
          points: str(a.points),
        }))
        : null,
    };

    const epoch = TopochainLeaderboard._drillEpoch;
    const breakdown = epoch.data && epoch.data.breakdown;
    const epochView = {
      loading: !!epoch.loading,
      error: epoch.error ? str(epoch.error) : null,
      rows: (!epoch.loading && !epoch.error && Array.isArray(breakdown))
        ? breakdown.map((e) => ({
          epoch: str(e.epoch),
          wonSlots: str(e.total_won_slots),
          produced: str(e.chain_total_produced_blocks),
          successRate: str(e.success_rate),
        }))
        : null,
    };

    const prof = TopochainLeaderboard._drillProfile;
    // `shown` is the string version's `prof.data || prof.loading || prof.error`
    // gate on the whole "Your profile" block: it only exists for the viewer's
    // OWN row (see the file header), and on every other row all three are
    // falsy, so the block is absent rather than empty.
    const profile = {
      shown: !!(prof.data || prof.loading || prof.error),
      loading: !!prof.loading,
      error: prof.error ? str(prof.error) : null,
      stats: prof.data ? {
        rank: str(prof.data.rank ?? '—'),
        totalPoints: str(prof.data.total_points),
        producedBlocks: str(prof.data.produced_blocks),
        clientSuccessRate: prof.data.client_success_rate == null
          ? null : str(prof.data.client_success_rate),
        canonicalSuccessRate: prof.data.canonical_success_rate == null
          ? null : str(prof.data.canonical_success_rate),
      } : null,
    };

    return {
      displayName: str(row.display_name),
      walletAddress: row.wallet_address ? str(row.wallet_address) : null,
      profile,
      activities,
      epoch: epochView,
    };
  },
};

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F, but ./leaderboard.js's lazy mount and
// app.js's pull-to-refresh
// all still reach it by name. The guard is for the SSG prerender pass —
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph
// in Node, where there is no window.
if (typeof window !== 'undefined') window.TopochainLeaderboard = TopochainLeaderboard;
