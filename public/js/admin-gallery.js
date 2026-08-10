'use strict';

// Screenshot gallery section of the admin console (#860) — the retired
// standalone /gallery page, ported into #admin/gallery.
//
// Tiles are rendered by AppView.visualsTilesHtml in GALLERY MODE —
// { preload: 'none', overlay: false } — so recordings are click-to-play
// and the SPA-only comparison overlay isn't wired. Reusing that renderer
// is deliberate: the gallery must show exactly what a reviewer sees on a
// proposal card, including the fell-back / no-before captions, and a
// second renderer would drift. app-view.js is already loaded by the SPA
// shell, so the standalone page's own <script src="/js/app-view.js"> is
// gone.
//
// Changes from the standalone page: `render(host)` / `destroy()`, and
// element ids prefixed `admin-gallery-` (the page used bare `f-app` /
// `apply` / `refresh` / `proposals` / `stats` / `empty`).
//
// PERMISSIONS: admin-only, enforced by the inline `req.user?.isAdmin` 403
// gate on /api/gallery/* (src/routes/gallery.js). Read-only surface, so
// full and view-only admins both get it.

const AdminGallery = (() => {
  const PAGE_LIMIT = 20;
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';

  let cursor = null;      // { before, before_id } for the next older page
  let loading = false;

  async function getJSON(url) {
    const resp = await fetch(url, { headers: { accept: 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  const $ = (id) => document.getElementById(id);

  function showGate(message) {
    $('admin-gallery-content')?.classList.add('hidden');
    const gate = $('admin-gallery-gate');
    if (!gate) return;
    gate.textContent = message;
    gate.classList.remove('hidden');
  }

  function currentFilters() {
    const app = $('admin-gallery-f-app')?.value || '';
    const problem = $('admin-gallery-f-problem')?.value || '';
    const params = new URLSearchParams();
    if (app) params.set('app', app);
    if (problem) params.set('problem', problem);
    // Staging demo rows (src/routes/gallery.js) — the SPA form is
    // /?demo=1#admin/gallery, so the flag rides in location.search.
    if (DEMO) params.set('demo', '1');
    return params;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Capture-state chip. A NULL state means the proposal merged before capture
  // outcomes were persisted — render it as "unknown" rather than mislabelling
  // it as a success or a failure.
  const CHIP = {
    captured: { label: 'Captured', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    partial: { label: 'Partial', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    console_only: { label: 'No visual change expected', cls: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400' },
    failed: { label: 'Capture failed', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  };

  function chipHtml(state, reason) {
    const chip = CHIP[state] || { label: 'Outcome unknown', cls: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400' };
    const title = reason ? ` title="${esc(reason)}"` : '';
    return `<span class="text-[0.65rem] px-1.5 py-0.5 rounded ${chip.cls}"${title}>${chip.label}</span>`;
  }

  function proposalCardHtml(p) {
    const tiles = (window.AppView && p.visuals)
      ? window.AppView.visualsTilesHtml(p.visuals, { preload: 'none', overlay: false })
      : '';
    const appLabel = p.appName || p.appSlug || `app ${p.appId}`;
    const appLink = p.appSlug
      ? `<a href="/#app/${esc(p.appSlug)}/dev" class="text-violet-500 dark:text-violet-400 hover:text-violet-400 dark:hover:text-violet-300">${esc(appLabel)}</a>`
      : esc(appLabel);
    const prLink = (p.prUrl && p.prNumber)
      ? `<a href="${esc(p.prUrl)}" target="_blank" rel="noopener" class="font-mono text-violet-500 dark:text-violet-400 hover:underline">PR#${esc(p.prNumber)}</a>`
      : (p.prNumber ? `<span class="font-mono text-zinc-500">PR#${esc(p.prNumber)}</span>` : '');
    const proposalLink = p.appSlug
      ? `<a href="/#app/${esc(p.appSlug)}/dev/proposals/${p.id}" class="text-violet-500 dark:text-violet-400 hover:text-violet-400 dark:hover:text-violet-300">Open proposal &rarr;</a>`
      : '';
    const meta = [prLink, fmtDate(p.mergedAt) ? esc(fmtDate(p.mergedAt)) : '', proposalLink]
      .filter(Boolean).join(' <span class="text-zinc-400 dark:text-zinc-600">·</span> ');
    // No tiles is a real state, not an error: console_only / failed proposals
    // legitimately stored nothing. Say which, using the persisted reason.
    const body = tiles || `<div class="text-xs text-zinc-500 dark:text-zinc-400 py-2">
      ${esc(p.captureReason || 'No screenshots were stored for this proposal.')}
    </div>`;

    return `<article class="${AdminUI.card} p-3">
      <div class="flex items-start justify-between gap-3 mb-1">
        <div class="min-w-0">
          <div class="text-sm font-medium truncate">${esc(p.title || `Proposal ${p.id}`)}</div>
          <div class="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">${appLink} <span class="text-zinc-400 dark:text-zinc-600">·</span> ${meta}</div>
        </div>
        <div class="shrink-0">${chipHtml(p.captureState, p.captureReason)}</div>
      </div>
      ${body}
    </article>`;
  }

  function statsHtml(s) {
    if (!s || typeof s.total !== 'number') return '';
    const pct = (n) => (s.total ? Math.round((n / s.total) * 100) : 0);
    const item = (label, n, withPct) => `<span><strong class="text-zinc-700 dark:text-zinc-200">${n}</strong> ${esc(label)}${withPct && s.total ? ` (${pct(n)}%)` : ''}</span>`;
    return [
      item('matching proposals', s.total, false),
      item('complete', s.complete || 0, true),
      item('missing recording', s.missing_recording || 0, true),
      item('missing before', s.missing_before || 0, true),
      item('before fell back', s.before_fell_back || 0, true),
      item('front page only', s.root_only || 0, true),
      item('failed / skipped', s.failed_or_skipped || 0, true),
      (s.unknown_state ? item('outcome not recorded', s.unknown_state, true) : ''),
    ].filter(Boolean).join('');
  }

  async function loadStats() {
    const el = $('admin-gallery-stats');
    if (!el) return;
    try {
      const { stats } = await getJSON(`/api/gallery/stats?${currentFilters().toString()}`);
      if (!$('admin-gallery-stats')) return;
      const html = statsHtml(stats);
      el.innerHTML = html;
      el.classList.toggle('hidden', !html);
      if (html) el.classList.add('flex');
    } catch {
      el.classList.add('hidden');
    }
  }

  async function loadPage({ append }) {
    if (loading) return;
    loading = true;
    const list = $('admin-gallery-proposals');
    const older = $('admin-gallery-load-older');
    const empty = $('admin-gallery-empty');
    if (!list) { loading = false; return; }
    try {
      const params = currentFilters();
      params.set('limit', String(PAGE_LIMIT));
      if (append && cursor) {
        params.set('before', cursor.before);
        params.set('before_id', String(cursor.before_id));
      }
      const data = await getJSON(`/api/gallery/proposals?${params.toString()}`);
      if (!$('admin-gallery-proposals')) return;
      const html = (data.proposals || []).map(proposalCardHtml).join('');
      if (append) list.insertAdjacentHTML('beforeend', html);
      else list.innerHTML = html;
      cursor = data.nextCursor || null;
      older?.classList.toggle('hidden', !data.hasMore);
      empty?.classList.toggle('hidden', !!list.children.length);
    } catch (err) {
      if (!append) {
        list.innerHTML = `<div class="text-sm text-rose-500 dark:text-rose-400">Failed to load the gallery: ${esc(err.message)}</div>`;
      }
    } finally {
      loading = false;
    }
  }

  async function loadFirstPage() {
    cursor = null;
    await Promise.all([loadPage({ append: false }), loadStats()]);
  }

  async function loadApps() {
    try {
      const { apps } = await getJSON(`/api/gallery/apps${DEMO ? '?demo=1' : ''}`);
      const sel = $('admin-gallery-f-app');
      if (!sel) return;
      (apps || []).forEach((a) => {
        const o = document.createElement('option');
        o.value = a.slug || String(a.id);
        o.textContent = `${a.name || a.slug} (${a.proposal_count})`;
        sel.appendChild(o);
      });
    } catch { /* non-fatal — the filter just stays "All apps" */ }
  }

  async function init() {
    // Admin check up front. The /api/gallery/* endpoints are independently
    // enforced server-side; this is only for a clean in-section message. We
    // do NOT navigate away on failure — a transient 401 shouldn't bounce an
    // admin, and it keeps the section coherent under headless checks.
    let me = null;
    try {
      me = await getJSON('/api/auth/me');
    } catch {
      showGate('Sign in as an admin to view the screenshot gallery.');
      return;
    }
    if (!me.user?.isAdmin) {
      showGate('Admins only — this section shows before/after screenshots for merged proposals.');
      return;
    }
    if (!$('admin-gallery-root')) return;
    $('admin-gallery-content')?.classList.remove('hidden');

    $('admin-gallery-apply')?.addEventListener('click', loadFirstPage);
    $('admin-gallery-refresh')?.addEventListener('click', loadFirstPage);
    $('admin-gallery-load-older')?.addEventListener('click', () => loadPage({ append: true }));

    await loadApps();
    await loadFirstPage();
  }

  const MARKUP = `
    <div id="admin-gallery-root">
      <h2 class="text-lg font-semibold mb-4">Screenshot gallery</h2>
      <div id="admin-gallery-gate" class="hidden text-zinc-500 text-center py-20"></div>

      <main id="admin-gallery-content" class="hidden space-y-4">
        <p class="text-sm text-zinc-500">
          Before/after screenshots of every merged proposal, newest first. Each row
          shows the screen it was shot at and the frame it was shot in; recordings
          play on click.
        </p>

        <!-- Filter bar -->
        <section class="${AdminUI.card} p-3
                        flex flex-wrap items-end gap-3">
          <label class="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">App
            <select id="admin-gallery-f-app" class="mt-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100">
              <option value="">All apps</option>
            </select>
          </label>
          <label class="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">Problem
            <select id="admin-gallery-f-problem" class="mt-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100">
              <option value="">Any</option>
              <option value="missing_recording">Missing recording</option>
              <option value="missing_before">Missing before side</option>
              <option value="before_fell_back">Before fell back to home page</option>
              <option value="root_only">Shot at the front page only</option>
              <option value="failed_or_skipped">Capture failed or skipped</option>
            </select>
          </label>
          <button id="admin-gallery-apply" type="button" class="ml-auto px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-700 text-white text-sm">Apply</button>
          <button id="admin-gallery-refresh" type="button" class="px-3 py-1.5 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm">Refresh</button>
        </section>

        <!-- Stats strip for the current filter -->
        <section id="admin-gallery-stats" class="hidden flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400
                                   ${AdminUI.card} px-3 py-2"></section>

        <div id="admin-gallery-proposals" class="space-y-4"></div>

        <div class="flex justify-center py-4">
          <button id="admin-gallery-load-older" type="button" class="hidden px-4 py-2 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm">Load older</button>
          <span id="admin-gallery-empty" class="hidden text-zinc-500 text-sm">No merged proposals match these filters yet.</span>
        </div>
      </main>
    </div>`;

  return {
    render(host) {
      host.innerHTML = MARKUP;
      cursor = null;
      loading = false;
      init();
    },

    // No timers or body-level listeners of its own — the tiles are inert
    // markup inside the section host, so clearing the paging cursor is all
    // the teardown this section needs.
    destroy() {
      cursor = null;
      loading = false;
    },
  };
})();

window.AdminGallery = AdminGallery;
