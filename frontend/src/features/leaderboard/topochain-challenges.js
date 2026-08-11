// Challenges pane of the Leaderboard screen — the season's challenge grid.
//
// This file was public/js/topochain-seasons.js (Task 14, the public
// seasons/events screen at #topochain/seasons). The leaderboard merge folded
// it, and the separate #challenges screen (the deleted public/js/challenges.js),
// into the Leaderboard screen's third tab:
//   - the event picker + hero it used to render itself moved UP into the
//     shared bar owned by ./topochain-event-context.js, so this pane
//     and the standings pane always describe the same event;
//   - the old #challenges screen's one unique contribution — YOUR OWN points
//     on each challenge — became a decoration on these (richer) cards, see
//     "personalization" below;
//   - its season-scope leaderboard block is gone: it was a thinner copy of the
//     standings tab, which the "See where the season stands" link now points at.
//
// Hosted in #challenges-root inside #leaderboard-screen (public/index.html);
// mounted/unmounted by the Leaderboard module (./leaderboard.js) when
// its section flips, not by a navigate* pair in app.js. The legacy
// #topochain/seasons and #challenges hashes both still land here — the router
// aliases them to #leaderboard/challenges.
//
// Mirrors the source `seasons-events/index` page's three overlays (SPEC
// §5.2/§5.5.1: challenge grid, challenge detail overlay, user profile
// overlay), served by /api/v4 endpoints:
//   - challenge grid: GET /season-events/:id/challenges (card_preview fields).
//   - challenge detail overlay: the SAME challenge's detail_modal fields
//     (already in hand from the grid fetch) + GET .../challenges/:cid/
//     breakdown for the participant list.
//   - user profile overlay: GET /users/:id/profile. Unlike the standings pane
//     (see that file's header comment for why it CAN'T do this for an
//     arbitrary row), the breakdown entries here carry a real `user_id`
//     (src/routes/topochain/public.js's challenge-breakdown route), so this
//     overlay opens for any participant a challenge's breakdown lists.
//
// PERSONALIZATION: on top of the public grid, a second fetch to
// GET /challenges-api/challenges?season_event_id=<id> (session-cookie authed,
// src/routes/topochain/mobile.js) supplies the viewer's own per-challenge
// points plus `featured`, keyed by the same challenges.id the public endpoint
// returns. It is strictly DECORATIVE: a 401/422/network failure leaves the
// public grid exactly as it rendered, with no error banner.
//
// COMPLETION (#981): `completed` is a column on the challenges row — an
// organiser flag about the CHALLENGE ("this one is over"), not a per-user
// completion. The per-user signal is activities_total. This pane is now the
// HOME for that flag: the profile screen used to list the season's finished
// challenges and no longer does (see the header of
// frontend/src/features/profile/profile.js), so the grid groups them, counts
// them in a summary line and dims them.
//
// That is why `completed` is read from the PUBLIC row rather than from the
// personalization map it used to come from: the chip, the grouping and the
// count are all correct on FIRST PAINT and for an ANONYMOUS visitor, neither
// of which held while the flag arrived only with the session-authed pass.
// (`featured` still comes from that pass, so the featured lift can still
// re-sort once it lands — pre-existing behaviour, deliberately unchanged.)
'use strict';

const TopochainChallenges = {
  _open: false,

  _challenges: [],
  _challengesLoading: false,
  _challengesError: null,
  // challenge id -> the viewer's own row from /challenges-api/challenges.
  // Empty map = no personalization available (signed out, request failed);
  // the grid renders identically, just without the "you" decorations.
  _mine: new Map(),
  // Unsubscribe handle from TopochainEventContext.onChange.
  _unsub: null,
  // The event id `_challenges` was last loaded for. `undefined` until the
  // first load, which is deliberately distinct from the `null` a pane with
  // no resolvable event settles on.
  _loadedEventId: undefined,
  // True once the ?shot=challenge-detail deep link has fired, so a later
  // re-render (event switch, personalization landing) doesn't reopen it.
  _shotFired: false,
  // Pending #leaderboard/challenges/<eventId>/<challengeId> request (#982),
  // as { eventId, challengeId }, or null. Held rather than acted on
  // immediately because the router registers it before the pane has
  // mounted, let alone fetched the event's challenge list.
  _pendingDeepLink: null,

  // Challenge detail overlay state. `_detailChallenge` is the clicked
  // challenge-grid item (already carries card_preview/detail_modal); the
  // breakdown paginates via limit/offset/has_more (its own documented
  // shape, not the shared page/per_page meta envelope — SPEC judgment
  // call #5 in public.js).
  _detailChallenge: null,
  _breakdown: null,
  _breakdownLoading: false,
  _breakdownError: null,

  // User profile overlay state.
  _profileUserId: null,
  _profile: null,
  _profileLoading: false,
  _profileError: null,

  isOpen() { return TopochainChallenges._open; },

  // Escapes every character that is dangerous in EITHER text-node context
  // OR a double-quoted attribute-value context (this module interpolates
  // into both). `&`/`<`/`>` alone is not enough for an attribute value —
  // an unescaped `"` lets an admin-supplied string (challenge/template
  // copy, a cta_link, ...) break out of `href="..."` and inject new
  // attributes (e.g. `onclick=`). Escaping `'` too covers single-quoted
  // attributes, in case this template literal style is ever copied into
  // one.
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // href-safe URL: only http(s) links are ever rendered as a real anchor.
  // `esc()` alone stops attribute breakout but does NOT stop a
  // `javascript:`-scheme href, which executes on click with no markup
  // injection needed at all. Every cta/mobile_cta link in this file must
  // go through this before it can reach an `href`; anything that isn't
  // http(s) renders as plain (escaped) text instead of a clickable link.
  safeHref(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  },

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
    TopochainChallenges._open = true;
    TopochainChallenges._renderShell();
    // The event bar owns the selection; re-render whenever it CHANGES.
    // Not on every notification: the bar also notifies once at the end of
    // its own initial loadEvents(), and that one carries the same event
    // this pane already loaded. Treating it as a change tore down whatever
    // was on top of the grid a beat after it opened — which is how the
    // #982 deep link ended up rendering the right detail panel and then
    // closing it unprompted, and would do the same to an overlay the user
    // opened by hand.
    if (window.TopochainEventContext?.onChange) {
      TopochainChallenges._unsub = TopochainEventContext.onChange(() => {
        if (!TopochainChallenges._open) return;
        if (TopochainChallenges._eventId() === TopochainChallenges._loadedEventId) return;
        TopochainChallenges.closeChallengeDetail();
        TopochainChallenges.closeUserProfile();
        TopochainChallenges.loadChallenges();
      });
    }
    TopochainChallenges.loadChallenges();
  },

  close() {
    TopochainChallenges._open = false;
    TopochainChallenges._detailChallenge = null;
    TopochainChallenges._profileUserId = null;
    // An unresolved deep link dies with the screen. Keeping it would make a
    // much later, unrelated visit to this pane pop an overlay the user
    // never asked for.
    TopochainChallenges._pendingDeepLink = null;
    if (TopochainChallenges._unsub) {
      TopochainChallenges._unsub();
      TopochainChallenges._unsub = null;
    }
  },

  _eventId() {
    return window.TopochainEventContext
      ? TopochainEventContext.eventId : null;
  },

  // ── Shell ────────────────────────────────────────────────────────────

  // No title and no event picker of its own: the Leaderboard screen shell
  // titles the page, the tab strip above says "Challenges", and the shared
  // event bar (TopochainEventContext) owns the picker + hero.
  _renderShell() {
    const root = document.getElementById('challenges-root');
    if (!root) return;
    root.innerHTML = `
      <div id="tc-se-grid"></div>
      <!-- Challenge detail overlay -->
      <div id="tc-se-detail-overlay" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div id="tc-se-detail-panel" class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-xl border border-zinc-200 dark:border-zinc-800"></div>
      </div>
      <!-- User profile overlay -->
      <div id="tc-se-profile-overlay" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div id="tc-se-profile-panel" class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md max-h-[85vh] overflow-y-auto shadow-xl border border-zinc-200 dark:border-zinc-800"></div>
      </div>`;

    document.getElementById('tc-se-detail-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'tc-se-detail-overlay') TopochainChallenges.closeChallengeDetail();
    });
    document.getElementById('tc-se-profile-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'tc-se-profile-overlay') TopochainChallenges.closeUserProfile();
    });
  },

  // ── Data loading ─────────────────────────────────────────────────────

  async loadChallenges() {
    const eventId = TopochainChallenges._eventId();
    // The event `_challenges` reflects (or is being fetched for). The
    // onChange subscriber above compares against it to tell a real event
    // switch apart from a redundant re-notification.
    TopochainChallenges._loadedEventId = eventId;
    if (eventId == null) {
      TopochainChallenges._challenges = [];
      TopochainChallenges._challengesLoading = false;
      TopochainChallenges._challengesError = null;
      TopochainChallenges._mine = new Map();
      TopochainChallenges._renderGrid();
      return;
    }

    TopochainChallenges._challengesLoading = true;
    TopochainChallenges._challengesError = null;
    TopochainChallenges._mine = new Map();
    TopochainChallenges._renderGrid();

    const res = await TopochainChallenges.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}/challenges`
    );
    if (!TopochainChallenges._open
        || TopochainChallenges._eventId() !== eventId) return;

    TopochainChallenges._challengesLoading = false;
    if (res.ok && res.data?.success && Array.isArray(res.data.data)) {
      TopochainChallenges._challenges = res.data.data;
    } else {
      TopochainChallenges._challenges = [];
      TopochainChallenges._challengesError = (res.data && res.data.error)
        || 'Failed to load challenges.';
    }
    TopochainChallenges._renderGrid();
    // Decorations land in a second pass so the grid never waits on them.
    TopochainChallenges._loadMine(eventId);
  },

  // Your own points per challenge, from the session-authed web read. Purely
  // additive: any failure (401 signed out, 422, network) leaves the grid as
  // rendered above — no error banner, no retry.
  async _loadMine(eventId) {
    if (!TopochainChallenges._challenges.length) return;
    const { ok, data } = await TopochainChallenges.fetchJson(
      `/challenges-api/challenges?season_event_id=${encodeURIComponent(eventId)}`
    );
    if (!TopochainChallenges._open
        || TopochainChallenges._eventId() !== eventId) return;
    // The /challenges-api envelope is { success, data } like /api/v4.
    const rows = (ok && data && Array.isArray(data.data)) ? data.data : null;
    if (!rows) return;
    const mine = new Map();
    for (const r of rows) {
      if (r && r.id != null) mine.set(Number(r.id), r);
    }
    TopochainChallenges._mine = mine;
    TopochainChallenges._renderGrid();
  },

  // ── Challenge grid ───────────────────────────────────────────────────

  // Is this challenge organiser-FINISHED? The public row is the source of
  // truth (see the file header's COMPLETION note); the personalization row
  // is only a fallback, so a stale/older public payload still gets the chip
  // for a signed-in viewer rather than silently losing it.
  _isDone(c) {
    if (c && c.completed === true) return true;
    const m = TopochainChallenges._mine.get(Number(c && c.id)) || null;
    return !!(m && m.completed === true);
  },

  // Unfinished challenges first, then organiser-featured, then display_order
  // — the retired #challenges screen's ordering with the completed split
  // added in front of it (#981). The not-completed key comes from the PUBLIC
  // row, so the split is final on first paint; `featured` still arrives with
  // the personalization pass, so that lift alone can still re-sort later.
  _ordered() {
    const mine = TopochainChallenges._mine;
    return TopochainChallenges._challenges
      .map((c, i) => ({ c, i, m: mine.get(Number(c.id)) || null }))
      .sort((a, b) => {
        const ad = TopochainChallenges._isDone(a.c) ? 1 : 0;
        const bd = TopochainChallenges._isDone(b.c) ? 1 : 0;
        if (ad !== bd) return ad - bd;
        const af = a.m && a.m.featured === true ? 1 : 0;
        const bf = b.m && b.m.featured === true ? 1 : 0;
        if (af !== bf) return bf - af;
        return a.i - b.i;
      })
      .map((x) => x.c);
  },

  _renderGrid() {
    const host = document.getElementById('tc-se-grid');
    if (!host) return;
    const esc = TopochainChallenges.esc;

    if (TopochainChallenges._challengesLoading && !TopochainChallenges._challenges.length) {
      host.innerHTML = '<p class="text-sm text-zinc-500">Loading challenges…</p>';
      return;
    }
    // Both terminal empty states retire a pending deep link (#982) on the
    // way out, via the same guards the populated path uses — an empty
    // `ordered` simply matches nothing. Neither state can ever resolve one,
    // and leaving it armed would fire it against whatever event the viewer
    // picks next.
    if (TopochainChallenges._challengesError) {
      TopochainChallenges._maybeDeepLink([]);
      host.innerHTML = `
        <div class="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
          ${esc(TopochainChallenges._challengesError)}
        </div>`;
      return;
    }
    if (!TopochainChallenges._challenges.length) {
      TopochainChallenges._maybeDeepLink([]);
      host.innerHTML = '<p class="text-sm text-zinc-500 py-8 text-center">No challenges for this event yet.</p>';
      return;
    }

    const ordered = TopochainChallenges._ordered();
    // `ordered` stays ONE flat array whatever the grouping below does: both
    // the cards' `data-idx` and _maybeShot index into it, so splitting it in
    // two would desynchronise every click from the card it was made for.
    const firstDone = ordered.findIndex((c) => TopochainChallenges._isDone(c));
    const doneCount = firstDone === -1 ? 0 : ordered.length - firstDone;

    const cards = ordered.map((c, i) => {
      const cp = c.card_preview || {};
      const m = TopochainChallenges._mine.get(Number(c.id)) || null;
      const featured = !!(m && m.featured === true);
      const done = TopochainChallenges._isDone(c);
      const mineTotal = m && Number(m.activities_total) > 0
        ? Number(m.activities_total) : 0;
      const doneChip = done
        ? `<span class="shrink-0 inline-block px-2 py-0.5 rounded-full text-[0.65rem] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Completed</span>`
        : '';
      // A finished challenge is DIMMED, not hidden: its detail overlay and
      // participant breakdown are the interesting part of it, so the card
      // stays fully clickable — the opacity only takes it out of the way of
      // whatever is still open.
      return `
        <div class="tc-se-card bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 cursor-pointer hover:border-violet-400 dark:hover:border-violet-600 transition-colors${featured ? ' ring-1 ring-violet-500/40' : ''}${done ? ' opacity-60' : ''}" data-idx="${esc(i)}">
          <div class="flex items-start justify-between gap-2 mb-1">
            <div class="text-[10px] uppercase tracking-wide text-violet-600 dark:text-violet-400 font-semibold">${esc(cp.label || '')}</div>
            ${doneChip}
          </div>
          <div class="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1">${esc(cp.goal || '')}</div>
          <p class="text-xs text-zinc-500 line-clamp-2">${esc(cp.task || '')}</p>
          ${cp.reward ? `<p class="text-xs text-violet-500 mt-2 font-medium">${esc(cp.reward)}</p>` : ''}
          ${mineTotal ? `<p class="text-xs text-emerald-600 dark:text-emerald-400 mt-2 font-medium">You&rsquo;ve contributed ${esc(mineTotal)} pts</p>` : ''}
        </div>`;
    });

    const GRID_CLASS = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';
    // The "Completed" subheading only earns its row when there is something
    // on BOTH sides of it. Every public event in production is currently
    // 100% completed, and a heading over the entire grid says nothing.
    const gridsHtml = (firstDone > 0 && doneCount > 0)
      ? `<div class="${GRID_CLASS}">${cards.slice(0, firstDone).join('')}</div>
        <div class="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2">Completed</div>
        <div class="${GRID_CLASS}">${cards.slice(firstDone).join('')}</div>`
      : `<div class="${GRID_CLASS}">${cards.join('')}</div>`;

    // Always rendered when the grid has rows (including "0 of 8" and
    // "8 of 8"), so the declared dapp.json check can anchor on it whatever
    // the selected event's data happens to be.
    host.innerHTML = `
      <p id="tc-se-challenge-summary" class="text-sm text-zinc-500 dark:text-zinc-400 mb-3">${esc(doneCount)} of ${esc(ordered.length)} challenges completed</p>
      ${gridsHtml}
      <div class="mt-4 text-center">
        <button id="tc-se-to-standings"
          class="text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline">See where the season stands &rarr;</button>
      </div>`;

    host.querySelectorAll('.tc-se-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx, 10);
        TopochainChallenges.openChallengeDetail(ordered[idx]);
      });
    });
    // Real hash navigation so the section switch goes through the router
    // (and the shared event selection is untouched).
    document.getElementById('tc-se-to-standings')?.addEventListener('click', () => {
      window.location.hash = '#leaderboard/topochain';
    });

    TopochainChallenges._maybeShot(ordered);
    TopochainChallenges._maybeDeepLink(ordered);
  },

  // Screenshot-state deep link (`?shot=challenge-detail`): the detail overlay
  // is interaction-gated, so before/after captures and the declared dapp.json
  // check can't reach it by URL alone. Opens the first card once, right after
  // the grid first paints — since #981 that is the first UNFINISHED card when
  // the event has one, which is the better capture either way. Scoped to that
  // one param value so a real user's
  // grid never auto-opens an overlay. Pure UI state — no writes, no env gate.
  _maybeShot(ordered) {
    if (TopochainChallenges._shotFired) return;
    if (!ordered.length) return;
    let shot = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch (err) { /* ignore */ }
    if (shot !== 'challenge-detail') return;
    TopochainChallenges._shotFired = true;
    TopochainChallenges.openChallengeDetail(ordered[0]);
  },

  // ── Challenge deep link (#982) ───────────────────────────────────────

  // Entry point for #leaderboard/challenges/<eventId>[/<challengeId>], the
  // address the profile's completed-challenge rows link to. Called by
  // App._routeLeaderboard BEFORE the pane mounts, so it can only record the
  // intent and point the shared event bar at the right event; the detail
  // overlay opens later, from the render that first paints that event's
  // grid. A bare eventId (no challenge) is a valid, useful address too —
  // it just selects the event.
  openFromHash(eventId, challengeId) {
    const ev = Number.isInteger(eventId) ? eventId : null;
    const ch = Number.isInteger(challengeId) ? challengeId : null;
    if (ev == null && ch == null) return;
    if (ch != null) TopochainChallenges._pendingDeepLink = { eventId: ev, challengeId: ch };
    // select() is a no-op when the event is already the selected one, so
    // this neither reloads nor re-renders in the common "already looking at
    // this event" case — which is exactly why the grid below may already be
    // painted and needs resolving here rather than waiting for a render
    // that will never come.
    if (ev != null && window.TopochainEventContext?.select) {
      TopochainEventContext.select(ev);
    }
    if (TopochainChallenges._open) {
      TopochainChallenges._maybeDeepLink(TopochainChallenges._ordered());
    }
  },

  // Resolve a pending deep link against a freshly painted grid. Consumed
  // ONCE, whether or not the challenge is there: an id that doesn't exist
  // (deleted challenge, hand-edited hash, wrong event) leaves the viewer on
  // the grid with no overlay and no error, which is the honest answer —
  // the challenges they CAN open are all on screen.
  _maybeDeepLink(ordered) {
    const want = TopochainChallenges._pendingDeepLink;
    if (!want) return;
    // Mid-reload the grid still holds the PREVIOUS event's rows (see
    // loadChallenges), and matching against those could open the wrong
    // event's challenge — or, worse, silently burn the link on a list the
    // target was never in. Wait for the render that belongs to it.
    if (TopochainChallenges._challengesLoading) return;
    if (want.eventId != null
        && TopochainChallenges._eventId() !== want.eventId) return;
    TopochainChallenges._pendingDeepLink = null;
    const match = ordered.find((c) => c && Number(c.id) === want.challengeId);
    if (match) TopochainChallenges.openChallengeDetail(match);
  },

  // ── Challenge detail overlay ─────────────────────────────────────────

  openChallengeDetail(challenge) {
    if (!challenge) return;
    TopochainChallenges._detailChallenge = challenge;
    TopochainChallenges._breakdown = null;
    TopochainChallenges._breakdownError = null;
    TopochainChallenges._breakdownLoading = true;
    document.getElementById('tc-se-detail-overlay')?.classList.remove('hidden');
    TopochainChallenges._renderDetailOverlay();
    TopochainChallenges._loadBreakdown(0);
  },

  closeChallengeDetail() {
    TopochainChallenges._detailChallenge = null;
    document.getElementById('tc-se-detail-overlay')?.classList.add('hidden');
  },

  async _loadBreakdown(offset) {
    const challenge = TopochainChallenges._detailChallenge;
    if (!challenge) return;
    const eventId = TopochainChallenges._eventId();
    const { ok, data } = await TopochainChallenges.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challenge.id)}/breakdown`
      + `?limit=25&offset=${encodeURIComponent(offset)}`
    );
    if (TopochainChallenges._detailChallenge !== challenge) return; // overlay closed/changed
    TopochainChallenges._breakdownLoading = false;
    if (ok && data?.success) {
      const page = data.data;
      if (offset === 0 || !TopochainChallenges._breakdown) {
        TopochainChallenges._breakdown = page;
      } else {
        // "Load more": append entries, keep the fresh totals/has_more/next_offset.
        TopochainChallenges._breakdown = {
          ...page,
          entries: TopochainChallenges._breakdown.entries.concat(page.entries),
        };
      }
    } else {
      TopochainChallenges._breakdownError = (data && data.error) || 'Failed to load the breakdown.';
    }
    TopochainChallenges._renderDetailOverlay();
  },

  // Renders a `detail_modal` CTA, scheme-guarded: only an http(s) link
  // (per safeHref) becomes a real, clickable anchor. Anything else
  // (missing, `javascript:`, a bare string, ...) renders the label as
  // plain escaped text with no href at all — never an anchor whose href
  // an attacker-controlled scheme could turn into script execution.
  _ctaHtml(dm) {
    const esc = TopochainChallenges.esc;
    const label = esc(dm.cta_label || dm.cta_button || 'Go');
    if (!dm.cta_link) return '';
    const href = TopochainChallenges.safeHref(dm.cta_link);
    if (!href) {
      return `<p class="mb-3 text-xs text-zinc-500">${label} <span class="italic">(link unavailable)</span></p>`;
    }
    return `<a href="${esc(href)}" target="_blank" rel="noopener" class="inline-block mb-3 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">${label}</a>`;
  },

  _renderDetailOverlay() {
    const panel = document.getElementById('tc-se-detail-panel');
    if (!panel) return;
    const challenge = TopochainChallenges._detailChallenge;
    if (!challenge) return;
    const esc = TopochainChallenges.esc;
    const dm = challenge.detail_modal || {};
    const cp = challenge.card_preview || {};

    const bd = TopochainChallenges._breakdown;
    let entriesHtml;
    if (TopochainChallenges._breakdownLoading && !bd) {
      entriesHtml = '<p class="text-xs text-zinc-500">Loading participants…</p>';
    } else if (TopochainChallenges._breakdownError) {
      entriesHtml = `<p class="text-xs text-zinc-500">${esc(TopochainChallenges._breakdownError)}</p>`;
    } else if (bd && bd.entries.length) {
      entriesHtml = `
        <ul class="space-y-1">
          ${bd.entries.map((e) => `
            <li class="tc-se-entry flex items-center justify-between gap-3 text-xs p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer" data-user-id="${esc(e.user_id)}">
              <span class="text-zinc-700 dark:text-zinc-200">${esc(e.display_name)}${e.is_non_podium ? ' <span class="text-zinc-400">(non-podium)</span>' : ''}</span>
              <span class="font-mono text-zinc-400">${esc(e.points)}${e.rate != null ? ` · ${esc(e.rate)}%` : ''}</span>
            </li>`).join('')}
        </ul>
        ${bd.has_more ? '<button id="tc-se-breakdown-more" class="mt-2 text-xs text-violet-500 hover:text-violet-400">Load more</button>' : ''}`;
    } else {
      entriesHtml = '<p class="text-xs text-zinc-500">No participants yet.</p>';
    }

    const totalsHtml = bd
      ? `<p class="text-xs text-zinc-500 mb-2">${esc(bd.totals.participants)} participants · ${esc(bd.totals.total_points)} points total</p>`
      : '';

    // Your own contribution on this challenge, when the personalization pass
    // has it — the same number the card shows, repeated where the detail is.
    const mine = TopochainChallenges._mine.get(Number(challenge.id)) || null;
    const mineTotal = mine && Number(mine.activities_total) > 0
      ? Number(mine.activities_total) : 0;
    const mineHtml = mineTotal
      ? `<p class="text-xs text-emerald-600 dark:text-emerald-400 mb-2 font-medium">You&rsquo;ve contributed ${esc(mineTotal)} pts to this.</p>`
      : '';

    panel.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-2">
        <div>
          <div class="text-[10px] uppercase tracking-wide text-violet-600 dark:text-violet-400 font-semibold">${esc(cp.label || '')}</div>
          <h2 class="text-lg font-bold text-zinc-900 dark:text-zinc-100">${esc(cp.goal || '')}</h2>
        </div>
        <button id="tc-se-detail-close" class="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-xl leading-none" aria-label="Close">&times;</button>
      </div>
      ${dm.description ? `<p class="text-sm text-zinc-600 dark:text-zinc-300 mb-2">${esc(dm.description)}</p>` : ''}
      ${mineHtml}
      ${dm.requirements ? `<p class="text-xs text-zinc-500 mb-2"><span class="font-medium">Requirements:</span> ${esc(dm.requirements)}</p>` : ''}
      ${dm.reward_logic ? `<p class="text-xs text-zinc-500 mb-3"><span class="font-medium">Reward logic:</span> ${esc(dm.reward_logic)}</p>` : ''}
      ${TopochainChallenges._ctaHtml(dm)}
      <div class="border-t border-zinc-200 dark:border-zinc-800 pt-3">
        <div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Participants</div>
        ${totalsHtml}
        ${entriesHtml}
      </div>`;

    document.getElementById('tc-se-detail-close')
      ?.addEventListener('click', () => TopochainChallenges.closeChallengeDetail());
    document.getElementById('tc-se-breakdown-more')?.addEventListener('click', () => {
      TopochainChallenges._breakdownLoading = true;
      TopochainChallenges._renderDetailOverlay();
      TopochainChallenges._loadBreakdown(bd.next_offset);
    });
    panel.querySelectorAll('.tc-se-entry').forEach((el) => {
      el.addEventListener('click', () => {
        const userId = parseInt(el.dataset.userId, 10);
        if (Number.isInteger(userId)) TopochainChallenges.openUserProfile(userId);
      });
    });
  },

  // ── User profile overlay ─────────────────────────────────────────────

  openUserProfile(userId) {
    TopochainChallenges._profileUserId = userId;
    TopochainChallenges._profile = null;
    TopochainChallenges._profileError = null;
    TopochainChallenges._profileLoading = true;
    document.getElementById('tc-se-profile-overlay')?.classList.remove('hidden');
    TopochainChallenges._renderProfileOverlay();

    const eventId = TopochainChallenges._eventId();
    TopochainChallenges.fetchJson(
      `/api/v4/users/${encodeURIComponent(userId)}/profile?season_event_id=${encodeURIComponent(eventId)}`
    ).then(({ ok, data }) => {
      if (TopochainChallenges._profileUserId !== userId) return; // overlay closed/changed
      TopochainChallenges._profileLoading = false;
      if (ok && data?.success) {
        TopochainChallenges._profile = data.data;
      } else {
        TopochainChallenges._profileError = (data && data.error) || 'Failed to load this profile.';
      }
      TopochainChallenges._renderProfileOverlay();
    });
  },

  closeUserProfile() {
    TopochainChallenges._profileUserId = null;
    document.getElementById('tc-se-profile-overlay')?.classList.add('hidden');
  },

  _renderProfileOverlay() {
    const panel = document.getElementById('tc-se-profile-panel');
    if (!panel) return;
    if (TopochainChallenges._profileUserId == null) return;
    const esc = TopochainChallenges.esc;

    let body;
    if (TopochainChallenges._profileLoading) {
      body = '<p class="text-sm text-zinc-500">Loading…</p>';
    } else if (TopochainChallenges._profileError) {
      body = `<p class="text-sm text-zinc-500">${esc(TopochainChallenges._profileError)}</p>`;
    } else {
      const p = TopochainChallenges._profile;
      body = `
        <h2 class="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-3">${esc(p.display_name)}</h2>
        <div class="grid grid-cols-2 gap-2 text-xs mb-4">
          <div><span class="text-zinc-500">Rank</span><div class="font-mono">${esc(p.rank ?? '—')}</div></div>
          <div><span class="text-zinc-500">Total points</span><div class="font-mono">${esc(p.total_points)}</div></div>
          <div><span class="text-zinc-500">Extra points</span><div class="font-mono">${esc(p.extra_points)}</div></div>
          <div><span class="text-zinc-500">Produced blocks</span><div class="font-mono">${esc(p.produced_blocks)}</div></div>
          <div><span class="text-zinc-500">VRF won slots</span><div class="font-mono">${esc(p.vrf_won_slots)}</div></div>
          <div><span class="text-zinc-500">Success rate</span><div class="font-mono">${esc(p.success_rate)}%</div></div>
        </div>
        <div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Activities</div>
        ${p.activities && p.activities.length
          ? `<ul class="space-y-1">${p.activities.map((a) => `
              <li class="flex items-center justify-between gap-3 text-xs">
                <span class="text-zinc-600 dark:text-zinc-300">${esc(a.description || a.activity_type)}</span>
                <span class="font-mono text-zinc-400">+${esc(a.points)}</span>
              </li>`).join('')}</ul>`
          : '<p class="text-xs text-zinc-500">No activities recorded.</p>'}`;
    }

    panel.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="flex-1 min-w-0">${body}</div>
        <button id="tc-se-profile-close" class="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-xl leading-none shrink-0" aria-label="Close">&times;</button>
      </div>`;

    document.getElementById('tc-se-profile-close')
      ?.addEventListener('click', () => TopochainChallenges.closeUserProfile());
  },
};

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F, but ./leaderboard.js's lazy mount, app.js's
// pull-to-refresh and its #982 deep-link branch (openFromHash)
// all still reach it by name. The guard is for the SSG prerender pass —
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph
// in Node, where there is no window.
if (typeof window !== 'undefined') window.TopochainChallenges = TopochainChallenges;
