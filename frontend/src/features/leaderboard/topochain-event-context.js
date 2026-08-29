// Shared event selection for the Leaderboard screen's two Topochain-domain
// panes (./topochain-leaderboard.js and
// ./topochain-challenges.js).
//
// Why this module exists: before the leaderboard merge, the standings screen
// and the seasons screen each fetched GET /api/v4/season-events?include_past=1
// themselves, each ran TopochainEvents.pickDefault on the result, and each
// rendered its own <select> + hero. They agreed only by convention — two
// screens could sit on different events at the same time, and the user had to
// re-pick after every navigation. Now there is ONE selection: this module owns
// the list, the picked id, the picker and the hero, and the panes subscribe.
//
// Hosted in #leaderboard-event-bar (public/index.html), inside
// #leaderboard-screen but ABOVE the panes. Shown/hidden by
// Leaderboard._applySection — the Kudos tab has no event dimension, so the bar
// is hidden there.
//
// Default-pick note: pickDefault runs WITHOUT `requireLeaderboard: true`, which
// the standings screen used to pass. The selection is shared with the
// challenges pane now, and that pane renders fine for an event whose standings
// are switched off — narrowing the shared default to leaderboard-rendering
// events would hide challenges for no reason. When the picked event does have
// display_leaderboard = false, the standings pane still shows its own "The
// leaderboard for this event isn't public yet." message, which is the correct
// per-pane answer.
//
// Every fetch here hits the public /api/v4 group (src/routes/topochain/
// public.js), which is optionally-authenticated but never 401s.
'use strict';

import { eventBarStore } from './event-bar-store.js';

const TopochainEventContext = {
  _mounted: false,

  // Full events list (GET /season-events?include_past=1), for the picker.
  _events: [],
  // Selected season_event_id, or null before loadEvents() resolves (or when
  // the server has no public events at all).
  eventId: null,
  // True when the default we landed on is an event that already ENDED — i.e.
  // nothing is running right now. Drives the explanatory caption and the
  // picker's placeholder label. Cleared as soon as the user chooses an event
  // themselves: from then on the selection is theirs, not a fallback.
  _endedFallback: false,

  // Detail for the hero (GET /season-events/:id).
  _detail: null,
  _detailLoading: false,
  _detailError: null,

  // Subscribers: pane callbacks fired whenever the selected event changes.
  _subs: [],

  isMounted() { return TopochainEventContext._mounted; },

  // The selected event's entry in the LIST payload (GET /season-events),
  // which is where `type` lives — GET /season-events/:id (the hero's own
  // `_detail`) deliberately keeps its v1 shape and carries no `type`, so the
  // list is the one source for "is this the season aggregate". Null before
  // loadEvents() resolves.
  selectedEvent() {
    const id = TopochainEventContext.eventId;
    if (id == null) return null;
    return TopochainEventContext._events.find((ev) => ev.id === id) || null;
  },

  // True when the CURRENT selection is the season-level aggregate, whoever
  // chose it — the hero badge and the season caption both key off THIS, not
  // off "did pickDefault land here".
  //
  // Why it must be the selection: loadEvents() only runs pickDefault when
  // `eventId` is still null, and by then it usually isn't. The standings
  // pane's own first fetch goes out with no season_event_id, the server
  // resolves the default itself, and the pane feeds that id back through
  // select(..., { silent: true }) — often before this module's event list has
  // even landed. A flag set inside the pickDefault branch is therefore false
  // on most real loads (and after any re-open, since close() deliberately
  // keeps the resolved selection). Keying off the selection also means
  // picking "Season 1" by hand reads exactly like landing on it, which is
  // right: the caption explains what the board IS, it is not a notice that a
  // fallback fired.
  isSeasonSelected() {
    return !!(window.TopochainEvents
      && TopochainEvents.isSeasonAggregate(TopochainEventContext.selectedEvent()));
  },

  // `esc()` lived here — safe in BOTH a text node and a double-quoted attribute
  // value, because this file interpolated admin-authored copy (event names,
  // descriptions) into both. The bar is ./event-bar.tsx's markup now and React
  // escapes both contexts by construction, so it has no caller.

  // Safe fetch+parse: never throws, returns { status, ok, data } with
  // data === null on anything that isn't a clean JSON 2xx.
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

  // ── Subscription ─────────────────────────────────────────────────────

  // Register a pane callback. Returns an unsubscribe function (the panes call
  // it from their own close()), so a torn-down pane can never be woken by a
  // later event change.
  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    TopochainEventContext._subs.push(fn);
    return () => {
      const i = TopochainEventContext._subs.indexOf(fn);
      if (i >= 0) TopochainEventContext._subs.splice(i, 1);
    };
  },

  _notify() {
    // Copy first: a subscriber may unsubscribe from inside its own callback.
    for (const fn of TopochainEventContext._subs.slice()) {
      try {
        fn(TopochainEventContext.eventId);
      } catch (err) {
        console.warn('[tc-event-context] subscriber failed', err);
      }
    }
  },

  // ── Mount / teardown ─────────────────────────────────────────────────

  open() {
    TopochainEventContext._mounted = true;
    TopochainEventContext._renderShell();
    TopochainEventContext.loadEvents();
  },

  close() {
    TopochainEventContext._mounted = false;
    // Deliberately NOT clearing _events/eventId: the panes tear down and
    // remount with the screen, and keeping the resolved selection means a
    // re-open paints the same event instead of flickering through the
    // default-pick again. loadEvents() re-validates on the next mount.
    TopochainEventContext._subs = [];
  },

  // Reveal the bar. Was an `innerHTML` assignment plus a `change` listener
  // attached to the `<select>` it had just created; both are ./event-bar.tsx's
  // now, and what is left is the flag that says "an event section is open".
  //
  // The picker starts on its `Loading…` placeholder and the hero starts EMPTY,
  // which is exactly what the string version's markup said — loadEvents() and
  // _loadDetail() fill each in turn.
  _renderShell() {
    eventBarStore.set({
      mounted: true,
      options: [],
      placeholder: 'Loading…',
      selectedId: null,
      hero: null,
    });
  },

  // ── Data loading ─────────────────────────────────────────────────────

  async loadEvents() {
    const { ok, data } = await TopochainEventContext.fetchJson(
      '/api/v4/season-events?include_past=1'
    );
    if (!TopochainEventContext._mounted) return;
    if (ok && data?.success && Array.isArray(data.data)) {
      TopochainEventContext._events = data.data;
      if (TopochainEventContext.eventId == null && window.TopochainEvents) {
        const pick = TopochainEvents.pickDefault(data.data);
        if (pick) {
          TopochainEventContext.eventId = pick.id;
          // The season aggregate is NOT a "nothing is running" fallback,
          // even though it has usually ended by the time it is the default
          // (production's Season 1 event closed 2026-06-30 and is still the
          // season people mean). hasEnded() is true for it, so keying the
          // caption off that alone put "Nothing is running right now —
          // showing the most recent event." above a live season board.
          TopochainEventContext._endedFallback =
            !TopochainEvents.isSeasonAggregate(pick) && TopochainEvents.hasEnded(pick);
        }
      }
    }
    TopochainEventContext._renderOptions();
    if (TopochainEventContext.eventId != null) {
      TopochainEventContext._loadDetail();
    } else {
      TopochainEventContext._renderHero();
    }
    // Even with no event resolved, tell the panes: their own empty states are
    // the right answer to "there are no public events", and the standings pane
    // additionally falls back to the server's own "current event" default.
    TopochainEventContext._notify();
  },

  // Change the selection (user pick, or a server-resolved id learned by a
  // pane). Re-renders the bar and wakes both panes.
  select(id, opts) {
    const next = Number.isInteger(id) ? id : null;
    if (next == null || next === TopochainEventContext.eventId) {
      // Still reflect a no-op server write-back in the picker: the first
      // standings fetch may resolve "current" before our own list lands.
      TopochainEventContext._renderOptions();
      return;
    }
    TopochainEventContext.eventId = next;
    // An explicit choice is not a fallback — drop the caption. A server
    // write-back (silent: true) is not a choice either way, so it leaves the
    // caption alone.
    if (!(opts && opts.silent)) TopochainEventContext._endedFallback = false;
    TopochainEventContext._detail = null;
    TopochainEventContext._renderOptions();
    TopochainEventContext._loadDetail();
    if (!(opts && opts.silent)) TopochainEventContext._notify();
  },

  async _loadDetail() {
    const eventId = TopochainEventContext.eventId;
    if (eventId == null) return;
    TopochainEventContext._detailLoading = true;
    TopochainEventContext._detailError = null;
    TopochainEventContext._renderHero();
    const { ok, data } = await TopochainEventContext.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}`
    );
    // Stale response for an event the user has already navigated away from.
    if (!TopochainEventContext._mounted
        || TopochainEventContext.eventId !== eventId) return;
    TopochainEventContext._detailLoading = false;
    if (ok && data?.success) {
      TopochainEventContext._detail = data.data;
    } else {
      TopochainEventContext._detail = null;
      TopochainEventContext._detailError = (data && data.error)
        || 'Failed to load this event.';
    }
    TopochainEventContext._renderHero();
  },

  // ── Rendering ────────────────────────────────────────────────────────

  // The picker's entries. `selected` and the `sel.value = …` that followed it
  // are one field now — a controlled `<select>` cannot disagree with itself.
  _renderOptions() {
    const events = TopochainEventContext._events;
    if (!events.length) {
      eventBarStore.set({ options: [], placeholder: 'No events', selectedId: null });
      return;
    }
    eventBarStore.set({
      options: events.map((ev) => ({
        id: ev.id,
        label: `${ev.name}${TopochainEventContext._tagFor(ev)}`,
      })),
      placeholder: null,
      selectedId: TopochainEventContext.eventId,
    });
  },

  // A season-type event is labelled by WHAT IT IS, not by its window: its
  // standings are the whole season's, so "(past)" is both wrong and — since it
  // is the default selection — the first thing a reader sees. Its own window
  // has usually closed while the season is still the dataset everyone means.
  _tagFor(ev) {
    const isSeason = !!(window.TopochainEvents
      && TopochainEvents.isSeasonAggregate(ev));
    if (isSeason) return ' (season)';
    if (ev.is_current) return ' (current)';
    return ev.is_active ? '' : ' (past)';
  },

  // The hero, as one of four tagged shapes. Every branch of the string version
  // is a tag, so ./event-bar.tsx has no condition of its own to get wrong.
  _renderHero() {
    if (TopochainEventContext._detailLoading && !TopochainEventContext._detail) {
      eventBarStore.set({ hero: { kind: 'loading' } });
      return;
    }
    if (TopochainEventContext._detailError && !TopochainEventContext._detail) {
      eventBarStore.set({
        hero: { kind: 'error', message: TopochainEventContext._detailError },
      });
      return;
    }
    const ev = TopochainEventContext._detail;
    if (!ev) {
      eventBarStore.set({ hero: { kind: 'empty' } });
      return;
    }
    // Same reasoning as the picker's `(season)` suffix: a season-type event is
    // badged for what it is rather than for its own window, which has usually
    // closed while the season is still the dataset on screen.
    const isSeason = TopochainEventContext.isSeasonSelected();
    // Four badge tones, one per state. `meadow` is the product's one green —
    // stock `green` is not a tuned ramp, so it rendered an untuned hue beside
    // the azure and amber badges it sits next to in this very expression. The
    // dark inks are each ramp's own 200 step, which is what the red, amber and
    // meadow ramps were solved to for parity with their light 700/800 halves.
    //
    // Azure now joins them at 800/200. This line used to end "azure stops at
    // 300 because its light ink deliberately sits lower to stay near the brand
    // hex", and the correction is left visible rather than deleted because the
    // old reading is the trap: the brand hex is what the GROUNDS carry — the
    // `-500/20` washes on all four of these badges, and the chip and fill
    // steps elsewhere — and blue INK is a separate job that takes the 800/200
    // parity pair. This exact recipe is already the console's, on the
    // byte-identical wash: see the composited Lc figure in the BADGE table
    // comment of features/admin/admin-merges.tsx, which is what sent every
    // `bg-azure-500/20` badge there to 800/200 rather than 700.
    //
    // Each badge KEEPS its dark ground: the panel-becomes-a-border rule is
    // about section-sized fields, not chips.
    const statusClass = isSeason
      ? 'bg-azure-500/20 text-azure-800 dark:text-azure-200'
      : (ev.is_current
        ? 'bg-meadow-500/20 text-meadow-700 dark:text-meadow-200'
        : (ev.is_active
          ? 'bg-amber-500/20 text-amber-800 dark:text-amber-200'
          : 'bg-zinc-500/20 text-zinc-500 dark:text-zinc-300'));
    const statusLabel = isSeason ? 'season'
      : (ev.is_current ? 'active now' : (ev.is_active ? 'active' : 'past'));
    const fmt = (iso) => (iso
      ? new Date(iso).toLocaleDateString(undefined,
        { year: 'numeric', month: 'short', day: 'numeric' })
      : '—');
    eventBarStore.set({
      hero: {
        kind: 'event',
        name: String(ev.name || ''),
        statusLabel,
        statusClass,
        description: ev.description ? String(ev.description) : null,
        // An en dash between the two dates, as the `&ndash;` entity drew.
        dates: `${fmt(ev.starts_at)} – ${fmt(ev.ends_at)}`,
        participants: ev.users_count != null ? ` · ${ev.users_count} taking part` : null,
        seasonNote: isSeason,
        fallbackNote: !!TopochainEventContext._endedFallback,
      },
    });
  },
};

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F, but ./leaderboard.js's lazy mount and both
// Topochain-domain panes
// all still reach it by name. The guard is for the SSG prerender pass —
// frontend/scripts/build-shell.mjs evaluates the island's whole module graph
// in Node, where there is no window.
if (typeof window !== 'undefined') window.TopochainEventContext = TopochainEventContext;
