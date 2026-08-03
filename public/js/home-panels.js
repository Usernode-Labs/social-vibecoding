// Home-screen panels (issue #911) — the cards that sit on the home screen
// between the "Your apps" grid and "Featured apps". One panel exists so
// far: "Challenges", listing every currently-open challenge with the
// viewer's own progress and the points each pays out.
//
// NAMING — "panel", not "widget". home.js already owns a DIFFERENT
// concept called "widget" (Home.renderWidgetSection / #widget-strip /
// .widget-tile: the iOS home-screen widget's pinned app grid, whose UI
// says "Usernode widget"). Both render on this same screen, so everything
// here says `panel`. Nothing user-facing says it: the card is titled
// "Challenges" and the Settings row is "Home screen widgets".
//
// FETCH DISCIPLINE. Home.load() is called from a dozen WS/event paths
// (app_status, app_update, notifications…), so this module must NOT fetch
// per Home.load(): ensureLoaded() is TTL-guarded and de-duped on an
// in-flight promise, while render() is pure paint from the cache. The
// section markup is static in index.html and lives OUTSIDE #app-list, so
// Home.render()'s wholesale innerHTML rewrite of the grid never destroys
// it (same reasoning as the home search bar).
'use strict';

const HomePanels = {
  // Cache of GET /api/home-panels: { registry, hidden, panels }.
  _data: null,
  _fetchedAt: 0,
  _inflight: null,
  TTL_MS: 60 * 1000,

  // Escapes every character that is dangerous in EITHER a text node OR a
  // double-quoted attribute value. Organiser-authored strings (challenge
  // goals, metric labels, cta links) land in both here, and the global
  // escapeHtml() in home.js only covers & < > — an unescaped `"` would let
  // a goal break out of title="…" and inject attributes.
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // Only http(s) links ever become a real anchor. esc() stops attribute
  // breakout but does nothing about a `javascript:` href, which executes
  // on click with no markup injection at all.
  safeHref(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  },

  // Rewards are organiser prose — rendered verbatim ("Up to 6,500 pts",
  // "½ of your final credits"). The single exception: a bare number gets
  // " pts" appended, because organisers do type just "1500".
  formatReward(reward) {
    const s = String(reward == null ? '' : reward).trim();
    if (!s) return '';
    return /^[\d][\d.,]*$/.test(s) ? `${s} pts` : s;
  },

  // Bar fill, 0-100. A missing/zero/NaN target is 0 (the caller renders no
  // bar in that case anyway); over-target is clamped so a viewer who blew
  // past the goal doesn't get a bar wider than its track.
  progressPercent(current, target) {
    const t = Number(target);
    const c = Number(current);
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(c) || c <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((c / t) * 100)));
  },

  // Client mirror of the server's ORDER BY, so a cached or demo payload
  // renders in exactly the order a fresh query would produce: not-done
  // first (lead with something actionable), then featured, then the
  // organiser's display order. Stable — Array#sort is stable, so equal
  // rows keep the server's sequence.
  orderRows(rows) {
    return (rows || []).slice().sort((a, b) => {
      const ad = a?.progress?.done ? 1 : 0;
      const bd = b?.progress?.done ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return 0;
    });
  },

  // "2 of 5 done · 4,300 pts still on the table". The second clause only
  // appears when the server could total the open rewards honestly (see
  // parseRewardPoints server-side) AND there is something left to earn.
  summaryLine(panel) {
    if (!panel) return '';
    const total = Number(panel.total) || 0;
    const done = Number(panel.done) || 0;
    let line = `${done} of ${total} done`;
    const remaining = panel.points_remaining;
    if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0) {
      line += ` · ${remaining.toLocaleString('en-US')} pts still on the table`;
    }
    return line;
  },

  // ── Data ───────────────────────────────────────────────────────────

  // Called from Home.load(). At most one fetch per TTL, and concurrent
  // callers share the in-flight promise.
  ensureLoaded(opts) {
    const force = !!(opts && opts.force);
    if (!window.App || !App.user) return Promise.resolve();
    if (HomePanels._inflight) return HomePanels._inflight;
    if (!force && HomePanels._data
        && Date.now() - HomePanels._fetchedAt < HomePanels.TTL_MS) {
      return Promise.resolve();
    }
    // ?demo=1 rides along exactly like Home.load()'s own demoQS — the
    // server only honours it in staging.
    let demoQS = '';
    try {
      if (new URLSearchParams(location.search).get('demo') === '1') demoQS = '?demo=1';
    } catch (err) { /* ignore */ }

    HomePanels._inflight = fetch(`/api/home-panels${demoQS}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json && Array.isArray(json.panels)) {
          HomePanels._data = json;
          HomePanels._fetchedAt = Date.now();
        }
      })
      // Silent on failure: a home screen must never break (or shout in the
      // console) because the challenge read hiccuped. The card just stays
      // absent until the next mount.
      .catch(() => {})
      .then(() => {
        HomePanels._inflight = null;
        HomePanels.render();
      });
    return HomePanels._inflight;
  },

  panelFor(key) {
    const panels = HomePanels._data && HomePanels._data.panels;
    if (!Array.isArray(panels)) return null;
    return panels.find((p) => p && p.key === key) || null;
  },

  // ── Rendering ──────────────────────────────────────────────────────

  // Painted from the cache only — never fetches. Deliberately NOT gated on
  // Home._dragActive: this section is outside #app-list, so painting it
  // mid-drag can't yank a card out from under the pointer.
  render() {
    const section = document.getElementById('home-panels');
    if (!section) return;
    const html = HomePanels.renderAll();
    section.innerHTML = html;
    section.classList.toggle('hidden', !html);
    if (html) HomePanels._wire(section);
  },

  // Every visible panel's markup, concatenated. Empty string = render
  // nothing at all (the section is hidden).
  renderAll() {
    if (!window.App || !App.user) return '';
    if (!HomePanels._data) return '';
    const panel = HomePanels.panelFor('challenges');
    if (!panel) return '';
    return HomePanels.renderChallengesPanel(panel);
  },

  renderChallengesPanel(panel) {
    const esc = HomePanels.esc;
    const total = Number(panel.total) || 0;
    const isAdmin = !!(window.App && App.user && App.user.isAdmin);

    // Nothing open: the card is absent for ordinary users (an empty box on
    // every home screen is worse than no box), but admins still see it so
    // they can confirm the feature shipped — and so the between-seasons
    // state is visible to whoever runs the seasons.
    if (!total || !Array.isArray(panel.challenges) || !panel.challenges.length) {
      if (!isAdmin) return '';
      return `
        <div class="home-section-header">${esc(panel.title || 'Challenges')}</div>
        <div class="home-section-block">
          <div class="home-panel-card rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 overflow-hidden">
            <p class="px-3 py-4 text-sm text-zinc-500 dark:text-zinc-400">
              No challenges are running right now — check the leaderboard for past seasons.
            </p>
          </div>
        </div>`;
    }

    const rows = HomePanels.orderRows(panel.challenges)
      .map((c) => HomePanels.renderChallengeRow(c)).join('');
    const seasonName = panel.season && panel.season.name ? panel.season.name : '';
    const footerLabel = total > panel.challenges.length
      ? `See all ${esc(total)} challenges`
      : 'See all challenges';

    return `
      <div class="home-section-header flex items-center justify-between gap-2">
        <span class="min-w-0 truncate">${esc(panel.title || 'Challenges')}${seasonName ? ` · <span class="normal-case tracking-normal">${esc(seasonName)}</span>` : ''}</span>
        <button type="button" id="home-panel-hide-challenges"
          class="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-500/10 text-base leading-none un-touch-target"
          title="Hide the Challenges card" aria-label="Hide the Challenges card">&times;</button>
      </div>
      <div class="home-section-block">
        <div class="home-panel-card rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 overflow-hidden">
          <p class="px-3 pt-3 pb-1 text-xs text-zinc-500 dark:text-zinc-400">${esc(HomePanels.summaryLine(panel))}</p>
          <div class="px-3 pb-1">${rows}</div>
          <button type="button" id="home-panel-challenges-all"
            class="w-full flex items-center justify-between gap-2 px-3 py-3 border-t border-zinc-200 dark:border-zinc-800 text-sm font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-500/[0.06] dark:hover:bg-violet-500/10 transition-colors">
            <span>${footerLabel}</span>
            <svg class="w-4 h-4 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>
      </div>`;
  },

  renderChallengeRow(c) {
    const esc = HomePanels.esc;
    const done = !!(c.progress && c.progress.done);
    const numeric = !!(c.metric && c.progress && c.progress.target != null);

    const chip = done
      ? '<span class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.65rem] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">&#10003; Done</span>'
      : '<span class="shrink-0 inline-block px-2 py-0.5 rounded-full text-[0.65rem] font-medium bg-zinc-500/10 text-zinc-500 dark:text-zinc-400">Not done yet</span>';

    const reward = HomePanels.formatReward(c.reward);
    const rewardChip = reward
      ? `<span class="shrink-0 text-xs font-semibold text-violet-600 dark:text-violet-400">${esc(reward)}</span>`
      : '';

    let progressHtml = '';
    if (numeric) {
      const current = Number(c.progress.current) || 0;
      const target = Number(c.progress.target);
      const pct = HomePanels.progressPercent(current, target);
      const label = c.metric.label ? ` ${esc(c.metric.label)}` : '';
      progressHtml = `
        <div class="mt-2">
          <div class="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden"
               role="progressbar" aria-valuenow="${esc(current)}" aria-valuemin="0" aria-valuemax="${esc(target)}"
               aria-label="${esc(c.goal || 'Challenge')} progress">
            <div class="h-full rounded-full bg-violet-500" style="width:${pct}%"></div>
          </div>
          <div class="mt-1 text-[0.65rem] text-zinc-500 dark:text-zinc-400">${esc(current)} / ${esc(target)}${label}</div>
        </div>`;
    } else if (done && Number(c.earned_points) > 0) {
      progressHtml = `<div class="mt-1 text-[0.65rem] font-medium text-emerald-600 dark:text-emerald-400">You earned ${esc(Number(c.earned_points).toLocaleString('en-US'))} pts</div>`;
    }

    const href = c.cta ? HomePanels.safeHref(c.cta.link) : null;
    const ctaHtml = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener"
            class="home-panel-cta shrink-0 rounded-full border border-violet-500 dark:border-violet-400 px-3 py-1 text-xs font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950 transition-colors"
            title="${esc(c.cta.label || 'Start')}">${esc(c.cta.label || 'Start')}</a>`
      : '';

    // The category + chips share the FIRST line (both are short), and the
    // goal gets the row's full width below them. Putting the goal beside
    // the chips instead left it ~130px on a 390px phone, where every title
    // truncated to "Staging demo …" — the one string that matters most in
    // the row. Both goal and task are line-clamped so a 255-char goal
    // still can't blow the card up.
    return `
      <div class="home-panel-row py-2.5 border-b border-zinc-200/70 dark:border-zinc-800/70 last:border-b-0 cursor-pointer" data-challenge-id="${esc(c.id)}">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 truncate text-[10px] uppercase tracking-wide text-violet-600 dark:text-violet-400 font-semibold">${esc(c.label || '')}</div>
          <div class="flex items-center gap-2 shrink-0">${rewardChip}${chip}</div>
        </div>
        <div class="mt-0.5 text-sm font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2">${esc(c.goal || '')}</div>
        ${c.task ? `<p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2">${esc(c.task)}</p>` : ''}
        ${progressHtml}
        ${ctaHtml ? `<div class="mt-2">${ctaHtml}</div>` : ''}
      </div>`;
  },

  _wire(section) {
    // Rows and the footer both go to the existing Challenges screen. Real
    // hash navigation so the router gets a history entry and the device
    // back gesture returns here.
    const toChallenges = () => { location.hash = '#leaderboard/challenges'; };
    section.querySelectorAll('.home-panel-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        // The CTA is its own link out to the organiser's page.
        if (e.target.closest('.home-panel-cta')) return;
        toChallenges();
      });
    });
    const all = section.querySelector('#home-panel-challenges-all');
    if (all) all.addEventListener('click', toChallenges);
    const hide = section.querySelector('#home-panel-hide-challenges');
    if (hide) hide.addEventListener('click', (e) => {
      e.stopPropagation();
      HomePanels.setHidden('challenges', true);
    });
  },

  // Per-user show/hide. Optimistic: the card disappears immediately and
  // comes back if the write fails.
  async setHidden(key, hidden) {
    const prev = HomePanels._data;
    if (prev) {
      HomePanels._data = {
        ...prev,
        hidden: hidden
          ? Array.from(new Set([...(prev.hidden || []), key]))
          : (prev.hidden || []).filter((k) => k !== key),
        panels: hidden
          ? (prev.panels || []).filter((p) => p.key !== key)
          : (prev.panels || []),
      };
      HomePanels.render();
    }
    try {
      const res = await fetch(`/api/home-panels/${encodeURIComponent(key)}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ hidden: !!hidden }),
      });
      if (!res.ok) throw new Error('save failed');
      // Un-hiding needs the payload rebuilt — it was never fetched, or was
      // filtered out of the cache above.
      if (!hidden) await HomePanels.ensureLoaded({ force: true });
      return true;
    } catch (err) {
      HomePanels._data = prev;
      HomePanels.render();
      return false;
    }
  },
};

window.HomePanels = HomePanels;
