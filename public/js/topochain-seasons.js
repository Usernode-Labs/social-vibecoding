// Topochain public seasons/events screen (Task 14, public screens).
// Full-page SPA screen hosted at hash route #topochain/seasons, hosted in
// #topochain-seasons-screen / #topochain-seasons-root (public/index.html)
// and mounted/unmounted by App.navigateToTopochainSeasons /
// App._exitTopochainSeasons (public/js/app.js) — the same shape as the
// admin console (public/js/admin-console.js) and the sibling
// topochain-leaderboard.js, minus any auth gate: this is a public read.
//
// Mirrors the source `seasons-events/index` page's three overlays (SPEC
// §5.2/§5.5.1: event hero + challenge grid, challenge detail overlay,
// user profile overlay), all three served by /api/v4 endpoints:
//   - event hero + challenge grid: GET /season-events/:id and
//     GET /season-events/:id/challenges (card_preview fields).
//   - challenge detail overlay: the SAME challenge's detail_modal fields
//     (already in hand from the grid fetch) + GET .../challenges/:cid/
//     breakdown for the participant list.
//   - user profile overlay: GET /users/:id/profile. Unlike the
//     leaderboard screen (see that file's header comment for why it
//     CAN'T do this for an arbitrary row), the breakdown entries here
//     carry a real `user_id` (src/routes/topochain/public.js's
//     challenge-breakdown route), so this overlay opens for any
//     participant a challenge's breakdown lists.
'use strict';

const TopochainSeasons = {
  _open: false,

  _events: [],
  _eventId: null,
  _eventDetail: null,
  _eventLoading: false,
  _eventError: null,
  // True when the default we landed on is an event that already ENDED —
  // i.e. nothing is running. Drives the explanatory caption; cleared the
  // moment the user picks an event themselves.
  _endedFallback: false,

  _challenges: [],
  _challengesLoading: false,
  _challengesError: null,

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

  isOpen() { return TopochainSeasons._open; },

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
    TopochainSeasons._open = true;
    TopochainSeasons._renderShell();
    TopochainSeasons.loadEvents();
  },

  close() {
    TopochainSeasons._open = false;
    TopochainSeasons._detailChallenge = null;
    TopochainSeasons._profileUserId = null;
  },

  // ── Shell ────────────────────────────────────────────────────────────

  _renderShell() {
    const root = document.getElementById('topochain-seasons-root');
    if (!root) return;
    root.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 class="text-xl font-bold text-zinc-900 dark:text-zinc-100">Topochain seasons</h1>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-zinc-500 dark:text-zinc-400">Event</span>
          <select id="tc-se-event-select"
            class="rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1.5 text-sm max-w-[16rem]">
            <option value="">Loading…</option>
          </select>
        </label>
      </div>
      <div id="tc-se-hero" class="mb-4"></div>
      <div id="tc-se-grid"></div>
      <!-- Challenge detail overlay -->
      <div id="tc-se-detail-overlay" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div id="tc-se-detail-panel" class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-xl border border-zinc-200 dark:border-zinc-800"></div>
      </div>
      <!-- User profile overlay -->
      <div id="tc-se-profile-overlay" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div id="tc-se-profile-panel" class="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-md max-h-[85vh] overflow-y-auto shadow-xl border border-zinc-200 dark:border-zinc-800"></div>
      </div>`;

    document.getElementById('tc-se-event-select').addEventListener('change', (e) => {
      const id = parseInt(e.target.value, 10);
      if (Number.isInteger(id)) {
        TopochainSeasons._eventId = id;
        // An explicit choice is not a fallback — drop the caption.
        TopochainSeasons._endedFallback = false;
        TopochainSeasons.loadEventAndChallenges();
      }
    });
    document.getElementById('tc-se-detail-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'tc-se-detail-overlay') TopochainSeasons.closeChallengeDetail();
    });
    document.getElementById('tc-se-profile-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'tc-se-profile-overlay') TopochainSeasons.closeUserProfile();
    });
  },

  // ── Data loading ─────────────────────────────────────────────────────

  async loadEvents() {
    const { ok, data } = await TopochainSeasons.fetchJson(
      '/api/v4/season-events?include_past=1'
    );
    if (!TopochainSeasons._open) return;
    if (ok && data?.success && Array.isArray(data.data)) {
      TopochainSeasons._events = data.data;
      // Default: the currently-running event, else the most recent one
      // that has already started. Shared with the leaderboard and
      // challenges screens (public/js/topochain-events.js) so all three
      // agree on which event they are describing — otherwise the
      // standings and the challenge list can silently show different
      // weeks.
      const pick = window.TopochainEvents
        ? TopochainEvents.pickDefault(data.data)
        : (data.data.find((ev) => ev.is_current) || data.data[0] || null);
      TopochainSeasons._eventId = pick ? pick.id : null;
      TopochainSeasons._endedFallback = window.TopochainEvents
        ? TopochainEvents.hasEnded(pick) : false;
      TopochainSeasons._renderEventOptions();
    } else {
      TopochainSeasons._eventError = (data && data.error) || 'Failed to load events.';
    }
    if (TopochainSeasons._eventId != null) {
      TopochainSeasons.loadEventAndChallenges();
    } else {
      TopochainSeasons._renderHero();
      TopochainSeasons._renderGrid();
    }
  },

  _renderEventOptions() {
    const sel = document.getElementById('tc-se-event-select');
    if (!sel) return;
    const esc = TopochainSeasons.esc;
    sel.innerHTML = TopochainSeasons._events.map((ev) => {
      const selected = TopochainSeasons._eventId === ev.id ? ' selected' : '';
      const tag = ev.is_current ? ' (current)' : (ev.is_active ? '' : ' (past)');
      return `<option value="${esc(ev.id)}"${selected}>${esc(ev.name)}${esc(tag)}</option>`;
    }).join('') || '<option value="">No events</option>';
  },

  async loadEventAndChallenges() {
    TopochainSeasons._eventLoading = true;
    TopochainSeasons._challengesLoading = true;
    TopochainSeasons._eventError = null;
    TopochainSeasons._challengesError = null;
    TopochainSeasons._renderHero();
    TopochainSeasons._renderGrid();

    const eventId = TopochainSeasons._eventId;
    const [eventRes, challengesRes] = await Promise.all([
      TopochainSeasons.fetchJson(`/api/v4/season-events/${encodeURIComponent(eventId)}`),
      TopochainSeasons.fetchJson(`/api/v4/season-events/${encodeURIComponent(eventId)}/challenges`),
    ]);
    if (!TopochainSeasons._open || TopochainSeasons._eventId !== eventId) return;

    TopochainSeasons._eventLoading = false;
    if (eventRes.ok && eventRes.data?.success) {
      TopochainSeasons._eventDetail = eventRes.data.data;
    } else {
      TopochainSeasons._eventDetail = null;
      TopochainSeasons._eventError = (eventRes.data && eventRes.data.error) || 'Failed to load this event.';
    }

    TopochainSeasons._challengesLoading = false;
    if (challengesRes.ok && challengesRes.data?.success && Array.isArray(challengesRes.data.data)) {
      TopochainSeasons._challenges = challengesRes.data.data;
    } else {
      TopochainSeasons._challenges = [];
      TopochainSeasons._challengesError = (challengesRes.data && challengesRes.data.error)
        || 'Failed to load challenges.';
    }

    TopochainSeasons._renderHero();
    TopochainSeasons._renderGrid();
  },

  // ── Hero ─────────────────────────────────────────────────────────────

  _renderHero() {
    const host = document.getElementById('tc-se-hero');
    if (!host) return;
    const esc = TopochainSeasons.esc;

    if (TopochainSeasons._eventLoading && !TopochainSeasons._eventDetail) {
      host.innerHTML = '<p class="text-sm text-zinc-500">Loading…</p>';
      return;
    }
    if (TopochainSeasons._eventError && !TopochainSeasons._eventDetail) {
      host.innerHTML = `
        <div class="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
          ${esc(TopochainSeasons._eventError)}
        </div>`;
      return;
    }
    const ev = TopochainSeasons._eventDetail;
    if (!ev) {
      host.innerHTML = '<p class="text-sm text-zinc-500">No event selected.</p>';
      return;
    }
    const statusBadge = ev.is_current
      ? 'bg-green-500/20 text-green-600 dark:text-green-300'
      : (ev.is_active ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300' : 'bg-zinc-500/20 text-zinc-500');
    const statusLabel = ev.is_current ? 'active now' : (ev.is_active ? 'active' : 'past');
    const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

    host.innerHTML = `
      <div class="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100">${esc(ev.name)}</h2>
          <span class="text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge}">${esc(statusLabel)}</span>
        </div>
        ${ev.description ? `<p class="text-sm text-zinc-600 dark:text-zinc-300 mt-2">${esc(ev.description)}</p>` : ''}
        <p class="text-xs text-zinc-500 mt-2">
          ${esc(fmt(ev.starts_at))} &ndash; ${esc(fmt(ev.ends_at))}
          ${ev.users_count != null ? ` · ${esc(ev.users_count)} users enrolled` : ''}
        </p>
        ${TopochainSeasons._endedFallback ? `
        <p id="tc-se-fallback-note" class="text-xs text-zinc-500 mt-2">
          Nothing is running right now — showing the most recent event.
        </p>` : ''}
      </div>`;
  },

  // ── Challenge grid ───────────────────────────────────────────────────

  _renderGrid() {
    const host = document.getElementById('tc-se-grid');
    if (!host) return;
    const esc = TopochainSeasons.esc;

    if (TopochainSeasons._challengesLoading && !TopochainSeasons._challenges.length) {
      host.innerHTML = '<p class="text-sm text-zinc-500">Loading challenges…</p>';
      return;
    }
    if (TopochainSeasons._challengesError) {
      host.innerHTML = `
        <div class="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
          ${esc(TopochainSeasons._challengesError)}
        </div>`;
      return;
    }
    if (!TopochainSeasons._challenges.length) {
      host.innerHTML = '<p class="text-sm text-zinc-500 py-8 text-center">No challenges for this event yet.</p>';
      return;
    }

    const cards = TopochainSeasons._challenges.map((c, i) => {
      const cp = c.card_preview || {};
      return `
        <div class="tc-se-card bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 cursor-pointer hover:border-violet-400 dark:hover:border-violet-600 transition-colors" data-idx="${esc(i)}">
          <div class="text-[10px] uppercase tracking-wide text-violet-600 dark:text-violet-400 font-semibold mb-1">${esc(cp.label || '')}</div>
          <div class="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1">${esc(cp.goal || '')}</div>
          <p class="text-xs text-zinc-500 line-clamp-2">${esc(cp.task || '')}</p>
          ${cp.reward ? `<p class="text-xs text-violet-500 mt-2 font-medium">${esc(cp.reward)}</p>` : ''}
        </div>`;
    }).join('');

    host.innerHTML = `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${cards}</div>`;

    host.querySelectorAll('.tc-se-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx, 10);
        TopochainSeasons.openChallengeDetail(TopochainSeasons._challenges[idx]);
      });
    });
  },

  // ── Challenge detail overlay ─────────────────────────────────────────

  openChallengeDetail(challenge) {
    TopochainSeasons._detailChallenge = challenge;
    TopochainSeasons._breakdown = null;
    TopochainSeasons._breakdownError = null;
    TopochainSeasons._breakdownLoading = true;
    document.getElementById('tc-se-detail-overlay')?.classList.remove('hidden');
    TopochainSeasons._renderDetailOverlay();
    TopochainSeasons._loadBreakdown(0);
  },

  closeChallengeDetail() {
    TopochainSeasons._detailChallenge = null;
    document.getElementById('tc-se-detail-overlay')?.classList.add('hidden');
  },

  async _loadBreakdown(offset) {
    const challenge = TopochainSeasons._detailChallenge;
    if (!challenge) return;
    const eventId = TopochainSeasons._eventId;
    const { ok, data } = await TopochainSeasons.fetchJson(
      `/api/v4/season-events/${encodeURIComponent(eventId)}/challenges/${encodeURIComponent(challenge.id)}/breakdown`
      + `?limit=25&offset=${encodeURIComponent(offset)}`
    );
    if (TopochainSeasons._detailChallenge !== challenge) return; // overlay closed/changed
    TopochainSeasons._breakdownLoading = false;
    if (ok && data?.success) {
      const page = data.data;
      if (offset === 0 || !TopochainSeasons._breakdown) {
        TopochainSeasons._breakdown = page;
      } else {
        // "Load more": append entries, keep the fresh totals/has_more/next_offset.
        TopochainSeasons._breakdown = {
          ...page,
          entries: TopochainSeasons._breakdown.entries.concat(page.entries),
        };
      }
    } else {
      TopochainSeasons._breakdownError = (data && data.error) || 'Failed to load the breakdown.';
    }
    TopochainSeasons._renderDetailOverlay();
  },

  // Renders a `detail_modal` CTA, scheme-guarded: only an http(s) link
  // (per safeHref) becomes a real, clickable anchor. Anything else
  // (missing, `javascript:`, a bare string, ...) renders the label as
  // plain escaped text with no href at all — never an anchor whose href
  // an attacker-controlled scheme could turn into script execution.
  _ctaHtml(dm) {
    const esc = TopochainSeasons.esc;
    const label = esc(dm.cta_label || dm.cta_button || 'Go');
    if (!dm.cta_link) return '';
    const href = TopochainSeasons.safeHref(dm.cta_link);
    if (!href) {
      return `<p class="mb-3 text-xs text-zinc-500">${label} <span class="italic">(link unavailable)</span></p>`;
    }
    return `<a href="${esc(href)}" target="_blank" rel="noopener" class="inline-block mb-3 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">${label}</a>`;
  },

  _renderDetailOverlay() {
    const panel = document.getElementById('tc-se-detail-panel');
    if (!panel) return;
    const challenge = TopochainSeasons._detailChallenge;
    if (!challenge) return;
    const esc = TopochainSeasons.esc;
    const dm = challenge.detail_modal || {};
    const cp = challenge.card_preview || {};

    const bd = TopochainSeasons._breakdown;
    let entriesHtml;
    if (TopochainSeasons._breakdownLoading && !bd) {
      entriesHtml = '<p class="text-xs text-zinc-500">Loading participants…</p>';
    } else if (TopochainSeasons._breakdownError) {
      entriesHtml = `<p class="text-xs text-zinc-500">${esc(TopochainSeasons._breakdownError)}</p>`;
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

    panel.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-2">
        <div>
          <div class="text-[10px] uppercase tracking-wide text-violet-600 dark:text-violet-400 font-semibold">${esc(cp.label || '')}</div>
          <h2 class="text-lg font-bold text-zinc-900 dark:text-zinc-100">${esc(cp.goal || '')}</h2>
        </div>
        <button id="tc-se-detail-close" class="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-xl leading-none" aria-label="Close">&times;</button>
      </div>
      ${dm.description ? `<p class="text-sm text-zinc-600 dark:text-zinc-300 mb-2">${esc(dm.description)}</p>` : ''}
      ${dm.requirements ? `<p class="text-xs text-zinc-500 mb-2"><span class="font-medium">Requirements:</span> ${esc(dm.requirements)}</p>` : ''}
      ${dm.reward_logic ? `<p class="text-xs text-zinc-500 mb-3"><span class="font-medium">Reward logic:</span> ${esc(dm.reward_logic)}</p>` : ''}
      ${TopochainSeasons._ctaHtml(dm)}
      <div class="border-t border-zinc-200 dark:border-zinc-800 pt-3">
        <div class="text-xs uppercase tracking-wide text-zinc-500 mb-1">Participants</div>
        ${totalsHtml}
        ${entriesHtml}
      </div>`;

    document.getElementById('tc-se-detail-close')
      ?.addEventListener('click', () => TopochainSeasons.closeChallengeDetail());
    document.getElementById('tc-se-breakdown-more')?.addEventListener('click', () => {
      TopochainSeasons._breakdownLoading = true;
      TopochainSeasons._renderDetailOverlay();
      TopochainSeasons._loadBreakdown(bd.next_offset);
    });
    panel.querySelectorAll('.tc-se-entry').forEach((el) => {
      el.addEventListener('click', () => {
        const userId = parseInt(el.dataset.userId, 10);
        if (Number.isInteger(userId)) TopochainSeasons.openUserProfile(userId);
      });
    });
  },

  // ── User profile overlay ─────────────────────────────────────────────

  openUserProfile(userId) {
    TopochainSeasons._profileUserId = userId;
    TopochainSeasons._profile = null;
    TopochainSeasons._profileError = null;
    TopochainSeasons._profileLoading = true;
    document.getElementById('tc-se-profile-overlay')?.classList.remove('hidden');
    TopochainSeasons._renderProfileOverlay();

    const eventId = TopochainSeasons._eventId;
    TopochainSeasons.fetchJson(
      `/api/v4/users/${encodeURIComponent(userId)}/profile?season_event_id=${encodeURIComponent(eventId)}`
    ).then(({ ok, data }) => {
      if (TopochainSeasons._profileUserId !== userId) return; // overlay closed/changed
      TopochainSeasons._profileLoading = false;
      if (ok && data?.success) {
        TopochainSeasons._profile = data.data;
      } else {
        TopochainSeasons._profileError = (data && data.error) || 'Failed to load this profile.';
      }
      TopochainSeasons._renderProfileOverlay();
    });
  },

  closeUserProfile() {
    TopochainSeasons._profileUserId = null;
    document.getElementById('tc-se-profile-overlay')?.classList.add('hidden');
  },

  _renderProfileOverlay() {
    const panel = document.getElementById('tc-se-profile-panel');
    if (!panel) return;
    if (TopochainSeasons._profileUserId == null) return;
    const esc = TopochainSeasons.esc;

    let body;
    if (TopochainSeasons._profileLoading) {
      body = '<p class="text-sm text-zinc-500">Loading…</p>';
    } else if (TopochainSeasons._profileError) {
      body = `<p class="text-sm text-zinc-500">${esc(TopochainSeasons._profileError)}</p>`;
    } else {
      const p = TopochainSeasons._profile;
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
      ?.addEventListener('click', () => TopochainSeasons.closeUserProfile());
  },
};

window.TopochainSeasons = TopochainSeasons;
