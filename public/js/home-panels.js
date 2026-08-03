// Home-screen panels (issue #911) — the compact widget blocks that sit
// between the "Your apps" grid and "Featured apps". One panel exists so
// far: "Challenges", listing the season's open challenges with the
// viewer's own progress and the points each pays out.
//
// NAMING — "panel", not "widget". home.js already owns a DIFFERENT
// concept called "widget" (Home.renderWidgetSection / #widget-strip /
// .widget-tile: the iOS home-screen widget's pinned app grid, whose UI
// says "Usernode widget"). Both render on this same screen, so everything
// here says `panel`. Nothing user-facing says it: the block is titled
// "Challenges" and the Settings row is "Home screen widgets".
//
// LAYOUT — each panel is its OWN bordered <article class="home-panel">,
// stacked with a gap, so a second widget lands as a distinct block rather
// than another row inside a shared card. The title (and the ✕) travel
// INSIDE each block: the panel area holds N widgets with N titles, so the
// shared heading-above-the-section shape that "Featured apps" uses cannot
// work here. Blocks are plain full-width children — .home-column bounds
// the feed (see app.css; #922 removed the per-box bound).
//
// DENSITY — the block is capped at two app-grid rows (--home-panel-max-h,
// derived in app.css) and spends that budget on a ~28px title bar plus
// FOUR 38px single-line rows. Overflow is handled by rendering fewer rows
// and giving the last slot to a "See all N" link — never an inner
// scroller (a nested scroll region inside the page scroller is a touch
// trap) and never a horizontal pager (invisible to the screenshot capture
// and to dapp.json checks, which can only navigate). That mirrors the
// removed mobile Challenges tab, which paged by navigation: it was a
// plain vertical list of bordered cards on a screen of its own.
//
// FETCH DISCIPLINE. Home.load() is called from a dozen WS/event paths, so
// this module must NOT fetch per Home.load(): ensureLoaded() is
// TTL-guarded and de-duped on an in-flight promise, while render() is
// pure paint from the cache. The section markup is static in index.html
// and lives OUTSIDE #app-list, so Home.render()'s wholesale innerHTML
// rewrite of the grid never destroys it.
'use strict';

const HomePanels = {
  // Cache of GET /api/home-panels: { registry, hidden, panels }.
  _data: null,
  _fetchedAt: 0,
  _inflight: null,
  TTL_MS: 60 * 1000,

  // How many row slots fit under the height cap. The server returns at
  // most this many challenges; when more are open, the last slot becomes
  // the "See all N" link instead of a fourth challenge.
  ROW_SLOTS: 4,

  // Escapes every character that is dangerous in EITHER a text node OR a
  // double-quoted attribute value. Organiser-authored strings (challenge
  // goals, metric labels) land in both here, and the global escapeHtml()
  // in home.js only covers & < > — an unescaped `"` would let a goal
  // break out of title="…" and inject attributes.
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
  // first (lead with something actionable), then the server's own order.
  // Stable — Array#sort is stable, so equal rows keep the server sequence.
  orderRows(rows) {
    return (rows || []).slice().sort((a, b) => {
      const ad = a?.progress?.done ? 1 : 0;
      const bd = b?.progress?.done ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return 0;
    });
  },

  // How the four slots are spent. When more challenges are open than fit,
  // the LAST slot becomes the "See all N" link — so the overflow
  // affordance costs a row only when there is actually overflow, and the
  // budget stays exactly ROW_SLOTS either way.
  visibleSlots(panel) {
    const rows = HomePanels.orderRows(panel && panel.challenges);
    const total = Number(panel && panel.total) || 0;
    const slots = HomePanels.ROW_SLOTS;
    if (total > slots) {
      return { rows: rows.slice(0, slots - 1), link: true, total };
    }
    return { rows: rows.slice(0, slots), link: false, total };
  },

  // "1 of 6 · 3,900 pts left" — folded into the title bar rather than
  // spending a row of its own. The points clause only appears when the
  // server could total the open rewards honestly (organiser prose can't
  // be summed; see parseRewardPoints server-side).
  summaryLine(panel) {
    if (!panel) return '';
    const total = Number(panel.total) || 0;
    const done = Number(panel.done) || 0;
    let line = `${done} of ${total}`;
    const remaining = panel.points_remaining;
    if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0) {
      line += ` · ${remaining.toLocaleString('en-US')} pts left`;
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
      // console) because the challenge read hiccuped. The block just stays
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

  // One article per visible panel, stacked. Empty string = render nothing
  // at all (the section is hidden).
  renderAll() {
    if (!window.App || !App.user) return '';
    if (!HomePanels._data) return '';
    const panels = HomePanels._data.panels;
    if (!Array.isArray(panels) || !panels.length) return '';
    const blocks = panels
      .map((p) => HomePanels.renderPanel(p))
      .filter(Boolean);
    if (!blocks.length) return '';
    // space-y-2 between blocks: each widget reads as its own box.
    return `<div class="space-y-2">${blocks.join('')}</div>`;
  },

  // Dispatch on panel key. An unknown key renders nothing rather than
  // throwing, so a server that ships a new panel before the client knows
  // it degrades to "not shown" instead of a blank home screen.
  renderPanel(panel) {
    if (!panel) return '';
    if (panel.key === 'challenges') return HomePanels.renderChallengesPanel(panel);
    return '';
  },

  // The bordered block: title bar + rows list, nothing else. `flex-none`
  // on the bar and .home-panel-rows on the list are what make the CSS cap
  // clip rather than grow (see app.css --home-panel-max-h).
  _panelShell(key, titleHtml, bodyHtml) {
    return `
      <article class="home-panel home-panel-card rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 overflow-hidden" data-panel="${HomePanels.esc(key)}">
        <div class="home-panel-bar flex-none flex items-center gap-2 px-2.5 py-1 border-b border-zinc-200 dark:border-zinc-800">
          ${titleHtml}
          <button type="button" class="home-panel-hide un-touch-target shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-sm leading-none"
            data-panel-key="${HomePanels.esc(key)}"
            title="Hide this widget" aria-label="Hide this widget">&times;</button>
        </div>
        ${bodyHtml}
      </article>`;
  },

  renderChallengesPanel(panel) {
    const esc = HomePanels.esc;
    const total = Number(panel.total) || 0;
    const isAdmin = !!(window.App && App.user && App.user.isAdmin);
    const title = esc(panel.title || 'Challenges');

    // Nothing open: the block is absent for ordinary users (an empty box on
    // every home screen is worse than no box), but admins still see it so
    // they can confirm the feature shipped — and so the between-seasons
    // state is visible to whoever runs the seasons.
    if (!total || !Array.isArray(panel.challenges) || !panel.challenges.length) {
      if (!isAdmin) return '';
      return HomePanels._panelShell(
        panel.key,
        `<span class="home-panel-title min-w-0 truncate whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${title}</span>`,
        `<p class="home-panel-rows home-panel-row flex items-center px-2.5 text-[13px] text-zinc-500 dark:text-zinc-400">No challenges are running right now</p>`
      );
    }

    const { rows, link } = HomePanels.visibleSlots(panel);
    const summary = esc(HomePanels.summaryLine(panel));
    // truncate (which carries white-space: nowrap) + an explicit nowrap on
    // the inner span: the counter must never push the title onto a second
    // line, it gets clipped with an ellipsis instead.
    const titleHtml = `
      <span class="home-panel-title min-w-0 flex-1 truncate whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${title}<span class="normal-case tracking-normal whitespace-nowrap"> · ${summary}</span></span>`;

    const rowsHtml = rows.map((c) => HomePanels.renderChallengeRow(c)).join('')
      + (link ? HomePanels.renderMoreRow(total) : '');

    return HomePanels._panelShell(panel.key, titleHtml,
      `<div class="home-panel-rows">${rowsHtml}</div>`);
  },

  // One 38px line: glyph · goal · count · reward, plus a 2px progress bar
  // riding the row's bottom edge on numeric rows. Category, task, the
  // organiser CTA and the earned-points line are deliberately absent —
  // they don't fit at this density and all four live one tap away on the
  // Challenges screen.
  renderChallengeRow(c) {
    const esc = HomePanels.esc;
    const done = !!(c.progress && c.progress.done);
    const numeric = !!(c.metric && c.progress && c.progress.target != null);

    // A glyph, not a chip: same signal, a fraction of the width.
    const glyph = done
      ? '<span class="home-panel-glyph shrink-0 text-emerald-500 text-xs leading-none" aria-hidden="true">&#10003;</span>'
      : '<span class="home-panel-glyph shrink-0 w-2.5 h-2.5 rounded-full border border-zinc-300 dark:border-zinc-600" aria-hidden="true"></span>';

    // whitespace-nowrap on the chip is load-bearing, not decoration: the
    // reward is organiser prose and multi-word ("Up to 6,500 pts",
    // "½ of your final credits"), so without it a tight row wraps the chip
    // to a second line that the fixed row height then clips.
    const reward = HomePanels.formatReward(c.reward);
    const rewardHtml = reward
      ? `<span class="shrink-0 whitespace-nowrap text-[11px] font-semibold text-violet-600 dark:text-violet-400">${esc(reward)}</span>`
      : '';

    let countHtml = '';
    let barHtml = '';
    if (numeric) {
      const current = Number(c.progress.current) || 0;
      const target = Number(c.progress.target);
      const pct = HomePanels.progressPercent(current, target);
      const label = c.metric.label ? ` ${c.metric.label}` : '';
      countHtml = `<span class="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">${esc(current)}/${esc(target)}</span>`;
      // Absolutely positioned near the row's bottom edge so the row stays
      // its fixed height — a real progressbar, not a decorative stripe.
      // Inset horizontally (to the row's own text gutter) and lifted 3px
      // off the edge with rounded ends: flush at bottom-0 and full-bleed,
      // an EMPTY track is indistinguishable from the row's hairline
      // divider, which reads as a rendering bug rather than "0 of 5".
      barHtml = `
        <span class="home-panel-bar-track absolute left-2.5 right-2.5 bottom-[3px] h-[2px] rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden"
              role="progressbar" aria-valuenow="${esc(current)}" aria-valuemin="0" aria-valuemax="${esc(target)}"
              aria-label="${esc(c.goal || 'Challenge')}: ${esc(current)} of ${esc(target)}${esc(label)}">
          <span class="home-panel-bar-fill block h-full rounded-full bg-violet-500" style="width:${pct}%"></span>
        </span>`;
    }

    // The task is the row's tooltip — the one place the dropped detail
    // still surfaces without costing height.
    const tip = c.task ? `${c.goal || ''} — ${c.task}` : (c.goal || '');
    return `
      <div class="home-panel-row flex items-center gap-2 px-2.5 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors"
           data-challenge-id="${esc(c.id)}" title="${esc(tip)}">
        ${glyph}
        <span class="home-panel-goal flex-1 min-w-0 truncate whitespace-nowrap text-[13px] text-zinc-900 dark:text-zinc-100">${esc(c.goal || '')}</span>
        ${countHtml}
        ${rewardHtml}
        ${barHtml}
      </div>`;
  },

  // The overflow slot. Occupies one of the four rows, only when total
  // exceeds them, so nothing is hidden behind a gesture.
  renderMoreRow(total) {
    return `
      <div class="home-panel-row home-panel-more flex items-center justify-between gap-2 px-2.5 cursor-pointer text-[13px] font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-500/[0.06] dark:hover:bg-violet-500/10 transition-colors">
        <span class="min-w-0 truncate whitespace-nowrap">See all ${HomePanels.esc(total)} challenges</span>
        <svg class="w-3.5 h-3.5 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
      </div>`;
  },

  _wire(section) {
    // Rows and the overflow slot both go to the existing Challenges
    // screen. Real hash navigation so the router gets a history entry and
    // the device back gesture returns here.
    const toChallenges = () => { location.hash = '#leaderboard/challenges'; };
    section.querySelectorAll('.home-panel-row').forEach((row) => {
      row.addEventListener('click', toChallenges);
    });
    section.querySelectorAll('.home-panel-hide').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        HomePanels.setHidden(btn.dataset.panelKey, true);
      });
    });
  },

  // Per-user show/hide. Optimistic: the block disappears immediately and
  // comes back if the write fails.
  async setHidden(key, hidden) {
    if (!key) return false;
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
