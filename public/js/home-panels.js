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
  // Cache of GET /api/home-panels: { registry, hidden, positions, panels }.
  _data: null,
  _fetchedAt: 0,
  _inflight: null,
  TTL_MS: 60 * 1000,

  // Which panels the viewer has expanded in place, this visit only. The
  // expand toggle grows the block past its height cap and asks the server
  // for the full list (finished challenges included); nothing is
  // persisted, so a reload comes back collapsed. Deliberate: the cap is
  // the default contract, and an expansion the user forgot about would
  // quietly eat the fold forever.
  _expanded: Object.create(null),

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

  // How many rows to draw. Collapsed spends the height cap on at most
  // ROW_SLOTS rows; the overflow affordance is the footer's expand toggle
  // now, so it no longer costs a row slot (it used to take the fourth).
  // Expanded draws everything the server sent and the CSS cap lifts.
  //
  // `link` stays in the return shape as a compatibility flag for anything
  // still reading it, but it is always false: the footer owns overflow.
  visibleSlots(panel) {
    const rows = HomePanels.orderRows(panel && panel.challenges);
    const total = Number(panel && panel.total) || 0;
    const key = panel && panel.key;
    if (key && HomePanels._expanded[key]) {
      return { rows, link: false, total, expanded: true };
    }
    return {
      rows: rows.slice(0, HomePanels.ROW_SLOTS),
      link: false, total, expanded: false,
    };
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
    // server only honours it in staging. `expand` names the one panel the
    // viewer has opened in place, so the fetch brings its full list.
    const params = new URLSearchParams();
    try {
      if (new URLSearchParams(location.search).get('demo') === '1') params.set('demo', '1');
    } catch (err) { /* ignore */ }
    const expandKey = Object.keys(HomePanels._expanded)
      .find((k) => HomePanels._expanded[k]);
    if (expandKey) params.set('expand', expandKey);
    const qs = params.toString() ? `?${params.toString()}` : '';

    HomePanels._inflight = fetch(`/api/home-panels${qs}`, { credentials: 'same-origin' })
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
    // Two possible hosts. Home.render() plants a col-span-full slot INSIDE
    // #app-list at the viewer's dragged position, and that wins when it is
    // there; the standalone section below the grid is the fallback (search
    // is active, the grid didn't render, or the viewer has never dragged).
    // Painting whichever exists keeps one render path for both.
    const slot = document.getElementById('home-panel-slot');
    const section = document.getElementById('home-panels');
    const host = slot || section;
    if (!host) return;
    const html = HomePanels.renderAll();
    if (slot && section) {
      // Don't leave a stale copy in the section when the slot owns it.
      section.innerHTML = '';
      section.classList.add('hidden');
    }
    host.innerHTML = html;
    if (host === section) section.classList.toggle('hidden', !html);
    else host.classList.toggle('hidden', !html);
    if (html) HomePanels._wire(host);
  },

  // Cards above the block, as last dragged. null = never dragged, so the
  // block keeps its default place under the whole grid.
  positionFor(key) {
    const positions = HomePanels._data && HomePanels._data.positions;
    if (!positions || typeof positions !== 'object') return null;
    const n = Number(positions[key]);
    return Number.isInteger(n) && n >= 0 ? n : null;
  },

  // The one panel the grid hosts. With a single widget this is simply
  // "challenges when it is visible and positioned"; a second widget would
  // extend this to a list of slots.
  gridSlotPanelKey() {
    if (!HomePanels._data) return null;
    const panels = HomePanels._data.panels;
    if (!Array.isArray(panels) || !panels.length) return null;
    const key = panels[0].key;
    return HomePanels.positionFor(key) == null ? null : key;
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

  // The bordered block: drag handle + title bar, rows list, optional
  // footer. `flex-none` on the bar/footer and .home-panel-rows on the list
  // are what make the CSS cap clip rather than grow (app.css
  // --home-panel-max-h); `.home-panel--expanded` lifts the cap entirely.
  _panelShell(key, titleHtml, bodyHtml, footerHtml) {
    const esc = HomePanels.esc;
    const expanded = !!HomePanels._expanded[key];
    return `
      <article class="home-panel home-panel-card${expanded ? ' home-panel--expanded' : ''} rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 overflow-hidden" data-panel="${esc(key)}">
        <div class="home-panel-bar flex-none flex items-center gap-2 px-2.5 py-1 border-b border-zinc-200 dark:border-zinc-800">
          <span class="home-panel-grip shrink-0 whitespace-nowrap text-zinc-300 dark:text-zinc-600 cursor-grab select-none leading-none" aria-hidden="true" title="Drag to move this widget">⠿</span>
          ${titleHtml}
          <button type="button" class="home-panel-hide un-touch-target shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-sm leading-none"
            data-panel-key="${esc(key)}"
            title="Hide this widget" aria-label="Hide this widget">&times;</button>
        </div>
        ${bodyHtml}
        ${footerHtml || ''}
      </article>`;
  },

  // The footer bar: the expand/collapse toggle on the LEFT (it grows the
  // block past its cap in place, and the same control collapses it), and
  // the way out to the full Challenges screen on the RIGHT.
  _panelFooter(key, total, expanded) {
    const esc = HomePanels.esc;
    const label = expanded
      ? 'Show less'
      : (total ? `See all ${esc(total)} challenges` : 'See all challenges');
    return `
      <div class="home-panel-footer flex-none flex items-center justify-between gap-2 px-2.5 border-t border-zinc-200 dark:border-zinc-800">
        <button type="button" class="home-panel-expand flex items-center gap-1 text-[12px] font-medium text-violet-600 dark:text-violet-400 hover:underline whitespace-nowrap"
          data-panel-key="${esc(key)}" aria-expanded="${expanded ? 'true' : 'false'}"
          title="${expanded ? 'Collapse this widget' : 'Show every challenge in this widget'}">
          <svg class="w-3 h-3 shrink-0 transition-transform${expanded ? ' rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
          <span class="whitespace-nowrap">${label}</span>
        </button>
        <button type="button" class="home-panel-open flex items-center gap-1 text-[12px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-violet-600 dark:hover:text-violet-400 whitespace-nowrap"
          title="Open the Challenges screen" aria-label="Open the Challenges screen">
          <span class="whitespace-nowrap">Open</span>
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </button>
      </div>`;
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

    const expanded = !!HomePanels._expanded[panel.key];
    const { rows } = HomePanels.visibleSlots(panel);
    const summary = esc(HomePanels.summaryLine(panel));
    // truncate (which carries white-space: nowrap) + an explicit nowrap on
    // the inner span: the counter must never push the title onto a second
    // line, it gets clipped with an ellipsis instead.
    const titleHtml = `
      <span class="home-panel-title min-w-0 flex-1 truncate whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${title}<span class="normal-case tracking-normal whitespace-nowrap"> · ${summary}</span></span>`;

    const rowsHtml = rows.map((c) => HomePanels.renderChallengeRow(c)).join('');

    return HomePanels._panelShell(panel.key, titleHtml,
      `<div class="home-panel-rows">${rowsHtml}</div>`,
      HomePanels._panelFooter(panel.key, total, expanded));
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
    //
    // Both states occupy the SAME 10px box (w-2.5). That is not cosmetic
    // symmetry: the goal text's left edge and the progress bar's `left-7`
    // are both computed from this width (px-2.5 10 + glyph 10 + gap-2 8 =
    // 28px), so a ✓ that sized itself intrinsically would shift the goal —
    // and desynchronise the bar from it — on exactly the done rows.
    const glyph = done
      ? '<span class="home-panel-glyph shrink-0 w-2.5 h-2.5 flex items-center justify-center text-emerald-500 text-[11px] leading-none" aria-hidden="true">&#10003;</span>'
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
      // An OUTLINED bar: a HAIRLINE border plus a light interior (white in
      // light mode, near-black in dark), so an EMPTY 0/5 track still reads
      // as an empty bar. A borderless 2px grey fill was indistinguishable
      // from the row's hairline divider — it looked like a rendering
      // artefact rather than "none of five done".
      //
      // The outline is deliberately FAINT (a /60 alpha on both skins): its
      // whole job is to describe where the bar's extent is, and at full
      // zinc-300/600 it competed with the violet fill for attention and
      // made a mostly-empty bar look like the loud element in the row. The
      // fill is the signal; the outline is the ruler behind it.
      //
      // 9px tall — enough to read as a bar rather than a rule at row
      // density, still absolutely positioned so the row keeps its fixed
      // 38px height. It starts at left-7 = 28px, the goal text's own left
      // edge (see the glyph comment above), so it measures the row's TEXT
      // rather than running under the status dot, where its empty end used
      // to read as a stray underline attached to the glyph.
      barHtml = `
        <span class="home-panel-bar-track absolute left-7 right-2.5 bottom-[3px] h-[9px] rounded-full border border-zinc-300/60 dark:border-zinc-600/60 bg-white dark:bg-zinc-900 overflow-hidden"
              role="progressbar" aria-valuenow="${esc(current)}" aria-valuemin="0" aria-valuemax="${esc(target)}"
              aria-label="${esc(c.goal || 'Challenge')}: ${esc(current)} of ${esc(target)}${esc(label)}">
          <span class="home-panel-bar-fill block h-full bg-violet-500" style="width:${pct}%"></span>
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
  _wire(section) {
    // Rows and the footer's "Open" button both go to the existing
    // Challenges screen. Real hash navigation so the router gets a history
    // entry and the device back gesture returns here.
    const toChallenges = () => { location.hash = '#leaderboard/challenges'; };
    section.querySelectorAll('.home-panel-row').forEach((row) => {
      row.addEventListener('click', toChallenges);
    });
    section.querySelectorAll('.home-panel-open').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); toChallenges(); });
    });
    section.querySelectorAll('.home-panel-expand').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        HomePanels.toggleExpanded(btn.dataset.panelKey);
      });
    });
    section.querySelectorAll('.home-panel-hide').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        HomePanels.setHidden(btn.dataset.panelKey, true);
      });
    });
  },

  // Grow the block past its height cap in place, showing every challenge
  // including the organiser-finished ones; the same control collapses it.
  // Expanding needs a refetch because the collapsed payload is filtered
  // server-side (finished challenges never left the database), so the
  // toggle paints the state it can immediately and fills in when the
  // wider list lands.
  async toggleExpanded(key) {
    if (!key) return false;
    const next = !HomePanels._expanded[key];
    HomePanels._expanded[key] = next;
    HomePanels.render();
    try {
      await HomePanels.ensureLoaded({ force: true });
      return true;
    } catch (err) {
      // A failed refetch leaves the rows as they were rather than emptying
      // the block; the toggle can simply be pressed again.
      return false;
    }
  },

  // Persist an iOS-style drag: `index` is how many app cards sit above the
  // block. Optimistic — the grid has already moved the element, so this
  // only records where it landed.
  async setPosition(key, index) {
    if (!key) return false;
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0) return false;
    if (HomePanels._data) {
      HomePanels._data = {
        ...HomePanels._data,
        positions: { ...(HomePanels._data.positions || {}), [key]: n },
      };
    }
    try {
      const res = await fetch(`/api/home-panels/${encodeURIComponent(key)}/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ index: n }),
      });
      return res.ok;
    } catch (err) {
      return false;
    }
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
