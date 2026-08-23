'use strict';

// The shared admin class-string registry — imported, not read off the
// global, so the dependency survives bundling (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { E2E_RUN, E2E_AREAS, E2E_CASES } from './e2e-results-data.js';

// End-to-end coverage section of the admin console (#admin/e2e).
//
// The platform has 300+ unit tests and 365 declared dapp tests, and both
// answer the same question: "does this component still behave?" Neither
// answers the question an operator actually asks before a release —
// "has anyone walked the product end to end, on production, recently,
// and what did they find?" That evidence has historically lived in a
// chat log and then evaporated. This section is where it stops
// evaporating.
//
// It is a REPORT, not a runner: nothing here executes a test. The
// dataset is generated (see ./e2e-results-data.js) from the same table
// that writes docs/e2e-use-cases.md, so the repo document and this
// screen cannot drift. Re-running the sweep means regenerating both.
//
// Read the three status groups as different kinds of claim:
//   pass     — someone exercised it and watched it work.
//   fail     — someone exercised it and it broke. These are the point.
//   blocked  — could not be run because something else is down.
//   pending  — needs a human hand (a password, an OAuth consent, a
//              phone, a passport) and has not been done yet.
//   skipped  — deliberately not run, with the reason recorded.
//
// PERMISSIONS: read-only, and visible to any admin (full or view-only).
// It reads no API at all — the data is compiled in — so there is nothing
// to gate beyond reaching the console.

const AdminE2E = (() => {
  let host = null;
  // Bumped on destroy so a late listener can't write into a host that now
  // belongs to another section. Nothing here fetches, but the section can
  // be re-entered, and the filter state must not leak across mounts.
  let generation = 0;
  let statusFilter = null;   // null = every status
  let query = '';

  const esc = (s) => (window.AdminConsole
    ? AdminConsole.esc(s)
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  // Status → badge recipe. `fail` is deliberately the loudest thing on the
  // screen: a red pill among green ones is the whole reason to open this.
  const STATUS_BADGE = {
    pass: AdminUI.badge.success,
    fail: AdminUI.badge.destructive,
    blocked: AdminUI.badge.warn,
    pending: AdminUI.badge.default,
    skipped: AdminUI.badge.outline,
  };

  const METHOD_LABEL = {
    browser: 'Browser-auto',
    api: 'API-auto',
    phone: 'Phone-in-loop',
    assist: 'User-assist',
    unit: 'Unit-pinned',
    manual: 'Manual',
  };

  const GATE_LABEL = {
    guest: 'Guest',
    user: 'User',
    admin: 'Admin',
    alt: '2 accounts',
    device: 'Device',
    creds: 'Ext. creds',
  };

  const STATUS_ORDER = ['fail', 'blocked', 'pending', 'pass', 'skipped'];

  function matches(c) {
    if (statusFilter && c.status !== statusFilter) return false;
    if (!query) return true;
    const hay = `${c.id} ${c.name} ${c.flow} ${c.notes}`.toLowerCase();
    return hay.includes(query);
  }

  // Summary strip. Failures first and always rendered, even at zero —
  // "0 failures" is information an operator wants stated, not implied by
  // an absent tile.
  function summaryHtml() {
    const counts = E2E_RUN.counts || {};
    const tiles = STATUS_ORDER
      .filter((s) => s === 'fail' || counts[s])
      .map((s) => {
        const n = counts[s] || 0;
        const active = statusFilter === s;
        return `<button type="button" data-e2e-status="${s}"
          class="${AdminUI.card} px-4 py-3 text-left transition-colors ${active ? 'ring-2 ring-violet-500' : ''}">
          <span class="block text-2xl font-semibold tabular-nums ${s === 'fail' && n ? 'text-red-600 dark:text-red-400' : 'text-zinc-900 dark:text-zinc-100'}">${n}</span>
          <span class="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400">${esc(s)}</span>
        </button>`;
      }).join('');
    return `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">${tiles}</div>`;
  }

  function caseRowHtml(c) {
    const badge = STATUS_BADGE[c.status] || AdminUI.badge.default;
    const notes = c.notes
      ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">${esc(c.notes)}</p>`
      : '';
    return `<tr class="${AdminUI.trHover}">
      <td class="${AdminUI.td} font-mono text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap align-top">${esc(c.id)}</td>
      <td class="${AdminUI.td} align-top">
        <span class="font-medium text-zinc-900 dark:text-zinc-100">${esc(c.name)}</span>
        <p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">${esc(c.flow)}</p>
        ${notes}
      </td>
      <td class="${AdminUI.td} align-top whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">${esc(GATE_LABEL[c.gate] || c.gate)}</td>
      <td class="${AdminUI.td} align-top whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">${esc(METHOD_LABEL[c.method] || c.method)}</td>
      <td class="${AdminUI.td} align-top whitespace-nowrap"><span class="${badge}">${esc(c.status)}</span></td>
    </tr>`;
  }

  function areaHtml(area) {
    const cases = E2E_CASES.filter((c) => c.area === area.key && matches(c));
    if (!cases.length) return '';
    return `<section class="mb-6">
      <h3 class="${AdminUI.sectionTitle} mb-1">
        <span class="font-mono text-violet-600 dark:text-violet-400 mr-2">${esc(area.key)}</span>${esc(area.title)}
      </h3>
      <p class="${AdminUI.cardDescription} mb-3">${esc(area.blurb)}</p>
      <div class="${AdminUI.tableWrap}">
        <table class="${AdminUI.table}">
          <thead class="${AdminUI.thead}">
            <tr>
              <th class="${AdminUI.th}">ID</th>
              <th class="${AdminUI.th}">Use case</th>
              <th class="${AdminUI.th}">Gate</th>
              <th class="${AdminUI.th}">Method</th>
              <th class="${AdminUI.th}">Status</th>
            </tr>
          </thead>
          <tbody>${cases.map(caseRowHtml).join('')}</tbody>
        </table>
      </div>
    </section>`;
  }

  function listHtml() {
    const body = E2E_AREAS.map(areaHtml).join('');
    return body || `<p class="${AdminUI.muted} py-8 text-center">No use case matches that filter.</p>`;
  }

  function repaintList() {
    const list = document.getElementById('admin-e2e-list');
    if (list) list.innerHTML = listHtml();
  }

  function repaintSummary() {
    const sum = document.getElementById('admin-e2e-summary');
    if (sum) sum.innerHTML = summaryHtml();
  }

  return {
    render(el) {
      host = el;
      generation += 1;
      statusFilter = null;
      query = '';

      host.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 class="${AdminUI.cardTitle}">End-to-end coverage</h2>
          <span class="${AdminUI.badge.outline}">${esc(E2E_RUN.environment)} &middot; ${esc(E2E_RUN.ran)}</span>
        </div>
        <p class="${AdminUI.muted} mb-4 max-w-3xl">
          A record of the last full manual sweep of the product against production &mdash;
          ${E2E_RUN.total} catalogued user-facing flows, what was exercised, and what broke.
          Unit and dapp tests answer &ldquo;does this component still behave?&rdquo;; this
          answers &ldquo;has anyone walked the product end to end, and what did they find?&rdquo;
          It reports, it does not run: the data is generated alongside
          <span class="${AdminUI.kbd}">docs/e2e-use-cases.md</span> so the two cannot drift.
        </p>
        <div id="admin-e2e-summary"></div>
        <div class="flex flex-wrap items-center gap-2 mb-4">
          <input id="admin-e2e-q" type="search" autocomplete="off" spellcheck="false"
            placeholder="Filter by id, name or note&hellip;"
            class="${AdminUI.input} max-w-sm">
          <button id="admin-e2e-clear" type="button" class="${AdminUI.btn.outlineSm}">Clear filters</button>
        </div>
        <div id="admin-e2e-list"></div>`;

      repaintSummary();
      repaintList();

      // One delegated listener on the summary strip: the tiles are
      // re-rendered on every filter change, so binding per-tile would
      // leak handlers with each repaint.
      document.getElementById('admin-e2e-summary')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-e2e-status]');
        if (!btn) return;
        const next = btn.dataset.e2eStatus;
        statusFilter = statusFilter === next ? null : next;
        repaintSummary();
        repaintList();
      });

      document.getElementById('admin-e2e-q')?.addEventListener('input', (e) => {
        query = String(e.target.value || '').trim().toLowerCase();
        repaintList();
      });

      document.getElementById('admin-e2e-clear')?.addEventListener('click', () => {
        statusFilter = null;
        query = '';
        const q = document.getElementById('admin-e2e-q');
        if (q) q.value = '';
        repaintSummary();
        repaintList();
      });
    },

    destroy() {
      // Nothing polls and nothing is in flight — the teardown is purely
      // about not carrying this section's filter state into the next
      // mount of it.
      generation += 1;
      statusFilter = null;
      query = '';
      host = null;
    },
  };
})();

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') window.AdminE2E = AdminE2E;
