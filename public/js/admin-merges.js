'use strict';

// Merge debug section of the admin console (#860) — the retired standalone
// /debug page, ported into #admin/merges.
//
// Lists merge / conflict-resolution runs from /api/debug/merge-runs and
// renders each as a collapsible per-run step timeline. Filters, keyset
// paging and the "Live" 3s poll are all carried over. Changes from the
// standalone page:
//
//   - `render(host)` / `destroy()`; `destroy()` clears the Live poll, which
//     the standalone page could leave running for the life of the tab;
//   - element ids are prefixed `admin-merges-` (the page used bare `f-app`
//     / `apply` / `refresh` / `runs` / `empty`, which are too generic to
//     share a document with the other console sections);
//   - `?demo=1` is still read from location.search — in the SPA that is
//     `/?demo=1#admin/merges`, which is what dapp.json's rendered checks
//     now use. The staging mock rows come from stagingMockMergeRuns() in
//     src/routes/debug.js and are unchanged.
//   - .step-detail / .spin moved to public/css/app.css under
//     #admin-merges-root.
//
// PERMISSIONS: admin-only. /api/debug/* has its own inline
// `req.user?.isAdmin` 403 gate (src/routes/debug.js) covering full AND
// view-only admins — diagnostics is a read surface, so no
// canAdminWrite gate.

const AdminMerges = (() => {
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';
  const qs = (extra) => {
    const p = new URLSearchParams();
    if (DEMO) p.set('demo', '1');
    for (const [k, v] of Object.entries(extra || {})) {
      if (v != null && v !== '') p.set(k, v);
    }
    const s = p.toString();
    return s ? '?' + s : '';
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function getJSON(url) {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  const $ = (id) => document.getElementById(id);

  function showGate(msg) {
    $('admin-merges-content')?.classList.add('hidden');
    const gate = $('admin-merges-gate');
    if (!gate) return;
    gate.textContent = msg;
    gate.classList.remove('hidden');
  }

  // ── Outcome badge ───────────────────────────────────────────────────────
  const BADGES = {
    running:            { label: 'Running',              cls: 'bg-sky-500/20 text-sky-600 dark:text-sky-300', spin: true },
    merged:             { label: 'Merged',               cls: 'bg-green-500/20 text-green-600 dark:text-green-300' },
    blocked:            { label: 'Blocked',              cls: 'bg-amber-500/20 text-amber-600 dark:text-amber-300' },
    conflict_resolving: { label: 'Conflict — resolving', cls: 'bg-sky-500/20 text-sky-600 dark:text-sky-300', spin: true },
    conflict_failed:    { label: 'Conflict — failed',    cls: 'bg-red-500/20 text-red-600 dark:text-red-300' },
    awaiting_github:    { label: 'Awaiting GitHub',      cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' },
    noop:               { label: 'No-op',                cls: 'bg-zinc-500/20 text-zinc-500 dark:text-zinc-400' },
    error:              { label: 'Error',                cls: 'bg-red-500/20 text-red-600 dark:text-red-300' },
    // The proposal's PR is closed on GitHub and couldn't be reopened —
    // terminal, distinct from a conflict.
    pr_closed:          { label: 'PR closed',            cls: 'bg-red-500/20 text-red-600 dark:text-red-300' },
    // A kind='checks' run ends on the verdict its suite produced rather than
    // on a merge outcome. ('error' above is shared — a checks run whose
    // container broke reports the same thing a failed merge does.)
    passing:            { label: 'Checks passing',       cls: 'bg-green-500/20 text-green-600 dark:text-green-300' },
    failing:            { label: 'Checks failing',       cls: 'bg-red-500/20 text-red-600 dark:text-red-300' },
    skipped:            { label: 'Checks skipped',       cls: 'bg-zinc-500/20 text-zinc-500 dark:text-zinc-400' },
  };
  function badge(status) {
    const b = BADGES[status] || { label: status || '—', cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' };
    const spin = b.spin ? '<span class="inline-block w-2 h-2 mr-1 rounded-full bg-current spin align-middle"></span>' : '';
    return `<span class="text-[11px] font-semibold px-2 py-0.5 rounded ${b.cls}">${spin}${esc(b.label)}</span>`;
  }
  const LEVEL_DOT = {
    info:  'bg-zinc-400',
    warn:  'bg-amber-400',
    error: 'bg-red-400',
  };

  function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }
  function fmtDuration(a, b) {
    if (!a) return '';
    const start = new Date(a).getTime();
    const end = b ? new Date(b).getTime() : Date.now();
    const s = Math.max(0, Math.round((end - start) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
  }

  // ── Run card ────────────────────────────────────────────────────────────
  function runCard(run) {
    const title = run.pr_title ? ` — ${esc(run.pr_title)}` : '';
    const pr = run.pr_number ? `PR #${run.pr_number}` : `session ${esc(run.session_id)}`;
    const kindLabel = run.kind === 'conflict_resolution' ? 'conflict resolution'
      : run.kind === 'checks' ? 'checks'
      : 'merge';
    const el = document.createElement('div');
    el.className = 'border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900 overflow-hidden';
    el.innerHTML = `
      <button type="button" class="run-head w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-zinc-100 dark:hover:bg-zinc-800/60">
        <span class="chev text-zinc-500 transition-transform">▶</span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm font-medium truncate">${esc(run.app_name || run.app_slug || 'unknown app')} · ${esc(pr)}${title}</span>
          <span class="block text-xs text-zinc-500">
            ${esc(kindLabel)} · trigger: ${esc(run.trigger || '—')} · ${run.step_count != null ? run.step_count + ' steps · ' : ''}${esc(fmtTime(run.started_at))} · ${esc(fmtDuration(run.started_at, run.ended_at))}
          </span>
        </span>
        ${badge(run.status)}
      </button>
      <div class="run-body hidden border-t border-zinc-200 dark:border-zinc-800 px-4 py-3"></div>`;

    const head = el.querySelector('.run-head');
    const body = el.querySelector('.run-body');
    const chev = el.querySelector('.chev');
    let loaded = false;
    head.addEventListener('click', async () => {
      const open = !body.classList.contains('hidden');
      if (open) {
        body.classList.add('hidden');
        chev.style.transform = '';
        return;
      }
      body.classList.remove('hidden');
      chev.style.transform = 'rotate(90deg)';
      if (!loaded) {
        body.innerHTML = '<div class="text-xs text-zinc-500">Loading steps…</div>';
        try {
          const data = await getJSON(`/api/debug/merge-runs/${run.id}${qs()}`);
          body.innerHTML = stepsHtml(data.steps || []);
          wireDetailToggles(body);
          loaded = true;
        } catch (e) {
          body.innerHTML = `<div class="text-xs text-red-500 dark:text-red-400">Failed to load steps: ${esc(e.message)}</div>`;
        }
      }
    });
    return el;
  }

  function stepsHtml(steps) {
    if (!steps.length) return '<div class="text-xs text-zinc-500">No steps recorded.</div>';
    return '<ol class="space-y-1.5">' + steps.map((s) => {
      const dot = LEVEL_DOT[s.level] || LEVEL_DOT.info;
      const hasDetail = s.detail && Object.keys(s.detail).length > 0;
      const detailJson = hasDetail ? esc(JSON.stringify(s.detail, null, 2)) : '';
      // A kind='checks' step's whole point is its duration — show it on the
      // line rather than only inside the collapsed detail JSON, so scanning
      // a run tells you which phase is the slow one at a glance.
      const ms = s.detail && typeof s.detail.durationMs === 'number' ? s.detail.durationMs : null;
      const dur = ms == null ? '' :
        `<span class="text-[10px] font-mono px-1 rounded bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">${
          esc(ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's')}</span>`;
      return `<li class="text-sm">
        <div class="flex items-start gap-2">
          <span class="mt-1.5 w-2 h-2 rounded-full ${dot} flex-shrink-0"></span>
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2">
              <span class="text-[10px] uppercase tracking-wide text-zinc-500 font-mono">${esc(s.phase || '')}</span>
              <span class="text-[10px] text-zinc-500 dark:text-zinc-600">${esc(fmtTime(s.created_at))}</span>
              ${dur}
            </div>
            <div class="${s.level === 'error' ? 'text-red-600 dark:text-red-300' : s.level === 'warn' ? 'text-amber-600 dark:text-amber-300' : 'text-zinc-700 dark:text-zinc-200'}">${esc(s.message || '')}</div>
            ${hasDetail ? `<button type="button" class="detail-toggle text-[11px] text-violet-500 dark:text-violet-400 hover:text-violet-400 dark:hover:text-violet-300 mt-0.5">detail</button>
              <pre class="detail-body hidden step-detail mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-950 rounded p-2 border border-zinc-200 dark:border-zinc-800">${detailJson}</pre>` : ''}
          </div>
        </div>
      </li>`;
    }).join('') + '</ol>';
  }

  function wireDetailToggles(root) {
    root.querySelectorAll('.detail-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pre = btn.nextElementSibling;
        if (pre) pre.classList.toggle('hidden');
      });
    });
  }

  // ── State + loading ─────────────────────────────────────────────────────
  let cursor = null;       // { before, before_id } for the next "Load older"
  let liveTimer = null;

  function currentFilters() {
    return {
      app: $('admin-merges-f-app')?.value || '',
      pr_number: ($('admin-merges-f-pr')?.value || '').trim(),
      session_id: ($('admin-merges-f-session')?.value || '').trim(),
      outcome: $('admin-merges-f-outcome')?.value || '',
      kind: $('admin-merges-f-kind')?.value || '',
    };
  }

  async function loadFirstPage() {
    const runsEl = $('admin-merges-runs');
    if (!runsEl) return;
    try {
      const data = await getJSON('/api/debug/merge-runs' + qs(currentFilters()));
      if (!$('admin-merges-runs')) return;
      runsEl.innerHTML = '';
      (data.runs || []).forEach((r) => runsEl.appendChild(runCard(r)));
      cursor = data.nextCursor || null;
      $('admin-merges-empty')?.classList.toggle('hidden', (data.runs || []).length > 0);
      $('admin-merges-load-older')?.classList.toggle('hidden', !data.hasMore);
    } catch (e) {
      runsEl.innerHTML = `<div class="text-sm text-red-500 dark:text-red-400">Failed to load: ${esc(e.message)}</div>`;
    }
  }

  async function loadOlder() {
    if (!cursor) return;
    const runsEl = $('admin-merges-runs');
    if (!runsEl) return;
    try {
      const data = await getJSON('/api/debug/merge-runs' + qs({ ...currentFilters(), ...cursor }));
      if (!$('admin-merges-runs')) return;
      (data.runs || []).forEach((r) => runsEl.appendChild(runCard(r)));
      cursor = data.nextCursor || null;
      $('admin-merges-load-older')?.classList.toggle('hidden', !data.hasMore);
    } catch (e) {
      console.error('Load older failed', e);
    }
  }

  async function loadApps() {
    try {
      const data = await getJSON('/api/debug/apps' + qs());
      const sel = $('admin-merges-f-app');
      if (!sel) return;
      (data.apps || []).forEach((a) => {
        const o = document.createElement('option');
        o.value = a.slug;
        o.textContent = `${a.name || a.slug} (${a.run_count})`;
        sel.appendChild(o);
      });
    } catch { /* non-fatal — filter just stays "All apps" */ }
  }

  function setLive(on) {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (on) liveTimer = setInterval(loadFirstPage, 3000);
  }

  async function init() {
    // Admin check up front. The /api/debug/* endpoints are independently
    // enforced server-side; this is only for a clean in-section message. We
    // do NOT navigate away on failure — a transient 401 shouldn't bounce an
    // admin, and it keeps the section coherent under headless checks.
    let me = null;
    try {
      me = await getJSON('/api/auth/me');
    } catch {
      showGate('Sign in as an admin to view merge logs.');
      return;
    }
    if (!me.user?.isAdmin) {
      showGate('Admins only — this section shows merge & conflict-resolution logs.');
      return;
    }
    if (!$('admin-merges-root')) return;
    $('admin-merges-content')?.classList.remove('hidden');

    $('admin-merges-apply')?.addEventListener('click', () => {
      setLive(false);
      const live = $('admin-merges-live');
      if (live) live.checked = false;
      loadFirstPage();
    });
    $('admin-merges-refresh')?.addEventListener('click', loadFirstPage);
    $('admin-merges-load-older')?.addEventListener('click', loadOlder);
    $('admin-merges-live')?.addEventListener('change', (e) => setLive(e.target.checked));

    await loadApps();
    await loadFirstPage();
  }

  const MARKUP = `
    <div id="admin-merges-root">
      <h2 class="text-lg font-semibold mb-4">Merge debug</h2>
      <div id="admin-merges-gate" class="hidden text-zinc-500 text-center py-20"></div>

      <main id="admin-merges-content" class="hidden space-y-4">
        <p class="text-sm text-zinc-500">
          Step-by-step trace of every PR merge and automatic conflict resolution.
          Each row is one merge attempt; expand it for the chronological steps.
        </p>

        <!-- Filter bar -->
        <section class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3 border border-zinc-200 dark:border-zinc-800
                        flex flex-wrap items-end gap-3">
          <label class="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">App
            <select id="admin-merges-f-app" class="mt-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100">
              <option value="">All apps</option>
            </select>
          </label>
          <label class="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">PR #
            <input id="admin-merges-f-pr" type="text" inputmode="numeric" placeholder="any"
                   class="mt-1 w-24 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm">
          </label>
          <label class="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">Session id
            <input id="admin-merges-f-session" type="text" inputmode="numeric" placeholder="any"
                   class="mt-1 w-24 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm">
          </label>
          <label class="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">Outcome
            <select id="admin-merges-f-outcome" class="mt-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm">
              <option value="">Any</option>
              <option value="running">Running</option>
              <option value="merged">Merged</option>
              <option value="blocked">Blocked</option>
              <option value="conflict_resolving">Conflict — resolving</option>
              <option value="conflict_failed">Conflict — failed</option>
              <option value="awaiting_github">Awaiting GitHub</option>
              <option value="noop">No-op</option>
              <option value="error">Error</option>
              <option value="pr_closed">PR closed</option>
              <option value="passing">Checks passing</option>
              <option value="failing">Checks failing</option>
              <option value="skipped">Checks skipped</option>
            </select>
          </label>
          <label class="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">Kind
            <select id="admin-merges-f-kind" class="mt-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm">
              <option value="">Any</option>
              <option value="merge">Merge</option>
              <option value="conflict_resolution">Conflict resolution</option>
              <!-- kind='checks' runs are EXCLUDED from the unfiltered list on
                   purpose (several per proposal would bury the merge traces),
                   so this chip is the only way to reach them. -->
              <option value="checks">Checks (timings)</option>
            </select>
          </label>
          <button id="admin-merges-apply" type="button" class="ml-auto px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-700 text-white text-sm">Apply</button>
          <button id="admin-merges-refresh" type="button" class="px-3 py-1.5 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm">Refresh</button>
          <label class="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400 cursor-pointer select-none">
            <input id="admin-merges-live" type="checkbox" class="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-600 focus:ring-violet-500">
            <span>Live</span>
          </label>
        </section>

        <div id="admin-merges-runs" class="space-y-2"></div>

        <div class="flex justify-center py-4">
          <button id="admin-merges-load-older" type="button" class="hidden px-4 py-2 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm">Load older</button>
          <span id="admin-merges-empty" class="hidden text-zinc-500 text-sm">No merge runs match these filters yet.</span>
        </div>
      </main>
    </div>`;

  return {
    render(host) {
      host.innerHTML = MARKUP;
      cursor = null;
      init();
    },

    destroy() {
      setLive(false);
      cursor = null;
    },
  };
})();

window.AdminMerges = AdminMerges;
