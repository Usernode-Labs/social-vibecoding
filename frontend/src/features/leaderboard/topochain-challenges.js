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
//
// ── #1191 slice 6, conversion 7: this file builds DESCRIPTORS ────────────
//
// `#challenges-root` was the Leaderboard screen's last innerHTML host. It is
// React-owned now: ./challenges-pane.tsx is the only writer below it, and the
// four render methods below push view descriptors into
// ./topochain-challenges-store.js instead of assembling markup. That is a
// change of OUTPUT TYPE, not of behaviour — the ordering, the completed
// split, the deep-link resolution and every id are the ones this file already
// shipped, and each is still decided here.
//
// Three consequences worth stating, because each replaced something visible
// in the diff:
//
//   * `esc()` is gone, replaced by `str()`. There is no markup left to escape
//     — React escapes the text when it renders it, and an esc() surviving
//     into a descriptor would double-encode. What outlived it is the
//     null→'' coercion, which is still load-bearing: React prints
//     String(null) as the four-character word "null". `safeHref()` did NOT
//     retire with it, because it guards a real `href` attribute and React
//     does not validate schemes.
//   * The four `addEventListener` sweeps that were re-bound after every
//     render (the cards, the see-the-standings link, the two overlay
//     backdrops, the close buttons, the breakdown's Load more and its
//     participant rows) are named methods now — `_openIdx`, `_toStandings`,
//     `_moreBreakdown` — and the component calls them. The behaviour stayed
//     here; only the wiring moved.
//   * The overlays' `hidden` class retired into their descriptors: `detail`
//     and `profile` are null when closed. Only the PANE ROOT's visibility is
//     still `Leaderboard._applySection()`'s `classList.toggle`, which is why
//     #challenges-root keeps a constant `className` in ./index.tsx.
'use strict';

const TopochainChallenges = {
  // ./topochain-challenges-store.js, planted by ./mount.ts rather than
  // imported — see that store's header for why this file can take no import
  // at all. Null during the SSG prerender pass and until the bundle mounts,
  // so every write below goes through `?.set(...)`.
  _store: null,

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

  // What is left of esc() after conversion 7 took the markup away: the
  // null→empty coercion, with none of the escaping. React escapes every text
  // node and every attribute value it renders, so escaping here would
  // double-encode — a challenge goal reading `Ship & tell` would paint as
  // `Ship &amp; tell`. The coercion is NOT redundant: React renders
  // String(null) as the four-character word "null", so a nullable API field
  // still has to land as ''.
  str(s) {
    return String(s == null ? '' : s);
  },

  // href-safe URL: only http(s) links are ever rendered as a real anchor.
  // This is the ONE guard React does not make redundant. Rendering through a
  // component stops attribute breakout for free, but it does NOT stop a
  // `javascript:`-scheme href, which executes on click with no markup
  // injection needed at all. Every cta/mobile_cta link in this file must
  // go through this before it can reach an `href`; anything that isn't
  // http(s) renders as plain text instead of a clickable link.
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
  //
  // The grid host and the two overlay roots are ./challenges-pane.tsx's
  // markup now, so all this does is announce that the pane is open. It still
  // clears both overlays, exactly as re-writing the root's innerHTML did:
  // close() leaves `_detailChallenge` null but never took the `hidden` class
  // off, and it was this rebuild that re-hid them on the next open.
  _renderShell() {
    TopochainChallenges._store?.set({ mounted: true, detail: null, profile: null });
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
    const store = TopochainChallenges._store;

    if (TopochainChallenges._challengesLoading && !TopochainChallenges._challenges.length) {
      store?.set({ grid: { kind: 'loading' } });
      return;
    }
    // Both terminal empty states retire a pending deep link (#982) on the
    // way out, via the same guards the populated path uses — an empty
    // `ordered` simply matches nothing. Neither state can ever resolve one,
    // and leaving it armed would fire it against whatever event the viewer
    // picks next.
    if (TopochainChallenges._challengesError) {
      TopochainChallenges._maybeDeepLink([]);
      store?.set({
        grid: {
          kind: 'error',
          message: TopochainChallenges.str(TopochainChallenges._challengesError),
        },
      });
      return;
    }
    if (!TopochainChallenges._challenges.length) {
      TopochainChallenges._maybeDeepLink([]);
      store?.set({ grid: { kind: 'empty' } });
      return;
    }

    const ordered = TopochainChallenges._ordered();
    store?.set({ grid: TopochainChallenges.gridView(ordered) });
    TopochainChallenges._maybeShot(ordered);
    TopochainChallenges._maybeDeepLink(ordered);
  },

  // The populated grid, as a descriptor. `ordered` stays ONE flat array
  // whatever the grouping does: both the cards' `idx` and _maybeShot index
  // into it, so splitting it in two would desynchronise every click from the
  // card it was made for. The groups below therefore carry SLICES of the same
  // numbering, not a re-numbering.
  gridView(ordered) {
    const firstDone = ordered.findIndex((c) => TopochainChallenges._isDone(c));
    const doneCount = firstDone === -1 ? 0 : ordered.length - firstDone;
    const cards = ordered.map((c, i) => TopochainChallenges.cardView(c, i));

    // The "Completed" subheading only earns its row when there is something
    // on BOTH sides of it. Every public event in production is currently
    // 100% completed, and a heading over the entire grid says nothing.
    const groups = (firstDone > 0 && doneCount > 0)
      ? [
        { key: 'open', heading: null, cards: cards.slice(0, firstDone) },
        { key: 'done', heading: 'Completed', cards: cards.slice(firstDone) },
      ]
      : [{ key: 'all', heading: null, cards }];

    return {
      kind: 'cards',
      // Always present when the grid has rows (including "0 of 8" and
      // "8 of 8"), so the declared dapp.json check can anchor on
      // #tc-se-challenge-summary whatever the selected event's data happens
      // to be.
      summary: `${doneCount} of ${ordered.length} challenges completed`,
      groups,
    };
  },

  // One card. `idx` is this challenge's position in the flat `ordered` array
  // — the component hands it straight back to _openIdx, which is what the
  // retired `data-idx` attribute did.
  cardView(c, i) {
    const str = TopochainChallenges.str;
    const cp = c.card_preview || {};
    const m = TopochainChallenges._mine.get(Number(c.id)) || null;
    const mineTotal = m && Number(m.activities_total) > 0
      ? Number(m.activities_total) : 0;
    return {
      key: `${c.id}|${i}`,
      idx: i,
      featured: !!(m && m.featured === true),
      // A finished challenge is DIMMED, not hidden: its detail overlay and
      // participant breakdown are the interesting part of it, so the card
      // stays fully clickable — the opacity only takes it out of the way of
      // whatever is still open.
      done: TopochainChallenges._isDone(c),
      label: str(cp.label || ''),
      goal: str(cp.goal || ''),
      task: str(cp.task || ''),
      reward: cp.reward ? str(cp.reward) : null,
      // Composed here rather than in the renderer so the number and its unit
      // stay one text node — see the header of ./challenges-pane.tsx.
      mineNote: mineTotal ? `You’ve contributed ${mineTotal} pts` : null,
    };
  },

  // A card click, by its index in the flat ordered array. Recomputed rather
  // than closed over: the only thing that can change `_ordered()` is a new
  // `_mine` or a new `_challenges`, and either of those has already pushed a
  // fresh grid descriptor, so the index the component is holding belongs to
  // the array this returns.
  _openIdx(idx) {
    const ordered = TopochainChallenges._ordered();
    TopochainChallenges.openChallengeDetail(ordered[idx]);
  },

  // Real hash navigation so the section switch goes through the router
  // (and the shared event selection is untouched).
  _toStandings() {
    window.location.hash = '#leaderboard/topochain';
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
    // The overlay's visibility IS its descriptor now — _renderDetailOverlay
    // publishing a non-null `detail` is what used to be the
    // classList.remove('hidden') on this line.
    TopochainChallenges._renderDetailOverlay();
    TopochainChallenges._loadBreakdown(0);
  },

  closeChallengeDetail() {
    TopochainChallenges._detailChallenge = null;
    TopochainChallenges._store?.set({ detail: null });
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

  // Describes a `detail_modal` CTA, scheme-guarded: only an http(s) link
  // (per safeHref) becomes a real, clickable anchor. Anything else
  // (missing, `javascript:`, a bare string, ...) renders the label as
  // plain text with no href at all — never an anchor whose href
  // an attacker-controlled scheme could turn into script execution. The
  // decision stays here, in the shaping module, precisely so that the
  // renderer has no branch to get wrong: it is handed either a href or not
  // one, and `kind: 'text'` has no href field at all to reach for.
  ctaView(dm) {
    const label = TopochainChallenges.str(dm.cta_label || dm.cta_button || 'Go');
    if (!dm.cta_link) return null;
    const href = TopochainChallenges.safeHref(dm.cta_link);
    if (!href) return { kind: 'text', label };
    return { kind: 'link', href, label };
  },

  _renderDetailOverlay() {
    if (!TopochainChallenges._detailChallenge) return;
    TopochainChallenges._store?.set({ detail: TopochainChallenges.detailView() });
  },

  detailView() {
    const challenge = TopochainChallenges._detailChallenge;
    if (!challenge) return null;
    const str = TopochainChallenges.str;
    const dm = challenge.detail_modal || {};
    const cp = challenge.card_preview || {};

    const bd = TopochainChallenges._breakdown;
    let entries;
    if (TopochainChallenges._breakdownLoading && !bd) {
      entries = { kind: 'loading' };
    } else if (TopochainChallenges._breakdownError) {
      entries = { kind: 'error', message: str(TopochainChallenges._breakdownError) };
    } else if (bd && bd.entries.length) {
      entries = {
        kind: 'list',
        hasMore: !!bd.has_more,
        rows: bd.entries.map((e, i) => ({
          key: `${e.user_id}|${i}`,
          userId: e.user_id,
          name: str(e.display_name),
          nonPodium: !!e.is_non_podium,
          // Points and the optional rate are ONE string, composed here: they
          // shared a single <span> in the markup this replaces, and two
          // sibling expressions in JSX are two text nodes.
          points: e.rate != null ? `${str(e.points)} · ${str(e.rate)}%` : str(e.points),
        })),
      };
    } else {
      entries = { kind: 'empty' };
    }

    // Your own contribution on this challenge, when the personalization pass
    // has it — the same number the card shows, repeated where the detail is.
    const mine = TopochainChallenges._mine.get(Number(challenge.id)) || null;
    const mineTotal = mine && Number(mine.activities_total) > 0
      ? Number(mine.activities_total) : 0;

    return {
      label: str(cp.label || ''),
      goal: str(cp.goal || ''),
      description: dm.description ? str(dm.description) : null,
      mineNote: mineTotal ? `You’ve contributed ${mineTotal} pts to this.` : null,
      requirements: dm.requirements ? str(dm.requirements) : null,
      rewardLogic: dm.reward_logic ? str(dm.reward_logic) : null,
      cta: TopochainChallenges.ctaView(dm),
      totals: bd
        ? `${str(bd.totals.participants)} participants · ${str(bd.totals.total_points)} points total`
        : null,
      entries,
    };
  },

  // The breakdown's "Load more". `next_offset` is read off the CURRENT
  // breakdown rather than a captured one, so a page that landed between the
  // render and the click cannot make this re-request a page already in hand.
  _moreBreakdown() {
    const bd = TopochainChallenges._breakdown;
    if (!bd) return;
    TopochainChallenges._breakdownLoading = true;
    TopochainChallenges._renderDetailOverlay();
    TopochainChallenges._loadBreakdown(bd.next_offset);
  },

  // ── User profile overlay ─────────────────────────────────────────────

  openUserProfile(userId) {
    TopochainChallenges._profileUserId = userId;
    TopochainChallenges._profile = null;
    TopochainChallenges._profileError = null;
    TopochainChallenges._profileLoading = true;
    // As with the detail overlay: publishing a non-null `profile` is what the
    // classList.remove('hidden') on this line used to be.
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
    TopochainChallenges._store?.set({ profile: null });
  },

  _renderProfileOverlay() {
    if (TopochainChallenges._profileUserId == null) return;
    TopochainChallenges._store?.set({ profile: TopochainChallenges.profileView() });
  },

  profileView() {
    if (TopochainChallenges._profileUserId == null) return null;
    const str = TopochainChallenges.str;
    if (TopochainChallenges._profileLoading) return { kind: 'loading' };
    if (TopochainChallenges._profileError) {
      return { kind: 'error', message: str(TopochainChallenges._profileError) };
    }
    const p = TopochainChallenges._profile;
    return {
      kind: 'profile',
      name: str(p.display_name),
      // The stats grid was six hand-written cells in the same shape; one
      // ordered list of label/value pairs is the same six, and a label can no
      // longer drift away from the field it sits over.
      stats: [
        { label: 'Rank', value: str(p.rank ?? '—') },
        { label: 'Total points', value: str(p.total_points) },
        { label: 'Extra points', value: str(p.extra_points) },
        { label: 'Produced blocks', value: str(p.produced_blocks) },
        { label: 'VRF won slots', value: str(p.vrf_won_slots) },
        { label: 'Success rate', value: `${str(p.success_rate)}%` },
      ],
      // null, not [], so the renderer's "No activities recorded." branch is
      // the same explicit choice the template's ternary was.
      activities: (p.activities && p.activities.length)
        ? p.activities.map((a, i) => ({
          key: `${i}`,
          text: str(a.description || a.activity_type),
          points: `+${str(a.points)}`,
        }))
        : null,
    };
  },
};

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F, but ./leaderboard.js's lazy mount, app.js's
// pull-to-refresh and its #982 deep-link branch (openFromHash)
// all still reach it by name. The guard is for the SSG prerender pass —
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph
// in Node, where there is no window.
if (typeof window !== 'undefined') window.TopochainChallenges = TopochainChallenges;
